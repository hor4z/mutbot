/**
 * Loot: los drops en scope (ItemsDropped / ItemDropRemoved) y el paso de ir a levantar uno valioso
 * (cajas, joyas, excelentes, guantes 10/1). El zen y el equipo común no se levantan.
 */
import { MoneyDropped075Packet } from '../packets';
import { WALK_PACE_MS } from '../core/config';
import { step, sendPickup } from '../core/actions';
import { itemInfo } from '../core/panel-logic';
import { classFamily, lootReason, pickLoot, type DropInfo, type LootRules } from './farming';
import { itemRow } from '../core/gamedata';
import { decide, journal } from '../core/journal';
import { EventBus } from '../net/eventBus';
import { parseItemDropRemoved, parseItemsDropped, parseServerMessage } from '../core/protocol097';
import { drops, lootState, type ScopedDrop } from '../core/loot-state';
import { world } from '../core/state';
import { trackEvent } from '../core/telemetry';
import { chebyshev, directionTowards, humanPace, log, sleep, toBytes } from '../core/util';



// Bug real encontrado jugando (cuenta melu): 'ItemsDropped' (C2/0x20) y
// 'MoneyDropped075' (mismo código, confirmado en ClientToServerPackets.xml de
// OpenMU) comparten exactamente el mismo code/header, igual que el caso ya
// documentado de SkillAdded. createSocket resuelve por code sin SubCode, así
// que SIEMPRE llega como 'ItemsDropped' (el único generado para 0x20 sin
// SubCode), aunque el payload real sea un drop de dinero — de 14 bytes fijos,
// no una lista de ítems de 16 bytes c/u. Intentar leer el ItemData de 12
// bytes de un drop de dinero leía fuera de rango y tiraba abajo el proceso
// entero. Se distingue por tamaño: si el buffer no matchea
// 5 + ItemCount*16 (layout de ItemsDropped), se intenta como
// MoneyDropped075 (14 bytes fijos, ver MoneyDropped075Packet).
function parseDropsPacket(raw: any): ScopedDrop[] {
  const bytes = toBytes(raw);
  // Ítems en 5 bytes (o 12, los de zen): parseItemsDropped de protocol097.ts.
  const items = parseItemsDropped(bytes);
  if (items) return items.map((it) => ({ ...it, isMoney: it.group === 14 && it.num === 15 }));
  if (bytes.length === 14) {
    const p = new MoneyDropped075Packet(raw);
    return [{ id: p.Id & 0x7fff, x: p.PositionX, y: p.PositionY, group: p.MoneyGroup, num: p.MoneyNumber, isMoney: true, amount: p.Amount }];
  }
  log(`AVISO: packet de drop con layout inesperado (${bytes.length} bytes, ItemCount=${bytes[4]}), lo ignoro.`);
  return [];
}

