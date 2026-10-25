/**
 * Dónde está parado el bot: la única decisión de "lugar" que existe. Tres casos, de más a menos ambicioso:
 *   corner — el fuerte (mata Gaint Drakan) farmea la esquina de Arena 2 desde el nivel 100: ~300-550M exp/min.
 *   shadow — el que la estación (orquestador) manda a seguir a un compañero más fuerte: va a su mapa, se queda a su lado y
 *            pelea lo que tiene cerca; en party cobra parte de cada kill y crece mucho más que solo. Sigue al líder por
 *            todos los mapas, y cuando resetea o no llega al nivel de un mapa, farmea su spot hasta poder volver.
 *   carreo — un personaje de nivel bajo (< CARRY_UNTIL) que sigue a un líder pide, por el bus, que el líder baje a su mapa y
 *            pelee a su lado en party hasta que suba (el lugar del líder es `fetch`). Con menos nivel que el warp más bajo (10) no puede
 *            ir a ningún mapa: farmea donde está mientras el líder llega.
 *   tier   — sin nadie a quien acompañar: el spot seguro de su nivel (Lorencia, después Devias 4).
 * Cada lugar es un ancla y un radio: se pelea lo más cercano dentro del radio y, sin nada, se espera en el ancla.
 * Los lugares no se miden ni se aprenden; los números de abajo vienen de lo medido jugando (ver docs/arquitectura.md).
 */
import { WARP_COOLDOWN_MS, warpAndWait, type Warp } from './warps';
import { CORNER } from './corner';
import { canFarmMonster, type Fighter } from './power';
import { classFamily } from './farming';
import { bot, expLog, isMate, world } from './state';
import { directedLeader, followHumanTarget, myShadows, setNeedsCarry, setWaiting } from './bus';
import { isSafeZone, walkableFor } from './terrain';
import { trackEvent } from './telemetry';
import { dist, type Pos } from './util';
import { WARPS, warp } from './warps';
import { lowLevelZones } from './zones';

export type Place = { kind: 'corner' | 'shadow' | 'fetch' | 'tier'; warp: Warp; anchor: Pos; radius: number; name: string };

/** Spots seguros por nivel (de menor a mayor): ancla = donde se juntan los monstruos que se mataron siempre ahí. */
const TIERS: { minLevel: number; warp: number; anchor: Pos; radius: number }[] = [
  { minLevel: 0, warp: 2, anchor: { x: 132, y: 200 }, radius: 30 },   // Lorencia
  { minLevel: 20, warp: 7, anchor: { x: 58, y: 192 }, radius: 25 },   // Devias 4
];

/** Carreo: una sombra de nivel menor a esto pide que el líder la acompañe (sube de nivel muy rápido en party con alguien fuerte). */
/** El carreo dura mientras la sombra no aguante lo de Arena 2 (donde farmea el líder): a nivel 100 el warp la deja, pero con ~1.300 de vida la matan en la entrada (69 muertes en 30 min). */
const CARRY_UNTIL = 0; // sin tope por nivel: ver canCross en choosePlace
/** Vida mínima para los spots de más nivel que Lorencia (el nivel solo no alcanza: un personaje nuevo tiene poca vida). */
const TIER_MIN_HP = 500;
/** El carreo se puede apagar con MUBOT_CARRY=0. */
const CARRY_ENABLED = process.env.MUBOT_CARRY !== '0';
/** Con menos nivel que el warp más bajo no se puede ir a ningún mapa: hay que farmear donde se está. */
const MIN_WARP_LEVEL = Math.min(...WARPS.map((w) => w.reqLevel));
const WAIT_MONSTERS_MS = 25_000;
/**
 * Dónde farmear cuando el lugar se quedó sin monstruos (otros jugadores se los llevan, o son pocos): `home` mientras gane exp; si
 * pasan WAIT_MONSTERS_MS sin ganar nada, la mejor zona con monstruos cercana a `home` que no probó (las zonas salen de `ticks`, ver
 * zones.ts); sin más zonas, vuelve a `home`. Una instancia por lugar (no se mezclan los recuerdos).
 */
