/**
 * Regla fuerte de dorados (port de `browser/corner.js`, C.dragon). Usuario: "si aparece un dragón o lo
 * que sea dorado lo matás y recogés las cajas"; "si se topan con cualquier dorado lo matan igual".
 *
 * Farmeando (no cazando), cualquier dorado vivo a <= 20 tiles es el objetivo: primero Golden Dragon
 * (79) o Dragón Rojo (44) aunque haya uno chico más cerca. Uno que en 2 min no se pudo matar (pared,
 * otro lo tiene) se deja. Mientras haya uno, y 15 s después de que muera (para levantar las cajas), no
 * se cambia de mapa, no se resetea ni se vuelve a la esquina.
 *
 * Lógica PURA (posiciones y reloj por parámetro): se testea en `golden-tests.ts`.
 */
export type GoldenCandidate = { id: number; x: number; y: number; type: number };

export const GOLDEN_RULE = { range: 20, dragonBonus: 30, giveUpMs: 120_000, dragonGiveUpMs: 300_000, lootStayMs: 15_000 } as const;
// Golden Dragon de la invasión dorada (79) y Dragón Rojo de su propia invasión (44: el cliente también lo
// llama "Golden Dragon"; RedDragonInvasionPlugIn de OpenMU, ver EVENTOS.md).
export const DRAGON_TYPES: ReadonlySet<number> = new Set([44, 79]);
/** Nivel de la Box of Kundun que suelta cada dorado (guía "Invasión Dorada"; Dragón Rojo +4). */
export const GOLDEN_VALUE: ReadonlyMap<number, number> = new Map([
  [78, 1], [43, 2], [53, 2], [54, 2], [80, 3], [83, 3], [81, 4], [44, 4], [82, 5], [79, 5],
]);
// Cuántos tiles vale un nivel de caja al elegir sin objetivo: un Titan (+2) a 10 gana a un Goblin (+1) a 5.
const VALUE_TILES = 6;

/**
 * Objetivo dorado con correa (2026-10-23): el daño repartido entre dorados no mata a ninguno (la caja es
 * del que más le pegó). Se sigue con el actual mientras se vea; solo un dragón lo desplaza (si el actual
 * no es dragón). Sin actual: el dragón más cercano; si no, el dorado de mejor caja según la distancia.
 */
export function stickyGolden<M extends GoldenCandidate>(me: { x: number; y: number }, currentId: number | null, monsters: Iterable<M>, golden: (type: number) => boolean): M | null {
  let cur: M | null = null;
  let dragon: M | null = null;
  let near: M | null = null;
  let dd = Infinity;
  let nd = Infinity;
  for (const m of monsters) {
    const isDragon = DRAGON_TYPES.has(m.type);
    if (!isDragon && !golden(m.type)) continue;
    if (m.id === currentId) cur = m;
    const d = Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y));
    if (isDragon && d < dd) { dd = d; dragon = m; }
    const score = d - (GOLDEN_VALUE.get(m.type) ?? 1) * VALUE_TILES;
    if (score < nd) { nd = score; near = m; }
  }
  if (cur && (DRAGON_TYPES.has(cur.type) || !dragon)) return cur;
  return dragon ?? near;
}

export class GoldenRule {
  private firstSeen = new Map<number, number>();
  private holdUntil = 0;

  /** El dorado a atacar ahora (o null). `golden(type)` dice si un tipo es dorado. */
  pick<M extends GoldenCandidate>(me: { x: number; y: number }, monsters: Iterable<M>, golden: (type: number) => boolean, now: number, currentId: number | null = null): M | null {
    let best: M | null = null;
    let bs = Infinity;
    const seen = new Set<number>();
    for (const m of monsters) {
      const dragon = DRAGON_TYPES.has(m.type);
      if (!dragon && !golden(m.type)) continue;
      seen.add(m.id);
      // El alcance es la distancia real; el bonus de los dragones solo ordena.
      const d = Math.hypot(m.x - me.x, m.y - me.y);
      if (d > GOLDEN_RULE.range) continue;
      // El reloj de "2 min y se deja" arranca cuando entra al alcance, no cuando se lo vio de lejos.
      if (!this.firstSeen.has(m.id)) this.firstSeen.set(m.id, now);
      if (now - this.firstSeen.get(m.id)! > (dragon ? GOLDEN_RULE.dragonGiveUpMs : GOLDEN_RULE.giveUpMs)) continue;
      // Correa: el que ya tiene el golpe gana a cualquiera de su clase (un dragón sigue ganándole a un chico).
      const score = d - (dragon ? GOLDEN_RULE.dragonBonus : 0) - (m.id === currentId ? GOLDEN_RULE.range : 0);
      if (score < bs) { bs = score; best = m; }
    }
    // Los ids que ya no se ven se olvidan (el server los reusa al reaparecer).
    for (const id of this.firstSeen.keys()) if (!seen.has(id)) this.firstSeen.delete(id);
    if (best) this.holdUntil = now + GOLDEN_RULE.lootStayMs;
    return best;
  }

  /** ¿Hay que quedarse (dorado a la vista o recién muerto)? Sin cambio de mapa ni reset. */
  holding(now: number): boolean {
    return now < this.holdUntil;
  }
}

type Fight = { id: number; type: number; seenAt: number; announceAt: number | null; firstHitAt: number | null; lastSeenAt: number; hits: number; dmg: number; ownHits: number; ownDmg: number; hsFirst: number | null; hsLast: number | null; others: Set<string>; sx: number; sy: number; ex: number; ey: number };

