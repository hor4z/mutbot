/**
 * Explorador (lógica pura, tests en scout-tests.ts): un bot con la orden `scout` recorre mapas SIN pelear
 * (salvo defensa propia) y cada 30-60 s avisa a la estación qué ve (POST MUBOT_TEAM_URL, `kind: 'scout'`).
 * Los cazadores leen esos reportes (GET MUBOT_TEAM_URL → `scouts`, frescos < 10 min) y los usan para elegir
 * mapa (`scoutFactor`, en `pickHuntMap`) y a dónde ir primero (`scoutHints`).
 *
 * Seguro por construcción: solo mapas que el nivel y los stats aguantan (`scoutMaps`), vuelve al mapa más
 * seguro si hay peligro, muere o el vigía diagnostica traba (`ScoutTour`), y un mapa que lo hizo retroceder
 * no se vuelve a pisar por un rato. Sin red ni reloj propio: todo recibe `now`.
 */
import { HUNT_MAPS, type HuntMap } from './panel-logic';

export const SCOUT = {
  /** Cada cuánto publica (aleatorio entre los dos, así no sale con compás de metrónomo). */
  publishMinMs: 30_000,
  publishMaxMs: 60_000,
  /** Primer reporte en un mapa: unos segundos después de llegar (que el scope se llene). */
  arriveDelayMs: 8_000,
  /** Cuánto se queda en cada mapa antes de pasar al siguiente (con variación), o antes si dio una vuelta entera. */
  dwellMs: 3 * 60_000,
  /** El nivel tiene que superar el requerido por el mapa en esto. */
  levelMargin: 20,
  /** Personaje limitado (isFreshChar): solo mapas con reqLevel <= esto. */
  weakMaxReq: 20,
  /** Un mapa del que se retiró por peligro / traba / no llegar no se pisa por esto; si murió, más. */
  banMs: 15 * 60_000,
  deathBanMs: 45 * 60_000,
  /** Vida por debajo de esto (%) = peligro. */
  lowHpPct: 50,
  /** Un monstruo que no puede vencer a esta distancia = peligro. */
  threatRadius: 5,
  /** Un golpe de un monstruo cuenta como "me atacó" (defensa propia) por esto, y solo si está así de cerca. */
  defenseMs: 4_000,
  defenseRadius: 2,
} as const;

/** Reporte que los cazadores leen (lo que la estación devuelve en `scouts`). */
export type ScoutInfo = { from: string; map: number; x: number; y: number; players: number; monsters: number; golds: number; goldTypes?: string[]; note: string; at: number };
/** Vigencia de un reporte (igual que SCOUT_TTL_MS de la estación). */
export const SCOUT_FRESH_MS = 10 * 60_000;
/** Si la estación no contesta hace más que esto, los reportes guardados no se usan. */
export const STATION_STALE_MS = 2 * 60_000;

const rand = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);

// --- Mapas seguros ---------------------------------------------------------------------------------------

/**
 * Mapas por los que puede pasear: los de la lista de cacería (con warp) que el nivel supera por margen y, si el
 * personaje es limitado, solo los de entrada (Lorencia, Noria, Devias). Orden de la lista = de más seguro a menos.
 */
export function scoutMaps(level: number, weak: boolean): HuntMap[] {
  return HUNT_MAPS.filter((h) => level >= Math.max(h.reqLevel, 10) + SCOUT.levelMargin && (!weak || h.reqLevel <= SCOUT.weakMaxReq));
}

/** ¿Peligro ahora? Motivo o null. `threats`: monstruos a <= threatRadius que el personaje no puede vencer (power.ts). */
export function scoutDanger(i: { hpPct: number; threats: number }): string | null {
  if (i.hpPct < SCOUT.lowHpPct) return `vida baja (${Math.round(i.hpPct)} %)`;
  if (i.threats > 0) return `${i.threats} monstruo${i.threats === 1 ? '' : 's'} cerca que no puedo vencer`;
  return null;
}

// --- El recorrido de mapas ------------------------------------------------------------------------------

export type TourStep = { kind: 'stay' } | { kind: 'go'; to: HuntMap; why: string } | { kind: 'stop'; why: string };
export type TourInput = {
  now: number; map: number; level: number; weak: boolean; deaths: number;
  /** motivo de peligro (scoutDanger) o null */
  danger: string | null;
  /** el recorrido del mapa dio una vuelta entera (HuntExplorer.passes >= 1) */
  lapDone: boolean;
  /** mapa → último reporte de OTRO explorador (para no repetir lo que ya cubrió) */
  covered?: ReadonlyMap<number, number>;
};

export class ScoutTour {
  target: HuntMap | null = null;
  private arrivedAt: number | null = null;
  private dwellMs = SCOUT.dwellMs;
  private deaths: number | null = null;
  private readonly visited = new Map<number, number>();
  private readonly banned = new Map<number, number>();

