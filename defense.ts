/**
 * Defensa propia (port de `browser/defense.js`). Usuario: "si te atacan te defendés con todo; si no
 * podés, seguí tu camino". Solo contesta a un JUGADOR que le pegó a este personaje (golpe 0x18 o skill
 * dirigido 0x19, ver `attackerOf` en protocol097.ts) en los últimos 10 s y está a <= 10 tiles: nunca
 * ataca primero, y nunca a los propios (Horaz, Melu). Pelea con el skill más fuerte (Death Stab 43 >
 * Rageful Blow 42 > Twisting Slash 41 > Falling Slash 19). Con vida < 35 % se va a otro mapa de la ruta
 * y lo evita 5 min.
 *
 * Lógica PURA: se testea en `defense-tests.ts`.
 */
export const DEFENSE = { memoryMs: 10_000, chaseTiles: 10, fleeHp: 0.35, avoidMapMs: 5 * 60_000, skills: [43, 42, 41, 19] } as const;

export type PlayerPos = { id: number; x: number; y: number; name?: string };

export class Defense {
  private hitBy = new Map<number, number>();
  private avoid = new Map<number, number>();

  constructor(readonly friends: ReadonlySet<string> = new Set(['horaz', 'melu'])) {}

  /** Un jugador (id) me pegó. Devuelve true si es nuevo (para avisarlo una vez). */
  hit(id: number, now: number): boolean {
    if (this.hitBy.size > 200) for (const [k, t] of this.hitBy) if (now - t > DEFENSE.memoryMs) this.hitBy.delete(k);
    const isNew = !this.hitBy.has(id) || now - this.hitBy.get(id)! > DEFENSE.memoryMs;
    this.hitBy.set(id, now);
    return isNew;
  }

  /** A quién contestarle ahora (el más cercano de los que me pegaron), o null. */
  target<P extends PlayerPos>(me: { x: number; y: number }, players: Iterable<P>, now: number): P | null {
    let best: P | null = null;
    let bd = Infinity;
    for (const p of players) {
      const at = this.hitBy.get(p.id);
      if (at == null || now - at > DEFENSE.memoryMs || (p.name && this.friends.has(p.name.toLowerCase()))) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y); // euclídea, como defense.js y el resto
      if (d <= DEFENSE.chaseTiles && d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** ¿Huir? (vida baja peleando con un jugador). Marca el mapa para evitarlo un rato. */
  shouldFlee(hpPct: number, map: number, now: number): boolean {
    if (hpPct >= DEFENSE.fleeHp) return false;
    this.avoid.set(map, now + DEFENSE.avoidMapMs);
    return true;
  }

  /** ¿Evitar este mapa (huyó de ahí hace poco)? */
  avoiding(map: number, now: number): boolean {
    return (this.avoid.get(map) ?? 0) > now;
  }

  /** El skill para pelear: el primero de DEFENSE.skills que tenga. */
  static skill(have: (n: number) => boolean): number | null {
    return DEFENSE.skills.find(have) ?? null;
  }
}
