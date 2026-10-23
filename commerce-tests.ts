/**
 * Tests offline del comercio: parsers y armadores de bytes (ítems de 5 y 6 bytes), confirmación,
 * reglas de "qué no se vende", planificador de ventas y resúmenes. Sin red: nada se manda a ningún server.
 *
 *   bun run commerce-tests.ts
 */
import {
  buildBuyNpc, buildSellNpc, buildShopBuy, buildShopClose, buildShopCloseDialog, buildShopListRequest, buildShopOpen, buildShopSetPrice,
  buildTradeAnswer, buildTradeButton, buildTradeCancel, buildTradeRequest, buildTradeZen, commerceToken, firstFit, hasValidConfirm, isBuyFailed,
  parseNpcWindow, parsePlayerShopList, parsePlayerShops, parseSellResult, parseShopOpenResult, parseStoreList, parseTradeAnswer, parseTradeFinished,
  parseTradeItemAdded, parseTradeMoney, parseTradeRequest,
} from './commerce-packets';
import { compareToWorn, neverSell, neverShop, opSummary, planSales } from './commerce-plan';
import { decodeItemDetail } from './protocol097';
import type { CommerceDraft, CommerceOp } from './panel-protocol';
import type { Fighter } from './item-rules';
import type { PlanItem } from './equip-plan';
import hume from './fixtures/hume-vault.json';
import { runCommerce, runShops, shopsView } from './commerce';
import { bot, world } from './state';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const same = (a: Uint8Array, b: number[]) => Array.from(a).join() === b.join();

/** Codifica un ítem en el formato de 5/6 bytes del 0.97d (inverso de decodeItem5/decodeItemDetail). */
function enc(group: number, num: number, o: { level?: number; luck?: boolean; skill?: boolean; opt?: number; exc?: number; ancient?: number; harmony?: number; bytes?: 5 | 6 } = {}): Uint8Array {
  const r = (group << 5) | (num & 31);
  const e = new Uint8Array(o.bytes ?? 6);
  e[0] = r & 0xff;
  e[1] = ((o.level ?? 0) << 3) | (o.skill ? 0x80 : 0) | (o.luck ? 0x04 : 0) | ((o.opt ?? 0) & 3);
  e[2] = 255;
  e[3] = ((r >> 8) << 7) | ((o.exc ?? 0) & 0x3f);
  e[4] = ((num & 32) ? 0x10 : 0) | ((o.ancient ?? 0) & 0x0f);
  if (e.length === 6) e[5] = o.harmony ?? 0;
  return e;
}
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const pad = (s: string, n: number) => [...Buffer.from(s, 'latin1'), ...new Array(n - s.length).fill(0)];

// --- el codificador de los tests es el inverso del decodificador del bot -------------
{
  const d = decodeItemDetail(enc(8, 21, { level: 9, luck: true, opt: 2, exc: 0b101100, ancient: 0 }));
  ok('enc/decode: Great Dragon Armor +9 luck +8 exc×3', d.group === 8 && d.num === 21 && d.level === 9 && d.luck && d.option === 2 && d.excCount === 3 && d.excellent, d);
  ok('enc/decode: número ≥ 32 (bit 5 en e[4] & 0x10)', decodeItemDetail(enc(14, 33)).num === 33 && decodeItemDetail(enc(14, 33)).group === 14);
}

