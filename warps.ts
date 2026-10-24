/** Los warps del menú del juego (a los que se puede ir) y el viaje: un warp, esperar el cambio de mapa, anotarlo. */
import { warpTo } from './actions';
import { waitFor } from './connection';
import { bot, pkGuard } from './state';
import { log } from './util';

export type Warp = { index: number; name: string; reqLevel: number; map: number };

export const WARPS: readonly Warp[] = [
  { index: 2, name: 'Lorencia', reqLevel: 10, map: 0 },
  { index: 1, name: 'Arena', reqLevel: 50, map: 6 },
  { index: 5, name: 'Devias 2', reqLevel: 20, map: 2 },
  { index: 6, name: 'Devias 3', reqLevel: 20, map: 2 },
  { index: 7, name: 'Devias 4', reqLevel: 20, map: 2 },
  { index: 24, name: 'Arena 2', reqLevel: 100, map: 83 },
  { index: 25, name: 'Arena 3', reqLevel: 200, map: 84 },
  { index: 26, name: 'Arena 4', reqLevel: 300, map: 85 },
  { index: 27, name: 'Aida', reqLevel: 140, map: 33 },
  { index: 28, name: 'Aida 2', reqLevel: 170, map: 33 },
];
export const warp = (index: number): Warp => WARPS.find((w) => w.index === index)!;

/** Entre warps: que cargue el mapa y aparezcan los monstruos. */
export const WARP_COOLDOWN_MS = 15_000;

export async function warpAndWait(w: Warp): Promise<boolean> {
  const waiter = waitFor('MapChanged075', 6000).catch(() => null);
  warpTo(w.index);
  bot.lastWarpAt = Date.now();
  const ok = !!(await waiter);
  pkGuard.onWarp(ok, Date.now());
  if (ok) bot.currentSpot = w;
  else log(`Warp a ${w.name} sin respuesta (¿nivel, zen o PK?).`);
  return ok;
}
