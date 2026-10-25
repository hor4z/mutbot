/**
 * Reparto del rastrillaje entre los que cazan juntos en un mapa (lógica pura): cada uno barre su franja contigua en vez de
 * recorrer los tres lo mismo (medido el 24/10: cazando a la vez, los pares estaban a < 15 tiles el 60-73 % del tiempo).
 */
export type Pt = { x: number; y: number };

/**
 * Parte los puntos en `n` franjas contiguas de igual cantidad, a lo largo del eje donde se extienden más.
 * Devuelve la franja (0..n-1) de cada punto; con n <= 1 todos son de la 0.
 */
export function bandsOf<P extends Pt>(points: readonly P[], n: number): Map<P, number> {
  const out = new Map<P, number>();
  if (n <= 1 || points.length === 0) {
    for (const p of points) out.set(p, 0);
    return out;
  }
  const span = (k: 'x' | 'y') => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]));
  const main = span('x') >= span('y') ? 'x' : 'y';
  const other = main === 'x' ? 'y' : 'x';
  const sorted = [...points].sort((a, b) => a[main] - b[main] || a[other] - b[other]);
  sorted.forEach((p, i) => out.set(p, Math.min(n - 1, Math.floor((i * n) / sorted.length))));
  return out;
}

/** Mi lugar entre los que cazan (nombres en minúscula, ordenados): el mismo orden en todos, sin hablar entre ellos. */
export function crewRank(me: string, others: readonly string[]): { rank: number; n: number } {
  const names = [...new Set([...others.map((s) => s.toLowerCase()), me.toLowerCase()])].sort();
  return { rank: names.indexOf(me.toLowerCase()), n: names.length };
}
