/** Los warps del menú del juego (a los que se puede ir) y el viaje: un warp, esperar el cambio de mapa, anotarlo. */
import { warpTo } from '../core/actions';
import { waitFor } from '../core/connection';
import { bot } from '../core/state';
import { log } from '../core/util';

/** `arrival`: dónde deja el warp (medido), para elegir la entrada más cercana a un compañero. */
export type Warp = { index: number; name: string; reqLevel: number; map: number; arrival?: { x: number; y: number } };

export const WARPS: readonly Warp[] = [
  { index: 2, name: 'Lorencia', reqLevel: 10, map: 0 },
  { index: 1, name: 'Arena', reqLevel: 50, map: 6 },
  { index: 3, name: 'Noria', reqLevel: 10, map: 3 },
  // El primer Devias del menú de warps (índice 4): dónde deja se aprende al usarlo (place.ts, `landings`).
  { index: 4, name: 'Devias 1', reqLevel: 20, map: 2 },
  { index: 5, name: 'Devias 2', reqLevel: 20, map: 2, arrival: { x: 24, y: 25 } },
  { index: 6, name: 'Devias 3', reqLevel: 20, map: 2, arrival: { x: 226, y: 228 } },
  { index: 7, name: 'Devias 4', reqLevel: 20, map: 2, arrival: { x: 70, y: 179 } },
  // Índices 8-10, 12 y 13 sin verificar (suposición por el menú estándar): el recorrido de prueba anota a qué mapa llegan.
  { index: 8, name: 'Dungeon 1', reqLevel: 20, map: 1 },
  { index: 9, name: 'Dungeon 2', reqLevel: 20, map: 1 },
  { index: 10, name: 'Dungeon 3', reqLevel: 20, map: 1 },
  { index: 12, name: 'Atlans 2', reqLevel: 70, map: 7 },
  { index: 13, name: 'Atlans 3', reqLevel: 70, map: 7 },
  { index: 11, name: 'Atlans', reqLevel: 70, map: 7 },
  { index: 21, name: 'Tarkan', reqLevel: 140, map: 8 },
  { index: 24, name: 'Arena 2', reqLevel: 100, map: 83, arrival: { x: 61, y: 114 } },
  { index: 25, name: 'Arena 3', reqLevel: 200, map: 84, arrival: { x: 61, y: 114 } },
  { index: 26, name: 'Arena 4', reqLevel: 300, map: 85, arrival: { x: 61, y: 114 } },
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
  if (ok) bot.currentSpot = w;
  else log(`Warp a ${w.name} sin respuesta (¿nivel, zen o PK?).`);
  return ok;
}