// --- catálogo de un NPC (StoreItemList: mismo formato que el inventario, SIN precios) ----
{
  const items = [enc(14, 3), enc(14, 2), enc(0, 0, { level: 3 })];
  const body = items.flatMap((it, i) => [i, ...it]);
  const pkt = Uint8Array.from([0xc2, 0, 6 + body.length, 0x31, 0, items.length, ...body]);
  pkt[1] = (pkt.length >> 8) & 0xff;
  pkt[2] = pkt.length & 0xff;
  const r = parseStoreList(pkt);
  ok('StoreItemList de 6 bytes: 3 ítems con casilla y detalle', r?.items.length === 3 && r.items[1].slot === 1 && r.items[1].group === 14 && r.items[1].num === 2 && r.items[2].level === 3, r?.items.map((x) => [x.slot, x.group, x.num]));
  ok('el NPC no manda precio: price null', r?.items.every((x) => x.price === null) === true);
  ok('los bytes crudos quedan (6 por ítem) para mover/vender', r?.items[0].raw.length === 6);
  const b5 = [enc(14, 3, { bytes: 5 }), enc(14, 1, { bytes: 5 })].flatMap((it, i) => [i, ...it]);
  const p5 = Uint8Array.from([0xc2, 0, 6 + b5.length, 0x31, 0, 2, ...b5]);
  p5[2] = p5.length;
  ok('también acepta ítems de 5 bytes', parseStoreList(p5)?.items.length === 2);
  ok('largo que no cierra → null', parseStoreList(pkt.subarray(0, pkt.length - 2)) === null);
  ok('no es un StoreItemList (código 0x30) → null', parseStoreList(Uint8Array.from([0xc2, 0, 6, 0x30, 0, 0])) === null);
  ok('NpcWindowResponse: 0/1 mercader, 2 baúl, 3 máquina', parseNpcWindow(Uint8Array.from([0xc3, 4, 0x30, 0])) === 'mercader' && parseNpcWindow(Uint8Array.from([0xc3, 4, 0x30, 1])) === 'mercader' && parseNpcWindow(Uint8Array.from([0xc3, 4, 0x30, 2])) === 'baul' && parseNpcWindow(Uint8Array.from([0xc3, 4, 0x30, 3])) === 'maquina' && parseNpcWindow(Uint8Array.from([0xc3, 4, 0x30, 9])) === 'otro');
}

// --- comprar / vender a un NPC (packets generados de OpenMU; shop.ts los usaba igual) -------------
{
  ok('comprar: C3 04 32 <casilla>', same(buildBuyNpc(5), [0xc3, 4, 0x32, 5]));
  ok('vender: C3 04 33 <casilla>', same(buildSellNpc(20), [0xc3, 4, 0x33, 20]));
  ok('resultado de venta: ok y zen en LITTLE endian (trampa de AGENTS.md)', JSON.stringify(parseSellResult(Uint8Array.from([0xc3, 8, 0x33, 1, 0x40, 0x42, 0x0f, 0x00]))) === JSON.stringify({ ok: true, zen: 1_000_000 }));
  ok('resultado de venta fallida', parseSellResult(Uint8Array.from([0xc3, 8, 0x33, 0, 0, 0, 0, 0]))?.ok === false);
  ok('NpcItemBuyFailed es C1 04 32 FF', isBuyFailed(Uint8Array.from([0xc1, 4, 0x32, 0xff])) && !isBuyFailed(Uint8Array.from([0xc1, 10, 0x32, 3, 1, 2, 3, 4, 5, 6])));
}

// --- tienda personal (SIN VERIFICAR EN VIVO): armadores con bytes exactos ----------------------
{
  ok('pedir lista: C1 10 3F 05 <id BE> <nombre[10]>', same(buildShopListRequest(0x0123, 'Melu'), [0xc1, 0x10, 0x3f, 5, 1, 0x23, ...pad('Melu', 10)]));
  ok('comprar: C1 11 3F 06 <id> <nombre> <casilla>', same(buildShopBuy(300, 'Zamu', 7), [0xc1, 0x11, 0x3f, 6, ...u16(300), ...pad('Zamu', 10), 7]));
  ok('cerrar diálogo: C1 10 3F 07', same(buildShopCloseDialog(300, 'Zamu'), [0xc1, 0x10, 0x3f, 7, ...u16(300), ...pad('Zamu', 10)]));
  ok('precio: C1 09 3F 01 <casilla> <u32 BE>', same(buildShopSetPrice(76, 1_500_000), [0xc1, 9, 0x3f, 1, 76, ...u32(1_500_000)]));
  ok('abrir mi tienda: C1 28 3F 02 <cartel[36]>', same(buildShopOpen('Cajas baratas'), [0xc1, 0x28, 0x3f, 2, ...pad('Cajas baratas', 36)]) && buildShopOpen('x').length === 40);
  ok('cerrar mi tienda: C1 04 3F 03', same(buildShopClose(), [0xc1, 4, 0x3f, 3]));
  ok('cartel largo se corta en 36', buildShopOpen('x'.repeat(50)).length === 40);
}

