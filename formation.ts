/**
 * Seguir al líder sin amontonarse (lógica pura): cada seguidor mantiene una correa al líder
 * (`near` a `far` tiles), se para en un lugar propio detrás/al costado (nunca encima de otro
 * miembro) y lo cambia de vez en cuando. Nada de formaciones fijas: el ángulo, la distancia y los
 * tiempos de reacción salen del azar de cada seguidor, así dos corridas no hacen la misma
 * trayectoria. El paso a paso lo hace `walkTowards` (loop-ctx.ts, pathfinding con terreno real de
 * path.ts/terrain.ts) y respeta WALK_PACE_MS: esto solo elige A DÓNDE ir.
 *
 * Tests en `formation-tests.ts`.
 */
import { WARD_MAX_DIST } from './duo';
import { dist, type Pos } from './corner';

export type Walkable = (x: number, y: number) => boolean;

export const FOLLOW = {
  /** Más cerca que esto del líder, incómodo: se corre. */
  NEAR: 2,
  /** Más lejos que esto, vuelve. */
  FAR: 9,
  /** Distancia mínima entre dos miembros de la escuadra. */
  APART: 2.5,
  /** Reacción humana: espera antes de empezar a volver (ms). */
  REACT_MS: [700, 2600] as readonly [number, number],
  /** Cada cuánto cambia de lugar de espera (ms). */
  REROLL_MS: [9_000, 24_000] as readonly [number, number],
};

const between = (r: () => number, [lo, hi]: readonly [number, number]) => lo + r() * (hi - lo);

/** El caminable más cercano a `t` (radio 3) o null. */
export function nearestWalkable(walkable: Walkable, t: Pos): Pos | null {
  if (walkable(t.x, t.y)) return t;
  for (let r = 1; r <= 3; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && walkable(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
  return null;
}

export class Follower {
  private angle: number | null = null;
  private radius = 0;
  private rerollAt = 0;
  private reactAt = 0;
  private wasFar = false;
  private trail: Pos[] = [];

  /** `far`: correa máxima (tiles); la campaña de crianza usa una corta (squad.ts FOLLOW_MISSION.LEASH_FAR). */
  constructor(private rand: () => number = Math.random, private far: number = FOLLOW.FAR) {}

  /** Hacia dónde mira el líder: por dónde vino (últimas posiciones distintas). */
  private facing(leader: Pos): number {
    const last = this.trail.at(-1);
    if (!last || last.x !== leader.x || last.y !== leader.y) {
      this.trail.push({ x: leader.x, y: leader.y });
      if (this.trail.length > 6) this.trail.shift();
    }
    const a = this.trail[0], b = this.trail.at(-1)!;
    return a.x === b.x && a.y === b.y ? Math.PI / 2 : Math.atan2(b.y - a.y, b.x - a.x);
  }

  /**
   * Próximo destino, o null si está bien donde está. `others`: dónde están (o van) los demás
   * miembros. `slot`/`slots`: mi lugar entre los seguidores (reparte los ángulos).
   */
  next(now: number, me: Pos, leader: Pos, walkable: Walkable, others: readonly Pos[], slot: number, slots: number): Pos | null {
    const d = dist(me, leader);
    const crowded = others.some((o) => dist(o, me) < FOLLOW.APART);
    const tooClose = d < FOLLOW.NEAR;
    if (this.angle == null || now >= this.rerollAt) this.reroll(now, leader, slot, slots);
    if (d <= this.far && !crowded && !tooClose) { this.wasFar = false; return null; }
    // Reacción humana: no arranca en el mismo tick en que el líder se alejó.
    if (!this.wasFar && !crowded) {
      this.wasFar = true;
      this.reactAt = now + between(this.rand, FOLLOW.REACT_MS);
    }
    if (now < this.reactAt) return null;
    return this.pick(leader, walkable, others, me);
  }

  private reroll(now: number, leader: Pos, slot: number, slots: number) {
    const behind = this.facing(leader) + Math.PI;
    // Los seguidores se abren en abanico detrás del líder; cada uno con su ruido.
    const spread = Math.PI * 0.9;
    const base = slots > 1 ? (slot / (slots - 1) - 0.5) * spread : 0;
    this.angle = behind + base + (this.rand() - 0.5) * 0.7;
    this.radius = FOLLOW.NEAR + 1 + this.rand() * Math.max(1, this.far - FOLLOW.NEAR - 4);
    this.rerollAt = now + between(this.rand, FOLLOW.REROLL_MS);
  }

  private pick(leader: Pos, walkable: Walkable, others: readonly Pos[], me: Pos): Pos | null {
    for (let tries = 0; tries < 8; tries++) {
      const a = this.angle! + (tries ? (this.rand() - 0.5) * 1.6 : 0);
      const r = this.radius + (tries ? this.rand() * 2 : 0);
      const t = nearestWalkable(walkable, { x: Math.round(leader.x + Math.cos(a) * r), y: Math.round(leader.y + Math.sin(a) * r) });
      if (t && !others.some((o) => dist(o, t) < FOLLOW.APART) && (t.x !== me.x || t.y !== me.y)) return t;
    }
    return null;
  }
}

/**
 * Dónde se para un protegido que cobra mientras el padrino pelea: un anillo de 4 a WARD_MAX_DIST del
 * padrino, el punto con menos monstruos a <= 4 (y lejos de los otros protegidos). Entre puntos casi
 * igual de seguros sortea. Es la generalización de `wardSpot` (duo.ts) a cualquier mapa.
 */
export function wardTile(padrino: Pos, monsters: readonly Pos[], walkable: Walkable, others: readonly Pos[], rand: () => number = Math.random): Pos | null {
  const cands: { p: Pos; score: number }[] = [];
  for (let r = 4; r <= WARD_MAX_DIST - 1; r += 1.5)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + rand() * 0.4;
      const p = nearestWalkable(walkable, { x: Math.round(padrino.x + Math.cos(a) * r), y: Math.round(padrino.y + Math.sin(a) * r) });
      if (!p || dist(p, padrino) > WARD_MAX_DIST || others.some((o) => dist(o, p) < FOLLOW.APART)) continue;
      const threat = monsters.filter((m) => dist(m, p) <= 4).length * 3 + monsters.filter((m) => dist(m, p) <= 8).length;
      cands.push({ p, score: threat + dist(p, padrino) * 0.1 });
    }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  const best = cands[0].score;
  const near = cands.filter((c) => c.score <= best + 0.8);
  return near[Math.floor(rand() * near.length)].p;
}
