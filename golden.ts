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

export const GOLDEN_RULE = { range: 20, dragonBonus: 30, giveUpMs: 120_000, lootStayMs: 15_000 } as const;
export const DRAGON_TYPES: ReadonlySet<number> = new Set([44, 79]);

export class GoldenRule {
  private firstSeen = new Map<number, number>();
  private holdUntil = 0;

  /** El dorado a atacar ahora (o null). `golden(type)` dice si un tipo es dorado. */
  pick<M extends GoldenCandidate>(me: { x: number; y: number }, monsters: Iterable<M>, golden: (type: number) => boolean, now: number): M | null {
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
      if (now - this.firstSeen.get(m.id)! > GOLDEN_RULE.giveUpMs) continue;
      const score = d - (dragon ? GOLDEN_RULE.dragonBonus : 0);
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