// --- lista de la tienda de otro jugador: layouts A y C, precios BE ----------------------------
{
  const mk = (head: number[], items: { slot: number; it: Uint8Array; price: number }[]) => {
    const body = items.flatMap((x) => [x.slot, ...x.it, ...u32(x.price)]);
    const p = [0xc2, 0, 0, 0x3f, 0x05, ...head, ...body];
    p[1] = (p.length >> 8) & 0xff;
    p[2] = p.length & 0xff;
    return Uint8Array.from(p);
  };
  const two = [{ slot: 0, it: enc(14, 11, { level: 5 }), price: 5_000_000 }, { slot: 3, it: enc(8, 21, { level: 9, luck: true, exc: 0b111 }), price: 0 }];
  const A = mk([2, 1, ...u16(0x0133), ...pad('Zamu', 10), ...pad('Cajas y sets', 36)], two);
  const r = parsePlayerShopList(A);
  ok('tienda (layout A): jugador, cartel y 2 ítems', r?.count === 2 && r.playerId === 0x133 && r.name === 'Zamu' && r.title === 'Cajas y sets' && r.items.length === 2, r);
  ok('tienda: precio u32 BE por ítem, 0 = de muestra', r?.items[0].price === 5_000_000 && r.items[1].price === 0);
  ok('tienda: ítems con detalle (caja +5, set con luck y 3 exc)', r?.items[0].group === 14 && r.items[0].level === 5 && r.items[1].luck && r.items[1].excCount === 3);
  const B = mk([1, 2, ...u16(0x0133), ...pad('Zamu', 10), ...pad('Cajas y sets', 36)], two);
  ok('tienda (layout B: resultado antes de la cuenta)', parsePlayerShopList(B)?.items.length === 2);
  const C = mk([2, 1, ...u16(0x0133), ...pad('Zamu', 10)], two);
  const rc = parsePlayerShopList(C);
  ok('tienda (layout C sin cartel)', rc?.items.length === 2 && rc.title === '' && rc.name === 'Zamu');
  ok('tienda con ítems de 5 bytes', parsePlayerShopList(mk([1, 1, ...u16(7), ...pad('Ana', 10), ...pad('t', 36)], [{ slot: 1, it: enc(14, 3, { bytes: 5 }), price: 100 }]))?.items[0].raw.length === 5);
  ok('largo que no cierra → null (no inventa)', parsePlayerShopList(A.subarray(0, A.length - 1)) === null);
  ok('vacía: cuenta 0', parsePlayerShopList(mk([0, 1, ...u16(7), ...pad('Ana', 10), ...pad('t', 36)], []))?.items.length === 0);
  const shops = Uint8Array.from([0xc2, 0, 6 + 76, 0x3f, 0x00, 2, ...u16(0x0133), ...pad('Cajas', 36), ...u16(0x0140), ...pad('Sets', 36)]);
  shops[2] = shops.length;
  const ps = parsePlayerShops(shops);
  ok('PlayerShops (38 por tienda): ids y carteles', ps?.length === 2 && ps[0].id === 0x133 && ps[1].title === 'Sets', ps);
  ok('apertura exitosa: C1 05 3F 02 01', parseShopOpenResult(Uint8Array.from([0xc1, 5, 0x3f, 2, 1])) === true && parseShopOpenResult(Uint8Array.from([0xc1, 5, 0x3f, 2, 0])) === false);
}

