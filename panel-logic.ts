/**
 * Lado bot del panel (panel-protocol.ts), en lógica pura: parsers de los
 * packets que solo usa el panel (0x91 aperturas de eventos, 0xFD invasión
 * dorada), tickets del inventario, ciclos, elección/corte de la cacería y el
 * recorrido del mapa en celdas. Fuera de `headless-bot.ts` para poder testearlo
 * offline (`panel-tests.ts`): importar el bot lo arranca.
 */
import itemsData from './data/items.json';
import type { CycleRecord, EventKey, EventTimer, Invasion, MapName } from './panel-protocol';

const u8 = (raw: Uint8Array | DataView | ArrayBuffer): Uint8Array =>
  raw instanceof Uint8Array ? raw : raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);

const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// ---------------------------------------------------------------------------
// Nombres de mapa (índices del 0.97d + las Arenas custom de este server).
// ---------------------------------------------------------------------------
export const MAP_NAMES: Record<number, string> = {
  0: 'Lorencia', 1: 'Dungeon', 2: 'Devias', 3: 'Noria', 4: 'Lost Tower', 6: 'Arena',
  7: 'Atlans', 8: 'Tarkan', 33: 'Aida', 83: 'Arena 2', 84: 'Arena 3', 85: 'Arena 4',
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
// Ítems: nombre y tamaño en la grilla del inventario (data/items.json del cliente).
const ITEM_INFO = new Map<number, { name: string; w: number; h: number }>(
  (itemsData as { Group: number; Index: number; ItemName: string; X: number; Y: number }[])
    .map((i) => [i.Group * 512 + i.Index, { name: i.ItemName, w: i.X || 1, h: i.Y || 1 }]),
);
export function itemInfo(group: number, num: number): { name: string; w: number; h: number } {
  return ITEM_INFO.get(group * 512 + num) ?? { name: `ítem ${group}/${num}`, w: 1, h: 1 };
}

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
// value: cuánto vale cada dorado del mapa (la caja que suelta, guía "Invasión Dorada"): Noria Goblin +1;
// Lorencia Budge +2; Devias Soldier/Titan +2; Atlans Vepar +3 y Lizard King +4; Tarkan Wheel +3 y
// Tantallos +5. stopAlive 0 en todos (usuario, 2026-10-23: "debe cazar dorados hasta que no quede
// ninguno, esa es la prioridad máxima"); la salida es HUNT_DRY_MS (sin ver un dorado y otro mapa con más).
// Warps de la lista de /move del cliente 0.97d.
export type HuntMap = { map: number; warp: number; reqLevel: number; name: string; value?: number; stopAlive?: number };
export const HUNT_MAPS: readonly HuntMap[] = [
  { map: 0, warp: 2, reqLevel: 0, name: 'Lorencia', value: 2, stopAlive: 0 },
  { map: 3, warp: 3, reqLevel: 10, name: 'Noria', value: 1, stopAlive: 0 },
  { map: 2, warp: 6, reqLevel: 20, name: 'Devias', value: 2, stopAlive: 0 },
  { map: 7, warp: 11, reqLevel: 70, name: 'Atlans', value: 3.5, stopAlive: 0 },
  { map: 8, warp: 21, reqLevel: 140, name: 'Tarkan', value: 4, stopAlive: 0 },
];

/**
 * Mapa del Golden Dragon: a las :50 el server avisa "[Devias] Golden invasion!" (visto 2026-10-23; en
 * pantalla sale con "¡El Dragón Dorado está invadiendo!"). Devuelve el número de mapa o null.
 */
export function dragonMapFromServerMessage(text: string): number | null {
  // Solo el aviso de inicio ("... Golden invasion!"); el de cierre es "... Golden invasion has ended.".
  const m = /^\[([^\]]+)\]\s*golden invasion!\s*$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].trim().toLowerCase();
  const hit = Object.entries(MAP_NAMES).find(([, n]) => n.toLowerCase() === name);
  return hit ? Number(hit[0]) : null;
}

