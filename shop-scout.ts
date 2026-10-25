/**
 * Recorrido de lectura de tiendas (solo mira, no compra ni vende): camina por el pueblo, habla con cada NPC de comercio, anota lo que
 * vende (StoreItemList) en la base como evento `shop_list` y cierra la ventana. Se activa en caliente con la directiva `scoutShops`
 * (`POST /api/directivas {"scope":"capitan","set":{"scoutShops":true}}`); corre una vez y no repite hasta que la directiva pase a false.
 * Es para saber qué hay a la venta, dónde y a qué nivel (pociones, orbes de habilidad, equipo) antes de decidir qué comprar y qué recoger.
 */
import { sendToGS, waitFor } from './connection';
import { D } from './directivas';
import { itemInfo } from './panel-logic';
import { buildCloseNpc, buildTalkNpc, decodeItemDetail } from './protocol097';
import { monsterName, world, bot } from './state';
import { trackEvent } from './telemetry';
import { chebyshev, log, sleep, toBytes } from './util';
import { travelTo, type Place } from './place';
import { warp } from './warps';
import { walkTowards, type LoopCtx } from './loop-ctx';

/** NPC con tienda o servicio (tipos del cliente, data/monsters.json): se prueba hablar con cada uno que aparezca a la vista. */
const SHOP_TYPES = new Set([230, 242, 243, 244, 245, 246, 248, 250, 251, 253, 254, 255, 258]);
/** Lorencia (mapa 0): el centro del pueblo y puntos para recorrerlo y que los NPC entren en pantalla. */
const TOWN: Place = { kind: 'tier', warp: warp(2), anchor: { x: 125, y: 120 }, radius: 14, name: 'Lorencia (pueblo)' };
const PATROL = [{ x: 125, y: 122 }, { x: 140, y: 112 }, { x: 118, y: 108 }, { x: 122, y: 134 }, { x: 108, y: 126 }, { x: 146, y: 126 }, { x: 134, y: 100 }];
const MAX_STEPS_PER_NPC = 80;

let ran = false;
let st: { done: Set<number>; steps: Map<number, number>; patrol: number; patrolSteps: number; visited: string[] } | null = null;

type Shop = { slot: number; group: number; num: number; name: string; level: number; luck: boolean; option: number; exc: number };
function parseShop(p: Uint8Array): Shop[] {
  const out: Shop[] = [];
  for (let i = 0; i < p[5]; i++) {
    const o = 6 + i * 7;
    if (o + 7 > p.length) break;
    const it = decodeItemDetail(p.slice(o + 1, o + 7));
    out.push({ slot: p[o], group: it.group, num: it.num, name: itemInfo(it.group, it.num).name, level: it.level, luck: it.luck, option: it.option, exc: it.excCount });
  }
  return out;
}
const codeOf = (p: Uint8Array) => p[p[0] === 0xc2 || p[0] === 0xc4 ? 3 : 2];

/** Un paso del recorrido. true = usó el tick (el bucle sigue); false = nada que hacer (directiva apagada o recorrido terminado). */
export async function scoutShopsStep(ctx: LoopCtx): Promise<boolean> {
  if (!D.scoutShops) { st = null; ran = false; return false; }
  if (ran) return false;
  st ??= { done: new Set(), steps: new Map(), patrol: 0, patrolSteps: 0, visited: [] };
  ctx.target = null;
  if (await travelTo(TOWN)) return true;

  const npcs = [...world.npcs.values()].filter((n) => SHOP_TYPES.has(n.type) && !st!.done.has(n.id));
  const me = { x: world.x, y: world.y };
  npcs.sort((a, b) => chebyshev(a.x, a.y, me.x, me.y) - chebyshev(b.x, b.y, me.x, me.y));
  const npc = npcs[0];
  if (npc) {
    const steps = (st.steps.get(npc.id) ?? 0) + 1;
    st.steps.set(npc.id, steps);
    const d = chebyshev(npc.x, npc.y, me.x, me.y);
    if (d > 2 && steps <= MAX_STEPS_PER_NPC) {
      bot.doing = `recorrido de tiendas: yendo a ${monsterName(npc.type)} (${npc.x},${npc.y})`;
      ctx.phase = 'walk';
      await walkTowards(ctx, npc.x, npc.y);
      return true;
    }
    st.done.add(npc.id);
    if (d > 2) { log(`Tiendas: no llegué a ${monsterName(npc.type)} (${npc.x},${npc.y}); sigo.`); return true; }
    bot.doing = `recorrido de tiendas: hablando con ${monsterName(npc.type)}`;
    sendToGS(new DataView(buildTalkNpc(npc.id).buffer));
    let window: string | null = null;
    let items: Shop[] | null = null;
    for (let i = 0; i < 2 && !items; i++) {
      try {
        const raw = toBytes(await waitFor(['NpcWindowResponse', 'StoreItemList'], i === 0 ? 3000 : 1800));
        const code = codeOf(raw);
        if (code === 0x31 && raw[0] === 0xc2) items = parseShop(raw);
        else if (code === 0x30) window = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { break; }
    }
    const name = monsterName(npc.type);
    trackEvent('shop_list', name, items?.length ?? 0, npc.type, { npc: npc.type, map: world.map, x: npc.x, y: npc.y, window, items: items ?? [] });
    st.visited.push(`${name}: ${items ? `${items.length} ítems` : window ? 'ventana sin tienda' : 'sin respuesta'}`);
    log(`Tiendas: ${name} (${npc.x},${npc.y}) → ${items ? items.map((i) => i.name).join(', ') : window ? `ventana ${window}` : 'sin respuesta'}`);
    sendToGS(new DataView(buildCloseNpc().buffer));
    await sleep(700);
    return true;
  }

  // Nadie nuevo a la vista: se recorre el pueblo para que aparezcan.
  const wp = PATROL[st.patrol];
  if (!wp) {
    ran = true;
    trackEvent('shop_scout_done', st.visited.join(' | '), st.done.size, 0, { visited: st.visited });
    log(`Tiendas: recorrido terminado (${st.done.size} NPC). ${st.visited.join(' | ')}`);
    bot.doing = 'recorrido de tiendas: terminado';
    return false;
  }
  st.patrolSteps++;
  if (chebyshev(wp.x, wp.y, me.x, me.y) <= 3 || st.patrolSteps > 60) { st.patrol++; st.patrolSteps = 0; return true; }
  bot.doing = `recorrido de tiendas: buscando NPC (${wp.x},${wp.y})`;
  ctx.phase = 'walk';
  await walkTowards(ctx, wp.x, wp.y);
  return true;
}