// --- trade (SIN VERIFICAR EN VIVO) ------------------------------------------------------------
{
  ok('pedir trade: C1 05 36 <id BE>', same(buildTradeRequest(0x0102), [0xc1, 5, 0x36, 1, 2]));
  ok('responder: C1 06 37 <1/0> <id>', same(buildTradeAnswer(0x0102, true), [0xc1, 6, 0x37, 1, 1, 2]) && buildTradeAnswer(1, false)[3] === 0);
  ok('zen: C1 07 3A <u32 BE>', same(buildTradeZen(1_000_000), [0xc1, 7, 0x3a, ...u32(1_000_000)]));
  ok('botón OK: C1 04 3C 01 / 00', same(buildTradeButton(true), [0xc1, 4, 0x3c, 1]) && same(buildTradeButton(false), [0xc1, 4, 0x3c, 0]));
  ok('cancelar: C1 03 3D', same(buildTradeCancel(), [0xc1, 3, 0x3d]));
  ok('pedido entrante: nombre', parseTradeRequest(Uint8Array.from([0xc3, 13, 0x36, ...pad('Hume', 10)])) === 'Hume');
  ok('respuesta: acepta / rechaza', parseTradeAnswer(Uint8Array.from([0xc1, 6, 0x37, 1])) === true && parseTradeAnswer(Uint8Array.from([0xc1, 6, 0x37, 0])) === false);
  const added = parseTradeItemAdded(Uint8Array.from([0xc1, 10, 0x39, 4, ...enc(14, 11, { level: 5 })]));
  ok('ítem agregado por el otro: casilla 4, caja +5', added?.slot === 4 && added.group === 14 && added.num === 11 && added.level === 5, added);
  ok('zen del otro (u32 BE al final)', parseTradeMoney(Uint8Array.from([0xc1, 8, 0x3b, 0, ...u32(2_500_000)])) === 2_500_000);
  ok('trade terminado: resultado', parseTradeFinished(Uint8Array.from([0xc1, 4, 0x3d, 1])) === 1);
  ok('ventana de 8×4: firstFit respeta tamaños', firstFit([{ pos: 0, w: 2, h: 3 }], 1, 1, 8, 4) === 2 && firstFit([], 2, 2, 8, 4) === 0 && firstFit(Array.from({ length: 4 }, (_, i) => ({ pos: i * 8, w: 8, h: 1 })), 1, 1, 8, 4) === null);
}

// --- confirmación: el token incluye todo lo que el usuario vio ------------------------------
{
  const draft: CommerceDraft = { kind: 'sell', npc: 253, items: [{ slot: 14, group: 7, num: 1, level: 0 }] };
  const op: CommerceOp = { ...draft, confirm: commerceToken(draft) };
  ok('con el token correcto pasa', hasValidConfirm(op));
  ok('sin token / token de otra orden → no', !hasValidConfirm({ ...op, confirm: '' }) && !hasValidConfirm({ ...op, confirm: commerceToken({ kind: 'sell', npc: 253, items: [{ slot: 15, group: 7, num: 1, level: 0 }] }) }));
  ok('cambiar un campo después de confirmar invalida', !hasValidConfirm({ ...op, npc: 254 }) && !hasValidConfirm({ ...op, items: [{ slot: 14, group: 7, num: 1, level: 1 }] }));
  const buy: CommerceDraft = { kind: 'buy', npc: 253, slot: 2, qty: 5, maxZen: 20_000 };
  ok('comprar: cambiar cantidad o tope invalida', hasValidConfirm({ ...buy, confirm: commerceToken(buy) }) && !hasValidConfirm({ ...buy, qty: 6, confirm: commerceToken(buy) }) && !hasValidConfirm({ ...buy, maxZen: 99_999, confirm: commerceToken(buy) }));
  const sb: CommerceDraft = { kind: 'shop-buy', player: 300, slot: 1, price: 5_000_000 };
  ok('tienda: cambiar el precio invalida', !hasValidConfirm({ ...sb, price: 1, confirm: commerceToken(sb) }));
  ok('cerrar tienda y cancelar trade no necesitan confirm', hasValidConfirm({ kind: 'shop-close' }) && hasValidConfirm({ kind: 'trade-cancel' }));
}

