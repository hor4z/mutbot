/**
 * Lado bot del panel (panel-protocol.ts), en lógica pura: parsers de los
 * packets que solo usa el panel (0x91 aperturas de eventos, 0xFD invasión
 * dorada), tickets del inventario, ciclos, elección/corte de la cacería y el
 * recorrido del mapa en celdas. Fuera de `headless-bot.ts` para poder testearlo
 * offline (`panel-tests.ts`): importar el bot lo arranca.
 */
import type { CycleRecord, EventKey, EventTimer, Invasion, MapName } from './panel-protocol';

const u8 = (raw: Uint8Array | DataView | ArrayBuffer): Uint8Array =>
  raw instanceof Uint8Array ? raw : raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);

const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// ---------------------------------------------------------------------------
// Nombres de mapa (índices del 0.97d + las Arenas custom de este server).
// ---------------------------------------------------------------------------
export const MAP_NAMES: Record<number, string> = {
  0: 'Lorencia', 1: 'Dungeon', 2: 'Devias', 3: 'Noria', 4: 'Lost Tower', 6: 'Arena',
  7: 'Atlans', 8: 'Tarkan', 83: 'Arena 2', 84: 'Arena 3', 85: 'Arena 4',
};
export const mapName = (n: number): MapName => MAP_NAMES[n] ?? `mapa ${n}`;

// ---------------------------------------------------------------------------
// Aperturas de eventos (ver EVENTOS.md). Pregunta `C1 05 91 <tipo> <nivel>`;
// respuesta MiniGameOpeningState (C1 07 91): [3] tipo, [4] minutos, [5]
// jugadores, [6] byte bajo de los minutos (solo Chaos Castle: b4<<8 | b6).
// Minutos 0 = abierto; >= 255 (CC: >= 65535) = más de 4 h / desconocido.
// ---------------------------------------------------------------------------
export const EVENT_TYPES: Record<EventKey, number> = { devilSquare: 1, bloodCastle: 2, chaosCastle: 4 };
export const EVENT_KEYS = Object.keys(EVENT_TYPES) as EventKey[];
const KEY_BY_TYPE = new Map<number, EventKey>(EVENT_KEYS.map((k) => [EVENT_TYPES[k], k]));

export function buildOpeningStateRequest(key: EventKey, level = 1): Uint8Array {
  return Uint8Array.from([0xc1, 0x05, 0x91, EVENT_TYPES[key], level & 0xff]);
}

export function parseOpeningState(raw: Uint8Array | DataView | ArrayBuffer, now: number): EventTimer | null {
  const b = u8(raw);
  if (b.length < 6 || b[0] !== 0xc1 || b[2] !== 0x91) return null;
  const key = KEY_BY_TYPE.get(b[3]);
  if (!key) return null;
  let minutes: number | null;
  if (key === 'chaosCastle') {
    if (b.length < 7) return null;
    const m = (b[4] << 8) | b[6];
    minutes = m >= 0xffff ? null : m;
  } else {
    minutes = b[4] >= 255 ? null : b[4];
  }
  return { key, minutes, opensAt: minutes == null ? null : now + minutes * 60_000, users: b[5], at: now };
}

// ---------------------------------------------------------------------------
// Invasión dorada: paquete propio del server `C1 len FD`.
//   [3] estado (1 activa, 2 derrotada), [4-5] total vivos (u16 BE),
//   [6] cantidad de mapas, desde [7] por mapa: <mapa u8> <vivos u16 BE>.
// Calendario fijo: todas las horas a los :50, dura 15 min.
// ---------------------------------------------------------------------------
export const INVASION_MINUTE = 50;

export function nextInvasionAt(now: number): number {
  const d = new Date(now);
  d.setMinutes(INVASION_MINUTE, 0, 0);
  if (d.getTime() <= now) d.setHours(d.getHours() + 1);
  return d.getTime();
}

export function parseInvasion(raw: Uint8Array | DataView | ArrayBuffer, now: number): Invasion | null {
  const b = u8(raw);
  if (b.length < 7 || b[0] !== 0xc1 || b[2] !== 0xfd) return null;
  const status = b[3] === 1 ? 'active' : b[3] === 2 ? 'defeated' : 'none';
  const count = b[6];
  const maps: Invasion['maps'] = [];
  for (let i = 0; i < count; i++) {
    const o = 7 + i * 3;
    if (o + 3 > b.length) break; // packet corto: lo que entre, sin leer basura
    maps.push({ map: b[o], name: mapName(b[o]), alive: (b[o + 1] << 8) | b[o + 2] });
  }
  return { status, total: (b[4] << 8) | b[5], maps, at: now, nextAt: nextInvasionAt(now) };
}

