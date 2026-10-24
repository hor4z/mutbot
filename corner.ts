/**
 * La esquina de Arena 2: el mejor spot conocido. Ahí se juntan 12-18 Gaint Drakan (nivel 100, 50.000 de vida) y un
 * personaje fuerte rinde unos 550M exp/min (38 niveles/min en nivel 300) contra ~50M en las Arenas 3/4 y ~15M en Devias.
 * Versión mínima: desde el nivel 100 hasta el reset el bot viaja a Arena 2, camina el camino hasta la esquina y pelea lo
 * que entra en el radio de `home`. Sin medir lados, sin mirar a otros jugadores. Lo llama farm-loop.ts (`cornerOn`).
 * Solo lo usa un personaje que `farmMiddleware` deja farmear ahí (`profile.corner`: stats a la altura).
 */
import type { Pos } from './util';
import { dist } from './util';

export const CORNER = {
  map: 83,          // Arena 2
  warp: 24,
  minLevel: 100,    // "You need to be level 100 in order to warp"
  home: { x: 7, y: 11 } as Pos,
  // Donde espera cuando no hay nada a la vista: la esquina misma.
  wait: { x: 2, y: 10 } as Pos,
  radius: 7,        // se pelea dentro de esto (+ fill) alrededor de home
  fill: 2,
  // Camino desde la llegada (61,114): norte por x≈56-61 y oeste por y≈10 (directo cortaba por los Elite Skeleton).
  route: [[61, 98], [58, 72], [56, 45], [52, 28], [40, 21], [30, 11], [16, 10], [7, 11]] as const,
} as const;

/** ¿Está en la esquina (no viajando)? */
export const inCorner = (p: Pos) => dist(p, CORNER.home) <= CORNER.radius + 3;

/**
 * Próximo punto del camino a la esquina. `idx` = el que venía siguiendo (null tras aparecer: warp o muerte → el más
 * cercano). Solo avanza: "el más cercano" oscilaba entre los dos primeros.
 */
export function nextRoutePoint(p: Pos, idx: number | null): { idx: number; x: number; y: number } {
  const R = CORNER.route;
  let i = idx;
  if (i == null || i < 0 || i >= R.length) {
    let bd = Infinity;
    R.forEach(([x, y], k) => {
      const d = dist(p, { x, y });
      if (d < bd) { bd = d; i = k; }
    });
  }
  let k = i as number;
  if (dist(p, { x: R[k][0], y: R[k][1] }) < 4 && k < R.length - 1) k++;
  return { idx: k, x: R[k][0], y: R[k][1] };
}

