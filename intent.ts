/**
 * Quién manda sobre el spot y los warps. Antes el panel, la escuadra, la espera en Lorencia y los pedidos de ayuda
 * escribían los mismos campos (`pinnedSpot`, `pendingWarp`) y cada uno guardaba y restauraba "su" valor: se pisaban.
 * Ahora cada dueño tiene su propio pin y manda el de mayor prioridad (panel > ayuda > espera en pueblo). Soltar
 * el propio nunca toca el de otro, y todo cambio queda en el diario con dueño y motivo.
 */
import { journal } from './journal';
import type { Spot } from './learning';
import { bot } from './state';

export type PinOwner = 'panel' | 'help' | 'town';

const PRIORITY: Record<PinOwner, number> = { panel: 3, help: 2, town: 1 };
const pins = new Map<PinOwner, Spot>();

const top = (): [PinOwner, Spot] | null => {
  let best: [PinOwner, Spot] | null = null;
  for (const [o, s] of pins) if (!best || PRIORITY[o] > PRIORITY[best[0]]) best = [o, s];
  return best;
};

export const pin = {
  /** El spot que vale ahora (el del dueño de mayor prioridad), o null si la ruta es libre. */
  current: (): Spot | null => top()?.[1] ?? null,
  owner: (): PinOwner | null => top()?.[0] ?? null,
  has: (owner: PinOwner) => pins.has(owner),
  set(owner: PinOwner, spot: Spot, why = '') {
    if (pins.get(owner)?.index === spot.index) return;
    pins.set(owner, spot);
    journal('mode', `spot fijo (${owner}): ${spot.name}${why ? ` — ${why}` : ''}`, { pin: owner, warp: spot.index });
  },
  clear(owner: PinOwner, why = '') {
    const s = pins.get(owner);
    if (!s) return;
    pins.delete(owner);
    journal('mode', `spot liberado (${owner}): ${s.name}${why ? ` — ${why}` : ''}`, { pin: owner, warp: s.index });
  },
  clearAll(why = '') {
    for (const o of [...pins.keys()]) pin.clear(o, why);
  },
};

/** Un warp pedido a la vez: el loop lo ejecuta en su próximo tick. Devuelve false si ya hay uno en espera. */
export function requestWarp(spot: Spot, owner: PinOwner, why: string): boolean {
  if (bot.pendingWarp) return false;
  bot.pendingWarp = spot;
  journal('travel', `warp pedido a ${spot.name} (${owner}): ${why}`, { warp: spot.index, owner });
  return true;
}
