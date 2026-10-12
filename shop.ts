/**
 * Comprar pociones (personaje nuevo, pedido del usuario). Paquetes del cliente web (season6 sin
 * adaptar en el 0.97d):
 *   hablar   C3 05 30 <id NPC BE>     → NpcWindowResponse + StoreItemList (C2 31: catálogo)
 *   comprar  C3 04 32 <casilla>       → ItemBought (C1 32) o NpcItemBuyFailed (C1 32 FF)
 *   cerrar   C1 03 31
 * La casilla es la del catálogo que arma el server (no un índice de items.json). El catálogo llega
 * con el mismo formato que el inventario (`parseInventory`, ítems de 5 bytes).
 *
 * Vendedora de pociones de Lorencia: Amy (NPC 253), cerca de (127,86) (Lorencia.cs de OpenMU).
 */
import { rawPacket } from './actions';
import { sendToGS, waitFor } from './connection';
import { decide } from './journal';
import { EventBus } from './net/eventBus';
import { parseInventory } from './protocol097';
import { world } from './state';
import { log, sleep, toBytes } from './util';

export const POTION_NPC = { type: 253, map: 0, x: 127, y: 86 } as const;
/** Pociones de vida, de la que más cura a la que menos. */
export const HEAL_POTIONS = [3, 2, 1] as const;

export const potionCount = () => [...world.inventory.values()].filter((it) => it.group === 14 && (HEAL_POTIONS as readonly number[]).includes(it.num)).length;

const catalog = new Map<number, { group: number; num: number }>();
let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  EventBus.on('StoreItemList', (raw: any) => {
    catalog.clear();
    for (const it of parseInventory(toBytes(raw)) ?? []) catalog.set(it.slot, { group: it.group, num: it.num });
    log(`Catálogo del NPC: ${catalog.size} ítem(s).`);
  });
}

/** La casilla del catálogo con la mejor poción de vida (o null). */
export function bestPotionSlot(cat: Map<number, { group: number; num: number }>): number | null {
  for (const num of HEAL_POTIONS) for (const [slot, it] of cat) if (it.group === 14 && it.num === num) return slot;
  return null;
}

/** Habla con el NPC, compra `n` pociones (una por vez, a ritmo humano) y cierra. Devuelve cuántas compró. */
export async function buyPotions(npcId: number, n: number): Promise<number> {
  watch();
  catalog.clear();
  const list = waitFor('StoreItemList', 4000).catch(() => null);
  sendToGS(rawPacket([0xc3, 0x05, 0x30, npcId >> 8, npcId]));
  await list;
  const slot = bestPotionSlot(catalog);
  if (slot == null) {
    log('Compra: el NPC no vende pociones de vida (o no contestó).');
    sendToGS(rawPacket([0xc1, 0x03, 0x31]));
    return 0;
  }
  let bought = 0;
  for (let i = 0; i < n; i++) {
    const r = waitFor('ItemBought', 3000).catch(() => null);
    const failed = waitFor('NpcItemBuyFailed', 3000).catch(() => null);
    sendToGS(rawPacket([0xc3, 0x04, 0x32, slot]));
    const got = await Promise.race([r.then((x) => (x ? 'ok' : null)), failed.then((x) => (x ? 'fail' : null))]);
    if (got !== 'ok') break;
    bought++;
    await sleep(500);
  }
  sendToGS(rawPacket([0xc1, 0x03, 0x31]));
  const it = catalog.get(slot)!;
  decide(`Compra: ${bought} poción(es) ${it.group}/${it.num} a Amy.`);
  return bought;
}