// --- qué NUNCA se vende ------------------------------------------------------------------------
{
  const it = (group: number, num: number, o: Partial<PlanItem> = {}): PlanItem => ({ group, num, level: 0, slot: 20, name: `${group}/${num}`, ...o });
  ok('caja de Kundun (14/11) nunca', neverSell(it(14, 11, { level: 5 }))?.includes('caja') === true);
  ok('Cristales (14/31) nunca', neverSell(it(14, 31))?.includes('Cristales') === true);
  ok('talismanes 14/7, 14/12, 14/20 nunca', [7, 12, 20].every((n) => neverSell(it(14, n)) !== null));
  ok('joyas: Bless, Soul, Life, Creation, Chaos, Armonía, Gemstone nunca', [13, 14, 16, 22, 41, 42, 43, 44].every((n) => neverSell(it(14, n)) !== null) && neverSell(it(12, 15)) !== null);
  ok('lo puesto (casillas 0-11) nunca', neverSell(it(8, 21, { slot: 3 }))?.includes('puesto') === true);
  ok('armonía, excelentes, ancient y +13 nunca por orden suelta', neverSell(it(8, 0, { harmony: { option: 1, level: 1 } })) !== null && neverSell(it(8, 0, { excellent: true })) !== null && neverSell(it(8, 0, { ancient: 5 })) !== null && neverSell(it(8, 0, { level: 13 })) !== null);
  ok('alas y mascotas (12/*, 13/*) no', neverSell(it(12, 5)) !== null && neverSell(it(13, 3)) !== null);
  ok('pociones no (consumibles)', neverSell(it(14, 3)) !== null);
  ok('una armadura común +0 sí se puede vender', neverSell(it(8, 0)) === null && neverSell(it(0, 1)) === null);
  ok('tienda personal: caja y Cristales no, excelente sí', neverShop(it(14, 11)) !== null && neverShop(it(14, 31)) !== null && neverShop(it(8, 21, { excellent: true })) === null);
}

