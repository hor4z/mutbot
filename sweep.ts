/**
 * Rastrillaje de la cacería por VISIÓN (2026-10-23, usuario viendo a Hume en Lorencia: "se detiene en
 * lugares, va muy por los bordes y no tiene una buena estrategia", "no hace falta ir hasta la punta para
 * ver si hay un dorado"). Reemplaza al recorrido en celdas de 25 tiles (HuntExplorer) cuando se conoce el
 * terreno:
 *  - La cobertura es lo VISTO: toda casilla caminable a <= R tiles (Chebyshev, como el scope del server) de
 *    donde estuvo el bot. Sin línea de vista: el scope del server es por distancia, no por paredes.
 *  - Los objetivos son puntos del INTERIOR caminable (>= 2 casillas de paredes), en una retícula de
 *    ~1,5 × R (carriles), y se elige el que da más casillas nuevas por camino (utilidad / costo), con un
 *    poco de continuidad de rumbo (sale una serpentina sola). Un objetivo se da por hecho cuando desde
 *    donde se está ya se ve casi todo lo que daría: no se llega a las puntas.
 *  - El siguiente objetivo se elige antes de llegar al actual (`after`): cero paradas.
 *  - Previo blando (zonas de la base, mezcladas con uniforme): pesa la utilidad; una vuelta vacía no cambia
 *    el previo de un objetivo ya visto (se baja al visitarlo), un dorado visto lo sube.
 *  - Termina la vuelta con >= 95 % del área vista (o sin objetivos que valgan).
 *
 * Lógica PURA (el terreno entra como función): se testea en `sweep-tests.ts`.
 */
export type Pos = { x: number; y: number };
export const SWEEP = { defaultR: 9, minR: 8, maxR: 12, spacingK: 1.5, clearance: 2, doneAt: 0.95, giveUpMs: 45_000, arrive: 3, minNewFrac: 0.1, prior: 0.3, detect: 0.8 } as const;
const N = 256;

/** Radio de visión a usar: el máximo observado de objetos en scope, entre minR y maxR; sin datos, defaultR. */
export function scopeRadius(observedMax: number): number {
  return observedMax >= SWEEP.minR ? Math.min(SWEEP.maxR, Math.floor(observedMax)) : SWEEP.defaultR;
}

/** Previo de las zonas (n avistamientos cada una): mezcla suave, 1 = sin información. */
export function zonePrior(zones: readonly { x: number; y: number; n: number }[], sigma = 20): (x: number, y: number) => number {
  const total = zones.reduce((s, z) => s + z.n, 0);
  if (!total) return () => 1;
  return (x, y) => {
    let v = 0;
    for (const z of zones) v += (z.n / total) * Math.exp(-((x - z.x) ** 2 + (y - z.y) ** 2) / (2 * sigma * sigma));
    return v * 6; // ~1 = promedio sobre una zona fuerte; el mezclado con el uniforme lo acota
  };
}

type Wp = { x: number; y: number; p: number; done: boolean };

export class SweepPlanner {
  readonly R: number;
  /** Casillas del área a cubrir (caminables, alcanzables, fuera de zona segura). */
  readonly area: Uint8Array;
  readonly areaCount: number;
  readonly seen = new Uint8Array(N * N);
  seenCount = 0;
  readonly wps: Wp[] = [];
  goal: (Pos & { since: number; idx: number }) | null = null;
  after: number | null = null;
  passes = 0;
  private interior = new Uint8Array(N * N);
  private heading: Pos = { x: 0, y: 0 };
  private last: Pos;

