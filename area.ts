/**
 * Dónde farmea el bot, sin una lista de spots: elige y aprende una zona mientras juega.
 *  1. Candidatas: las celdas del mapa donde nacen monstruos que el personaje puede farmear (`power.ts`), de los datos de spawns del cliente.
 *  2. Elección: si alguna zona ya tiene medidos MIN_TICKS ticks, se queda con la que más exp/min dio (`learning.ts`); de vez en cuando prueba
 *     una sin medir (exploración, la de más densidad cerca). Se re-decide cada REDECIDE_MS.
 *  3. Si el área está vacía EMPTY_MS estando ahí, se marca como vacía un rato y se busca otra. Si el personaje muere, esa zona se evita.
 *  4. Si el mapa no tiene zonas que sirvan, cambia de mapa por warp (el de mejor rendimiento medido o, sin datos, el de más monstruos de valor).
 * Cada decisión se explica con `decide()`. El Slow tiene monstruos custom que el spawns.json del cliente no ubica: lo que se ve en pantalla manda
 * (`noteSeen`) y se suma a las candidatas.
 */
import { D } from './directivas';
import { decide } from './journal';
import { classFamily, type StatValues } from './farming';
import { cellKey, cellStat, deathsIn, MIN_TICKS, refreshLearned, valueOf } from './learning';
import { mapName } from './panel-logic';
import { canFarmMonster, type Fighter } from './power';
import { hotspots, isMonster, type Hotspot } from './spawns';
import { MONSTER_TYPE_NUMBERS, bot, monsterName, world, type ScopedNpc } from './state';
import { isSafeZone } from './terrain';
import { dist, log, type Pos } from './util';
import { WARPS, WARP_COOLDOWN_MS, warpAndWait, type Warp } from './warps';

export type Place = { warp: Warp; anchor: Pos; radius: number; name: string };

// --- Stats ------------------------------------------------------------------------------------------------------------------------
// Velocidad de ataque = Agi / 15: con 90 pasa de 5 a 6 con muy pocos puntos.
export const STAT_SHARES = { str: 0.45, agi: 0.3, vit: 0.15, ene: 0.1 } as const;
/** Primero Agi hasta `D.agiTarget`; el resto 45 % Str, 30 % Agi, 15 % Vit, 10 % Ene (lo que sobra del redondeo, a Str). Estimado, a ajustar con datos. */
export function statPlan(points: number, stats: StatValues): StatValues {
  const agiFirst = Math.min(points, Math.max(0, D.agiTarget - stats.agi));
  const rest = points - agiFirst;
  const agi = agiFirst + Math.floor(rest * STAT_SHARES.agi);
  const vit = Math.floor(rest * STAT_SHARES.vit);
  const ene = Math.floor(rest * STAT_SHARES.ene);
  return { str: points - agi - vit - ene, agi, vit, ene };
}

// --- Personaje y monstruos ----------------------------------------------------------------------------------------------------------
export const fighterNow = (): Fighter => ({ family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp });

/** ¿Ya hay stats y vida para decidir qué puede pelear? Antes de eso no se decide nada. */
export function statsReady(): boolean {
  const s = world.stats;
  return world.maxHp > 0 && s.str + s.agi + s.vit + s.ene > 0;
}

/** ¿Puede farmear este tipo de monstruo seguido? (power.ts, con Twisting Slash si lo sabe). */
export const canFarm = (type: number) => canFarmMonster(fighterNow(), type, world.skills.has(41));

/** Monstruo que se puede atacar: de verdad (AttType != 0; los NPC custom del server, >= 300, no), fuera de zona segura y que el personaje aguanta. */
export const isAttackable = (n: ScopedNpc) => MONSTER_TYPE_NUMBERS.has(n.type) && !isSafeZone(world.map, n.x, n.y) && canFarm(n.type);

// --- Elegir la zona -----------------------------------------------------------------------------------------------------------------
const AREA_RADIUS = 12;
const EMPTY_MS = 45_000;
const EMPTY_AVOID_MS = 10 * 60_000;
const DEATH_AVOID_MS = 60 * 60_000;
const REDECIDE_MS = 20 * 60_000;
const EXPLORE_P = 0.2;
/** Mientras tanto un mapa nuevo se cambia como mucho una vez por esto. */
const RELOCATE_COOLDOWN_MS = 2 * 60_000;

