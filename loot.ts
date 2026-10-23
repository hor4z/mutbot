/**
 * Loot: los drops en scope (ItemsDropped / ItemDropRemoved) y el paso de ir a levantar uno valioso
 * (cajas, joyas, excelentes, guantes 10/1). El zen y el equipo común no se levantan.
 */
import { MoneyDropped075Packet } from './packets';
import { WALK_PACE_MS } from './config';
import { sendToGS } from './connection';
import { step, sendPickup } from './actions';
import { itemInfo } from './panel-logic';
import { pickLoot } from './farming';
import { decide, journal } from './journal';
import { EventBus } from './net/eventBus';
import { parseItemDropRemoved, parseItemsDropped, parseServerMessage } from './protocol097';
import { world } from './state';
import { trackEvent } from './telemetry';
import { chebyshev, directionTowards, humanPace, log, sleep, toBytes } from './util';

type ScopedDrop = { id: number; x: number; y: number; group: number; num: number; isMoney?: boolean; amount?: number; excellent?: boolean };
export const drops = new Map<number, ScopedDrop>();

// Drop que se está yendo a buscar, y cuántos se levantaron en total (panel e informe).
export const lootState = {
  looting: null as { id: number; since: number; pickAt?: number; drop?: { group: number; num: number; x: number; y: number } } | null,
  count: 0,
};

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
      for (const d of parseDropsPacket(raw)) drops.set(d.id, d);
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
    foreignUntil.set(lt.id, Date.now() + FOREIGN_RETRY_MS);
    const d = drops.get(lt.id) ?? lt.drop;
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

// Loot valioso (farming.ts, isValuableDrop): cajas, joyas, excelentes y los
// guantes 10/1. El zen y el equipo común NO se levantan (cada viaje es tiempo
// sin pelear). Se camina hasta el drop (a <= 12 tiles) y se levanta a <= 1;
// mientras tanto no se pelea, como el agente web. Un drop al que no se llega
// en LOOT_TIMEOUT_MS se olvida.
const LOOT_RADIUS = 12;
const LOOT_TIMEOUT_MS = 8000;
// Desde 2026-10-18 las cajas, cristales y excelentes no se pueden levantar los primeros 2 s y, si varios
// los piden, se sortean: un solo pedido al caer se perdía. Se insiste cada PICKUP_RETRY_MS mientras siga
// en el piso (ItemDropRemoved lo saca de `drops`); una caja (queda 3 min) hasta LOOT_BOX_TIMEOUT_MS.
const PICKUP_RETRY_MS = 600;
const LOOT_BOX_TIMEOUT_MS = 20_000;
const isBox = (d: { group: number; num: number }) => d.group === 14 && d.num === 11;
// "This item doesn't belong to you" (la caja es del que más daño hizo): soltarla ya y no volver a pedirla
// hasta FOREIGN_RETRY_MS después (por si queda libre). Insistir 20 s en plena invasión era perder dorados.
const FOREIGN_RETRY_MS = 10_000;
const foreignUntil = new Map<number, number>();
// Joyas, excelentes y equipo solo con lugar en el inventario (casillas libres de las 64): que siempre
// entren las cajas, el zen y las pociones.
const LOOT_GEAR_MIN_FREE = 12;
export function bagRoom(): number {
  let used = 0;
  for (const it of world.inventory.values()) if (it.slot >= 12 && it.slot < 76) { const i = itemInfo(it.group, it.num); used += i.w * i.h; }
  return 64 - used;
}

// Devuelve true si hizo algo (un paso o el pickup).
/**
 * `fresh` (personaje nuevo): además de lo valioso, zen/pociones/equipo; pero primero pelea (con un
 * atacable a <= 8 solo levanta lo que está pegado) y no levanta lo que cae al lado de otro jugador (es
 * suyo: Hume se pasaba el tiempo juntando el zen de dos jugadores y no sumaba exp, 2026-10-12).
 */
let bagWarnedAt = 0;
const BAG_WARN_MS = 10 * 60_000;
export async function lootStep(fresh = false, fightNear = false): Promise<boolean> {
  // Aviso (panel y log) para que el usuario vacíe la bolsa: con poco lugar solo entran cajas.
  const room = bagRoom();
  if (room < LOOT_GEAR_MIN_FREE && world.inventory.size && Date.now() - bagWarnedAt > BAG_WARN_MS) {
    bagWarnedAt = Date.now();
    decide(`Bolsa casi llena (${room} casillas libres): solo levanto cajas, Cristales y talismanes hasta que la vacíes.`);
  }
  if (!drops.size) {
    lootState.looting = null;
    return false;
  }
  const now = Date.now();
  const looting = lootState.looting;
  const lootingDrop = looting ? drops.get(looting.id) : undefined;
  if (looting && (!lootingDrop || now - looting.since > (isBox(lootingDrop) ? LOOT_BOX_TIMEOUT_MS : LOOT_TIMEOUT_MS))) {
    if (drops.has(looting.id)) {
      log(`No llego al drop Id=${looting.id}, lo dejo.`);
      drops.delete(looting.id);
    }
    lootState.looting = null;
  }
  const radius = fresh && fightNear ? 1 : LOOT_RADIUS;
  for (const [id, until] of foreignUntil) if (until <= now || !drops.has(id)) foreignUntil.delete(id);
  const mine = [...drops.values()].filter((dr) => !foreignUntil.has(dr.id));
  const pool = fresh ? mine.filter((dr) => ![...world.players.values()].some((p) => chebyshev(p.x, p.y, dr.x, dr.y) <= 2)) : mine;
  const d = lootState.looting ? drops.get(lootState.looting.id)! : pickLoot({ x: world.x, y: world.y }, pool, radius, fresh, bagRoom() >= LOOT_GEAR_MIN_FREE);
  if (!d) return false;
  if (!lootState.looting) {
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
