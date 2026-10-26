/** Estado del botín que comparten el núcleo (panel, mundo) y el cerebro (loot.ts): vive acá para que sobreviva a la recarga del cerebro. */
export type ScopedDrop = { seenAt?: number; id: number; x: number; y: number; group: number; num: number; isMoney?: boolean; amount?: number; excellent?: boolean; level?: number };

/** Los drops en scope (id → drop). */
export const drops = new Map<number, ScopedDrop>();

// Drop que se está yendo a buscar, y cuántos se levantaron en total (panel e informe).
export const lootState = {
  looting: null as { id: number; since: number; pickAt?: number; drop?: { group: number; num: number; x: number; y: number } } | null,
  count: 0,
};