type Pick = { map: number; anchor: Pos; why: string; at: number };
let cur: Pick | null = null;
/** Mapa donde se farmea: sobrevive a morir (se reaparece en el pueblo y se vuelve acá). */
let homeMap: number | null = null;
let emptySince = 0;
let lastRelocateAt = 0;
let lastAnnounced = '';
/** Zonas (celda de 16×16) que se evitan hasta cierto momento: vacías o donde murió. */
const avoid = new Map<string, number>();
/** Lo visto en pantalla (monstruos que se pueden atacar), por celda: suma a las candidatas donde el spawns.json no sabe. */
const seen = new Map<string, { map: number; x: number; y: number; n: number; at: number }>();

/** El panel y la base conocen el lugar actual por este nombre. */
export const lastPlace: { v: Place | null } = { v: null };

const rand = Math.random;
const areaName = (map: number, p: Pos) => `${mapName(map)} ${p.x >> 4},${p.y >> 4}`;
const here = (): Pos => ({ x: world.x, y: world.y });

/** Lo que se ve ahora: una celda con monstruos atacables es una candidata aunque el spawns.json no la tenga (monstruos custom). */
export function noteSeen() {
  const now = Date.now();
  for (const n of world.npcs.values()) {
    if (!isAttackable(n)) continue;
    const k = cellKey(world.map, n.x, n.y);
    const s = seen.get(k) ?? { map: world.map, x: n.x, y: n.y, n: 0, at: now };
    s.n = Math.max(s.n, 1);
    s.at = now;
    seen.set(k, s);
  }
}

/** La muerte marca la zona para evitarla un buen rato (y se vuelve a decidir). */
export function noteDeath() {
  avoid.set(cellKey(world.map, world.x, world.y), Date.now() + DEATH_AVOID_MS);
  decide(`Me mató en ${areaName(world.map, here())}: evito esa zona ${DEATH_AVOID_MS / 60_000} min.`, { kind: 'death', area: cellKey(world.map, world.x, world.y) });
  cur = null;
}

type Cand = { x: number; y: number; density: number; measured: boolean; expMin: number; dist: number };

/** Candidatas del mapa: celdas de spawns que el personaje aguanta, más lo visto en pantalla, sin las evitadas ni las de muertes. */
function candidatesIn(map: number, from: Pos): Cand[] {
  const now = Date.now();
  const byCell = new Map<string, Cand>();
  const add = (x: number, y: number, density: number) => {
    const k = cellKey(map, x, y);
    if ((avoid.get(k) ?? 0) > now || deathsIn(map, x, y) >= 2) return;
    const st = cellStat(map, x, y);
    const prev = byCell.get(k);
    const c: Cand = { x, y, density: Math.max(density, prev?.density ?? 0), measured: !!st && st.ticks >= MIN_TICKS, expMin: st?.expMin ?? 0, dist: dist({ x, y }, from) };
    if (!prev || c.density > prev.density) byCell.set(k, c);
  };
  const hs: Hotspot[] = hotspots(map, (t) => isMonster(t) && MONSTER_TYPE_NUMBERS.has(t) && canFarm(t)).filter((h) => h.walkable >= 0.7);
  for (const h of hs) add(h.x, h.y, h.density);
  for (const s of seen.values()) if (s.map === map && now - s.at < 30 * 60_000) add(s.x, s.y, 0.001);
  return [...byCell.values()];
}

