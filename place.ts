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
import { directedLeader, myShadows } from './bus';
import { isSafeZone, walkableFor } from './terrain';
import { dist, type Pos } from './util';
import { WARPS, warp } from './warps';

export type Place = { kind: 'corner' | 'shadow' | 'fetch' | 'tier'; warp: Warp; anchor: Pos; radius: number; name: string };

/** Spots seguros por nivel (de menor a mayor): ancla = donde se juntan los monstruos que se mataron siempre ahí. */
const TIERS: { minLevel: number; warp: number; anchor: Pos; radius: number }[] = [
  { minLevel: 0, warp: 2, anchor: { x: 132, y: 200 }, radius: 30 },   // Lorencia
  { minLevel: 20, warp: 7, anchor: { x: 58, y: 192 }, radius: 25 },   // Devias 4
];

/** Radio de pelea alrededor del punto de la sombra: solo lo que se le acerca. */
const SHADOW_RADIUS = 3;
/** Las Arenas: el monstruo que hay que poder matar para cruzarlas solo (Deathvim Knight 63, Phantom Knight 72, Gaint Drakan 75). */
const CROSS_GATE: Record<number, number> = { 83: 63, 84: 72, 85: 75 };
/** Con el líder a menos de esto en el mismo mapa, el débil va con él (está protegido); más lejos, en una Arena, espera en la entrada. */
const WITH_RADIUS = 40;
/** Dónde se para la sombra respecto del líder: a esta distancia (tiles) y a lo sumo a MAX_FROM_LEADER, para seguir cobrando la party. */
const SHADOW_DIST = 7;
const MAX_FROM_LEADER = 9;
let shadowSpot: Pos | null = null;

/**
 * El lugar de la sombra: un punto caminable cerca del líder pero lejos de donde pelea (el líder aguanta los monstruos, el débil
 * no). De las 8 direcciones a SHADOW_DIST elige la de menos monstruos a <= 4 tiles; el punto anterior se mantiene mientras siga
 * sirviendo, para no dar vueltas cada vez que el líder se mueve un tile.
 */
function shadowSpotNear(leader: Pos): Pos {
  const walk = walkableFor(world.map);
  const mons = [...world.npcs.values()];
  const threat = (p: Pos) => mons.filter((m) => dist(m, p) <= 4).length;
  const ok = (p: Pos) => p.x >= 0 && p.y >= 0 && p.x < 256 && p.y < 256 && walk(p.x, p.y) && !isSafeZone(world.map, p.x, p.y) && dist(p, leader) <= MAX_FROM_LEADER;
  if (shadowSpot && ok(shadowSpot) && threat(shadowSpot) <= 1 && dist(shadowSpot, leader) >= 3) return shadowSpot;
  let best: Pos | null = null;
  let bs = Infinity;
  for (let a = 0; a < 8; a++) {
    for (const r of [SHADOW_DIST, SHADOW_DIST - 2]) {
      const p = { x: Math.round(leader.x + Math.cos((a * Math.PI) / 4) * r), y: Math.round(leader.y + Math.sin((a * Math.PI) / 4) * r) };
      if (!ok(p)) continue;
      const s = threat(p) * 10 + dist(p, { x: world.x, y: world.y }) / 10;
      if (s < bs) { bs = s; best = p; }
    }
  }
  shadowSpot = best ?? leader;
  return shadowSpot;
}

/** El líder baja a buscar a su sombra como mucho una vez cada tanto (le cuesta exp: no está en la esquina). */
const FETCH_COOLDOWN_MS = 3 * 60_000;
let fetchedAt = 0;

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
  // El líder baja a buscar a su sombra, que espera en la entrada de una Arena porque no puede cruzarla sola.
  const waiting = myShadows().find((m) => m.map === world.map && CROSS_GATE[m.map] != null && dist(m, { x: world.x, y: world.y }) > WITH_RADIUS);
  if (waiting && Date.now() - fetchedAt > FETCH_COOLDOWN_MS) {
    if (dist(waiting, { x: world.x, y: world.y }) <= 12) fetchedAt = Date.now();
    else return { kind: 'fetch', warp: WARPS.find((w) => w.map === world.map) ?? warp(CORNER.warp), anchor: { x: waiting.x, y: waiting.y }, radius: 6, name: `${waiting.char} en la entrada` };
  }
  // Orden del orquestador: seguir al líder por donde vaya. El warp es la entrada de su mapa más cercana a él a la que llego por nivel.
  // Solo vale seguirlo si va a un lugar que rinde: la esquina o una cacería (cuando recién resetea y está bajo, cada uno a lo suyo).
  const lead = directedLeader();
  const leader = lead && (lead.level >= CORNER.minLevel || lead.mode === 'hunt') ? lead : null;
  if (leader) {
    const entries = WARPS.filter((w) => w.map === leader.map && w.reqLevel <= level);
    const wp = [...entries].sort((a, b) => dist(a.arrival ?? leader, leader) - dist(b.arrival ?? leader, leader))[0]
      ?? (world.map === leader.map ? { index: -1, name: `mapa ${leader.map}`, reqLevel: 0, map: leader.map } : null);
    if (wp) {
      const gate = CROSS_GATE[leader.map];
      const apart = world.map !== leader.map || dist(leader, { x: world.x, y: world.y }) > WITH_RADIUS;
      // Una Arena que no puedo cruzar sola y el líder lejos: espero en la entrada a que me recoja.
      if (gate != null && apart && !canFarmMonster(fighterNow(), gate, world.skills.has(41)) && wp.arrival)
        return { kind: 'shadow', warp: wp, anchor: wp.arrival, radius: 5, name: `la entrada de ${wp.name} (espero a ${leader.char})` };
      return { kind: 'shadow', warp: wp, anchor: shadowSpotNear({ x: leader.x, y: leader.y }), radius: SHADOW_RADIUS, name: `${leader.char} (${wp.name})` };
    }
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
