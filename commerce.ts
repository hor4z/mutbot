/**
 * Comercio del bot: LEER paneles de venta (orden `shops`) y operaciones por orden explícita del panel
 * (`commerce`): comprar a un NPC, vender al NPC, mi tienda personal, comprar en una tienda personal y
 * trade directo. Es una CAPACIDAD, no un automatismo: el loop del bot no llama a nada de acá.
 *
 * Reglas duras (el usuario las pidió):
 *  - Las operaciones que mueven zen o ítems exigen que el bot esté en PAUSA (así el loop no camina ni
 *    pelea en el medio), la forma exacta de `CommerceOp` y su `confirm` (commerceToken), que el panel arma
 *    recién al confirmar el resumen con ítem, cantidad y TOTAL.
 *  - Cajas y Cristales no se venden (`neverSell`/`neverShop`); trade sí los puede pasar (mulas).
 *  - Se revisa que cada casilla siga teniendo el ítem que el usuario vio, y que el precio leído no cambió.
 *  - Ritmos humanos: una acción por vez con pausa, nada en ráfaga.
 *
 * SIN VERIFICAR EN VIVO: nada de acá se corrió contra el server (pedido: todo offline). Lo que sí está
 * respaldado por bytes reales: hablar con un NPC y leer StoreItemList (vault.ts) y mover ítems (equip.ts).
 * Tienda personal y trade son de memoria de OpenMU: ver commerce-packets.ts y docs/comercio.md.
 */
import { rawPacket, step } from './actions';
import { commerceToken, firstFit, hasValidConfirm, hex, parseNpcWindow, parsePlayerShopList, parsePlayerShops, parseSellResult, parseShopOpenResult, parseStoreList, parseTradeAnswer, parseTradeFinished, parseTradeItemAdded, parseTradeMoney, parseTradeRequest, buildBuyNpc, buildSellNpc, buildShopBuy, buildShopClose, buildShopCloseDialog, buildShopListRequest, buildShopOpen, buildShopSetPrice, buildTradeAnswer, buildTradeButton, buildTradeCancel, buildTradeRequest, buildTradeZen, isBuyFailed, STORE_COLS, STORE_FIRST_SLOT, STORE_SLOTS, TRADE_COLS, TRADE_REQUEST_TTL_MS, TRADE_ROWS, type ShopRawItem } from './commerce-packets';
import { neverSell, neverShop, opSummary, planSales, itemKey, type VendorRef } from './commerce-plan';
import { WALK_PACE_MS } from './config';
import { sendToGS, waitFor } from './connection';
import { move } from './equip';
import { findPath } from './path';
import { walkableFor } from './terrain';
import { decide, panelLog } from './journal';
import { EventBus } from './net/eventBus';
import { itemInfo } from './panel-logic';
import type { CommerceOp, ItemRef, PanelCommand, ShopItemView, ShopsView, ShopView, TradeView } from './panel-protocol';
import { buildCloseNpc, buildMoveItem, buildTalkNpc, decodeItemDetail, STORAGE } from './protocol097';
import { bot, monsterName, world, type ItemSlot } from './state';
import { chebyshev, directionTowards, humanPace, log, sleep, toBytes } from './util';
import { currentFighter } from './vault';
import type { CommandResult } from './ws-server';

/** A cuántas casillas hay que estar para hablar con un NPC / jugador (el server decide; esto evita pedidos inútiles). */
export const TALK_RANGE = 6;
const MIN_GAP_MS = 2000;
const NPC_TYPES = (t: number) => t >= 200 && t < 300;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
type Touched = { on: boolean };
const touched: Touched = { on: false };
const readShops = new Map<string, ShopView>(); // `npc:<id>` / `player:<id>`
const shopTitles = new Map<number, string>(); // cartel por id de jugador (PlayerShops)
const seenSellPrices: Record<string, number> = {};
const seenBuyPrices: Record<string, number> = {};
const history: { at: number; text: string; ok: boolean }[] = [];
const notes: string[] = [];
const seenHex = new Set<string>();
let mine: ShopsView['mine'] = null;
let trade: TradeView | null = null;
let incoming: { name: string; id: number | null; at: number } | null = null;
let busy = false;
let lastIoAt = 0;
let planCache: { sig: string; plan: ReturnType<typeof planSales> } | null = null;

const hist = (text: string, ok: boolean) => {
  history.unshift({ at: Date.now(), text, ok });
  history.length = Math.min(history.length, 20);
  touched.on = true;
};
/** Guarda el hex del primer packet de cada tipo no verificado, para poder confirmar el layout. */
function noteOnce(kind: string, b: Uint8Array) {
  if (seenHex.has(kind) || notes.length >= 10) return;
  seenHex.add(kind);
  notes.push(`${kind} (${b.length} bytes, SIN verificar): ${hex(b.subarray(0, 64))}`);
  touched.on = true;
}