/** Invasión del Dragón Rojo: "[Lorencia] Red Dragon invasion!" (aviso de OpenMU, EVENTOS.md). Mapa o null. */
export function redDragonMapFromServerMessage(text: string): number | null {
  const m = /^\[([^\]]+)\]\s*red dragon invasion!\s*$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].trim().toLowerCase();
  const hit = Object.entries(MAP_NAMES).find(([, n]) => n.toLowerCase() === name);
  return hit ? Number(hit[0]) : null;
}
// Dura 30 min y no hay cuenta de vivos (no hay 0xFD): se caza RED_HUNT_MS y se vuelve.
export const RED_HUNT_MS = 12 * 60_000;

export const HUNT_DRAGON_BONUS = 100;
// Competencia por mapa (2026-10-23: Devias bajó de 10 a 3 vivos en minutos por la multitud; Lorencia y Noria casi
// sin cazadores). Se guarda el historial de vivos por mapa (cada 0xFD) y el puntaje se divide por
// 1 + caídaPorMin / CROWD_DIVISOR; con tope CROWD_MAX_DROP (factor mínimo 1/(1+3) = 0,25). Sin al menos
// CROWD_MIN_SPAN_MS de historial: 1 (comportamiento de siempre). MUBOT_COMPETITION=0 lo apaga.
export const CROWD_WINDOW_MS = 5 * 60_000;
export const CROWD_MIN_SPAN_MS = 60_000;
export const CROWD_DIVISOR = 2;
export const CROWD_MAX_DROP = 6;
// El bonus del mapa del dragón decae lineal hasta 0 a los DRAGON_BONUS_MS del aviso (ya los mataron o están rodeados).
export const DRAGON_BONUS_MS = 4 * 60_000;
export const competitionOn = () => process.env.MUBOT_COMPETITION !== '0';
export class AliveHistory {
  private h = new Map<number, { at: number; alive: number }[]>();
  record(inv: Invasion | null, now: number) {
    if (!inv || inv.status !== 'active') { this.h.clear(); return; }
    for (const m of inv.maps) {
      const a = this.h.get(m.map) ?? [];
      a.push({ at: now, alive: m.alive });
      while (a.length && now - a[0].at > CROWD_WINDOW_MS) a.shift();
      this.h.set(m.map, a);
    }
  }
  /** Vivos que se pierden por minuto en el mapa (0 sin historial suficiente o si no baja). */
  dropPerMin(map: number, now: number): number {
    const a = (this.h.get(map) ?? []).filter((x) => now - x.at <= CROWD_WINDOW_MS);
    if (a.length < 2) return 0;
    const span = a[a.length - 1].at - a[0].at;
    if (span < CROWD_MIN_SPAN_MS) return 0;
    return Math.min(CROWD_MAX_DROP, Math.max(0, ((a[0].alive - a[a.length - 1].alive) / span) * 60_000));
  }
  /** Multiplicador del puntaje: 1 / (1 + caídaPorMin / 2). */
  factor(map: number, now: number): number {
    return competitionOn() ? 1 / (1 + this.dropPerMin(map, now) / CROWD_DIVISOR) : 1;
  }
}
export const aliveHistory = new AliveHistory();
/** Bonus del mapa del dragón según los ms desde el aviso (sin dato o sin competencia: entero). */
export function dragonBonusFactor(announceAt: number | null | undefined, now: number | undefined): number {
  if (!competitionOn() || announceAt == null || now == null || now < announceAt) return 1;
  return Math.max(0, 1 - (now - announceAt) / DRAGON_BONUS_MS);
}
// Sin ver un dorado en este tiempo, y con otro mapa que tenga más vivos, se pasa a ese: buscar los
// últimos 1-2 a ciegas cuesta más dorados de los que da.
export const HUNT_DRY_MS = 2 * 60_000;
/** ¿Dejar este mapa por otro? Solo si hace HUNT_DRY_MS que no se ve un dorado y el otro tiene más vivos. */
// Quedan pocos acá (los pelea la competencia, que los mata antes) y otro mapa tiene muchos más: se pasa
// sin esperar los 2 min (hecho medido: 5 min en Devias con 3 vivos mientras Lorencia tenía 26 y las cajas fueron de otros).
export const HUNT_FEW_ALIVE = 3;
export const HUNT_FEW_MIN_STAY_MS = 45_000;
export function huntDryOut(inp: { invasion: Invasion | null; map: number; lastSeenAt: number; now: number; next: HuntChoice; since?: number }): string | null {
  if (!inp.next.ok) return null;
  const here = inp.invasion?.maps.find((m) => m.map === inp.map)?.alive ?? 0;
  const next = inp.next.alive ?? 0;
  if (inp.since != null && inp.now - inp.since >= HUNT_FEW_MIN_STAY_MS && here <= HUNT_FEW_ALIVE && next >= 8 && next >= 3 * Math.max(here, 1)) {
    return `quedan ${here} vivos acá y ${next} en ${inp.next.hunt.name}: me paso antes de que la competencia los limpie`;
  }
  if (inp.now - inp.lastSeenAt < HUNT_DRY_MS) return null;
  if ((inp.next.alive ?? 0) <= here) return null;
  return `${Math.round(HUNT_DRY_MS / 60_000)} min sin ver un dorado (${here} vivos acá, ${inp.next.alive} en ${inp.next.hunt.name})`;
}
/**
 * Mejor mapa para cazar ahora (auto y encadenado): vivos (tope 30, más no se llegan a matar) × valor de
 * sus cajas, más un bonus grande para el mapa del Golden Dragon. Solo mapas con más vivos que su
 * stopAlive, al alcance del nivel y no hechos ya en esta invasión.
 */
