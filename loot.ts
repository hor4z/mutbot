/**
 * Loot: los drops en scope (ItemsDropped / ItemDropRemoved) y el paso de ir a levantar uno valioso
 * (cajas, joyas, excelentes, guantes 10/1). El zen y el equipo común no se levantan.
 */
import { MoneyDropped075Packet, PickupItemRequest075Packet } from './packets';
import { WALK_PACE_MS } from './config';
import { sendToGS } from './connection';
import { step } from './actions';
import { pickLoot } from './farming';
import { journal } from './journal';
import { EventBus } from './net/eventBus';
import { parseItemDropRemoved, parseItemsDropped } from './protocol097';
import { world } from './state';
import { chebyshev, directionTowards, log, sleep, toBytes } from './util';

type ScopedDrop = { id: number; x: number; y: number; group: number; num: number; isMoney?: boolean; amount?: number; excellent?: boolean };
export const drops = new Map<number, ScopedDrop>();

// Drop que se está yendo a buscar, y cuántos se levantaron en total (panel e informe).
export const lootState = {
  looting: null as { id: number; since: number } | null,
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
  EventBus.on('ItemsDropped', onDrop);
  EventBus.on('ItemDropRemoved', onRemoved);
  return () => {
    EventBus.off('ItemsDropped', onDrop);
    EventBus.off('ItemDropRemoved', onRemoved);
  };
}

// Loot valioso (farming.ts, isValuableDrop): cajas, joyas, excelentes y los
// guantes 10/1. El zen y el equipo común NO se levantan (cada viaje es tiempo
// sin pelear). Se camina hasta el drop (a <= 12 tiles) y se levanta a <= 1;
// mientras tanto no se pelea, como el agente web. Un drop al que no se llega
// en LOOT_TIMEOUT_MS se olvida.
const LOOT_RADIUS = 12;
const LOOT_TIMEOUT_MS = 8000;

// Devuelve true si hizo algo (un paso o el pickup).
export async function lootStep(fresh = false): Promise<boolean> {
  if (!drops.size) {
    lootState.looting = null;
    return false;
  }
  const now = Date.now();
  const looting = lootState.looting;
  if (looting && (!drops.has(looting.id) || now - looting.since > LOOT_TIMEOUT_MS)) {
    if (drops.has(looting.id)) {
      log(`No llego al drop Id=${looting.id}, lo dejo.`);
      drops.delete(looting.id);
    }
    lootState.looting = null;
  }
  const d = lootState.looting ? drops.get(lootState.looting.id)! : pickLoot({ x: world.x, y: world.y }, drops.values(), LOOT_RADIUS, fresh);
  if (!d) return false;
  if (!lootState.looting) {
    journal('pickup', `levantar ${d.group}/${d.num}${d.excellent ? ' exc' : ''} (Id=${d.id}) en (${d.x},${d.y})`, { itemId: d.id, group: d.group, num: d.num, excellent: !!d.excellent, x: d.x, y: d.y });
    lootState.looting = { id: d.id, since: now };
  }
  if (chebyshev(world.x, world.y, d.x, d.y) > 1) {
    step(directionTowards(world.x, world.y, d.x, d.y));
    await sleep(WALK_PACE_MS);
    return true;
  }
  drops.delete(d.id);
  lootState.looting = null;
  const p = PickupItemRequest075Packet.createPacket();
  p.ItemId = d.id;
  sendToGS(p.buffer);
  lootState.count++;
  log(`Levanto ${d.group}/${d.num}${d.excellent ? ' exc' : ''} (Id=${d.id}) en (${d.x},${d.y})`);
  await sleep(300);
  return true;
}