  constructor(private readonly rng: () => number = Math.random) {}

  isBanned(map: number, now: number) {
    return (this.banned.get(map) ?? 0) > now;
  }

  ban(map: number, now: number, ms: number = SCOUT.banMs) {
    this.banned.set(map, Math.max(this.banned.get(map) ?? 0, now + ms));
  }

  private go(to: HuntMap) {
    this.target = to;
    this.arrivedAt = null;
    this.dwellMs = SCOUT.dwellMs * rand(this.rng, 0.8, 1.3);
  }

  /** El mapa menos cubierto (por mí y por otros exploradores) entre los seguros; empate = el de entrada más baja. */
  private pickNext(i: Pick<TourInput, 'now' | 'level' | 'weak' | 'covered'>, avoid?: number, safest = false): HuntMap | null {
    const ok = scoutMaps(i.level, i.weak).filter((h) => !this.isBanned(h.map, i.now));
    const cand = ok.filter((h) => h.map !== avoid);
    const pool = cand.length ? cand : ok;
    if (!pool.length) return null;
    if (safest) return pool[0];
    let best = pool[0];
    let bt = Infinity;
    for (const h of pool) {
      const t = Math.max(this.visited.get(h.map) ?? 0, i.covered?.get(h.map) ?? 0);
      if (t < bt) { bt = t; best = h; }
    }
    return best;
  }

  /** Primer mapa de la tarea; null si ninguno es seguro para este nivel y stats. */
  start(i: Pick<TourInput, 'now' | 'level' | 'weak' | 'covered' | 'map'>): HuntMap | null {
    const to = this.pickNext(i);
    if (to) this.go(to);
    return to;
  }

  /** ¿Ya estoy en el mapa objetivo desde cuándo? (el publicador lo usa) */
  get arrived() {
    return this.arrivedAt;
  }

  /** Qué hacer ahora: seguir, pasar a otro mapa o dejar de explorar. */
  step(i: TourInput): TourStep {
    if (!this.target) return { kind: 'stop', why: 'sin mapa' };
    const cur = this.target;
    const next = (why: string, ban?: number): TourStep => {
      if (ban != null) this.ban(cur.map, i.now, ban);
      else this.visited.set(cur.map, i.now);
      const to = this.pickNext(i, cur.map, ban != null);
      if (!to) return { kind: 'stop', why: `${why}; no queda un mapa seguro` };
      if (to.map === cur.map) { this.arrivedAt = i.now; return { kind: 'stay' }; }
      this.go(to);
      return { kind: 'go', to, why };
    };
    if (this.deaths == null) this.deaths = i.deaths;
    if (i.deaths > this.deaths) {
      this.deaths = i.deaths;
      return next(`morí en ${cur.name}`, SCOUT.deathBanMs);
    }
    if (i.map !== cur.map) {
      // En camino. Si el destino quedó vetado (no llegué) o dejó de ser seguro (bajó el nivel), otro.
      if (this.isBanned(cur.map, i.now) || !scoutMaps(i.level, i.weak).some((h) => h.map === cur.map)) return next(`${cur.name} ya no es seguro`, 0);
      return { kind: 'stay' };
    }
    this.arrivedAt ??= i.now;
    if (i.danger) return next(`peligro en ${cur.name}: ${i.danger}`, SCOUT.banMs);
    if (this.isBanned(cur.map, i.now) || !scoutMaps(i.level, i.weak).some((h) => h.map === cur.map)) return next(`${cur.name} ya no es seguro`, SCOUT.banMs);
    if (i.now - this.arrivedAt >= this.dwellMs || i.lapDone) return next(i.lapDone ? `recorrí ${cur.name}` : `ya vi ${cur.name}`);
    return { kind: 'stay' };
  }

  /** El vigía diagnosticó una traba: veta el mapa y vuelve al más seguro. Devuelve el mapa nuevo o null (queda donde está). */
  onStuck(i: Pick<TourInput, 'now' | 'level' | 'weak' | 'covered'>): HuntMap | null {
    if (!this.target) return null;
    this.ban(this.target.map, i.now);
    const to = this.pickNext(i, this.target.map, true);
    if (to && to.map !== this.target.map) { this.go(to); return to; }
    return null;
  }

  /** No pude llegar al mapa (warps sin respuesta): veto y otro la próxima vuelta. */
  warpFailed(now: number) {
    if (this.target) this.ban(this.target.map, now);
  }
}

// --- Publicar -----------------------------------------------------------------------------------------------

/** Cuándo toca publicar: cada 30-60 s al azar, el primero a los segundos de llegar a un mapa. */
export class ScoutPublisher {
  private nextAt = 0;
  private arrivedFor = -1;

  constructor(private readonly rng: () => number = Math.random) {}