// --- planificador: PROPONE, nunca ejecuta ---------------------------------------------------
const bk: Fighter = { cls: 'dk', evolved: true, level: 400, stats: { str: 65535, agi: 65535, vit: 65535, ene: 65535 } };
{
  const bagItem = (slot: number, group: number, num: number, o: Partial<PlanItem> = {}): PlanItem => ({ group, num, level: 0, slot, name: `${group}/${num}`, ...o });
  const bag: PlanItem[] = [
    bagItem(12, 8, 0, { name: 'Bronze Armor' }),                        // basura común
    bagItem(13, 14, 11, { name: 'Box of Luck', level: 5 }),             // caja: se guarda
    bagItem(14, 14, 31, { name: 'Jewel of Guardian' }),                 // Cristales: se guardan
    bagItem(15, 14, 14, { name: 'Jewel of Soul' }),                     // joya: no
    bagItem(16, 8, 21, { name: 'Great Dragon Armor', level: 9, luck: true, option: 4, excFlags: 44, excCount: 3, excellent: true }), // mejora lo puesto
    bagItem(17, 8, 23, { name: 'Hurricane Armor', level: 7, excFlags: 12, excCount: 2, excellent: true }),                          // MG: no sirve; vale Cristales
    bagItem(18, 7, 9, { name: 'Plate Helm' }),                          // basura
  ];
  const worn: PlanItem[] = [{ group: 8, num: 9, level: 0, slot: 3, name: 'Plate Armor' }, { group: 7, num: 9, level: 0, slot: 2, name: 'Plate Helm' }];
  const plan = planSales({ fighter: bk, equipped: worn, bag, vendors: [{ id: 253, name: 'Amy, Potion Girl', dist: 4 }, { id: 246, name: 'Zienna', dist: 9 }], seenSellPrices: { '8/0/0': 1200 } });
  ok('el plan nunca es ejecutable y pide confirmación', plan.executable === false && plan.needsConfirmation === true);
  ok('vende la basura común (Bronze Armor y Plate Helm)', plan.sell.map((s) => s.slot).join() === '12,18', plan.sell);
  ok('NO vende cajas, Cristales ni joyas: van a "guardar"', [13, 14, 15].every((s) => plan.keep.some((k) => k.slot === s)) && ![13, 14, 15].some((s) => plan.sell.some((x) => x.slot === s)));
  ok('la pieza que mejora el set se guarda para equipar', plan.keep.some((k) => k.slot === 16 && k.why.includes('mejora')), plan.keep);
  ok('el excelente de otra clase va a cristalizar con su valor en Cristales', plan.crystallize.some((c) => c.slot === 17 && c.crystals > 0), plan.crystallize);
  ok('y queda como candidato de tienda (precio lo fija el usuario)', plan.shop.some((c) => c.slot === 17) || plan.crystallize[0].crystals < 8, plan.shop);
  ok('dónde: el vendedor más cercano', plan.venue?.id === 253);
  ok('zen: solo si se conoce el precio de todas (observado: 1 de 2 → null)', plan.totalZen === null && plan.sell[0].zen === 1200 && plan.sell[1].zen === null);
  ok('resumen legible', plan.summary.includes('2 para vender') && plan.summary.includes('cristalizar'), plan.summary);
  const alone = planSales({ fighter: bk, equipped: worn, bag: [bagItem(12, 8, 0)] });
  ok('sin vendedor a la vista avisa', alone.venue === null && alone.notes.some((n) => n.includes('NPC vendedor')));
  const noClass = planSales({ fighter: null, equipped: [], bag });
  ok('sin clase conocida no propone vender nada', noClass.sell.length === 0 && noClass.keep.length === bag.length);
  // El baúl real de Hume (fixtures/hume-vault.json): bolsa con joyas, Cristales, pociones y 9 cajas.
  const real = planSales({
    fighter: bk,
    equipped: (hume.equipped as unknown as PlanItem[]),
    bag: (hume.bag as unknown as PlanItem[]),
  });
  ok('bolsa real de Hume: no vende nada (9 cajas, Cristales, joyas y una poción)', real.sell.length === 0 && real.keep.length === hume.bag.length, real.summary);
}

// --- comparar con lo puesto y resumen de la orden -------------------------------------------
{
  const gd = { group: 8, num: 21, level: 9, luck: true, option: 4, excFlags: 44, excCount: 3, excellent: true, slot: 0 };
  const cmp = compareToWorn(gd, [{ group: 8, num: 9, level: 0, slot: 3, name: 'Plate Armor' }]);
  ok('compara contra la armadura puesta', cmp.slotName === 'armadura' && cmp.worn === 'Plate Armor' && cmp.delta > 100 && cmp.crystals !== null, cmp);
  ok('un arma no tiene casilla comparable', compareToWorn({ group: 0, num: 1, level: 0 }, []).slotName === null);
  const names = (slot: number) => `ítem${slot}`;
  const buy = opSummary({ kind: 'buy', npc: 253, slot: 2, qty: 5, maxZen: 20_000 }, { name: names, price: () => 3000 });
  ok('resumen de compra: ítem, cantidad y total con precio conocido', buy.lines[0].startsWith('5 × ítem2') && buy.total.includes('15.000') && buy.total.includes('20.000'), buy);
  const buy2 = opSummary({ kind: 'buy', npc: 253, slot: 2, qty: 5, maxZen: 20_000 }, { name: names });
  ok('sin precio publicado el total es el tope', buy2.total.includes('hasta') && buy2.lines.some((l) => l.includes('no publica')), buy2);
  const open = opSummary({ kind: 'shop-open', title: 'Sets', items: [{ slot: 12, group: 7, num: 1, level: 0, price: 1_000_000 }, { slot: 13, group: 7, num: 2, level: 0, price: 0 }] }, { name: names });
  ok('abrir tienda: total si se vende todo y precio 0 = muestra', open.total.includes('1.000.000') && open.lines[1].includes('muestra'), open);
  const sb = opSummary({ kind: 'shop-buy', player: 5, slot: 1, price: 9_000_000 }, { name: names, zen: 1000 });
  ok('comprar en tienda: avisa si no alcanza el zen', sb.lines.some((l) => l.includes('no alcanza')) && sb.total.includes('9.000.000'), sb);
  const tr = opSummary({ kind: 'trade', player: 5, items: [{ slot: 12, group: 14, num: 31, level: 0 }], zen: 0 }, { name: names });
  ok('trade: ítems y que el otro tiene que aceptar', tr.total.includes('1 ítem') && tr.total.includes('aceptar'), tr);
}

