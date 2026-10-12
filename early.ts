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

/**
 * Farmeo inicial (personaje nuevo, hasta `untilLevel` en Lorencia): solo monstruos con los que puede
 * según SUS stats (`power.ts`: los mata en pocos segundos sin perder mucha vida), campamento en el
 * grupo más grande de esos a <= `scan` de mí; sin ninguno a la vista, va al campo más alto donde haya
 * alguno con el que pueda (`fields`, spawns de Lorencia en OpenMU, Lorencia.cs):
 *   este:  Spider (2) y Budge Dragon (4)          x 180-226, y 90-244
 *   norte: Bull Fighter (6) y Budge Dragon (4)    x 135-240, y 20-88
 *   oeste: Hound (9) y Elite Bull Fighter (12)    x 8-94,    y 11-244
 *   sur:   Lich (14)                              x 95-175,  y 168-244
 * Ya en el campo, lo recorre. El nivel no decide: un personaje con más fuerza o resets sube de campo
 * antes (usuario: "la estrategia sale de los stats del personaje"). Al llegar a `untilLevel` pasa al farmeo avanzado
 * (Devias, Arenas). Solo para personajes nuevos (`isFreshChar`): después de un reset, con stats
 * enormes, va directo al Lich como siempre.
 *
 * Hume (2026-10-12) salió del inicial en el 10 directo al Lich, sin puntos repartidos, y lo mató:
 * ahora sigue hasta el 20, sube de campo en campo y ataca solo monstruos de hasta 1 nivel más.
 *
 * Antes iba "del pueblo al Lich según el nivel": en nivel 1 eso es el centro del pueblo (zona segura,
 * sin monstruos de su nivel) y Hume se quedó parado ahí (2026-10-12).
 */
export const INITIAL = {
  untilLevel: 20,
  scan: 20,
  town: { x: 135, y: 128 } as Pos,
  /** campos de menor a mayor: zona a recorrer, por dónde se entra y qué monstruos salen (tipos) */
  fields: [
    { name: 'el campo de arañas y Budge Dragon (este)', monsters: [3, 2], x1: 182, x2: 212, y1: 105, y2: 150, entry: { x: 186, y: 128 } },
    { name: 'el campo de Bull Fighter (norte)', monsters: [0, 2], x1: 145, x2: 200, y1: 45, y2: 85, entry: { x: 170, y: 80 } },
    { name: 'el campo de Hound (oeste)', monsters: [1, 4], x1: 50, x2: 92, y1: 100, y2: 150, entry: { x: 85, y: 128 } },
    { name: 'el campo del Lich (sur)', monsters: [6], x1: 115, x2: 160, y1: 180, y2: 225, entry: { x: 134, y: 190 } },
  ] as Field[],
  jitter: 4,
} as const;

export type Field = { name: string; monsters: number[]; x1: number; x2: number; y1: number; y2: number; entry: Pos };
/**
 * El campo que le toca: el que tiene el monstruo más fuerte (más nivel) con el que puede. Si no puede
 * con ninguno, el primero (arañas). `levelOf`: nivel por tipo (monsters.json).
 */
export function fieldFor(canFight: (type: number) => boolean, levelOf: (type: number) => number | undefined): Field {
  let best = INITIAL.fields[0];
  let bestLevel = -1;
  for (const f of INITIAL.fields) {
    const top = Math.max(-1, ...f.monsters.filter(canFight).map((t) => levelOf(t) ?? -1));
    if (top > bestLevel) { best = f; bestLevel = top; }
  }
  return best;
}
export const inField = (p: Pos, f = INITIAL.fields[0]) => p.x >= f.x1 && p.x <= f.x2 && p.y >= f.y1 && p.y <= f.y2;

/**
 * Campamento del farmeo inicial. `monsters` ya filtrados por `canFight`. `prev` = el actual (se
 * mantiene salvo que el grupo se haya corrido más de `recenterAt`). Sin monstruos a la vista: `field`
 * (el de `fieldFor`).
 */