  /** ¿Publicar ahora? `map`: donde está parado el bot (el mapa cambia el compás). */
  due(now: number, map: number): boolean {
    if (map !== this.arrivedFor) {
      this.arrivedFor = map;
      this.nextAt = now + SCOUT.arriveDelayMs;
    }
    return now >= this.nextAt;
  }

  sent(now: number) {
    this.nextAt = now + rand(this.rng, SCOUT.publishMinMs, SCOUT.publishMaxMs);
  }
}

export type ScoutBody = { from: string; kind: 'scout'; map: number; x: number; y: number; players: number; monsters: number; golds: number; goldTypes: string[]; note: string };

/** El reporte de lo que el explorador tiene a la vista. Jugadores: sin contar a los compañeros. */
export function buildScoutBody(i: { from: string; mapName: string; map: number; x: number; y: number; players: number; monsters: number; golds: readonly string[] }): ScoutBody {
  const types = [...new Set(i.golds)].slice(0, 8).map((n) => n.slice(0, 30));
  const golds = Math.min(99, i.golds.length);
  const note = `${i.mapName}: ${golds ? `${golds} dorado${golds === 1 ? '' : 's'} (${types.slice(0, 3).join(', ')})` : 'sin dorados'}, ${i.players} jugador${i.players === 1 ? '' : 'es'}, ${i.monsters} monstruos`;
  return { from: i.from, kind: 'scout', map: i.map, x: i.x, y: i.y, players: Math.min(999, i.players), monsters: Math.min(9999, i.monsters), golds, goldTypes: types, note: note.slice(0, 80) };
}

// --- Consumir (cazadores) ------------------------------------------------------------------------------------

/** Lo que devuelve GET /api/team en `scouts`, validado y sin lo mío ni lo viejo (< 10 min). Tolera basura. */
export function freshReports(raw: unknown, me: string, now: number): ScoutInfo[] {
  if (!Array.isArray(raw)) return [];
  const int = (v: unknown, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= hi;
  const out = new Map<string, ScoutInfo>();
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.from !== 'string' || r.from.toLowerCase() === me.toLowerCase()) continue;
    if (!int(r.map, 255) || !int(r.x, 255) || !int(r.y, 255) || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    if (now - r.at > SCOUT_FRESH_MS || r.at - now > 60_000) continue;
    const goldTypes = Array.isArray(r.goldTypes) ? r.goldTypes.filter((t): t is string => typeof t === 'string').slice(0, 8) : undefined;
    const info: ScoutInfo = { from: r.from, map: r.map, x: r.x, y: r.y, players: int(r.players, 999) ? r.players : 0, monsters: int(r.monsters, 9999) ? r.monsters : 0,
      golds: int(r.golds, 99) ? r.golds : 0, ...(goldTypes ? { goldTypes } : {}), note: typeof r.note === 'string' ? r.note.slice(0, 80) : '', at: r.at };
    const k = `${info.from}:${info.map}`;
    if (!out.has(k) || out.get(k)!.at < info.at) out.set(k, info);
  }
  return [...out.values()];
}

/** Último reporte de otro explorador por mapa (para que el explorador no repita lo cubierto). */
export function coveredMaps(reports: readonly ScoutInfo[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of reports) m.set(r.map, Math.max(m.get(r.map) ?? 0, r.at));
  return m;
}

/**
 * Multiplicador del valor de un mapa para `pickHuntMap` según los reportes: dorados vivos vistos por un
 * explorador suben (hasta +100 %, menos cuanto más viejo) y la competencia lo baja (5+ jugadores x0,6; 2-4 x0,85),
 * con el reporte más fresco del mapa. Sin reportes: 1 (comportamiento de antes).
 */
export function scoutFactor(reports: readonly ScoutInfo[], map: number, now: number): number {
  const rs = reports.filter((r) => r.map === map && now - r.at <= SCOUT_FRESH_MS).sort((a, b) => b.at - a.at);
  if (!rs.length) return 1;
  const w = (r: ScoutInfo) => Math.max(0, 1 - Math.max(0, now - r.at) / SCOUT_FRESH_MS);
  const gold = rs.find((r) => r.golds > 0);
  const up = gold ? 1 + Math.min(gold.golds, 5) * 0.2 * w(gold) : 1;
  const f = rs[0];
  const crowd = f.players >= 5 ? 0.6 : f.players >= 2 ? 0.85 : 1;
  const down = 1 - (1 - crowd) * w(f);
  return Math.min(2, Math.max(0.5, up * down));
}

/** Dónde un explorador vio dorados en ese mapa hace poco (para ir primero): posición y cuándo. Los más frescos primero. */
export function scoutHints(reports: readonly ScoutInfo[], map: number, now: number, maxAgeMs: number): { key: number; x: number; y: number; at: number }[] {
  return reports.filter((r) => r.map === map && r.golds > 0 && now - r.at <= maxAgeMs).sort((a, b) => b.at - a.at).map((r) => ({ key: -r.at, x: r.x, y: r.y, at: r.at }));
}