class Roamer {
  private cur: { map: number; pos: Pos; since: number } | null = null;
  private seenAt = 0;
  private visited: Pos[] = [];
  constructor(private readonly startBest = false) {}
  spot(map: number, home: Pos, from: Pos, maxDist: number): Pos {
    const now = Date.now();
    // Cuenta que gana exp o mata algo (un líder muy por encima del monstruo mata sin ganar exp), no que haya un monstruo en pantalla: puede estar a la vista y no ser atacable desde acá.
    if (expLog.perMin(now, WAIT_MONSTERS_MS) > 0 || now - bot.lastKillAt < WAIT_MONSTERS_MS) this.seenAt = now;
    const pick = (): Pos => {
      const score = (z: Pos & { n: number }) => z.n / (1 + dist(z, from) / 15);
      const z = lowLevelZones(map).filter((q) => dist(q, home) <= maxDist && !this.visited.some((v) => dist(v, q) < 24)).sort((a, b) => score(b) - score(a))[0];
      return z ? { x: z.x, y: z.y } : home;
    };
    if (!this.cur || this.cur.map !== map) {
      this.visited = [];
      this.cur = { map, pos: this.startBest ? pick() : home, since: now };
      this.seenAt = now;
    } else if (now - this.seenAt > WAIT_MONSTERS_MS && now - this.cur.since > WAIT_MONSTERS_MS) {
      this.visited.push(this.cur.pos);
      if (this.visited.length > 8) this.visited.length = 0;
      this.cur = { map, pos: pick(), since: now };
      this.seenAt = now;
    }
    return this.cur.pos;
  }
}
const strandedRoam = new Roamer(true);
const tierRoam = new Roamer();
const carryRoam = new Roamer(true);
/** Los warps cuestan zen: tras un warp sin respuesta no se reintenta hasta tener algo más de plata que la vez que falló (no se sabe cuánto cuesta). */
let warpFails = 0;
let lastFailZen = 0;
const canWarpNow = () => world.level >= MIN_WARP_LEVEL && (warpFails === 0 || bot.lastMoney >= lastFailZen + 500);
let carryingAt = 0;
/** ¿Está en pleno carreo (de uno u otro lado)? Entonces la falta de exp no es una sesión rota (farm-loop no reconecta). */
export const isCarrying = () => Date.now() - carryingAt < 5_000;

/** Spots del carreo según el menor nivel de los dos (home null: sin ancla fija, se usa la zona con más monstruos del mapa). */
const CARRY_TIERS: { min: number; warp: number; home: Pos | null; radius: number }[] = [
  { min: 0, warp: 2, home: { x: 132, y: 200 }, radius: 30 },    // Lorencia
  { min: 20, warp: 7, home: { x: 58, y: 192 }, radius: 25 },    // Devias 4
  { min: 70, warp: 11, home: null, radius: 14 },                // Atlans
  { min: 140, warp: 21, home: null, radius: 14 },               // Tarkan
];
const hiRoam = new Roamer(true);
/** Última posición donde se vio al humano que se sigue (pista para buscarlo si se pierde de vista). */
let humanLast: { map: number; pos: Pos | null } | null = null;

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

/**
 * ¿Sigo a un líder que vale la pena (está en la esquina o cazando)? Entonces no salgo a cazar por mi cuenta: en una invasión
 * cazo como su sombra, en party y detrás de él (cobro la parte de cada dorado que mata); solo no aguantaría ni un dragón.
 */
export function followsLeader(): boolean {
  const lead = directedLeader();
  return !!lead && (lead.level >= CORNER.minLevel || lead.mode === 'hunt');
}

/** El líder baja a buscar a su sombra como mucho una vez cada tanto (le cuesta exp: no está en la esquina). */
const FETCH_COOLDOWN_MS = 3 * 60_000;
let fetchedAt = 0;
let fetchStart = 0;

export const fighterNow = (): Fighter => ({ family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp });

/** ¿Aguanta la esquina (mata un Gaint Drakan, tipo 75)? Sin stats ni vida todavía: null (no se decide nada). */
export function isStrong(): boolean | null {
  const f = fighterNow();
  if (!(world.maxHp > 0) || !(f.stats.str + f.stats.agi + f.stats.vit + f.stats.ene > 0)) return null;
  return canFarmMonster(f, 75, world.skills.has(41));
}

