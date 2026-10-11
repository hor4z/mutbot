/**
 * El arranque del ciclo, del reset al nivel 100 (port de `browser/corner.js`, la parte de Lorencia y
 * Devias que hacía que el navegador llegara al 100 en 2-3 min):
 *
 *  - Lorencia (10-19): directo al grupo de Lich (134,202), con una salida variada en cada reset
 *    (directa, apenas por el oeste o por el este del camino) y un punto de parada a ±3 tiles; objetivos
 *    a <= 8 del campamento (usuario: "en Lorencia te saliste del spot").
 *  - Devias 4 (20-99): el spot lleno pegado a la llegada. Campamento = centro del grupo más grande
 *    (>= 3 monstruos a <= 4) a <= 15 de la llegada; si el campamento queda pobre (< 3 a <= 10) 10 s,
 *    el grupo más grande (>= 2) a <= 25 de la llegada o el spot fijo (69,181). Objetivos a <= 8 del
 *    campamento (usuario: "en Devias no te salgas del spot muy lejos"); sin nada cerca, el más cercano
 *    a <= 12 (los que pegan de lejos).
 *
 * Lógica PURA (posiciones, reloj y azar por parámetro): se testea en `early-tests.ts`.
 */
import { dist, type Pos } from './corner';
export { dist, type Pos };

export const EARLY = {
  lorencia: { map: 0, maxLevel: 20, lich: { x: 134, y: 202 } as Pos, jitter: 3 },
  devias: { map: 2, maxLevel: 100, spot: { x: 69, y: 181 } as Pos },
  leash: 8,            // objetivos a <= esto del campamento
  dropTargetAt: 10,    // un objetivo que se alejó más de esto del campamento se suelta
  nearMe: 12,          // sin nada en el campamento: el más cercano a <= esto (pegan de lejos)
  clusterR: 4,         // radio de un "grupo"
  campScan: 15,        // grupo para el campamento: a <= esto de la llegada
  campMin: 3,          // monstruos mínimos para que un grupo sea campamento
  recenterAt: 4,       // se recentra si el grupo se corrió más que esto
  poorR: 10,           // campamento pobre: menos de campMin a <= esto...
  poorMs: 10_000,      // ...durante esto
  farScan: 25,         // campamento pobre: el grupo más grande (>= 2) a <= esto de la llegada
  viaReached: 3,
} as const;


/** Centro del grupo más grande (monstruo con más vecinos a <= r) entre `pool`, con su tamaño. */
export function biggestCluster<M extends Pos>(pool: readonly M[], r: number = EARLY.clusterR): { at: Pos; n: number } | null {
  let best: Pos | null = null;
  let bn = 0;
  for (const m of pool) {
    const n = pool.filter((o) => dist(o, m) <= r).length;
    if (n > bn) { bn = n; best = m; }
  }
  return best ? { at: { x: Math.round(best.x), y: Math.round(best.y) }, n: bn } : null;
}

/**
 * Plan de salida de Lorencia tras el reset: campamento en el Lich ±jitter y, a veces, un punto de
 * paso por el oeste o el este. `rand` en [0,1) (Math.random); `walkable` para no elegir una pared.
 */
export function lorenciaPlan(rand: () => number, walkable: (p: Pos) => boolean = () => true): { camp: Pos; via: Pos | null } {
  const r = (n: number) => Math.round((rand() * 2 - 1) * n);
  const L = EARLY.lorencia;
  let camp = { x: L.lich.x + r(L.jitter), y: L.lich.y + r(L.jitter) };
  if (!walkable(camp)) camp = { ...L.lich };
  const vias: (Pos | null)[] = [null, { x: 130 + r(2), y: 150 + r(4) }, { x: 141 + r(2), y: 165 + r(4) }, null];
  let via = vias[Math.floor(rand() * vias.length)] ?? null;
  if (via && !walkable(via)) via = null;
  return { camp, via };
}

/**
 * Campamento de Devias 4. `prev` = el actual (o null), `poorSince` = desde cuándo está pobre.
 * Devuelve el campamento a usar y el nuevo `poorSince`.
 */
export function deviasCamp<M extends Pos>(inp: { arrival: Pos; monsters: readonly M[]; prev: Pos | null; poorSince: number | null; now: number }): { camp: Pos; poorSince: number | null; why: string | null } {
  const E = EARLY;
  const near = inp.monsters.filter((m) => dist(m, inp.arrival) <= E.campScan);
  const big = biggestCluster(near);
  let camp = inp.prev;
  let why: string | null = null;
  if (big && big.n >= E.campMin && (!camp || dist(camp, big.at) > E.recenterAt || dist(camp, inp.arrival) > E.campScan)) {
    camp = big.at;
    why = `grupo de ${big.n} junto a la llegada`;
  }
  if (!camp) {
    camp = E.devias.spot;
    why = 'spot de Devias 4 (69,181)';
  }
  const poor = inp.monsters.filter((m) => dist(m, camp!) <= E.poorR).length < E.campMin;
  let poorSince = poor ? (inp.poorSince ?? inp.now) : null;
  if (poorSince != null && inp.now - poorSince > E.poorMs) {
    const far = biggestCluster(inp.monsters.filter((m) => dist(m, inp.arrival) <= E.farScan));
    camp = far && far.n >= 2 ? far.at : E.devias.spot;
    why = far && far.n >= 2 ? `campamento pobre: grupo de ${far.n} más lejos` : 'campamento pobre: spot de Devias 4 (69,181)';
    poorSince = null;
  }
  return { camp, poorSince, why };
}

/**
 * Objetivo con correa: el que deja más monstruos alrededor (cluster × 3 − distancia × 0,5) entre los
 * que están a <= leash del campamento; si no hay, el más cercano a <= nearMe de mí.
 */
export function leashedTarget<M extends Pos>(me: Pos, camp: Pos, monsters: readonly M[], leash: number = EARLY.leash): M | null {
  const near = monsters.filter((m) => dist(m, camp) <= leash);
  let best: M | null = null;
  let bs = -Infinity;
  for (const m of near) {
    const s = near.filter((o) => dist(o, m) <= EARLY.clusterR).length * 3 - dist(me, m) * 0.5;
    if (s > bs) { bs = s; best = m; }
  }
  if (best) return best;
  return [...monsters].filter((m) => dist(m, me) <= EARLY.nearMe).sort((a, b) => dist(a, me) - dist(b, me))[0] ?? null;
}
