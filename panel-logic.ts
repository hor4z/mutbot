/**
 * Datos puros del panel: nombres de mapa e ítems. Sin estado ni red (se importa también desde scripts/).
 */
import itemsData from './data/items.json';

// Índices de mapa del 0.97d.
export const MAP_NAMES: Record<number, string> = {
  0: 'Lorencia', 1: 'Dungeon', 2: 'Devias', 3: 'Noria', 4: 'Lost Tower', 6: 'Arena',
  7: 'Atlans', 8: 'Tarkan', 33: 'Aida',
};
export const mapName = (n: number): string => MAP_NAMES[n] ?? `mapa ${n}`;

// Ítems: nombre y tamaño en la grilla del inventario (data/items.json del cliente).
const ITEM_INFO = new Map<number, { name: string; w: number; h: number }>(
  (itemsData as { Group: number; Index: number; ItemName: string; X: number; Y: number }[])
    .map((i) => [i.Group * 512 + i.Index, { name: i.ItemName, w: i.X || 1, h: i.Y || 1 }]),
);
export function itemInfo(group: number, num: number): { name: string; w: number; h: number } {
  return ITEM_INFO.get(group * 512 + num) ?? { name: `ítem ${group}/${num}`, w: 1, h: 1 };
}
