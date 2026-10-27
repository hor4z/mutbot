/**
 * Ayudas chicas sin estado que usan todos los módulos del bot: log, sleep, bytes y la geometría
 * de las 8 direcciones de MU.
 */

export const log = (...a: unknown[]) => console.log(`[bot]`, ...a);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Variación pequeña por acción: conserva SIEMPRE el mínimo humano de config.
// Evita una cadencia idéntica por horas sin acelerar ataques, skills o pasos.
export const humanPace = (minimumMs: number, rand = Math.random) =>
  minimumMs + Math.floor(rand() * Math.min(75, minimumMs * 0.12));

// createSocket emite un DataView; otros paths pueden dar Uint8Array. Normalizamos.
export function toBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error(`payload inesperado: ${typeof data}`);
}

// Deltas de las 8 direcciones del compass de MU, medidos empíricamente con --probe-dir.
export const DIR_DELTA: Record<number, [number, number]> = {
  0: [-1, -1],
  1: [0, -1],
  2: [1, -1],
  3: [1, 0],
  4: [1, 1],
  5: [0, 1],
  6: [-1, 1],
  7: [-1, 0],
};

export function chebyshev(ax: number, ay: number, bx: number, by: number) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export function directionTowards(fromX: number, fromY: number, toX: number, toY: number): number {
  const dx = Math.sign(toX - fromX);
  const dy = Math.sign(toY - fromY);
  for (const [dir, [ddx, ddy]] of Object.entries(DIR_DELTA)) {
    if (ddx === dx && ddy === dy) return Number(dir);
  }
  // Si no hay una dirección exacta (ya llegamos en un eje), probamos la que achique más distancia.
  return dx !== 0 ? (dx > 0 ? 3 : 7) : dy > 0 ? 5 : 1;
}

export type Pos = { x: number; y: number };
export const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y);