const nameOf = (group: number, num: number) => itemInfo(group, num).name;
const refMatches = (it: ItemSlot | undefined, r: ItemRef) => !!it && it.group === r.group && it.num === r.num && (it.level ?? 0) === r.level;

export function toShopItem(it: ShopRawItem | (ItemSlot & { raw: Uint8Array }), price: number | null = null): ShopItemView {
  const d = decodeItemDetail(it.raw);
  const { w, h } = itemInfo(d.group, d.num);
  return {
    slot: it.slot, group: d.group, num: d.num, level: d.level, excellent: d.excellent, name: nameOf(d.group, d.num), w, h,
    ...(d.luck ? { luck: true } : {}), ...(d.skill ? { skill: true } : {}), ...(d.option ? { option: d.option } : {}),
    ...(d.excFlags ? { excFlags: d.excFlags, excCount: d.excCount } : {}), ...(d.ancient ? { ancient: d.ancient } : {}),
    ...(d.harmony ? { harmony: d.harmony } : {}), ...(d.opt380 ? { opt380: true } : {}), durability: d.durability,
    price: 'price' in it && it.price != null ? it.price : price,
  };
}

// ---------------------------------------------------------------------------
// Qué hay a la vista
// ---------------------------------------------------------------------------
export function vendorsInView() {
  return [...world.townNpcs.values()]
    .filter((n) => NPC_TYPES(n.type))
    .map((n) => ({ id: n.id, type: n.type, name: monsterName(n.type), x: n.x, y: n.y, dist: chebyshev(world.x, world.y, n.x, n.y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 24);
}
export function playersInView() {
  return [...world.players.entries()]
    .filter(([, p]) => p.name)
    .map(([id, p]) => ({ id, name: p.name!, x: p.x, y: p.y, dist: chebyshev(world.x, world.y, p.x, p.y), ...(shopTitles.has(id) ? { shop: shopTitles.get(id)! } : {}) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 40);
}

function carried() {
  return [...world.inventory.values()].filter((it): it is ItemSlot & { raw: Uint8Array } => !!it.raw).sort((a, b) => a.slot - b.slot);
}

/** El estado de comercio para el panel (null hasta que alguien use la vista). */
export function shopsView(now: number): ShopsView | null {
  if (!touched.on) return null;
  const items = carried();
  const equipped = items.filter((i) => i.slot < 12).map((i) => toShopItem(i));
  const bag = items.filter((i) => i.slot >= 12 && i.slot < 76).map((i) => toShopItem(i));
  const vendors = vendorsInView();
  const sig = `${bag.map((i) => `${i.slot}${i.group}${i.num}${i.level}`).join(',')}|${equipped.map((i) => `${i.slot}${i.group}${i.num}${i.level}`).join(',')}|${vendors[0]?.id ?? ''}|${Object.keys(seenSellPrices).length}`;
  if (!planCache || planCache.sig !== sig) {
    const v: VendorRef[] = vendors.map((x) => ({ id: x.id, name: x.name, dist: x.dist }));
    const toPlan = (i: ItemSlot & { raw: Uint8Array }) => ({ ...decodeItemDetail(i.raw), slot: i.slot, name: nameOf(i.group, i.num) });
    planCache = { sig, plan: planSales({ fighter: currentFighter(), equipped: items.filter((i) => i.slot < 12).map(toPlan), bag: items.filter((i) => i.slot >= 12 && i.slot < 76).map(toPlan), vendors: v, seenSellPrices }) };
  }
  return {
    at: now, vendors, players: playersInView(), shops: [...readShops.values()], mine, trade, equipped, bag,
    history: history.slice(0, 12), notes: notes.slice(), plan: planCache.plan,
  };
}

// ---------------------------------------------------------------------------
// Escucha pasiva (solo lee): carteles de tienda, tienda propia, pedidos de trade
// ---------------------------------------------------------------------------
let watching = false;
export function watchCommerce() {
  if (watching) return;
  watching = true;
  EventBus.on('PlayerShops', (raw: any) => {
    const b = toBytes(raw);
    const list = parsePlayerShops(b);
    if (!list) return noteOnce('PlayerShops', b);
    for (const s of list) shopTitles.set(s.id, s.title);
    touched.on = true;
  });
  EventBus.on('PlayerShopClosed', () => {
    if (mine?.open) mine = { ...mine, open: false };
  });
  EventBus.on('PlayerShopItemSoldToPlayer', (raw: any) => {
    const b = toBytes(raw);
    noteOnce('PlayerShopItemSoldToPlayer', b);
    hist(`Se vendió algo de mi tienda (aviso del server: ${hex(b.subarray(0, 20))})`, true);
  });
  EventBus.on('TradeRequest', (raw: any) => {
    const b = toBytes(raw);
    const name = parseTradeRequest(b);
    if (!name) return noteOnce('TradeRequest', b);
    const id = [...world.players.entries()].find(([, p]) => p.name === name)?.[0] ?? null;
    incoming = { name, id, at: Date.now() };
    trade = { with: name, withId: id, state: 'incoming', at: Date.now(), mine: [], theirs: [], mineZen: 0, theirsZen: 0, note: `${name} te pidió trade; vence a los ${TRADE_REQUEST_TTL_MS / 1000} s` };
    hist(`${name} me pidió trade (no lo acepto solo: hace falta la orden del panel)`, true);
  });
  EventBus.on('TradeItemAdded', (raw: any) => {
    const b = toBytes(raw);
    const it = parseTradeItemAdded(b);
    if (!it) return noteOnce('TradeItemAdded', b);
    if (trade) trade = { ...trade, theirs: [...trade.theirs.filter((x) => x.slot !== it.slot), toShopItem(it)] };
  });
  EventBus.on('TradeMoneyUpdate', (raw: any) => {
    const b = toBytes(raw);
    const z = parseTradeMoney(b);
    if (z == null) return noteOnce('TradeMoneyUpdate', b);
    if (trade) trade = { ...trade, theirsZen: z };
  });
  EventBus.on('TradeFinished', (raw: any) => {
    const b = toBytes(raw);
    const r = parseTradeFinished(b);
    if (r == null) return noteOnce('TradeFinished', b);
    if (trade) trade = { ...trade, state: r === 1 ? 'done' : 'cancelled', at: Date.now(), note: r === 1 ? 'trade hecho' : `trade cancelado (resultado ${r})` };
    hist(r === 1 ? `Trade con ${trade?.with ?? '?'} hecho` : `Trade con ${trade?.with ?? '?'} cancelado (resultado ${r})`, r === 1);
  });
}
watchCommerce();

// ---------------------------------------------------------------------------
// Utilidades de las órdenes
// ---------------------------------------------------------------------------
const send = (b: Uint8Array) => sendToGS(rawPacket([...b]));

async function pace(ms = 700) {
  await sleep(humanPace(ms));
}

/** Camina hasta quedar a <= `range` casillas del punto (como vault.ts: sin pathfinding, a ritmo de caminata). */
async function walkNear(x: number, y: number, range = 2, maxSteps = 40): Promise<boolean> {
  for (let i = 0; i < maxSteps && chebyshev(world.x, world.y, x, y) > range; i++) {
    // Con el terreno del mapa (path.ts); si no hay camino, en línea recta como antes.
    const path = findPath(walkableFor(world.map), { x: world.x, y: world.y }, { x, y }, 6000);
    const next = path && path.length > 1 ? path[1] : { x, y };
    step(directionTowards(world.x, world.y, next.x, next.y));
    await sleep(humanPace(WALK_PACE_MS));
    if (bot.kicked) return false;
  }
  return chebyshev(world.x, world.y, x, y) <= range;
}

function guardGame(): string | null {
  if (!bot.inGameAt || bot.kicked) return 'todavía no estoy en el mundo';
  if (bot.resetting) return 'estoy reseteando, probá en un rato';
  return null;
}

/** Una operación por vez y con 2 s entre una y otra. */
async function exclusive<T extends CommandResult>(run: () => Promise<T>): Promise<CommandResult> {
  if (busy) return { ok: false, msg: 'ya estoy haciendo una operación de comercio: esperá a que termine' };
  const wait = lastIoAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  busy = true;
  touched.on = true;
  try {
    return await run();
  } finally {
    busy = false;
    lastIoAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Leer paneles de venta (solo lectura)
// ---------------------------------------------------------------------------
async function openNpc(id: number): Promise<{ ok: true; win: string | null; items: ShopRawItem[]; type: number } | { ok: false; msg: string }> {
  const npc = world.townNpcs.get(id);
  if (!npc) return { ok: false, msg: `el NPC ${id} no está a la vista` };
  const d = chebyshev(world.x, world.y, npc.x, npc.y);
  if (d > TALK_RANGE) return { ok: false, msg: `${monsterName(npc.type)} está a ${d} casillas (hay que estar a ${TALK_RANGE} o menos): acercate` };
  const win = waitFor('NpcWindowResponse', 4000).catch(() => null);
  const list = waitFor('StoreItemList', 4000).catch(() => null);
  send(buildTalkNpc(id));
  const [w, raw] = await Promise.all([win, list]);
  await pace(900);
  send(buildCloseNpc());
  const kind = w ? parseNpcWindow(toBytes(w)) : null;
  if (kind === 'baul') return { ok: false, msg: `${monsterName(npc.type)} es el baúl: para leerlo usá la orden vault` };
  if (kind === 'maquina') return { ok: false, msg: `${monsterName(npc.type)} es una máquina de mezclas, no una tienda` };
  if (!raw) return { ok: false, msg: `${monsterName(npc.type)} no contestó con un catálogo (¿no es vendedor, o está lejos?)` };
  const parsed = parseStoreList(toBytes(raw));
  if (!parsed) return { ok: false, msg: `catálogo de ${monsterName(npc.type)} con largo inesperado (${toBytes(raw).length} bytes)` };
  return { ok: true, win: kind, items: parsed.items, type: npc.type };
}

async function readNpcShop(id: number): Promise<CommandResult> {
  const r = await openNpc(id);
  if (!r.ok) return r;
  const npc = world.townNpcs.get(id)!;
  const items = r.items.map((i) => toShopItem({ ...i, price: seenBuyPrices[itemKey({ group: i.group, num: i.num, level: i.level })] ?? null }));
  readShops.set(`npc:${id}`, { kind: 'npc', id, name: monsterName(npc.type), map: world.map, x: npc.x, y: npc.y, at: Date.now(), items, verified: false });
  log(`Comercio: catálogo de ${monsterName(npc.type)}: ${items.length} ítem(s).`);
  return { ok: true, msg: `${monsterName(npc.type)}: ${items.length} ítem(s) en el catálogo (el NPC no publica precios)` };
}

async function readPlayerShop(id: number): Promise<CommandResult> {
  const p = world.players.get(id);
  if (!p?.name) return { ok: false, msg: `el jugador ${id} no está a la vista o no sé su nombre` };
  const d = chebyshev(world.x, world.y, p.x, p.y);
  if (d > TALK_RANGE + 4) return { ok: false, msg: `${p.name} está a ${d} casillas: acercate` };
  const list = waitFor('PlayerShopItemList', 4000).catch(() => null);
  send(buildShopListRequest(id, p.name));
  const raw = await list;
  await pace(700);
  send(buildShopCloseDialog(id, p.name));
  if (!raw) return { ok: false, msg: `${p.name} no contestó con una tienda (¿no tiene la tienda abierta?)` };
  const b = toBytes(raw);
  noteOnce('PlayerShopItemList', b);
  const shop = parsePlayerShopList(b);
  if (!shop) return { ok: false, msg: `tienda de ${p.name} con un layout que no reconozco (${b.length} bytes; el hex quedó en las notas)` };
  const items = shop.items.map((i) => toShopItem(i));
  readShops.set(`player:${id}`, { kind: 'player', id, name: p.name, title: shop.title || shopTitles.get(id), map: world.map, x: p.x, y: p.y, at: Date.now(), items, verified: false });
  log(`Comercio: tienda de ${p.name}: ${items.length} ítem(s).`);
  return { ok: true, msg: `tienda de ${p.name}${shop.title ? ` ("${shop.title}")` : ''}: ${items.length} ítem(s)` };
}

/** Orden `shops`: solo lectura. */
export async function runShops(c: Extract<PanelCommand, { cmd: 'shops' }>): Promise<CommandResult> {
  const bad = guardGame();
  if (bad) return { ok: false, msg: bad };
  touched.on = true;
  if (c.npc === undefined && c.player === undefined) {
    const v = vendorsInView(), p = playersInView();
    return { ok: true, msg: `a la vista: ${v.length} NPC y ${p.length} jugador(es); ${readShops.size} tienda(s) leída(s)` };
  }
  return exclusive(() => (c.npc !== undefined ? readNpcShop(c.npc) : readPlayerShop(c.player!)));
}

// ---------------------------------------------------------------------------
// Operaciones (mueven zen/ítems): solo por orden explícita
// ---------------------------------------------------------------------------
function opDescribe(op: CommerceOp): string {
  const s = opSummary(op, {
    name: (slot, from) => (from === 'bag' ? (() => { const it = world.inventory.get(slot); return it ? nameOf(it.group, it.num) : `casilla ${slot}`; })() : (() => { const it = [...readShops.values()].flatMap((x) => x.items).find((x) => x.slot === slot); return it?.name ?? `casilla ${slot}`; })()),
    zen: bot.lastMoney,
  });
  return `${s.title}: ${s.lines.join('; ')}. ${s.total}`;
}

function checkRefs(refs: ItemRef[]): string | null {
  const seen = new Set<number>();
  for (const r of refs) {
    if (seen.has(r.slot)) return `la casilla ${r.slot} está repetida`;
    seen.add(r.slot);
    if (r.slot < 12 || r.slot >= 76) return `la casilla ${r.slot} no es de la bolsa (12-75): lo puesto no se mueve por acá`;
    if (!refMatches(world.inventory.get(r.slot), r)) return `la casilla ${r.slot} ya no tiene ${nameOf(r.group, r.num)} +${r.level}: refrescá y confirmá de nuevo`;
    if (!world.inventory.get(r.slot)?.raw) return `no tengo los bytes del ítem de la casilla ${r.slot}`;
  }
  return null;
}

export async function runCommerce(op: CommerceOp): Promise<CommandResult> {
  const bad = guardGame();
  if (bad) return { ok: false, msg: bad };
  if (!hasValidConfirm(op)) return { ok: false, msg: 'falta la confirmación del resumen (o no coincide con la orden): no hago nada' };
  const needsPause = op.kind !== 'trade-cancel' && op.kind !== 'shop-close';
  if (needsPause && !bot.paused) return { ok: false, msg: 'pausame primero (orden pause): el comercio se hace quieto, sin que el loop camine o pelee' };
  touched.on = true;
  const what = opDescribe(op);
  // Cancelar/cerrar son salidas seguras: no esperan la fila de operaciones.
  if (op.kind === 'trade-cancel') return doTradeCancel();
  const r = await exclusive(async () => {
    decide(`Comercio (orden del panel, confirmada): ${what}`);
    switch (op.kind) {
      case 'buy': return doBuy(op);
      case 'sell': return doSell(op);
      case 'shop-open': return doShopOpen(op);
      case 'shop-close': return doShopClose();
      case 'shop-buy': return doShopBuy(op);
      case 'trade': return doTrade(op);
      case 'trade-accept': return doTradeAccept(op);
      case 'trade-ok': return doTradeOk();
    }
  });
  hist(`${op.kind}: ${r.msg}`, r.ok);
  return r;
}

/** NPC conocidos (OpenMU, Lorencia.cs): Amy, vendedora de pociones, cerca de (127,86). */
const KNOWN_NPCS: Record<number, { map: number; x: number; y: number }> = { 253: { map: 0, x: 127, y: 86 } };

async function goTalk(npcId: number): Promise<CommandResult | null> {
  let npc = world.townNpcs.get(npcId);
  const known = KNOWN_NPCS[npcId];
  if (!npc && known && world.map === known.map) {
    // Fuera de la vista pero con posición conocida (vendedora de pociones de Lorencia): se camina hasta tenerla cerca.
    await walkNear(known.x, known.y, 8, 140);
    npc = world.townNpcs.get(npcId);
  }
  if (!npc) return { ok: false, msg: `el NPC ${npcId} no está a la vista` };
  if (chebyshev(world.x, world.y, npc.x, npc.y) > TALK_RANGE && !(await walkNear(npc.x, npc.y, 3))) return { ok: false, msg: `no llegué a ${monsterName(npc.type)} (${npc.x},${npc.y})` };
  return null;
}

async function doBuy(op: Extract<CommerceOp, { kind: 'buy' }>): Promise<CommandResult> {
  const before = [...readShops.values()].find((s) => s.kind === 'npc' && s.id === op.npc)?.items.find((i) => i.slot === op.slot);
  if (!before) return { ok: false, msg: 'primero leé el catálogo de ese NPC (shops) para ver qué estás comprando' };
  const err = await goTalk(op.npc);
  if (err) return err;
  const r = await (async () => {
    const win = waitFor('NpcWindowResponse', 4000).catch(() => null);
    const list = waitFor('StoreItemList', 4000).catch(() => null);
    send(buildTalkNpc(op.npc));
    const [w, raw] = await Promise.all([win, list]);
    return { kind: w ? parseNpcWindow(toBytes(w)) : null, parsed: raw ? parseStoreList(toBytes(raw)) : null };
  })();
  try {
    if (r.kind !== 'mercader' || !r.parsed) return { ok: false, msg: 'el NPC no abrió un catálogo de venta' };
    const now = r.parsed.items.find((i) => i.slot === op.slot);
    if (!now || now.group !== before.group || now.num !== before.num || now.level !== before.level) return { ok: false, msg: 'el catálogo cambió: esa casilla ya no tiene lo que viste. Releé y confirmá de nuevo' };
    const start = bot.lastMoney;
    let bought = 0, lastUnit = 0;
    for (let i = 0; i < op.qty; i++) {
      if (bot.lastMoney <= 0) break;
      if (start - bot.lastMoney + lastUnit > op.maxZen) break; // la próxima se pasaría del tope
      const ok = waitFor('ItemBought', 3000).then((b) => !isBuyFailed(toBytes(b))).catch(() => false);
      const failed = waitFor('NpcItemBuyFailed', 3000).then(() => false).catch(() => false);
      const zenBefore = bot.lastMoney;
      send(buildBuyNpc(op.slot));
      const res = await Promise.race([ok, failed]);
      if (!res) break;
      bought++;
      await sleep(500); // el InventoryMoneyUpdate llega un poco después
      lastUnit = Math.max(0, zenBefore - bot.lastMoney);
      if (start - bot.lastMoney > op.maxZen) break;
      await pace(600);
    }
    const spent = Math.max(0, start - bot.lastMoney);
    if (bought > 0) seenBuyPrices[itemKey(before)] = Math.round(spent / bought);
    return { ok: bought > 0, msg: `compré ${bought}/${op.qty} × ${before.name}; gasté ${spent.toLocaleString('es-AR')} zen (tope ${op.maxZen.toLocaleString('es-AR')})` };
  } finally {
    await pace(500);
    send(buildCloseNpc());
  }
}

async function doSell(op: Extract<CommerceOp, { kind: 'sell' }>): Promise<CommandResult> {
  const err0 = checkRefs(op.items);
  if (err0) return { ok: false, msg: err0 };
  for (const r of op.items) {
    const it = world.inventory.get(r.slot)!;
    const why = neverSell({ ...decodeItemDetail(it.raw!), slot: it.slot });
    if (why) return { ok: false, msg: `no vendo ${nameOf(r.group, r.num)} (casilla ${r.slot}): ${why}` };
  }
  const err = await goTalk(op.npc);
  if (err) return err;
  const win = waitFor('NpcWindowResponse', 4000).catch(() => null);
  const list = waitFor('StoreItemList', 4000).catch(() => null);
  send(buildTalkNpc(op.npc));
  const [w] = await Promise.all([win, list]);
  try {
    if ((w ? parseNpcWindow(toBytes(w)) : null) !== 'mercader') return { ok: false, msg: 'ese NPC no compra (no abrió una ventana de mercader)' };
    let sold = 0, gained = 0;
    for (const r of op.items) {
      const it = world.inventory.get(r.slot);
      if (!refMatches(it, r)) break;
      await pace(600);
      const res = waitFor('NpcItemSellResult', 3000).catch(() => null);
      const zenBefore = bot.lastMoney;
      send(buildSellNpc(r.slot));
      const raw = await res;
      const parsed = raw ? parseSellResult(toBytes(raw)) : null;
      if (!parsed?.ok) break;
      sold++;
      world.inventory.delete(r.slot);
      const delta = Math.max(0, parsed.zen - zenBefore);
      bot.lastMoney = parsed.zen;
      gained += delta;
      seenSellPrices[itemKey(r)] = delta;
    }
    return { ok: sold > 0, msg: `vendí ${sold}/${op.items.length}; cobré ${gained.toLocaleString('es-AR')} zen` };
  } finally {
    await pace(500);
    send(buildCloseNpc());
  }
}

async function doShopOpen(op: Extract<CommerceOp, { kind: 'shop-open' }>): Promise<CommandResult> {
  if (mine?.open) return { ok: false, msg: 'ya tengo la tienda abierta: cerrala primero' };
  const err0 = checkRefs(op.items);
  if (err0) return { ok: false, msg: err0 };
  for (const r of op.items) {
    const it = world.inventory.get(r.slot)!;
    const why = neverShop({ ...decodeItemDetail(it.raw!) });
    if (why) return { ok: false, msg: `no pongo ${nameOf(r.group, r.num)} en venta: ${why}` };
  }
  // Área de la tienda: casillas 76-107 del inventario (SIN verificar), 8×4.
  const occupied = [...world.inventory.values()].filter((i) => i.slot >= STORE_FIRST_SLOT).map((i) => ({ pos: i.slot - STORE_FIRST_SLOT, w: itemInfo(i.group, i.num).w, h: itemInfo(i.group, i.num).h }));
  const placed: { slot: number; price: number; name: string }[] = [];
  for (const r of op.items) {
    const it = world.inventory.get(r.slot)!;
    const { w, h } = itemInfo(it.group, it.num);
    const pos = firstFit(occupied, w, h, STORE_COLS, STORE_SLOTS / STORE_COLS);
    if (pos == null) return { ok: false, msg: `no entra ${nameOf(it.group, it.num)} en el área de la tienda (8×4)` };
    const to = STORE_FIRST_SLOT + pos;
    await pace(700);
    if (!(await move(it, to))) return { ok: false, msg: `el server no me dejó poner ${nameOf(it.group, it.num)} en la tienda (casilla ${to})` };
    occupied.push({ pos, w, h });
    placed.push({ slot: to, price: r.price, name: nameOf(it.group, it.num) });
  }
  for (const p of placed) {
    if (p.price <= 0) continue; // precio 0 = de muestra: no hace falta mandarlo
    await pace(600);
    const res = waitFor('PlayerShopSetItemPriceResponse', 3000).catch(() => null);
    send(buildShopSetPrice(p.slot, p.price));
    const raw = await res;
    if (raw) noteOnce('PlayerShopSetItemPriceResponse', toBytes(raw));
  }
  await pace(800);
  const opened = waitFor('PlayerShopOpenSuccessful', 4000).catch(() => null);
  send(buildShopOpen(op.title));
  const raw = await opened;
  const ok = raw ? parseShopOpenResult(toBytes(raw)) : null;
  mine = { open: ok === true, title: op.title, items: placed, at: Date.now() };
  return ok === true ? { ok: true, msg: `tienda "${op.title}" abierta con ${placed.length} ítem(s)` } : { ok: false, msg: ok === false ? 'el server no abrió la tienda' : 'el server no contestó al abrir la tienda (¿hay que estar en la ciudad?)' };
}

async function doShopClose(): Promise<CommandResult> {
  const closed = waitFor('PlayerShopClosed', 3000).catch(() => null);
  send(buildShopClose());
  const raw = await closed;
  if (mine) mine = { ...mine, open: false };
  return raw ? { ok: true, msg: 'tienda cerrada' } : { ok: true, msg: 'mandé cerrar la tienda (el server no avisó)' };
}

async function doShopBuy(op: Extract<CommerceOp, { kind: 'shop-buy' }>): Promise<CommandResult> {
  const p = world.players.get(op.player);
  if (!p?.name) return { ok: false, msg: `el jugador ${op.player} no está a la vista` };
  const known = readShops.get(`player:${op.player}`)?.items.find((i) => i.slot === op.slot);
  if (!known) return { ok: false, msg: 'primero leé esa tienda (shops) para ver qué estás comprando' };
  if (known.price !== op.price) return { ok: false, msg: `el precio que leíste (${known.price}) no es el de la orden (${op.price})` };
  if (op.price <= 0) return { ok: false, msg: 'precio 0 = de muestra: no se vende' };
  if (bot.lastMoney < op.price) return { ok: false, msg: `me faltan zen: tengo ${bot.lastMoney.toLocaleString('es-AR')}` };
  // Releer la tienda ahora y comprobar que el ítem y el precio siguen iguales.
  const list = waitFor('PlayerShopItemList', 4000).catch(() => null);
  send(buildShopListRequest(op.player, p.name));
  const raw = await list;
  const fresh = raw ? parsePlayerShopList(toBytes(raw)) : null;
  const now = fresh?.items.find((i) => i.slot === op.slot);
  try {
    if (!now) return { ok: false, msg: 'la tienda ya no tiene esa casilla' };
    if (now.group !== known.group || now.num !== known.num || now.level !== known.level || now.price !== op.price) return { ok: false, msg: 'la tienda cambió (ítem o precio): releé y confirmá de nuevo' };
    const zen0 = bot.lastMoney, count0 = world.inventory.size;
    await pace(800);
    send(buildShopBuy(op.player, p.name, op.slot));
    await sleep(2500);
    const spent = zen0 - bot.lastMoney;
    const ok = spent > 0 || world.inventory.size > count0;
    return { ok, msg: ok ? `compré ${known.name} a ${p.name}; gasté ${Math.max(spent, 0).toLocaleString('es-AR')} zen` : `${p.name} no me vendió (el server no cobró ni dio el ítem)` };
  } finally {
    await pace(400);
    send(buildShopCloseDialog(op.player, p.name));
  }
}

// --- trade ---------------------------------------------------------------
async function doTrade(op: Extract<CommerceOp, { kind: 'trade' }>): Promise<CommandResult> {
  const p = world.players.get(op.player);
  if (!p?.name) return { ok: false, msg: `el jugador ${op.player} no está a la vista` };
  if (chebyshev(world.x, world.y, p.x, p.y) > TALK_RANGE) return { ok: false, msg: `${p.name} está lejos: acercate` };
  if (op.items.length > 0) {
    const e = checkRefs(op.items);
    if (e) return { ok: false, msg: e };
  }
  if (op.zen > bot.lastMoney) return { ok: false, msg: `ofrecés ${op.zen.toLocaleString('es-AR')} zen y tengo ${bot.lastMoney.toLocaleString('es-AR')}` };
  if (trade && (trade.state === 'open' || trade.state === 'requested')) return { ok: false, msg: 'ya hay un trade en curso: cancelalo primero' };
  trade = { with: p.name, withId: op.player, state: 'requested', at: Date.now(), mine: [], theirs: [], mineZen: 0, theirsZen: 0, note: 'esperando que acepte (20 s)' };
  const answer = waitFor('TradeRequestAnswer', TRADE_REQUEST_TTL_MS).catch(() => null);
  send(buildTradeRequest(op.player));
  const a = await answer;
  const accepted = a ? parseTradeAnswer(toBytes(a)) : null;
  if (accepted !== true) {
    if (a) noteOnce('TradeRequestAnswer', toBytes(a));
    trade = { ...trade, state: 'cancelled', note: accepted === false ? `${p.name} rechazó el trade` : `${p.name} no contestó en ${TRADE_REQUEST_TTL_MS / 1000} s` };
    return { ok: false, msg: trade.note! };
  }
  trade = { ...trade, state: 'open', note: 'ventana abierta' };
  const occupied: { pos: number; w: number; h: number }[] = [];
  const mineItems: ShopItemView[] = [];
  for (const r of op.items) {
    const it = world.inventory.get(r.slot)!;
    const { w, h } = itemInfo(it.group, it.num);
    const pos = firstFit(occupied, w, h, TRADE_COLS, TRADE_ROWS);
    if (pos == null) return abortTrade('no entran todos los ítems en la ventana de trade (8×4)');
    await pace(800);
    const reply = waitFor('ItemMoved', 3000).catch(() => null);
    send(buildMoveItem(STORAGE.inventory, it.slot, it.raw!, STORAGE.trade, pos));
    const rb = await reply;
    const bytes = rb ? toBytes(rb) : null;
    if (!bytes || bytes[3] === 0xff) return abortTrade(`el server no me dejó poner ${nameOf(it.group, it.num)} en el trade`);
    occupied.push({ pos, w, h });
    mineItems.push(toShopItem({ ...it, slot: pos, raw: it.raw! }));
    trade = { ...trade!, mine: [...mineItems] };
  }
  if (op.zen > 0) {
    await pace(800);
    const res = waitFor('TradeMoneySetResponse', 3000).catch(() => null);
    send(buildTradeZen(op.zen));
    const rr = await res;
    if (rr) noteOnce('TradeMoneySetResponse', toBytes(rr));
    trade = { ...trade!, mineZen: op.zen };
  }
  await pace(1200);
  const fin = waitFor('TradeFinished', 60_000).catch(() => null);
  send(buildTradeButton(true));
  trade = { ...trade!, note: 'marqué OK: espero que el otro marque OK (60 s)' };
  const f = await fin;
  const res = f ? parseTradeFinished(toBytes(f)) : null;
  if (res === 1) {
    for (const r of op.items) world.inventory.delete(r.slot);
    bot.lastMoney = Math.max(0, bot.lastMoney - op.zen);
    trade = { ...trade!, state: 'done', note: 'trade hecho' };
    return { ok: true, msg: `trade con ${p.name} hecho: ${op.items.length} ítem(s)${op.zen ? ` y ${op.zen.toLocaleString('es-AR')} zen` : ''}` };
  }
  if (!f) {
    send(buildTradeCancel());
    trade = { ...trade!, state: 'cancelled', note: 'el otro no marcó OK en 60 s: cancelé' };
    return { ok: false, msg: trade.note! };
  }
  trade = { ...trade!, state: 'cancelled', note: `trade cancelado (resultado ${res})` };
  return { ok: false, msg: trade.note! };
}

function abortTrade(msg: string): CommandResult {
  send(buildTradeCancel());
  if (trade) trade = { ...trade, state: 'cancelled', note: msg };
  return { ok: false, msg: `${msg}; cancelé el trade` };
}

async function doTradeCancel(): Promise<CommandResult> {
  send(buildTradeCancel());
  if (trade && (trade.state === 'open' || trade.state === 'requested' || trade.state === 'incoming')) trade = { ...trade, state: 'cancelled', note: 'cancelado por orden del panel' };
  incoming = null;
  return { ok: true, msg: 'mandé cancelar el trade' };
}

async function doTradeAccept(op: Extract<CommerceOp, { kind: 'trade-accept' }>): Promise<CommandResult> {
  if (!incoming || Date.now() - incoming.at > TRADE_REQUEST_TTL_MS) return { ok: false, msg: 'no hay un pedido de trade vigente (vence a los 20 s)' };
  const id = incoming.id ?? op.player;
  if (incoming.id != null && incoming.id !== op.player) return { ok: false, msg: `el pedido es de ${incoming.name}, no del jugador ${op.player}` };
  send(buildTradeAnswer(id, true));
  trade = { with: incoming.name, withId: id, state: 'open', at: Date.now(), mine: [], theirs: [], mineZen: 0, theirsZen: 0, note: 'ventana abierta: revisá lo que pone el otro y marcá OK' };
  const name = incoming.name;
  incoming = null;
  return { ok: true, msg: `acepté el trade de ${name}; cuando termine de poner, revisá y mandá trade-ok` };
}

async function doTradeOk(): Promise<CommandResult> {
  if (!trade || trade.state !== 'open') return { ok: false, msg: 'no hay una ventana de trade abierta' };
  send(buildTradeButton(true));
  trade = { ...trade, note: 'marqué OK: espero que el otro también' };
  return { ok: true, msg: 'marqué OK en mi lado' };
}

export { commerceToken };
