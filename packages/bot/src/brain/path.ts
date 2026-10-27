/**
 * Caminos con el terreno del cliente (`.att`, terrain.ts): A* en la grilla de 256×256 con los 8 pasos
 * de MU (cada uno cuesta 1). Sin cortar esquinas: un paso en diagonal pide que los dos lados
 * rectos también sean caminables (si no, el server rechaza el paso). Antes el bot caminaba en línea
 * recta y rodeaba a tientas: Melu quedó trabada en un corral de Arena 2 contra la cerca.
 *
 * Lógica PURA (la grilla entra como función): se testea en `path-tests.ts`.
 */
export type Pos = { x: number; y: number };

const STEPS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Camino de `from` a `to` (incluidos los dos), o null si no hay o pasa de `limit` nodos. Si `to` no
 * es caminable, va al caminable más cercano a él (a <= 3).
 */
export function findPath(walkable: (x: number, y: number) => boolean, from: Pos, to: Pos, limit = 8000): Pos[] | null {
  let goal = to;
  if (!walkable(to.x, to.y)) {
    let best: Pos | null = null;
    for (let r = 1; r <= 3 && !best; r++)
      for (let dx = -r; dx <= r && !best; dx++)
        for (let dy = -r; dy <= r; dy++)
          if (walkable(to.x + dx, to.y + dy)) { best = { x: to.x + dx, y: to.y + dy }; break; }
    if (!best) return null;
    goal = best;
  }
  const key = (x: number, y: number) => y * 256 + x;
  const h = (x: number, y: number) => Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y));
  const g = new Map<number, number>([[key(from.x, from.y), 0]]);
  const came = new Map<number, number>();
  // Cola de prioridad simple (binaria) por f = g + h.
  const open: [number, number, number][] = [[h(from.x, from.y), from.x, from.y]];
  const push = (n: [number, number, number]) => {
    open.push(n);
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p][0] <= open[i][0]) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < open.length && open[l][0] < open[m][0]) m = l;
        if (r < open.length && open[r][0] < open[m][0]) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i], open[m]];
        i = m;
      }
    }
    return top;
  };
  let seen = 0;
  while (open.length && seen++ < limit) {
    const [, x, y] = pop();
    if (x === goal.x && y === goal.y) {
      const out: Pos[] = [];
      let k: number | undefined = key(x, y);
      while (k != null) {
        out.push({ x: k % 256, y: Math.floor(k / 256) });
        k = came.get(k);
      }
      return out.reverse();
    }
    const gk = g.get(key(x, y))!;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx > 255 || ny > 255 || !walkable(nx, ny)) continue;
      if (dx && dy && (!walkable(x + dx, y) || !walkable(x, y + dy))) continue;
      const nk = key(nx, ny);
      if (g.has(nk) && g.get(nk)! <= gk + 1) continue;
      g.set(nk, gk + 1);
      came.set(nk, key(x, y));
      push([gk + 1 + h(nx, ny), nx, ny]);
    }
  }
  return null;
}

/** Tramo recto Bresenham entre dos casillas (con las dos incluidas) si cada paso es válido (sin cortar esquinas); si no, null. */
export function straightLine(walkable: (x: number, y: number) => boolean, a: Pos, b: Pos): Pos[] | null {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const out: Pos[] = [a];
  let px = a.x, py = a.y;
  for (let k = 1; k <= n; k++) {
    const x = a.x + Math.round(((b.x - a.x) * k) / n);
    const y = a.y + Math.round(((b.y - a.y) * k) / n);
    if (x < 0 || y < 0 || x > 255 || y > 255 || !walkable(x, y)) return null;
    if (x !== px && y !== py && (!walkable(px + (x - px), py) || !walkable(px, py + (y - py)))) return null;
    out.push({ x, y });
    px = x; py = y;
  }
  return out;
}

/**
 * Suaviza un camino de findPath con línea de vista (estilo Theta*): cada tramo se cambia por la recta más
 * larga transitable (ventana de 40 casillas). Nunca queda más largo que el original ni cambia los extremos.
 */
export function smoothPath(walkable: (x: number, y: number) => boolean, path: readonly Pos[]): Pos[] {
  if (path.length < 3) return [...path];
  const out: Pos[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let took = false;
    for (let j = Math.min(path.length - 1, i + 40); j > i + 1; j--) {
      const seg = straightLine(walkable, path[i], path[j]);
      if (seg && seg.length - 1 <= j - i) { out.push(...seg.slice(1)); i = j; took = true; break; }
    }
    if (!took) { out.push(path[i + 1]); i++; }
  }
  return out;
}