/** La mejor candidata: la que más exp/min midió; con probabilidad EXPLORE_P (o si ninguna está medida) la más densa de las cercanas sin medir. */
function pickCell(cands: Cand[]): { c: Cand; why: string } | null {
  if (!cands.length) return null;
  const measured = cands.filter((c) => c.measured);
  const fresh = cands.filter((c) => !c.measured);
  const explore = fresh.length > 0 && (!measured.length || rand() < EXPLORE_P);
  if (!explore && measured.length) {
    const best = measured.reduce((b, c) => (c.expMin > b.expMin ? c : b));
    return { c: best, why: `es la zona que más rindió: ${Math.round(best.expMin / 1000)}k exp/min medidos` };
  }
  // Sin medir: de las 5 más densas, la más cercana (no cruzar medio mapa por una diferencia chica de densidad).
  const top = [...fresh].sort((a, b) => b.density - a.density).slice(0, 5);
  const c = top.reduce((b, x) => (x.dist < b.dist ? x : b));
  return { c, why: measured.length ? 'exploro una zona sin medir' : 'todavía no medí ninguna zona: pruebo la más densa cerca' };
}

/** El warp de un mapa más cercano a un punto (al que se llega por nivel). */
function warpFor(map: number, to: Pos): Warp | null {
  const opts = WARPS.filter((w) => w.map === map && w.reqLevel <= world.level);
  if (!opts.length) return null;
  return [...opts].sort((a, b) => dist(a.arrival ?? to, to) - dist(b.arrival ?? to, to))[0]!;
}
/** Un "warp" sin índice: el mismo mapa (travelTo no lo usa, solo camina). */
const inMap = (map: number): Warp => ({ index: -1, name: mapName(map), reqLevel: 0, map });

/**
 * El mapa al que ir cuando el actual no tiene zonas que sirvan: el de mejor rendimiento medido (sus celdas) o, sin datos, el de más
 * monstruos de valor que el personaje puede farmear. Un mapa donde murió hace poco se saltea.
 */
function pickMap(): { warp: Warp; map: number; why: string } | null {
  const now = Date.now();
  const options: { warp: Warp; potential: number; measured: number }[] = [];
  for (const w of WARPS) {
    if (w.reqLevel > world.level || w.map === world.map) continue;
    if (!w.arrival) continue;
    const hs = hotspots(w.map, (t) => isMonster(t) && MONSTER_TYPE_NUMBERS.has(t) && canFarm(t)).filter((h) => h.walkable >= 0.7 && (avoid.get(cellKey(w.map, h.x, h.y)) ?? 0) <= now);
    if (!hs.length) continue;
    const top = hs.sort((a, b) => b.density - a.density).slice(0, 5);
    const potential = top.reduce((t, h) => t + h.density, 0) / top.length;
    const meas = hs.map((h) => cellStat(w.map, h.x, h.y)).filter((s): s is NonNullable<typeof s> => !!s && s.ticks >= MIN_TICKS);
    options.push({ warp: w, potential, measured: meas.length ? Math.max(...meas.map((s) => s.expMin)) : 0 });
  }
  if (!options.length) return null;
  const best = options.filter((o) => o.measured > 0).sort((a, b) => b.measured - a.measured)[0];
  const unknown = options.filter((o) => o.measured === 0).sort((a, b) => b.potential - a.potential)[0];
  const pickUnknown = unknown && (!best || rand() < EXPLORE_P);
  const o = pickUnknown ? unknown! : best!;
  return { warp: o.warp, map: o.warp.map, why: pickUnknown ? `${mapName(o.warp.map)} todavía no está medido y tiene monstruos que aguanto` : `${mapName(o.warp.map)} es el mapa que más rindió (${Math.round(o.measured / 1000)}k exp/min)` };
}

function announce(p: Place, why: string, kind: 'spot' | 'travel' = 'spot') {
  if (p.name === lastAnnounced) return;
  lastAnnounced = p.name;
  decide(`Farmeo en ${p.name} (nivel ${world.level}): ${why}.`, { kind, area: p.name, map: p.warp.map });
}