export function initialCamp<M extends Pos>(inp: { me: Pos; field: Field; monsters: readonly M[]; prev: Pos | null; rand: () => number; walkable?: (p: Pos) => boolean }): { camp: Pos; why: string } {
  const near = inp.monsters.filter((m) => dist(m, inp.me) <= INITIAL.scan);
  const big = biggestCluster(near);
  if (big) {
    if (inp.prev && dist(inp.prev, big.at) <= EARLY.recenterAt) return { camp: inp.prev, why: `grupo de ${big.n} de mi nivel` };
    return { camp: big.at, why: `grupo de ${big.n} de mi nivel` };
  }
  if (inp.prev) return { camp: inp.prev, why: 'sigo en el campamento' };
  const F = inp.field;
  const ok = (p: Pos) => !inp.walkable || inp.walkable(p);
  const where = F.name;
  if (!inField(inp.me, F)) {
    const r = (n: number) => Math.round((inp.rand() * 2 - 1) * n);
    const e = F.entry;
    const camp = { x: e.x + r(INITIAL.jitter), y: e.y + r(INITIAL.jitter) };
    return { camp: ok(camp) ? camp : e, why: `sin monstruos de mi nivel a la vista: voy a ${where}` };
  }
  // Ya en el campo: un punto al azar adentro (hasta 5 intentos caminables).
  for (let i = 0; i < 5; i++) {
    const camp = { x: Math.round(F.x1 + inp.rand() * (F.x2 - F.x1)), y: Math.round(F.y1 + inp.rand() * (F.y2 - F.y1)) };
    if (ok(camp)) return { camp, why: 'sin monstruos de mi nivel a la vista: recorro el campo' };
  }
  return { camp: F.entry, why: 'sin monstruos de mi nivel a la vista: recorro el campo' };
}

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
  // El spot de Devias 4 solo si está cerca de la llegada: desde Devias 3 (222,208) Horaz cruzaba el mapa
  // caminando ~150 tiles. Lejos, se espera junto a la llegada (sin exp, el arranque cambia de entrada).
  const nearSpot = dist(inp.arrival, E.devias.spot) <= E.farScan;
  const fallback = nearSpot ? E.devias.spot : inp.arrival;
  const fallbackWhy = nearSpot ? 'spot de Devias 4 (69,181)' : 'espero junto a la llegada';
  const big = biggestCluster(near);
  let camp = inp.prev;
  let why: string | null = null;
  if (big && big.n >= E.campMin && (!camp || dist(camp, big.at) > E.recenterAt || dist(camp, inp.arrival) > E.campScan)) {
    camp = big.at;
    why = `grupo de ${big.n} junto a la llegada`;
  }
  if (!camp) {
    camp = { ...fallback };
    why = fallbackWhy;
  }
  const poor = inp.monsters.filter((m) => dist(m, camp!) <= E.poorR).length < E.campMin;
  let poorSince = poor ? (inp.poorSince ?? inp.now) : null;
  if (poorSince != null && inp.now - poorSince > E.poorMs) {
    const far = biggestCluster(inp.monsters.filter((m) => dist(m, inp.arrival) <= E.farScan));
    camp = far && far.n >= 2 ? far.at : { ...fallback };
    why = far && far.n >= 2 ? `campamento pobre: grupo de ${far.n} más lejos` : `campamento pobre: ${fallbackWhy}`;
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
  // Sin nada en la correa: el más cercano a <= nearMe de mí (los que pegan de lejos), pero sin salir de
  // dropTargetAt del campamento (si no, el que se suelta por lejos se vuelve a elegir y se aleja).
  return [...monsters].filter((m) => dist(m, me) <= EARLY.nearMe && dist(m, camp) <= EARLY.dropTargetAt).sort((a, b) => dist(a, me) - dist(b, me))[0] ?? null;
}