// --- puertas de las órdenes (sin socket: nada sale a ningún server) ---------------------------------
{
  const refOf = (slot: number, it: Uint8Array) => ({ slot, ...(() => { const d = decodeItemDetail(it); return { group: d.group, num: d.num, level: d.level }; })() });
  const boxRaw = enc(14, 11, { level: 5 });
  const junkRaw = enc(8, 0);
  const saved = { in: bot.inGameAt, paused: bot.paused, res: bot.resetting };
  world.inventory.set(16, { slot: 16, group: 14, num: 11, level: 5, raw: boxRaw });
  world.inventory.set(12, { slot: 12, group: 8, num: 0, level: 0, raw: junkRaw });
  const sell = (items: ReturnType<typeof refOf>[]): CommerceOp => { const d: CommerceDraft = { kind: 'sell', npc: 253, items }; return { ...d, confirm: commerceToken(d) } as CommerceOp; };
  bot.inGameAt = 0; bot.paused = false;
  ok('fuera del mundo: rechaza', (await runCommerce(sell([refOf(12, junkRaw)]))).ok === false);
  bot.inGameAt = Date.now(); bot.resetting = false;
  const r1 = await runCommerce(sell([refOf(12, junkRaw)]));
  ok('sin pausa: pide pausar primero', !r1.ok && r1.msg.includes('pausame'), r1);
  bot.paused = true;
  const r2 = await runCommerce({ ...sell([refOf(12, junkRaw)]), confirm: 'dale' } as CommerceOp);
  ok('sin la confirmación del resumen: no hace nada', !r2.ok && r2.msg.includes('confirmación'), r2);
  const r3 = await runCommerce(sell([refOf(16, boxRaw)]));
  ok('una caja no se vende ni con confirmación', !r3.ok && r3.msg.includes('caja'), r3);
  const r4 = await runCommerce(sell([{ slot: 12, group: 7, num: 1, level: 0 }]));
  ok('si la casilla ya no tiene ese ítem, rechaza', !r4.ok && r4.msg.includes('ya no tiene'), r4);
  const r5 = await runCommerce(sell([refOf(12, junkRaw)]));
  ok('NPC que no está a la vista: no vende', !r5.ok && r5.msg.includes('no está a la vista'), r5);
  const r6 = await runShops({ cmd: 'shops', npc: 253 });
  ok('shops con un NPC lejano o ausente: no habla', !r6.ok, r6);
  const r7 = await runCommerce({ kind: 'shop-open', title: 'Cajas', items: [{ ...refOf(16, boxRaw), price: 1 }], confirm: commerceToken({ kind: 'shop-open', title: 'Cajas', items: [{ ...refOf(16, boxRaw), price: 1 }] }) });
  ok('tampoco abre una tienda con una caja', !r7.ok && r7.msg.includes('caja'), r7);
  ok('shopsView arma el estado una vez que se usó el comercio', shopsView(Date.now())?.plan?.executable === false);
  world.inventory.delete(16); world.inventory.delete(12);
  bot.inGameAt = saved.in; bot.paused = saved.paused; bot.resetting = saved.res;
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE COMERCIO PASARON' : `\n${fails} TEST(S) DE COMERCIO FALLARON`);
process.exit(fails ? 1 : 0);
