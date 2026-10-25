/**
 * Ejemplo de ~/.mubot/ganchos.ts (copiar y editar; los bots lo recargan solos en ~2 s). Todo es opcional: lo que no exporta,
 * lo decide el repo. Devolver `undefined` = "no opino". Tipos: ver ganchos.ts.
 */
// Al copiarlo a ~/.mubot/ganchos.ts, cambiá './ganchos' por la ruta absoluta de tu checkout (solo se usa el tipo).
import type { Ganchos } from './ganchos';

/** Zonas por peso (avistamientos / distancia) en vez de la más cercana. */
export const elegirZona: Ganchos['elegirZona'] = ({ zonas, yo, visitadas }) => {
  let best = null as (typeof zonas)[number] | null;
  let bs = -Infinity;
  for (const z of zonas) {
    if (visitadas.has(`${z.x},${z.y}`)) continue;
    const s = z.n / (Math.hypot(z.x - yo.x, z.y - yo.y) + 25);
    if (s > bs) { bs = s; best = z; }
  }
  return best;
};