// Devuelve el handler para desuscribir, así el loop no lo deja colgado.
export function watchDrops(): () => void {
  const onDrop = (raw: any) => {
    try {
      for (const d of parseDropsPacket(raw)) drops.set(d.id, { ...d, seenAt: Date.now() });
    } catch (e) {
      log(`AVISO: no pude parsear un drop, lo ignoro: ${(e as Error).message}`);
    }
  };
  // Drop que levantó otro o que expiró: sacarlo, si no se iba a buscarlo.
  const onRemoved = (raw: any) => {
    for (const id of parseItemDropRemoved(toBytes(raw))) drops.delete(id);
  };
  // Lo que se estaba levantando entró al inventario (o es zen, FE): ya no está en el piso.
  const onAdded = (raw: any) => {
    const b = toBytes(raw);
    const lt = lootState.looting;
    if (b[3] < 0xfe && lt?.pickAt != null) { // FE zen, FF no se pudo
      const d = drops.get(lt.id) ?? lt.drop;
      if (d) trackEvent('loot_ok', `${d.group}/${d.num}`, d.group, d.num, { x: d.x, y: d.y, ms: Date.now() - lt.since });
      drops.delete(lt.id);
    }
  };
  const onServerMessage = (raw: any) => {
    const line = parseServerMessage(toBytes(raw));
    const lt = lootState.looting;
    if (!line || !lt || lt.pickAt == null || !/doesn't belong to you/i.test(line.text)) return;
    const d = drops.get(lt.id) ?? lt.drop;
    foreignUntil.set(lt.id, Date.now() + FOREIGN_RETRY_MS);
    if (d) trackEvent('loot_foreign', `${d.group}/${d.num}`, d.group, d.num, { x: d.x, y: d.y });
    log(`El drop Id=${lt.id} es de otro: lo dejo y vuelvo a probar en ${FOREIGN_RETRY_MS / 1000} s si sigue ahí.`);
    lootState.looting = null;
  };
  EventBus.on('ItemsDropped', onDrop);
  EventBus.on('ItemDropRemoved', onRemoved);
  EventBus.on('ItemAddedToInventory', onAdded);
  EventBus.on('ServerMessage', onServerMessage);
  return () => {
    EventBus.off('ItemsDropped', onDrop);
    EventBus.off('ItemDropRemoved', onRemoved);
    EventBus.off('ItemAddedToInventory', onAdded);
    EventBus.off('ServerMessage', onServerMessage);
  };
}

// Qué se levanta (farming.ts, lootReason): zen, joyas, excelentes y lo que mejora el equipo puesto; todo lo demás se deja. Se camina hasta el
// drop (a <= 12 tiles) y se levanta a <= 1; mientras tanto no se pelea. Un drop al que no se llega en LOOT_TIMEOUT_MS se olvida.
const LOOT_RADIUS = 12;
const LOOT_TIMEOUT_MS = 8000;
// Desde 2026-10-18 las cajas, cristales y excelentes no se pueden levantar los primeros 2 s y, si varios
// los piden, se sortean: un solo pedido al caer se perdía. Se insiste cada PICKUP_RETRY_MS mientras siga
// en el piso (ItemDropRemoved lo saca de `drops`); una caja (queda 3 min) hasta LOOT_BOX_TIMEOUT_MS.
const PICKUP_RETRY_MS = 600;
// "This item doesn't belong to you" (la caja es del que más daño hizo): soltarla ya y no volver a pedirla
// hasta FOREIGN_RETRY_MS después (por si queda libre). Insistir 20 s en plena invasión era perder dorados.
const FOREIGN_RETRY_MS = 10_000;
const foreignUntil = new Map<number, number>();
/** Casillas libres de la bolsa (64 de 8×8; las 12 primeras son el equipo puesto). */
export function bagRoom(): number {
  let used = 0;
  for (const it of world.inventory.values()) if (it.slot >= 12 && it.slot < 76) { const i = itemInfo(it.group, it.num); used += i.w * i.h; }
  return 64 - used;
}

// --- ¿Mejora lo que ya tenemos? -----------------------------------------------------------------------------------------------------------
/** Máscara de clase del personaje (gamedata.ts `cls`): 1 caballero, 2 mago, 4 elfo, 8 gladiador. */
const CLASS_MASK = { knight: 1, wizard: 2, elf: 4, gladiator: 8 } as const;
/** Cuánto vale un ítem para comparar: lo mayor entre defensa, daño y poder mágico, más 3 por cada +1 de nivel y un 20 % si es excelente. */
const scoreOf = (group: number, num: number, level = 0, excellent = false): number => {
  const r = itemRow(group, num);
  if (!r) return 0;
  const base = Math.max(r.def, r.dmg, r.mag);
  return base + level * 3 + (excellent ? base * 0.2 : 0);
};
/** El equipo puesto en un slot (0 a 11): los slots de anillo (10 y 11) se comparan con el peor de los dos. */
const wornIn = (slot: number) => (slot === 10 || slot === 11 ? [10, 11] : [slot]).map((s) => world.inventory.get(s));

/** ¿El drop es equipo que podemos usar y que supera lo que llevamos puesto en ese slot (por más de un 5 %)? */
function isUpgrade(d: DropInfo): boolean {
  const r = itemRow(d.group, d.num);
  if (!r || r.equipSlot < 0) return false;
  const family = classFamily(world.classId);
  if (!family || !(r.cls & CLASS_MASK[family])) return false;
  if (r.reqLevel > world.level) return false;
  const mine = scoreOf(d.group, d.num, d.level ?? 0, !!d.excellent);
  if (mine <= 0) return false; // sin defensa, daño ni poder (anillos, colgantes, mascotas): solo cuentan si son excelentes
  const worn = wornIn(r.equipSlot);
  if (worn.some((w) => !w)) return true; // un slot libre: cualquier equipo que podamos usar mejora
  return worn.every((w) => mine > scoreOf(w!.group, w!.num, w!.level ?? 0, !!w!.excellent) * 1.05);
}
/** ¿Cabe en la bolsa? (aproximado por casillas: no mira la forma del hueco). Sin lugar solo se levanta el zen. */
const hasRoom = (d: DropInfo) => { const i = itemInfo(d.group, d.num); return bagRoom() >= i.w * i.h; };
export const RULES: LootRules = { upgrade: isUpgrade, room: hasRoom };

// Devuelve true si hizo algo (un paso o el pickup).
/**
 * Un paso hacia el drop que vale la pena (zen, joya, excelente o mejora). No levanta lo que cae al lado de otro jugador (es suyo: se pasaba el
 * tiempo juntando el zen de otros y no sumaba exp).
 */
let bagWarnedAt = 0;
const BAG_WARN_MS = 60 * 60_000;
export async function lootStep(): Promise<boolean> {
  // Aviso (panel y log) para que el usuario vacíe la bolsa: sin lugar solo se levanta el zen.
  const room = bagRoom();
  if (room < 2 && world.inventory.size && Date.now() - bagWarnedAt > BAG_WARN_MS) {
    bagWarnedAt = Date.now();
    decide(`${room <= 0 ? 'La bolsa está llena' : 'A la bolsa le queda una casilla'}: solo levanto zen hasta que la vacíes.`, { kind: 'loot' });
  }
  if (!drops.size) {
    lootState.looting = null;
    return false;
  }
  const now = Date.now();
  const looting = lootState.looting;
  const lootingDrop = looting ? drops.get(looting.id) : undefined;
  if (looting && (!lootingDrop || now - looting.since > LOOT_TIMEOUT_MS)) {
    if (drops.has(looting.id)) {
      log(`No llego al drop Id=${looting.id}, lo dejo.`);
      drops.delete(looting.id);
    }
    lootState.looting = null;
  }
  for (const [id, until] of foreignUntil) if (until <= now || !drops.has(id)) foreignUntil.delete(id);
  const mine = [...drops.values()].filter((dr) => !foreignUntil.has(dr.id));
  const pool = mine.filter((dr) => ![...world.players.values()].some((p) => chebyshev(p.x, p.y, dr.x, dr.y) <= 2));
  const d = lootState.looting ? drops.get(lootState.looting.id)! : pickLoot({ x: world.x, y: world.y }, pool, LOOT_RADIUS, RULES);
  if (!d) return false;
  if (!lootState.looting) {
    const why = lootReason(d, RULES);
    // Lo que no es zen se cuenta en el feed: qué se va a buscar y por qué.
    if (why && why !== 'zen') decide(`Voy a levantar ${itemInfo(d.group, d.num).name}${d.level ? ` +${d.level}` : ''}${d.excellent ? ' excelente' : ''}: ${why === 'mejora' ? 'mejora lo que llevo puesto' : why}.`, { kind: 'loot', group: d.group, num: d.num });
    journal('pickup', `levantar ${d.group}/${d.num}${d.excellent ? ' exc' : ''} (Id=${d.id}) en (${d.x},${d.y})`, { itemId: d.id, group: d.group, num: d.num, excellent: !!d.excellent, x: d.x, y: d.y });
    lootState.looting = { id: d.id, since: now, drop: { group: d.group, num: d.num, x: d.x, y: d.y } };
  }
  if (chebyshev(world.x, world.y, d.x, d.y) > 1) {
    step(directionTowards(world.x, world.y, d.x, d.y));
    await sleep(humanPace(WALK_PACE_MS));
    return true;
  }
  // Al lado: pedirlo y seguir pidiéndolo hasta que deje de estar en el piso (o se venza el plazo).
  const lt = lootState.looting!;
  if (lt.pickAt == null) {
    lootState.count++;
    log(`Levanto ${d.group}/${d.num}${d.excellent ? ' exc' : ''} (Id=${d.id}) en (${d.x},${d.y})`);
  }
  if (lt.pickAt == null || now - lt.pickAt >= PICKUP_RETRY_MS) {
    lt.pickAt = now;
    sendPickup(d.id);
  }
  await sleep(150);
  return true;
}
