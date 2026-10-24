/**
 * Dónde está parado el bot: la única decisión de "lugar" que existe. Tres casos, de más a menos ambicioso:
 *   corner — el fuerte (mata Gaint Drakan) farmea la esquina de Arena 2 desde el nivel 100: ~300-550M exp/min.
 *   shadow — el que la estación (orquestador) manda a seguir a un compañero más fuerte: va a su mapa, se queda a su lado y
 *            pelea lo que tiene cerca; en party cobra parte de cada kill y crece mucho más que solo. Sigue al líder por
 *            todos los mapas, y cuando resetea o no llega al nivel de un mapa, farmea su spot hasta poder volver.
 *   tier   — sin nadie a quien acompañar: el spot seguro de su nivel (Lorencia, después Devias 4).
 * Cada lugar es un ancla y un radio: se pelea lo más cercano dentro del radio y, sin nada, se espera en el ancla.
 * Los lugares no se miden ni se aprenden; los números de abajo vienen de lo medido jugando (ver docs/arquitectura.md).
 */
import { WARP_COOLDOWN_MS, warpAndWait, type Warp } from './warps';
import { CORNER } from './corner';
import { canFarmMonster, type Fighter } from './power';
import { classFamily } from './farming';
import { bot, world } from './state';
import { directedLeader } from './bus';
import { dist, type Pos } from './util';
import { WARPS, warp } from './warps';

export type Place = { kind: 'corner' | 'shadow' | 'tier'; warp: Warp; anchor: Pos; radius: number; name: string };

/** Spots seguros por nivel (de menor a mayor): ancla = donde se juntan los monstruos que se mataron siempre ahí. */
const TIERS: { minLevel: number; warp: number; anchor: Pos; radius: number }[] = [
  { minLevel: 0, warp: 2, anchor: { x: 132, y: 200 }, radius: 30 },   // Lorencia
  { minLevel: 20, warp: 7, anchor: { x: 58, y: 192 }, radius: 25 },   // Devias 4
];

/** Cuánto se separa del líder al seguirlo (tiles). */
const SHADOW_RADIUS = 6;

export const fighterNow = (): Fighter => ({ family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp });

/** ¿Aguanta la esquina (mata un Gaint Drakan, tipo 75)? Sin stats ni vida todavía: null (no se decide nada). */
export function isStrong(): boolean | null {
  const f = fighterNow();
  if (!(world.maxHp > 0) || !(f.stats.str + f.stats.agi + f.stats.vit + f.stats.ene > 0)) return null;
  return canFarmMonster(f, 75, world.skills.has(41));
}

/** El lugar de este personaje ahora, o null si todavía no se puede decidir (faltan stats y vida). */
export function choosePlace(): Place | null {
  const strong = isStrong();
  if (strong == null) return null;
  const level = world.level;
  // Orden del orquestador: seguir al líder por donde vaya. El warp es el de su mapa más cercano a él al que llego por nivel.
  const leader = directedLeader();
  if (leader) {
    const entries = WARPS.filter((w) => w.map === leader.map && w.reqLevel <= level);
    const wp = [...entries].sort((a, b) => dist(a.arrival ?? leader, leader) - dist(b.arrival ?? leader, leader))[0]
      ?? (world.map === leader.map ? { index: -1, name: `mapa ${leader.map}`, reqLevel: 0, map: leader.map } : null);
    if (wp) return { kind: 'shadow', warp: wp, anchor: { x: leader.x, y: leader.y }, radius: SHADOW_RADIUS, name: `${leader.char} (${wp.name})` };
  }
  if (strong && level >= CORNER.minLevel) return { kind: 'corner', warp: warp(CORNER.warp), anchor: CORNER.home, radius: CORNER.radius + CORNER.fill, name: 'la esquina de Arena 2' };
  const t = [...TIERS].reverse().find((x) => level >= x.minLevel)!;
  return { kind: 'tier', warp: warp(t.warp), anchor: t.anchor, radius: t.radius, name: warp(t.warp).name };
}

/** Un paso hacia el lugar: warp si está en otro mapa. true = viajó o esperó (el tick ya está usado). */
export async function travelTo(place: Place): Promise<boolean> {
  if (world.map === place.warp.map) return false;
  if (Date.now() - bot.lastWarpAt < WARP_COOLDOWN_MS) {
    bot.doing = `esperando para ir a ${place.name}`;
    return true;
  }
  bot.doing = `viajando a ${place.name} (nivel ${world.level})`;
  await warpAndWait(place.warp);
  return true;
}

export { WARPS };
export const farFrom = (place: Place, margin = 0) => dist({ x: world.x, y: world.y }, place.anchor) > place.radius + margin;