/** ¿Hay algo atacable en el área, estando en ella? Cuenta el tiempo que no (EMPTY_MS: se marca como vacía). */
function checkEmpty(pick: Pick) {
  if (world.map !== pick.map || dist(here(), pick.anchor) > AREA_RADIUS) { emptySince = 0; return; }
  const any = [...world.npcs.values()].some((n) => isAttackable(n) && dist(n, pick.anchor) <= AREA_RADIUS + 8);
  if (any) { emptySince = 0; return; }
  emptySince ||= Date.now();
  if (Date.now() - emptySince > EMPTY_MS) {
    avoid.set(cellKey(pick.map, pick.anchor.x, pick.anchor.y), Date.now() + EMPTY_AVOID_MS);
    decide(`${areaName(pick.map, pick.anchor)} está vacía hace ${Math.round(EMPTY_MS / 1000)} s: la marco ${EMPTY_AVOID_MS / 60_000} min y busco otra.`, { kind: 'spot', empty: true });
    cur = null;
    emptySince = 0;
  }
}

/** El lugar donde farmea ahora, o null si todavía no se puede decidir (faltan stats y vida). */
export function choosePlace(): Place | null {
  return (lastPlace.v = decidePlace());
}
function decidePlace(): Place | null {
  if (!statsReady()) return null;
  void refreshLearned();
  noteSeen();
  const now = Date.now();
  if (cur) checkEmpty(cur);
  if (cur && now - cur.at > REDECIDE_MS) cur = null; // un cambio de zona cada tanto, para seguir midiendo y probando
  if (!cur) {
    homeMap ??= world.map;
    // Reaparece en el pueblo tras morir: se decide sobre el mapa donde farmeaba, no sobre el pueblo.
    const map = homeMap;
    const cands = candidatesIn(map, map === world.map ? here() : (WARPS.find((w) => w.map === map)?.arrival ?? here()));
    const pick = pickCell(cands);
    if (pick) {
      cur = { map, anchor: { x: pick.c.x, y: pick.c.y }, why: pick.why, at: now };
    } else if (now - lastRelocateAt > RELOCATE_COOLDOWN_MS) {
      lastRelocateAt = now;
      const m = pickMap();
      if (m) {
        homeMap = m.map;
        const hs = candidatesIn(m.map, m.warp.arrival ?? here());
        const first = pickCell(hs);
        const anchor = first ? { x: first.c.x, y: first.c.y } : (m.warp.arrival ?? here());
        cur = { map: m.map, anchor, why: `cambio de mapa: ${m.why}`, at: now };
      } else {
        log('Área: no hay zonas que pueda farmear en ningún mapa a mi alcance; espero.');
      }
    }
  }
  if (!cur) return null;
  const place: Place = {
    warp: cur.map === world.map ? inMap(cur.map) : (warpFor(cur.map, cur.anchor) ?? inMap(cur.map)),
    anchor: cur.anchor, radius: AREA_RADIUS, name: areaName(cur.map, cur.anchor),
  };
  announce(place, cur.why, cur.map === world.map ? 'spot' : 'travel');
  return place;
}

// --- Cuánto vale cada monstruo ------------------------------------------------------------------------------------------------------
/** Lo que el loop usa para elegir a quién pegarle: la exp medida de ese tipo (learning.ts). */
export { valueOf as targetValue } from './learning';

// --- Viajar -------------------------------------------------------------------------------------------------------------------------
/** Mismo mapa: el warp solo vale si el lugar queda a más de tantos tiles (si no, es más rápido caminar). */
const SAME_MAP_WARP_MIN = 70;

/**
 * Un paso hacia el lugar: warp si está en otro mapa. Dentro del mismo mapa se camina (el loop). Cuesta Zen y respeta la espera entre warps.
 * true = viajó o esperó (el tick ya está usado).
 */
export async function travelTo(place: Place): Promise<boolean> {
  if (world.map === place.warp.map || place.warp.index < 0) return false;
  if (Date.now() - bot.lastWarpAt < WARP_COOLDOWN_MS) {
    bot.doing = `esperando para ir a ${place.name}`;
    return true;
  }
  bot.doing = `viajando a ${place.name} (nivel ${world.level})`;
  decide(`Viajo a ${place.name} por el warp ${place.warp.name}.`, { kind: 'travel', warp: place.warp.index, map: place.warp.map });
  await warpAndWait(place.warp);
  return true;
}

export const farFrom = (place: Place, margin = 0) => dist({ x: world.x, y: world.y }, place.anchor) > place.radius + margin;