// ---------------------------------------------------------------------------
// Tickets de eventos en el inventario (group/num de data/items.json).
// ---------------------------------------------------------------------------
export type InvItem = { group: number; num: number; level?: number };

export function countTickets(items: Iterable<InvItem>): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string) => (out[k] = (out[k] ?? 0) + 1);
  for (const it of items) {
    if (it.group === 14 && it.num === 19) add(`Devil's Invitation +${it.level ?? 0}`);
    else if (it.group === 13 && it.num === 18) add(`Invisibility Cloak +${it.level ?? 0}`);
    else if (it.group === 13 && it.num === 29) add('Armor of Guardsman');
    else if (it.group === 14 && it.num === 11) add('Box of Luck');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ciclos de reset: el registro de farming.ts (CycleLog) → el formato del panel.
// ---------------------------------------------------------------------------
export type RawCycle = { start: number; min?: number; marks: Record<number, number>; tag?: string | null };

export function toPanelCycle(c: RawCycle, running = false): CycleRecord {
  const marks: Record<string, number> = {};
  for (const [k, v] of Object.entries(c.marks)) marks[k] = v;
  return { start: c.start, min: running ? null : (c.min ?? null), marks, tag: c.tag ?? null };
}

/** resets/día = 1440 / promedio de los últimos `n` ciclos cerrados sin tag (null si no hay). */
export function resetsPerDay(cycles: readonly CycleRecord[], n = 5): number | null {
  const last = cycles.filter((c) => !c.tag && c.min != null && c.min > 0).slice(-n);
  if (!last.length) return null;
  const avg = last.reduce((a, c) => a + c.min!, 0) / last.length;
  return +(1440 / avg).toFixed(1);
}

// ---------------------------------------------------------------------------
// Monstruos dorados: por nombre en data/monsters.json ("Gold"/"Golden"),
// fuera de los NPC de pueblo 200-299 (ej. 236 Golden Archer, que no pelea).
// ---------------------------------------------------------------------------
export const isGoldenName = (name: string) => /\bgold(en)?\b/i.test(name);

export function goldenTypes(rows: Iterable<{ Numb: number; Name: string }>): Set<number> {
  const out = new Set<number>();
  for (const r of rows) if (isGoldenName(r.Name) && !(r.Numb >= 200 && r.Numb <= 299)) out.add(r.Numb);
  return out;
}

// ---------------------------------------------------------------------------
// Cacería: a qué mapa ir y cuándo cortar.
// ---------------------------------------------------------------------------
export type HuntMap = { map: number; warp: number; reqLevel: number; name: string };
export const HUNT_MAPS: readonly HuntMap[] = [
  { map: 0, warp: 2, reqLevel: 0, name: 'Lorencia' },
  { map: 3, warp: 3, reqLevel: 10, name: 'Noria' },
  { map: 2, warp: 6, reqLevel: 20, name: 'Devias' },
];
export const HUNT_MAX_MS = 15 * 60_000;

export type HuntChoice = { ok: true; hunt: HuntMap; alive: number | null } | { ok: false; msg: string };

/** Mapa de la cacería: el pedido (si se puede entrar) o el de más vivos al alcance según el último 0xFD. */
export function chooseHuntMap(inp: { invasion: Invasion | null; level: number; map?: number }): HuntChoice {
  const aliveIn = (m: number) => inp.invasion?.maps.find((x) => x.map === m)?.alive ?? null;
  if (inp.map != null) {
    const h = HUNT_MAPS.find((x) => x.map === inp.map);
    if (!h) return { ok: false, msg: `no cazo en ${mapName(inp.map)}: solo ${HUNT_MAPS.map((x) => x.name).join(', ')}` };
    if (inp.level < h.reqLevel) return { ok: false, msg: `${h.name} pide nivel ${h.reqLevel} (tengo ${inp.level})` };
    return { ok: true, hunt: h, alive: aliveIn(h.map) };
  }
  const inv = inp.invasion;
  if (!inv || inv.status !== 'active') return { ok: false, msg: 'no hay invasión activa según el último 0xFD; pasá el mapa a mano' };
  let best: HuntMap | null = null;
  let bestAlive = 0;
  for (const h of HUNT_MAPS) {
    if (inp.level < h.reqLevel) continue;
    const a = aliveIn(h.map) ?? 0;
    if (a > bestAlive) {
      best = h;
      bestAlive = a;
    }
  }
  if (!best) return { ok: false, msg: 'no quedan dorados vivos en un mapa al que pueda ir' };
  return { ok: true, hunt: best, alive: bestAlive };
}

/**
 * Regla de corte de la cacería (lección de Noria: cortar apenas el 0xFD diga
 * que en ese mapa no quedan): devuelve el motivo para cortar, o null.
 * Solo cuenta un 0xFD recibido después de empezar la cacería; un mapa que no
 * figura en la lista de un 0xFD activo cuenta como 0 vivos.
 */
export function shouldStopHunt(inp: { invasion: Invasion | null; map: number; since: number; now: number; maxMs?: number }): string | null {
  if (inp.now - inp.since >= (inp.maxMs ?? HUNT_MAX_MS)) return `pasaron ${Math.round((inp.maxMs ?? HUNT_MAX_MS) / 60_000)} min`;
  const inv = inp.invasion;
  if (!inv || inv.at < inp.since) return null;
  if (inv.status === 'defeated') return 'la invasión fue derrotada';
  if (inv.status !== 'active') return 'no hay invasión activa';
  const alive = inv.maps.find((m) => m.map === inp.map)?.alive ?? 0;
  if (alive <= 0) return `no quedan dorados vivos en ${mapName(inp.map)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Recorrido del mapa en celdas de 25 tiles (port de hunter.js): la celda sin
// visitar más cercana primero. El headless no tiene la grilla de caminables
// del cliente (.att), así que una celda a la que no se llega en GIVE_UP_MS se
// da por visitada (muro, agua, fuera del mapa).
// ---------------------------------------------------------------------------
export const HUNT_CELL = 25;
export const HUNT_CELL_GIVE_UP_MS = 45_000;

export class HuntExplorer {
  readonly visited = new Set<string>();
  goal: { x: number; y: number; key: string; since: number } | null = null;
  /** Vueltas completas al mapa (o a la franja): el atlas pasa al mapa siguiente con una. */
  passes = 0;

  /** `band`: solo las celdas cuyo centro cae en [minX, maxX) (franja del buscador). */
  constructor(readonly cell = HUNT_CELL, readonly giveUpMs = HUNT_CELL_GIVE_UP_MS, readonly size = 256, readonly band: ScoutBand | null = null) {}

  /** Columnas (x de los centros) que se recorren: todas, o las de la franja (al menos una). */
  columns(): number[] {
    const half = Math.floor(this.cell / 2);
    const all: number[] = [];
    for (let cx = half; cx < this.size; cx += this.cell) all.push(cx);
    const b = this.band;
    if (!b) return all;
    const inBand = all.filter((cx) => cx >= b.minX && cx < b.maxX);
    // Franja más angosta que una celda: su medio, para no quedarse sin destino.
    return inBand.length ? inBand : [Math.floor((b.minX + b.maxX) / 2)];
  }

  /** Celdas a recorrer (para "celda 12/40"). */
  totalCells(): number {
    return this.columns().length * Math.ceil((this.size - Math.floor(this.cell / 2)) / this.cell);
  }

  /** Celdas ya visitadas de las que se recorren (la franja). */
  visitedCount(): number {
    const cols = new Set(this.columns().map((cx) => Math.floor(cx / this.cell)));
    let n = 0;
    for (const k of this.visited) if (cols.has(Number(k.split(',')[0]))) n++;
    return n;
  }

  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  reset() {
    this.visited.clear();
    this.goal = null;
  }

  /** A dónde caminar ahora. Marca la celda actual visitada; si se visitaron todas, vuelve a empezar. */
  next(x: number, y: number, now: number): { x: number; y: number } {
    this.visited.add(this.key(x, y));
    if (this.goal && (this.visited.has(this.goal.key) || now - this.goal.since > this.giveUpMs)) {
      this.visited.add(this.goal.key);
      this.goal = null;
    }
    if (this.goal) return this.goal;
    const half = Math.floor(this.cell / 2);
    let best: { x: number; y: number; key: string } | null = null;
    let bd = Infinity;
    for (const cx of this.columns()) {
      for (let cy = half; cy < this.size; cy += this.cell) {
        const k = this.key(cx, cy);
        if (this.visited.has(k)) continue;
        const d = cheb(x, y, cx, cy);
        if (d < bd) {
          bd = d;
          best = { x: cx, y: cy, key: k };
        }
      }
    }
    if (!best) {
      // Mapa entero recorrido: otra vuelta (los dorados se mueven y reaparecen).
      this.passes++;
      this.visited.clear();
      this.visited.add(this.key(x, y));
      return this.next(x, y, now);
    }
    this.goal = { ...best, since: now };
    return this.goal;
  }
}

// ---------------------------------------------------------------------------
// Buscador (orden `scout`, --scout): recorre una franja vertical del mapa sin
// pelear y avisa por HTTP cada dorado que ve, para que otro personaje lo mate.
// ---------------------------------------------------------------------------
export type ScoutBand = { minX: number; maxX: number };
export const SCOUT_MAX_MS = 20 * 60_000;
export const SCOUT_RESEND_MS = 2_000;
export const SCOUT_GOLD_URL = 'http://127.0.0.1:8788/gold';

/** Franja `sector` (1..sectors) de las `sectors` franjas verticales (por x) del mapa. */
export function scoutBand(sector: number, sectors: number, size = 256): ScoutBand {
  const n = Math.max(1, Math.floor(sectors));
  const k = Math.min(Math.max(1, Math.floor(sector)), n);
  return { minX: Math.floor(((k - 1) * size) / n), maxX: Math.floor((k * size) / n) };
}

/** Corte del buscador: igual que la cacería (0 vivos en el mapa, invasión terminada) pero a los 20 min. */
/** Se deja de buscar con 20 o menos vivos en el mapa y se arranca solo con más de SCOUT_START_ALIVE
 * (usuario, 2026-10-10: "seguir buscando tanto tiempo no es bueno"). */
export const SCOUT_MIN_ALIVE = 20;
export const SCOUT_START_ALIVE = 25;
export function shouldStopScout(inp: { invasion: Invasion | null; map: number; since: number; now: number }): string | null {
  const why = shouldStopHunt({ ...inp, maxMs: SCOUT_MAX_MS });
  if (why) return why;
  const inv = inp.invasion;
  if (inv && inv.at >= inp.since) { const alive = inv.maps.find((m) => m.map === inp.map)?.alive ?? 0; if (alive <= SCOUT_MIN_ALIVE) return `quedan ${alive} dorados en ${mapName(inp.map)}: no vale la pena`; }
  return null;
}

export type GoldSighting = { from: string; map: number; x: number; y: number; name: string; id: number; at: number };
export type GoldGone = { from: string; map: number; id: number; gone: true; at: number };
export type GoldSeen = { id: number; x: number; y: number; name: string };

export const goldSighting = (from: string, map: number, g: GoldSeen, at: number): GoldSighting =>
  ({ from, map, x: g.x, y: g.y, name: g.name, id: g.id, at });
export const goldGone = (from: string, map: number, id: number, at: number): GoldGone => ({ from, map, id, gone: true, at });

/**
 * Qué avisar en cada tick: un dorado nuevo en scope se avisa ya; uno que se
 * movió, como mucho cada SCOUT_RESEND_MS por id (si se movió durante la
 * espera, sale la última posición cuando se cumple); uno que ya no está en
 * scope (murió o se fue), `gone`. Cambiar de mapa = todos `gone`.
 */
export class GoldReporter {
  private sent = new Map<number, { at: number; x: number; y: number; map: number }>();

  constructor(readonly from: string, readonly resendMs = SCOUT_RESEND_MS) {}

  update(map: number, golds: readonly GoldSeen[], now: number): { payload: GoldSighting | GoldGone; isNew: boolean }[] {
    const out: { payload: GoldSighting | GoldGone; isNew: boolean }[] = [];
    const here = new Set(golds.map((g) => g.id));
    for (const [id, s] of this.sent) {
      if (here.has(id) && s.map === map) continue;
      out.push({ payload: goldGone(this.from, s.map, id, now), isNew: false });
      this.sent.delete(id);
    }
    for (const g of golds) {
      const s = this.sent.get(g.id);
      if (s && ((s.x === g.x && s.y === g.y) || now - s.at < this.resendMs)) continue;
      out.push({ payload: goldSighting(this.from, map, g, now), isNew: !s });
      this.sent.set(g.id, { at: now, x: g.x, y: g.y, map });
    }
    return out;
  }

  /** Al terminar: `gone` de todo lo que estaba avisado. */
  clear(now: number): GoldGone[] {
    const out = [...this.sent].map(([id, s]) => goldGone(this.from, s.map, id, now));
    this.sent.clear();
    return out;
  }
}

// ---------------------------------------------------------------------------
// Orden `warp`: solo índices de la ruta del bot, con su nivel.
// ---------------------------------------------------------------------------
export type WarpSpot = { index: number; name: string; reqLevel: number };

export function validateWarp<S extends WarpSpot>(warp: number, level: number, spots: readonly S[]): { ok: true; spot: S } | { ok: false; msg: string } {
  const spot = spots.find((s) => s.index === warp);
  if (!spot) return { ok: false, msg: `el warp ${warp} no está en la ruta (${spots.map((s) => `${s.index} ${s.name}`).join(', ')})` };
  if (level < spot.reqLevel) return { ok: false, msg: `${spot.name} pide nivel ${spot.reqLevel} (tengo ${level})` };
  return { ok: true, spot };
}