// Un mapa sin zonas conocidas (nunca se vio un dorado ahí) se busca a ciegas: vale esta fracción.
export const HUNT_UNKNOWN_FACTOR = 0.25;
// Datos de la base (insights.ts), ambos opcionales y neutros sin base: `factor` multiplica el valor del mapa (rendimiento
// de cajas medido, muertes y rivales a esta hora) y `predictedDragon` (el mapa más probable del dragón por el historial)
// suma un cuarto del bonus solo mientras el server no avisó el mapa de verdad.
export const HUNT_PREDICTED_FRACTION = 0.25;
export function pickHuntMap(inp: { invasion: Invasion | null; level: number; done?: ReadonlySet<number>; dragonMap?: number | null; knownMaps?: ReadonlySet<number>;
  factor?: (map: number) => number; predictedDragon?: number | null; dragonAt?: number | null; now?: number }): HuntChoice {
  const inv = inp.invasion;
  if (!inv || inv.status !== 'active') return { ok: false, msg: 'no hay invasión activa' };
  let best: HuntMap | null = null;
  let bestScore = 0;
  let bestAlive = 0;
  for (const h of HUNT_MAPS) {
    if (inp.level < h.reqLevel || inp.done?.has(h.map)) continue;
    const alive = inv.maps.find((x) => x.map === h.map)?.alive ?? 0;
    if (alive <= (h.stopAlive ?? AUTO_HUNT.stopAlive)) continue;
    const known = !inp.knownMaps || inp.knownMaps.has(h.map) || inp.dragonMap === h.map;
    const bonus = inp.dragonMap === h.map ? HUNT_DRAGON_BONUS * dragonBonusFactor(inp.dragonAt, inp.now) : inp.dragonMap == null && inp.predictedDragon === h.map ? HUNT_DRAGON_BONUS * HUNT_PREDICTED_FRACTION : 0;
    const score = Math.min(alive, 30) * (h.value ?? 1) * (known ? 1 : HUNT_UNKNOWN_FACTOR) * (inp.factor?.(h.map) ?? 1) + bonus;
    if (score > bestScore) { best = h; bestScore = score; bestAlive = alive; }
  }
  return best ? { ok: true, hunt: best, alive: bestAlive } : { ok: false, msg: 'no queda un mapa con dorados que valga la pena' };
}
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
export function shouldStopHunt(inp: { invasion: Invasion | null; map: number; since: number; now: number; maxMs?: number; stopAlive?: number }): string | null {
  if (inp.now - inp.since >= (inp.maxMs ?? HUNT_MAX_MS)) return `pasaron ${Math.round((inp.maxMs ?? HUNT_MAX_MS) / 60_000)} min`;
  const inv = inp.invasion;
  if (!inv || inv.at < inp.since) return null;
  if (inv.status === 'defeated') return 'la invasión fue derrotada';
  if (inv.status !== 'active') return 'no hay invasión activa';
  const alive = inv.maps.find((m) => m.map === inp.map)?.alive ?? 0;
  if (alive <= 0) return `no quedan dorados vivos en ${mapName(inp.map)}`;
  if (inp.stopAlive != null && alive <= (HUNT_MAPS.find((h) => h.map === inp.map)?.stopAlive ?? inp.stopAlive)) return `quedan ${alive} dorados en ${mapName(inp.map)}: no vale la pena`;
  return null;
}

