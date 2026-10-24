/** Utilidades del mapa: distancia y tipo de casilla (usado por el radar). */
export const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export function tileKind(v: number): "safe" | "blocked" | "water" | "walk" {
  return v & 12 ? "blocked" : v & 1 ? "safe" : v & 16 ? "water" : "walk";
}
export const TILE_LABEL = { safe: "Zona segura", blocked: "No transitable", water: "Agua / decorado", walk: "Transitable" } as const;
