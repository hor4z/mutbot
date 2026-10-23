/**
 * Equiparse con lo que levanta (personaje nuevo). Para cada lugar del equipo, si en el inventario hay
 * algo mejor del tipo que va ahí, lo pone; si el lugar está ocupado, primero pasa el viejo a un hueco
 * libre del inventario. Los requisitos los decide el server: si rechaza un ítem (fuerza, nivel o
 * clase) se recuerda y no se vuelve a probar. `data/items.json` tiene las columnas de requisitos
 * corridas, por eso no se usan.
 *
 * Packet (adaptador del cliente web para el 0.97d, `adaptOutgoing` de 0x24):
 *   C3 0C 24 <de: depósito> <de: casilla> <ítem 5 bytes> <a: depósito> <a: casilla> (C3 0D 24 con el
 *   ítem de 6 bytes que manda el server desde la armonía, 2026-10-23)
 * depósito 0 = inventario (equipo 0-11, bolsa 12-75). Respuesta `ItemMoved` (C3 24): byte 3 = casilla
 * nueva, o 0xFF si no se pudo.
 */
import { rawPacket } from './actions';
import { sendToGS, waitFor } from './connection';
import { itemInfo } from './panel-logic';
import { world, type ItemSlot } from './state';
import { decide } from './journal';
import { log, sleep, toBytes } from './util';

/** Lugar del equipo por grupo de ítem: armas (0-5) mano derecha, escudo, casco, armadura, pantalones, guantes, botas. */
export function equipSlotFor(group: number): number | null {
  if (group <= 5) return 0;
  if (group >= 6 && group <= 11) return group - 5; // 6 escudo→1, 7 casco→2, 8 armadura→3, 9 pantalones→4, 10 guantes→5, 11 botas→6
  return null;
}

/** ¿`a` es mejor que `b`? Dentro del grupo el número sube con el tier; a igual número, más +. */
export function betterItem(a: { group: number; num: number; level?: number }, b: { group: number; num: number; level?: number } | undefined): boolean {
  if (!b) return true;
  if (a.group !== b.group) return a.num > b.num; // armas de otro grupo: por tier aproximado
  if (a.num !== b.num) return a.num > b.num;
  return (a.level ?? 0) > (b.level ?? 0);
}

/** Primer hueco de la bolsa (8×8 desde la casilla 12) donde entra un ítem de w×h. */
export function freeBagSlot(items: Iterable<ItemSlot>, w: number, h: number): number | null {
  const used = new Set<number>();
  for (const it of items) {
    if (it.slot < 12 || it.slot >= 76) continue;
    const { w: iw, h: ih } = itemInfo(it.group, it.num);
    const p = it.slot - 12;
    for (let dy = 0; dy < ih; dy++) for (let dx = 0; dx < iw; dx++) used.add(p + dy * 8 + dx);
  }
  for (let p = 0; p < 64; p++) {
    const x = p % 8, y = Math.floor(p / 8);
    if (x + w > 8 || y + h > 8) continue;
    let ok = true;
    for (let dy = 0; dy < h && ok; dy++) for (let dx = 0; dx < w && ok; dx++) if (used.has(p + dy * 8 + dx)) ok = false;
    if (ok) return 12 + p;
  }
  return null;
}

const key = (it: ItemSlot) => `${it.group}/${it.num}/${it.level ?? 0}`;
const rejected = new Set<string>();

async function move(it: ItemSlot, to: number): Promise<boolean> {
  if (!it.raw || (it.raw.length !== 5 && it.raw.length !== 6)) return false;
  const reply = waitFor('ItemMoved', 3000).catch(() => null);
  sendToGS(rawPacket([0xc3, 7 + it.raw.length, 0x24, 0, it.slot, ...it.raw, 0, to]));
  const r = await reply;
  const b = r ? toBytes(r) : null;
  if (!b || b[3] === 0xff) return false;
  world.inventory.delete(it.slot);
  world.inventory.set(to, { ...it, slot: to });
  return true;
}

let running = false;

/** Una pasada: equipa como mucho un ítem. Devuelve lo que hizo (o null). */
export async function equipStep(): Promise<string | null> {
  if (running) return null;
  running = true;
  try {
    const inv = [...world.inventory.values()];
    const bag = inv.filter((it) => it.slot >= 12 && it.slot < 76 && !rejected.has(key(it)));
    for (const it of bag) {
      const slot = equipSlotFor(it.group);
      if (slot == null) continue;
      const cur = world.inventory.get(slot);
      if (!betterItem(it, cur)) continue;
      if (cur) {
        const { w, h } = itemInfo(cur.group, cur.num);
        const free = freeBagSlot(world.inventory.values(), w, h);
        if (free == null || !(await move(cur, free))) continue;
        await sleep(600);
      }
      const name = itemInfo(it.group, it.num).name;
      if (await move(it, slot)) {
        decide(`Equipo: me pongo ${name}${it.level ? ` +${it.level}` : ''}.`);
        return name;
      }
      rejected.add(key(it));
      log(`Equipo: el server no me deja usar ${name} (requisitos o clase): no lo vuelvo a probar.`);
      // Si saqué el viejo, lo vuelvo a poner.
      if (cur) {
        const back = [...world.inventory.values()].find((x) => x.slot >= 12 && key(x) === key(cur));
        if (back) await move(back, slot);
      }
      return null;
    }
    return null;
  } finally {
    running = false;
  }
}