// ---------------------------------------------------------------------------
// Cazador automático (port de hunter.js): con la invasión dorada activa y más de AUTO_HUNT.startAlive
// vivos en un mapa al alcance, sale a cazar solo, una vez por invasión; corta con el stopAlive del mapa
// o menos vivos ("si quedan pocos no tiene sentido buscar") y encadena el siguiente mapa (pickHuntMap).
// Entre :30 y :05 no resetea, para llegar a la invasión de las :50 en 400.
// ---------------------------------------------------------------------------
export const AUTO_HUNT = { startAlive: 25, stopAlive: 20, freshMs: 2 * 60_000, noResetFromMin: 30, noResetToMin: 5, minLevel: 380 } as const;

/** Clave de la invasión (la hora en la que empezó): una cacería automática por invasión. */
export const invasionKey = (inv: Invasion) => Math.floor(inv.at / 3_600_000);

export function autoHuntChoice(inp: { invasion: Invasion | null; level: number; now: number; lastKey: number | null; minLevel?: number; dragonMap?: number | null; knownMaps?: ReadonlySet<number>;
  factor?: (map: number) => number; predictedDragon?: number | null; dragonAt?: number | null }): HuntChoice | null {
  const inv = inp.invasion;
  if (!inv || inv.status !== 'active' || inp.now - inv.at > AUTO_HUNT.freshMs) return null;
  if (inp.lastKey === invasionKey(inv)) return null;
  // Recién reseteado no le gana a un dorado (usuario, 2026-10-23): sigue farmeando hasta el 400.
  if (inp.level < (inp.minLevel ?? AUTO_HUNT.minLevel)) return null;
  const ch = pickHuntMap({ invasion: inv, level: inp.level, dragonMap: inp.dragonMap, knownMaps: inp.knownMaps, factor: inp.factor, predictedDragon: inp.predictedDragon, dragonAt: inp.dragonAt, now: inp.now });
  return ch.ok ? ch : null;
}

/**
 * ¿Minuto de la hora en que no se resetea? Desde las :30 hasta las :05 (la invasión de las :50 dura 15
 * min): el usuario, 2026-10-23: "si justo no está en lvl 400 no sirve" (recién reseteado no le gana a un
 * dorado). Solo frena el reset: en 400 sigue farmeando.
 */
export function resetBlockedByInvasion(now: number): boolean {
  const m = new Date(now).getMinutes();
  return m >= AUTO_HUNT.noResetFromMin || m < AUTO_HUNT.noResetToMin;
}

// ---------------------------------------------------------------------------
// Recorrido del mapa en celdas de 25 tiles (port de hunter.js): la celda sin
// visitar más cercana primero. El headless no tiene la grilla de caminables
// del cliente (.att), así que una celda a la que no se llega en GIVE_UP_MS se
// da por visitada (muro, agua, fuera del mapa).
// ---------------------------------------------------------------------------
export const HUNT_CELL = 25;
export const HUNT_CELL_GIVE_UP_MS = 45_000;

/** Celda del recorrido con terreno: su punto de destino es una casilla caminable y alcanzable. */
export type HuntCell = { key: string; x: number; y: number; weight: number; avoid: boolean };
/** Una celda cuenta como recorrida cuando se pasó a esto (tiles) de su destino (~ el alcance de la vista). */
export const HUNT_CELL_REACH = 9;
/** Celdas con menos casillas caminables alcanzables que esto no se recorren (rincones, islas). */
export const HUNT_CELL_MIN_TILES = 40;

/**
 * Casillas alcanzables desde `start` por pasos de MU (8 direcciones, sin cortar esquinas, igual que
 * path.ts). Devuelve una grilla 256×256 (1 = alcanzable). `passable` incluye zonas seguras: el pueblo se cruza.
 */
