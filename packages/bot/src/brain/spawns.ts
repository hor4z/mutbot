/**
 * Dónde nacen los monstruos (tabla `spawns` de la base, sembrada desde la `reference/spawns.json` del cliente, por mapa: tipo, rectángulo
 * y cantidad). Con el terreno sirve para elegir un destino concreto en vez de explorar a ciegas: la celda más densa de monstruos que el
 * personaje puede pelear, caminable y fuera de zona segura. Coincide con lo medido en el Slow (los Giants de Lorencia nacen en [8,11,60,80]).
 */
import { monsters, onGameData, spawns as spawnsData, type Spawn } from '../core/gamedata';
import { isSafeZone, isWalkable, TERRAIN_SIZE } from '../core/terrain';
import { dist } from '../core/util';

export type { Spawn };
const LEVEL = new Map<number, number>();
onGameData('spawns', () => {
  LEVEL.clear();
  for (const m of monsters) LEVEL.set(m.Numb, m.Level);
});

export const spawnsOf = (map: number): Spawn[] => spawnsData[String(map)] ?? [];
/** Los tipos 200-299 son NPC de pueblo, no monstruos. */
export const isMonster = (type: number) => !(type >= 200 && type <= 299);

/**
 * Un "nido" es un spawn fijo de 1 tile con varios monstruos juntos (10 Elite Yeti en (36,25) de Devias): densísimo y mortal. Las celdas a menos de
 * esta distancia de un nido no se ofrecen como destino (Capitan murió en Devias 2, cuyo warp deja a 12 tiles del nido).
 */
export const NEST_KEEP_OUT = 26;
const NEST_MIN_QTY = 5;

/** Un rectángulo de 1 tile (evento o spawn fijo) se trata como mínimo de este tamaño, para que no parezca densísimo. */
const MIN_AREA = 100;
const CELL = 8;

export type Hotspot = { x: number; y: number; density: number; walkable: number };

/** Celdas de CELL×CELL con la densidad esperada de monstruos que pasan `filter` (monstruos por tile), solo las caminables y fuera de zona segura. */
export function hotspots(map: number, filter: (type: number) => boolean): Hotspot[] {
  const all = spawnsOf(map).filter((s) => isMonster(s.type));
  const nests = all.filter((s) => s.rect[0] === s.rect[2] && s.rect[1] === s.rect[3] && s.qty >= NEST_MIN_QTY);
  const spawns = all.filter((s) => filter(s.type));
  const out: Hotspot[] = [];
  for (let cy = 0; cy < TERRAIN_SIZE; cy += CELL) {
    for (let cx = 0; cx < TERRAIN_SIZE; cx += CELL) {
      const mx = cx + CELL / 2, my = cy + CELL / 2;
      if (nests.some((n) => dist({ x: mx, y: my }, { x: n.rect[0], y: n.rect[1] }) < NEST_KEEP_OUT)) continue;
      let density = 0;
      for (const s of spawns) {
        const [x1, y1, x2, y2] = s.rect;
        if (mx < x1 || mx > x2 || my < y1 || my > y2) continue;
        density += s.qty / Math.max(MIN_AREA, (x2 - x1 + 1) * (y2 - y1 + 1));
      }
      if (density <= 0) continue;
      let ok = 0;
      for (let y = cy; y < cy + CELL; y++) for (let x = cx; x < cx + CELL; x++) if (isWalkable(map, x, y) && !isSafeZone(map, x, y)) ok++;
      out.push({ x: mx, y: my, density, walkable: ok / (CELL * CELL) });
    }
  }
  return out;
}

/** Densidad mínima que ya sabemos que rinde: la de los Giants de Lorencia (15 en [8,11,60,80]), unos 0,004 monstruos por tile. */
export const MIN_DENSITY = 0.004;