  constructor(walkable: (x: number, y: number) => boolean, isSafe: (x: number, y: number) => boolean, start: Pos, observedMax = 0, prior: (x: number, y: number) => number = () => 1) {
    this.R = scopeRadius(observedMax);
    const w = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && walkable(x, y);
    // Alcanzables desde el bot (paso de MU: sin cortar esquinas).
    const reach = new Uint8Array(N * N);
    const q: number[] = [];
    let s = start;
    if (!w(s.x, s.y)) {
      outer: for (let r = 1; r <= 6; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (w(s.x + dx, s.y + dy)) { s = { x: s.x + dx, y: s.y + dy }; break outer; }
    }
    this.last = s;
    if (w(s.x, s.y)) { reach[s.y * N + s.x] = 1; q.push(s.y * N + s.x); }
    for (let h = 0; h < q.length; h++) {
      const x = q[h] % N, y = Math.floor(q[h] / N);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!w(nx, ny) || reach[ny * N + nx]) continue;
        if (dx && dy && (!w(x + dx, y) || !w(x, y + dy))) continue;
        reach[ny * N + nx] = 1;
        q.push(ny * N + nx);
      }
    }
    this.area = new Uint8Array(N * N);
    let count = 0;
    for (let i = 0; i < N * N; i++) if (reach[i] && !isSafe(i % N, Math.floor(i / N))) { this.area[i] = 1; count++; }
    this.areaCount = count;
    // Interior: alcanzable y con todo el cuadrado de `clearance` caminable.
    const c = SWEEP.clearance;
    let interiorCount = 0;
    for (let i = 0; i < N * N; i++) {
      if (!this.area[i]) continue;
      const x = i % N, y = Math.floor(i / N);
      let ok = true;
      for (let dx = -c; dx <= c && ok; dx++) for (let dy = -c; dy <= c; dy++) if (!w(x + dx, y + dy)) { ok = false; break; }
      if (ok) { this.interior[i] = 1; interiorCount++; }
    }
    // Retícula de carriles (~1,5 R) con cada punto pegado al interior más cercano; después, lo que quede
    // fuera del alcance de todos los puntos recibe el suyo.
    const sp = Math.max(4, Math.round(SWEEP.spacingK * this.R));
    const pr = (x: number, y: number) => (1 - SWEEP.prior) + SWEEP.prior * prior(x, y);
    const near = (cx: number, cy: number): Pos | null => {
      for (let r = 0; r <= sp; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < N && y < N && this.interior[y * N + x]) return { x, y };
      }
      return null;
    };
    const cover = new Uint8Array(N * N);
    const add = (p: Pos) => {
      this.wps.push({ x: p.x, y: p.y, p: pr(p.x, p.y), done: false });
      for (let dx = -this.R; dx <= this.R; dx++) for (let dy = -this.R; dy <= this.R; dy++) {
        const x = p.x + dx, y = p.y + dy;
        if (x >= 0 && y >= 0 && x < N && y < N) cover[y * N + x] = 1;
      }
    };
    if (interiorCount) {
      for (let cy = Math.floor(sp / 2); cy < N; cy += sp) for (let cx = Math.floor(sp / 2); cx < N; cx += sp) {
        const p = near(cx, cy);
        if (p && !cover[p.y * N + p.x]) add(p);
      }
      for (let i = 0; i < N * N; i++) if (this.interior[i] && !cover[i]) add({ x: i % N, y: Math.floor(i / N) });
    } else {
      // Mapa sin interior (corredores finos): puntos sobre el área misma.
      for (let i = 0; i < N * N; i++) if (this.area[i] && !cover[i]) add({ x: i % N, y: Math.floor(i / N) });
    }
  }

  get coverage(): number { return this.areaCount ? this.seenCount / this.areaCount : 1; }

  /** Marca como vistas las casillas del área a <= R del bot. */
  see(x: number, y: number) {
    this.last = { x, y };
    const R = this.R;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= N) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= N) continue;
        const i = yy * N + xx;
        if (this.area[i] && !this.seen[i]) { this.seen[i] = 1; this.seenCount++; }
      }
    }
  }

  /** Casillas del área todavía no vistas que se verían desde (x, y). */
  newFrom(x: number, y: number): number {
    const R = this.R;
    let n = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= N) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= N) continue;
        const i = yy * N + xx;
        if (this.area[i] && !this.seen[i]) n++;
      }
    }
    return n;
  }

  private get minNew(): number { return Math.max(8, Math.round(SWEEP.minNewFrac * (2 * this.R + 1) ** 2)); }

  /** Mejor objetivo no hecho desde `from`: casillas nuevas × previo / (costo + 8), con algo de continuidad de rumbo. */
  private pick(from: Pos, skip = -1): number | null {
    let best = -1;
    let bs = 0;
    for (let i = 0; i < this.wps.length; i++) {
      const w = this.wps[i];
      if (w.done || i === skip) continue;
      const nu = this.newFrom(w.x, w.y);
      if (nu < this.minNew) { w.done = true; continue; }
      const d = Math.max(Math.abs(w.x - from.x), Math.abs(w.y - from.y));
      let s = (nu * w.p) / (d + 8);
      const dot = (w.x - from.x) * this.heading.x + (w.y - from.y) * this.heading.y;
      if (dot > 0) s *= 1.15;
      if (s > bs) { bs = s; best = i; }
    }
    return best >= 0 ? best : null;
  }

  /** Un dorado visto en (x, y): sube el previo de los objetivos cerca. */
  hint(x: number, y: number) {
    for (const w of this.wps) if (Math.max(Math.abs(w.x - x), Math.abs(w.y - y)) <= 2 * this.R) w.p = Math.min(w.p * 2, 6);
  }

  private visit(i: number) {
    const w = this.wps[i];
    w.done = true;
    w.p *= 1 - SWEEP.detect; // recorrido sin ver nada: baja
  }

  /** A dónde caminar ahora (se llama en cada vuelta con la posición). Marca lo visto. */
  next(x: number, y: number, now: number): Pos {
    this.see(x, y);
    if (this.goal) {
      const g = this.goal;
      const reached = Math.max(Math.abs(g.x - x), Math.abs(g.y - y)) <= SWEEP.arrive || this.newFrom(g.x, g.y) < this.minNew;
      if (reached || now - g.since > SWEEP.giveUpMs) {
        this.visit(g.idx);
        this.heading = { x: Math.sign(g.x - this.last.x) || this.heading.x, y: Math.sign(g.y - this.last.y) || this.heading.y };
        const nxt = this.after != null && !this.wps[this.after].done ? this.after : this.pick({ x, y });
        this.goal = nxt == null ? null : { x: this.wps[nxt].x, y: this.wps[nxt].y, since: now, idx: nxt };
        this.after = null;
      }
    }
    if (!this.goal || this.coverage >= SWEEP.doneAt) {
      if (this.coverage >= SWEEP.doneAt || this.pick({ x, y }) == null) {
        // Vuelta completa: otra (los dorados se mueven y reaparecen). Lo visto se olvida; el previo queda bajado.
        this.passes++;
        this.seen.fill(0);
        this.seenCount = 0;
        for (const w of this.wps) w.done = false;
        this.goal = null;
        this.see(x, y);
      }
      const i = this.pick({ x, y });
      if (i == null) return { x, y };
      this.goal = { x: this.wps[i].x, y: this.wps[i].y, since: now, idx: i };
    }
    if (this.after == null) this.after = this.pick({ x: this.goal.x, y: this.goal.y }, this.goal.idx);
    return this.goal;
  }
}