export function reachableFrom(passable: (x: number, y: number) => boolean, start: { x: number; y: number }, size = 256): Uint8Array {
  const seen = new Uint8Array(size * size);
  let s = start;
  if (!passable(s.x, s.y)) {
    // El punto de llegada puede ser una casilla de borde: el caminable más cercano a <= 3.
    let found = false;
    for (let r = 1; r <= 3 && !found; r++)
      for (let dx = -r; dx <= r && !found; dx++)
        for (let dy = -r; dy <= r && !found; dy++)
          if (passable(start.x + dx, start.y + dy)) { s = { x: start.x + dx, y: start.y + dy }; found = true; }
    if (!found) return seen;
  }
  const queue: number[] = [s.y * size + s.x];
  seen[queue[0]] = 1;
  const steps: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i] % size, y = Math.floor(queue[i] / size);
    for (const [dx, dy] of steps) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size || seen[ny * size + nx] || !passable(nx, ny)) continue;
      if (dx && dy && (!passable(x + dx, y) || !passable(x, y + dy))) continue;
      seen[ny * size + nx] = 1;
      queue.push(ny * size + nx);
    }
  }
  return seen;
}

export class HuntExplorer {
  readonly visited = new Set<string>();
  goal: { x: number; y: number; key: string; since: number } | null = null;
  /** Vueltas completas al mapa. */
  passes = 0;
  /** Con terreno (useTerrain): las celdas caminables y alcanzables del mapa; null = a ciegas, como antes. */
  cells: HuntCell[] | null = null;
  private terrainMap = -1;
  private weightsRef: ReadonlyMap<string, number> | undefined;
  private avoidRef: ReadonlySet<string> | undefined;

  constructor(readonly cell = HUNT_CELL, readonly giveUpMs = HUNT_CELL_GIVE_UP_MS, readonly size = 256) {}

  /** Columnas (x de los centros) que se recorren. */
  columns(): number[] {
    const half = Math.floor(this.cell / 2);
    const all: number[] = [];
    for (let cx = half; cx < this.size; cx += this.cell) all.push(cx);
    return all;
  }

  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  private nextWithTerrain(x: number, y: number, now: number): { x: number; y: number } {
    // Lo que se pasó a <= HUNT_CELL_REACH de su destino (también de camino a otra) ya se vio.
    for (const c of this.cells!) if (!this.visited.has(c.key) && cheb(x, y, c.x, c.y) <= HUNT_CELL_REACH) this.visited.add(c.key);
    if (this.goal && (this.visited.has(this.goal.key) || now - this.goal.since > this.giveUpMs)) {
      this.visited.add(this.goal.key);
      this.goal = null;
    }
    if (this.goal) return this.goal;
    let c = this.nextCell(x, y);
    if (!c) {
      // Mapa entero recorrido: otra vuelta (los dorados se mueven y reaparecen).
      this.passes++;
      this.visited.clear();
      for (const k of this.cells!) if (cheb(x, y, k.x, k.y) <= HUNT_CELL_REACH) this.visited.add(k.key);
      c = this.nextCell(x, y);
      if (!c) return { x, y };
    }
    this.goal = { x: c.x, y: c.y, key: c.key, since: now };
    return this.goal;
  }

  reset() {
    this.visited.clear();
    this.goal = null;
  }

  /** Clave de la celda que contiene (x, y): la de `weights` / `avoid` de useTerrain. */
  cellKey(x: number, y: number) {
    return this.key(x, y);
  }

