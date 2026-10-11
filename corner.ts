/**
 * La esquina de Arena 2 (port de `browser/corner.js`, lo que hacía rápido al agente del navegador).
 *
 * Los primeros del ranking farmean en la esquina (5,11) de Arena 2, donde se juntan 12-18 Gaint Drakan
 * (nivel 100, 50.000 de vida). Horaz ahí, en el navegador: ~574M exp/min y 38 niveles/min en nivel 300,
 * contra ~50M en las Arenas 3/4 de la ruta normal. Desde el nivel 100 (el warp a Arena 2 lo pide) el bot
 * va a la esquina y se queda hasta el reset; si está llena de gente y rinde poco, se va 5 min a la Arena
 * de su nivel y vuelve a mirar.
 *
 * Lógica PURA (posiciones y reloj por parámetro): se testea en `corner-tests.ts`.
 */

export type Pos = { x: number; y: number };

export const CORNER = {
  map: 83,          // Arena 2
  warp: 24,
  minLevel: 100,    // "You need to be level 100 in order to warp"
  home: { x: 7, y: 11 } as Pos,
  // Donde espera cuando no hay nada en el giro: la esquina misma (el agente arrancaba ahí).
  wait: { x: 2, y: 10 } as Pos,
  radius: 7,        // se pelea dentro de esto (+ FILL) alrededor de home
  fill: 2,
  // Camino de LeanLive desde la llegada (61,114): norte por x≈56-61 y oeste por y≈10. Directo, cortaba
  // por el medio de los Elite Skeleton y zigzagueaba.
  route: [[61, 98], [58, 72], [56, 45], [52, 28], [40, 21], [30, 11], [16, 10], [7, 11]] as const,
  // Esquina llena: 3+ jugadores a <= 15 de home, 60 s adentro y el último minuto rindiendo menos del 80 %
  // de lo que da la Arena de su nivel (al menos 60M/min): 5 min afuera.
  fullRivals: 3,
  fullRivalDist: 15,
  fullAfterMs: 60_000,
  altMinRate: 60e6,
  altFrac: 0.8,
  awayMs: 5 * 60_000,
  // Cerca del reset no vale la pena volver (el camino a la esquina lleva ~1 min).
  noReturnLevel: 360,
  // Con 2+ jugadores a <= 6, no caminar hacia los monstruos (cuando llega ya los mataron): pegar solo
  // lo que entra en el giro.
  crowdDist: 6,
  crowdPlayers: 2,
  // Buff propio en la esquina (Swell Life 48 del DK, Mana Shield 16 del mago) cada tanto.
  buffMs: 55_000,
} as const;

/** Alcance del giro del skill de área (tiles). Twisting Slash 2,5; Evil Spirit 5. */
const SPIN: Record<number, number> = { 9: 5, 14: 3, 38: 3.5, 41: 2.5, 42: 3 };
export const spinRange = (skill: number | null | undefined) => (skill != null ? SPIN[skill] : undefined) ?? 2.5;

export const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y);

/** ¿Está en la esquina (no viajando)? */
export const inCorner = (p: Pos) => dist(p, CORNER.home) <= CORNER.radius + 3;

/**
 * Próximo punto del camino a la esquina. `idx` = el que venía siguiendo (null tras aparecer: warp o
 * muerte → el más cercano). Solo avanza: antes, "el más cercano" oscilaba entre los dos primeros.
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

/** Cuántos monstruos quedan dentro del giro centrado en `m`. */
const cluster = <M extends Pos>(m: M, all: readonly M[], r: number) => all.filter((o) => dist(o, m) <= r).length;

/**
 * A quién tirarle el skill ahora: el monstruo a distancia de giro (r + 0,5) que deja más monstruos
 * adentro. null = nada a tiro.
 */
export function spinTarget<M extends Pos>(me: Pos, monsters: readonly M[], r: number): M | null {
  let best: M | null = null;
  let bn = 0;
  for (const m of monsters) {
    if (dist(m, me) > r + 0.5) continue;
    const n = cluster(m, monsters, r);
    if (n > bn) { bn = n; best = m; }
  }
  return best;
}

/**
 * Hacia qué monstruo caminar estando en la esquina (sin nada a tiro). Viajando: solo lo que bloquea
 * el paso (<= 1,5). Con competencia encima: nada (se queda y pega lo que entra). Si no, el que deja
 * más monstruos en el giro, cerca, dentro de radius + fill de home.
 */
export function cornerTarget<M extends Pos>(me: Pos, monsters: readonly M[], playersNear: number, r: number): M | null {
  if (!inCorner(me)) return monsters.find((m) => dist(m, me) <= 1.5) ?? null;
  if (playersNear >= CORNER.crowdPlayers) return null;
  const pool = monsters.filter((m) => dist(m, CORNER.home) <= CORNER.radius + CORNER.fill);
  let best: M | null = null;
  let bs = -Infinity;
  for (const m of pool) {
    const s = cluster(m, pool, r) * 3 - dist(me, m) * 0.4;
    if (s > bs) { bs = s; best = m; }
  }
  return best;
}

/** La Arena "de afuera" según el nivel: 24 (Arena 2, otro spot), 25 (Arena 3) o 26 (Arena 4). */
export const altWarp = (level: number) => (level >= 300 ? 26 : level >= 200 ? 25 : 24);

/** ¿La esquina está llena y conviene irse un rato? */
export function cornerFull(inp: { rivals: number; inCornerSince: number | null; now: number; rate1m: number; altRate?: number }): boolean {
  if (inp.rivals < CORNER.fullRivals || inp.inCornerSince == null || inp.now - inp.inCornerSince <= CORNER.fullAfterMs) return false;
  const alt = Math.max(inp.altRate ?? 0, CORNER.altMinRate);
  return inp.rate1m < alt * CORNER.altFrac;
}

/** ¿Va (o vuelve) a la esquina? Afuera por estar llena hasta `awayUntil`; cerca del reset no vuelve. */
export function cornerActive(inp: { level: number; resetLevel: number; awayUntil: number; now: number }): boolean {
  return inp.level >= CORNER.minLevel && inp.level < inp.resetLevel && inp.now >= inp.awayUntil;
}
