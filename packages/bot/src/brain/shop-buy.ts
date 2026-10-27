/**
 * Compra de pociones de maná (directiva `comprarMana` = cantidad): va a Lorencia, habla con Amy (NPC 253, la vendedora de pociones, fuera de la
 * zona segura), compra las pociones azules más grandes que vende y las que alcance con el zen, y deja la directiva en 0 para volver a farmear.
 * Pedido de compra: C1 04 32 <casilla de la tienda>; el server responde C1 .. 32 con la casilla del inventario, o 0xFF si no pudo.
 */
import { sendToGS } from '../core/connection';
import { EventBus } from '../net/eventBus';
import { D, guardarDirectivas } from '../core/directivas';
import { itemInfo } from '../core/panel-logic';
import { buildCloseNpc, buildTalkNpc, decodeItemDetail } from '../core/protocol097';
import { monsterName, world, bot } from '../core/state';
import { trackEvent } from '../core/telemetry';
import { chebyshev, log, sleep, toBytes } from '../core/util';
import { decide } from '../core/journal';
import { travelTo, type Place } from './area';
import { warp } from './warps';
import { walkTowards, type LoopCtx } from './loop-ctx';

const AMY = 253;
const AMY_AT = { x: 127, y: 86 };
const TOWN: Place = { warp: warp(2), anchor: { x: 125, y: 120 }, radius: 14, name: 'Lorencia (pueblo)' };
/** Qué se compra, en orden: pociones de maná (azules) y de vida (rojas), las más grandes primero. */
const KINDS = [{ name: 'maná', nums: [6, 5, 4] }, { name: 'vida', nums: [3, 2, 1] }];
let kind = 0;
/** Cuántas pociones de cada tipo tiene en la bolsa (cada ítem lleva su pila en la durabilidad) más las que compró este viaje y todavía no ve. */
// Persiste entre recargas del cerebro y se pone en 0 al volver a entrar al juego (ahí el server manda la bolsa completa, compras incluidas).
const mem = ((globalThis as { __shopBought?: { at: number; n: number[] } }).__shopBought ??= { at: 0, n: [0, 0] });
const bought = new Proxy(mem.n, { get: (t, k) => { if (mem.at !== bot.inGameAt) { mem.at = bot.inGameAt; t.fill(0); } return Reflect.get(t, k); } });
const owned = (k: number) => [...world.inventory.values()]
  .filter((i) => i.group === 14 && KINDS[k]!.nums.includes(i.num))
  .reduce((a, i) => a + Math.max(1, i.raw ? decodeItemDetail(i.raw).durability : 1), 0) + bought[k]!;
const MAX_STEPS = 120;

let steps = 0;

const codeOf = (p: Uint8Array) => p[p[0] === 0xc2 || p[0] === 0xc4 ? 3 : 2];

/** Un paso de la compra. true = usó el tick; false = nada que hacer. */
export async function buyManaStep(ctx: LoopCtx): Promise<boolean> {
  ctx.target = null;
  if (await travelTo(TOWN)) return true;
  const amy = [...world.townNpcs.values()].find((n) => n.type === AMY);
  const me = { x: world.x, y: world.y };
  const to = amy ?? AMY_AT;
  if (!amy || chebyshev(to.x, to.y, me.x, me.y) > 2) {
    if (++steps > MAX_STEPS) return finish('no llegué hasta Amy');
    bot.doing = `yendo a comprar pociones de maná a Amy (${to.x},${to.y})`;
    ctx.phase = 'walk';
    await walkTowards(ctx, to.x, to.y);
    return true;
  }
  while (kind < KINDS.length && owned(kind) >= D.comprarMana) {
    decide(`Ya tengo ${owned(kind)} pociones de ${KINDS[kind]!.name}: no compro más.`, { kind: 'system' });
    kind++;
  }
  if (kind >= KINDS.length) return finish('ya tenía lo pedido');
  const K = KINDS[kind]!;
  bot.paused = false;
  bot.doing = `comprando pociones de ${K.name}`;
  const items: { slot: number; num: number }[] = [];
  const onList = (raw: unknown) => {
    const p = toBytes(raw);
    if (codeOf(p) !== 0x31 || p[0] !== 0xc2) return;
    for (let i = 0; i < p[5]; i++) {
      const o = 6 + i * 7;
      if (o + 7 > p.length) break;
      const it = decodeItemDetail(p.slice(o + 1, o + 7));
      if (it.group === 14 && K.nums.includes(it.num)) items.push({ slot: p[o], num: it.num });
    }
  };
  EventBus.on('StoreItemList' as any, onList);
  sendToGS(new DataView(buildTalkNpc(amy.id).buffer));
  for (let w = 0; w < 3000 && !items.length; w += 100) await sleep(100);
  EventBus.off('StoreItemList' as any, onList);
  const pick = K.nums.map((n) => items.find((i) => i.num === n)).find(Boolean);
  if (!pick) { sendToGS(new DataView(buildCloseNpc().buffer)); return finish(`Amy no mostró pociones de ${K.name}`); }

  const want = D.comprarMana - owned(kind), zen0 = bot.lastMoney;
  // La respuesta C1 04 32 FF llega aunque la compra se haga (el zen baja y la poción entra a la bolsa, que el bot no ve hasta el próximo login):
  // el criterio de compra hecha es que el zen baje, no esa respuesta.
  let got = 0, stalled = 0;
  while (got < want && stalled < 4) {
    const z0 = bot.lastMoney;
    sendToGS(new DataView(Uint8Array.from([0xc1, 0x04, 0x32, pick.slot]).buffer));
    await sleep(900);
    if (bot.lastMoney < z0) { got++; stalled = 0; } else { stalled++; await sleep(1500); }
  }
  const failed = 0;
  sendToGS(new DataView(buildCloseNpc().buffer));
  await sleep(500);
  const name = itemInfo(14, pick.num).name;
  bought[kind] = bought[kind]! + got;
  trackEvent('shop_buy', name, got, zen0 - bot.lastMoney, { item: name, asked: want });
  decide(`Compré ${got} ${name} (zen ${zen0} a ${bot.lastMoney}); se ven en la bolsa al volver a entrar.`, { kind: 'system' });
  if (++kind < KINDS.length) return true;
  return finish('listo, en pausa: decile adónde ir');
}

function finish(why: string): boolean {
  steps = 0;
  kind = 0;
  bot.paused = true; // terminó el trabajo: espera que el usuario le diga adónde ir
  decide(`Compra de pociones de maná terminada: ${why}.`, { kind: 'system', why });
  void guardarDirectivas({ comprarMana: 0 });
  D.comprarMana = 0;
  return false;
}