  /**
   * Recorrer solo lo caminable (HANDOFF "Qué sigue" #1): con el terreno del mapa, las celdas se arman con las
   * casillas ALCANZABLES desde `start` y su destino es una casilla caminable (no una pared ni el agua); las
   * celdas del pueblo (zona segura) y los rincones chicos se saltean. `weights`: celdas con dorados vistos
   * (zones.ts) que van primero, las de más peso y más cerca antes; `avoid`: celdas donde murieron personajes,
   * que van al final. Se arma una vez por mapa (y de nuevo si cambian los pesos); sin llamarlo, no cambia nada.
   */
  useTerrain(map: number, passable: (x: number, y: number) => boolean, huntable: (x: number, y: number) => boolean, start: { x: number; y: number },
    weights?: ReadonlyMap<string, number>, avoid?: ReadonlySet<string>) {
    if (this.terrainMap === map && this.weightsRef === weights && this.avoidRef === avoid) return;
    const rebuilt = this.terrainMap !== map;
    this.terrainMap = map;
    this.weightsRef = weights;
    this.avoidRef = avoid;
    if (!rebuilt && this.cells) {
      for (const c of this.cells) { c.weight = weights?.get(c.key) ?? 0; c.avoid = !!avoid?.has(c.key); }
      return;
    }
    const reach = reachableFrom(passable, start, this.size);
    const cells: HuntCell[] = [];
    const half = Math.floor(this.cell / 2);
    for (let cx0 = 0; cx0 < this.size; cx0 += this.cell) {
      for (let cy0 = 0; cy0 < this.size; cy0 += this.cell) {
        const mx = cx0 + half, my = cy0 + half;
        let n = 0;
        let best: { x: number; y: number } | null = null;
        let bd = Infinity;
        for (let x = cx0; x < Math.min(this.size, cx0 + this.cell); x++) {
          for (let y = cy0; y < Math.min(this.size, cy0 + this.cell); y++) {
            if (!reach[y * this.size + x] || !huntable(x, y)) continue;
            n++;
            const d = cheb(x, y, mx, my);
            if (d < bd) { bd = d; best = { x, y }; }
          }
        }
        if (n < HUNT_CELL_MIN_TILES || !best) continue;
        const key = this.key(mx, my);
        cells.push({ key, x: best.x, y: best.y, weight: weights?.get(key) ?? 0, avoid: !!avoid?.has(key) });
      }
    }
    this.cells = cells.length ? cells : null;
    this.visited.clear();
    this.goal = null;
  }

  /** La celda a recorrer con terreno: con peso primero (peso / distancia), sin peso la más cercana, las a evitar al final. */
  private nextCell(x: number, y: number): HuntCell | null {
    let best: HuntCell | null = null;
    let bs = -Infinity;
    for (const c of this.cells!) {
      if (this.visited.has(c.key)) continue;
      const d = cheb(x, y, c.x, c.y);
      // Tres bandas: con dorados (10 000+), comunes (0+), a evitar (-10 000+); adentro, lo más cerca / de más peso.
      const score = c.avoid ? -10_000 - d : c.weight > 0 ? 10_000 + (c.weight * 100) / (d + 25) : -d;
      if (score > bs) { bs = score; best = c; }
    }
    return best;
  }

  /** A dónde caminar ahora. Marca la celda actual visitada; si se visitaron todas, vuelve a empezar. */
  next(x: number, y: number, now: number): { x: number; y: number } {
    if (this.cells) return this.nextWithTerrain(x, y, now);
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
// Señales de dorados: cada bot avisa a la estación los dorados que ve (y el
// navegador también puede, si el usuario juega ahí). La estación los junta.
// ---------------------------------------------------------------------------
export const GOLD_RESEND_MS = 2_000;
/** Receptor de señales: la estación (estacion.ts). La estación lo pasa por env si cambia el puerto. */
export const GOLD_URL = process.env.MUBOT_GOLD_URL ?? 'http://127.0.0.1:8787/api/gold';

export type GoldSighting = { from: string; map: number; x: number; y: number; name: string; id: number; at: number };
export type GoldGone = { from: string; map: number; id: number; gone: true; at: number };
export type GoldSeen = { id: number; x: number; y: number; name: string };

export const goldSighting = (from: string, map: number, g: GoldSeen, at: number): GoldSighting =>
  ({ from, map, x: g.x, y: g.y, name: g.name, id: g.id, at });
export const goldGone = (from: string, map: number, id: number, at: number): GoldGone => ({ from, map, id, gone: true, at });

/**
 * Qué avisar en cada tick: un dorado nuevo en scope se avisa ya; uno que se
 * movió, como mucho cada GOLD_RESEND_MS por id (si se movió durante la
 * espera, sale la última posición cuando se cumple); uno que ya no está en
 * scope (murió o se fue), `gone`. Cambiar de mapa = todos `gone`.
 */
export class GoldReporter {
  private sent = new Map<number, { at: number; x: number; y: number; map: number }>();

  constructor(readonly from: string, readonly resendMs = GOLD_RESEND_MS) {}

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