/** El lugar de este personaje ahora, o null si todavía no se puede decidir (faltan stats y vida). */
export function choosePlace(): Place | null {
  setWaiting(false);
  setNeedsCarry(0);
  const strong = isStrong();
  if (strong == null) return null;
  const level = world.level;
  // Seguir a un humano propio (el usuario jugando a mano): si está en pantalla, a su lado; si no, al mapa y la posición que se le dieron (o la
  // última donde se lo vio). Pide party apenas lo ve (help.ts).
  const human = followHumanTarget();
  if (human) {
    const me = { x: world.x, y: world.y };
    const seen = [...world.players.values()].find((q) => q.name?.toLowerCase() === human.name.toLowerCase());
    const here: Warp = { index: -1, name: `mapa ${world.map}`, reqLevel: 0, map: world.map };
    if (seen) {
      humanLast = { map: world.map, pos: { x: seen.x, y: seen.y } };
      return { kind: 'shadow', warp: here, anchor: shadowSpotNear({ x: seen.x, y: seen.y }), radius: 8, name: `${human.name} (seguir)` };
    }
    const hint = humanLast ?? (human.map != null ? { map: human.map, pos: human.x != null && human.y != null ? { x: human.x, y: human.y } : null } : null);
    if (hint && hint.map !== world.map) {
      const wp = WARPS.find((w) => w.map === hint.map && w.reqLevel <= level);
      if (wp && canWarpNow()) return { kind: 'tier', warp: wp, anchor: hint.pos ?? wp.arrival ?? { x: 128, y: 128 }, radius: 10, name: `buscando a ${human.name}` };
    }
    if (hint?.pos) return { kind: 'tier', warp: here, anchor: hint.pos, radius: 8, name: `buscando a ${human.name}` };
    // Sin pista: espera donde está (el humano puede acercarse) y farmea lo que tenga cerca.
    return { kind: 'tier', warp: here, anchor: me, radius: 12, name: `esperando a ${human.name}` };
  }
  // Personaje de nivel bajo que no puede pagar un warp (nivel < 10, o sin zen): no puede ir a ningún mapa. Farmea donde está, en la zona con
  // monstruos más cercana, para subir y juntar zen. Con un líder que lo sigue (carreo) avisa si puede hacer warp (2) o si hace falta que el
  // líder baje a su mapa (1); con el líder en su mapa pelea cerca de él.
  const lead0 = directedLeader();
  // Pide carreo mientras no aguante a los de Arena 2 (la misma cuenta que usa para cruzar las Arenas): un nivel alto con poca vida no sirve.
  const canCross = canFarmMonster(fighterNow(), CROSS_GATE[83], world.skills.has(41));
  const weak = !canCross;
  const warpOk = canWarpNow();
  if (weak && CARRY_ENABLED && lead0) { setNeedsCarry(warpOk ? 2 : 1); carryingAt = Date.now(); }
  // Sin poder pagar el warp (de cualquier nivel): farmea donde está en vez de reintentar el warp para siempre sin pelear.
  if (!warpOk) {
    const here: Warp = { index: -1, name: `mapa ${world.map}`, reqLevel: 0, map: world.map };
    if (CARRY_ENABLED && lead0 && lead0.map === world.map) return { kind: 'shadow', warp: here, anchor: shadowSpotNear({ x: lead0.x, y: lead0.y }), radius: 8, name: `${lead0.char} (carreo)` };
    // Farmea la zona con monstruos más cercana; sin monstruos por un rato, pasa a la siguiente (las zonas se cargan unos segundos después de entrar).
    const me = { x: world.x, y: world.y };
    const anchor = strandedRoam.spot(world.map, me, me, 45);
    return { kind: 'tier', warp: here, anchor, radius: 12, name: `mapa ${world.map}: nivel ${level}, ${level < MIN_WARP_LEVEL ? 'todavía sin nivel para warp' : 'sin zen para el warp'}` };
  }
  // Carreo, lado fuerte: una sombra de nivel bajo me necesita cerca. Bajo a su mapa y peleo a su lado, en party, hasta que suba.
  const carried = !CARRY_ENABLED ? undefined : myShadows().filter((m) => m.carry > 0).sort((a, b) => a.level - b.level)[0];
  if (carried) {
    const wp = WARPS.find((w) => w.map === carried.map && w.reqLevel <= level) ?? (world.map === carried.map ? { index: -1, name: `mapa ${carried.map}`, reqLevel: 0, map: carried.map } : null);
    if (wp) {
      carryingAt = Date.now();
      const name = `${carried.char} (carreo, nivel ${carried.level})`;
      // Con warp posible (carry 2) el spot que aguanta el menor de los dos niveles: Lorencia, Devias 4, Atlans (desde 70) y Tarkan (desde 140), donde
      // la exp es mucho mayor. Ella me sigue por warp y yo la protejo. Atlans y Tarkan no tienen ancla fija: la zona con más monstruos del mapa.
      // Antes de poder pagar un warp (carry 1), la zona con monstruos más cercana donde está.
      if (carried.carry === 2) {
        const lvl = Math.min(carried.level, level);
        const t = [...CARRY_TIERS].reverse().find((x) => lvl >= x.min)!;
        const w = warp(t.warp);
        if (t.home) return { kind: 'fetch', warp: w, anchor: tierRoam.spot(w.map, t.home, { x: world.x, y: world.y }, 70), radius: t.radius, name };
        const mid = { x: 128, y: 128 };
        return { kind: 'fetch', warp: w, anchor: hiRoam.spot(w.map, mid, mid, 300), radius: t.radius, name };
      }
      const at = { x: carried.x, y: carried.y };
      return { kind: 'fetch', warp: wp, anchor: carryRoam.spot(carried.map, at, { x: world.x, y: world.y }, 100), radius: 12, name };
    }
  }
  // El líder baja a buscar a su sombra, que espera en la entrada de una Arena porque no puede cruzarla sola.
  const waiting = myShadows().find((m) => m.waiting && m.map === world.map && CROSS_GATE[m.map] != null && dist(m, { x: world.x, y: world.y }) > WITH_RADIUS);
  if (waiting && Date.now() - fetchedAt > FETCH_COOLDOWN_MS) {
    if (dist(waiting, { x: world.x, y: world.y }) <= 12) {
      fetchedAt = Date.now();
      if (fetchStart) trackEvent('fetch', waiting.char, Math.round((fetchedAt - fetchStart) / 1000)); // segundos que tardó la recogida
      fetchStart = 0;
    } else {
      fetchStart ||= Date.now();
      return { kind: 'fetch', warp: WARPS.find((w) => w.map === world.map) ?? warp(CORNER.warp), anchor: { x: waiting.x, y: waiting.y }, radius: 6, name: `${waiting.char} en la entrada` };
    }
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
      if (gate != null && apart && !canFarmMonster(fighterNow(), gate, world.skills.has(41)) && wp.arrival) {
        setWaiting(world.map === leader.map);
        return { kind: 'shadow', warp: wp, anchor: wp.arrival, radius: 5, name: `la entrada de ${wp.name} (espero a ${leader.char})` };
      }
      return { kind: 'shadow', warp: wp, anchor: shadowSpotNear({ x: leader.x, y: leader.y }), radius: SHADOW_RADIUS, name: `${leader.char} (${wp.name})` };
    }
  }
  if (strong && level >= CORNER.minLevel) return { kind: 'corner', warp: warp(CORNER.warp), anchor: CORNER.home, radius: CORNER.radius + CORNER.fill, name: 'la esquina de Arena 2' };
  // Con poca vida (personaje nuevo: ~230 a nivel 40) Devias 4 la mata; Lorencia, que es más fácil, hasta tener algo más de vida.
  const t = [...TIERS].reverse().find((x) => level >= x.minLevel && (x.minLevel === 0 || world.maxHp >= TIER_MIN_HP))!;
  // Sin monstruos a la vista por un rato (otros jugadores se los llevan): prueba otra zona cercana en vez de esperar en el ancla.
  const anchor = tierRoam.spot(warp(t.warp).map, t.anchor, { x: world.x, y: world.y }, 70);
  const moved = anchor.x !== t.anchor.x || anchor.y !== t.anchor.y;
  return { kind: 'tier', warp: warp(t.warp), anchor, radius: moved ? Math.min(t.radius, 14) : t.radius, name: warp(t.warp).name };
}

/** Un paso hacia el lugar: warp si está en otro mapa. true = viajó o esperó (el tick ya está usado). */
export async function travelTo(place: Place): Promise<boolean> {
  if (world.map === place.warp.map) return false;
  if (Date.now() - bot.lastWarpAt < WARP_COOLDOWN_MS) {
    bot.doing = `esperando para ir a ${place.name}`;
    return true;
  }
  bot.doing = `viajando a ${place.name} (nivel ${world.level})`;
  if (await warpAndWait(place.warp)) warpFails = 0;
  else { warpFails++; lastFailZen = bot.lastMoney; }
  return true;
}

export { WARPS };
export const farFrom = (place: Place, margin = 0) => dist({ x: world.x, y: world.y }, place.anchor) > place.radius + margin;
