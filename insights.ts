/**
 * Lo que dicen los datos (ClickHouse) para decidir en vivo: qué mapa conviene cazar a esta hora, qué dragón
 * viene, dónde murieron personajes parecidos, quién le roba las cajas. Una consulta cada 10 min (8 SELECT
 * livianos), con caché.
 *
 * REGLA DURA: el bot jamás depende de la base para jugar. Sin base, con la base caída o con datos pobres,
 * todo devuelve lo neutral (factor 1, sin predicción, sin celdas a evitar) y el bot hace lo de siempre. Las
 * consultas son solo lectura (queryDb) y los reintentos se espacian (2 min → 30 min). Cada efecto exige un
 * mínimo de datos medidos (ver MIN_*) y está acotado: ningún dato solo manda.
 *
 * Lo puro (`buildInsights`, `huntFactor`, `predictDragonMap`, `avoidCells`, `summarize`) se testea sin red en
 * insights-tests.ts; lo impuro (`insights()`) es solo la carga con caché.
 */
import { MAP_NAMES } from './panel-logic';
import { postInsight } from './team';
import { queryDb, telemetryOn } from './telemetry';
import { log } from './util';

/** Celda para las muertes y las zonas: igual que el recorrido de la cacería (HUNT_CELL). */
export const INSIGHT_CELL = 25;

export const INSIGHT = {
  refreshMs: 10 * 60_000,
  /** Más viejo que esto = se ignora (la base quedó muda). */
  maxAgeMs: 2 * 60 * 60_000,
  retryMinMs: 2 * 60_000,
  retryMaxMs: 30 * 60_000,
  /** Mínimos medidos para que un dato mueva una decisión. */
  minHuntMinutes: 20,
  minTotalHuntMinutes: 60,
  minExposureMin: 60,
  minRivalSnaps: 30,
  /** Invasiones vistas para predecir el mapa del dragón (en esa hora / en total) y la proporción que tiene que tener. */
  minDragonHour: 2,
  minDragonAll: 4,
  dragonShare: 0.6,
  /** Muertes en la misma celda para marcarla como letal. */
  minCellDeaths: 2,
  /** Nivel mínimo de las muertes que cuentan (los personajes nuevos mueren por otras causas). */
  deathLevel: 300,
} as const;

// --- Filas crudas de las consultas (los números grandes de ClickHouse llegan como string) ---------------------
type N = number | string;
export type RawInsights = {
  hunts: { map: N; minutes: N; hunts: N; seen: N }[];
  kills: { map: N; mine: N; other: N }[];
  boxes: { map: N; boxes: N }[];
  /** Una fila por invasión: hr = hora de inicio (unix s), name = mapa del Golden Dragon. */
  invasions: { hr: N; name: string }[];
  deaths: { map: N; cx: N; cy: N; player: N; h: N }[];
  exposure: { map: N; minutes: N }[];
  rivals: { map: N; h: N; seen: N; snaps: N }[];
  thieves: { killer: string; n: N }[];
};

export const INSIGHT_SQL: Record<keyof RawInsights, string> = {
  hunts: `SELECT toUInt16(JSONExtractInt(data,'map')) AS map, sum(JSONExtractFloat(data,'min')) AS minutes, count() AS hunts, sum(JSONExtractUInt(data,'seen')) AS seen
    FROM events WHERE kind='hunt_end' AND JSONExtractBool(data,'red')=0 AND ts > now() - INTERVAL 30 DAY GROUP BY map FORMAT JSONEachRow`,
  kills: `SELECT map, countIf(num2=1) AS mine, countIf(num2=0) AS other FROM events WHERE kind='golden_kill' AND ts > now() - INTERVAL 30 DAY GROUP BY map FORMAT JSONEachRow`,
  boxes: `SELECT map, countIf(num1=14 AND num2=11) AS boxes FROM events WHERE kind='loot_ok' AND ts > now() - INTERVAL 30 DAY GROUP BY map FORMAT JSONEachRow`,
  invasions: `SELECT toUInt32(toUnixTimestamp(hr)) AS hr, any(name) AS name FROM (
      SELECT toStartOfHour(ts) AS hr, extract(text, '^\\\\[([^\\\\]]+)\\\\]') AS name FROM events WHERE kind='server_msg' AND text LIKE '%Golden invasion!' AND ts > now() - INTERVAL 30 DAY
      UNION ALL
      SELECT toStartOfHour(ts - INTERVAL 10 MINUTE) AS hr, extract(text, '^\\\\[([^\\\\]]+)\\\\]') AS name FROM events WHERE kind='server_msg' AND text LIKE '%Golden invasion has ended.' AND ts > now() - INTERVAL 30 DAY)
    GROUP BY hr ORDER BY hr FORMAT JSONEachRow`,
  deaths: `SELECT map, intDiv(x, ${INSIGHT_CELL}) AS cx, intDiv(y, ${INSIGHT_CELL}) AS cy, toUInt8(num2 = 1) AS player, toHour(ts) AS h
    FROM events WHERE kind = 'death' AND level >= ${INSIGHT.deathLevel} AND ts > now() - INTERVAL 30 DAY FORMAT JSONEachRow`,
  exposure: `SELECT map, round(count() / 12) AS minutes FROM ticks WHERE level >= ${INSIGHT.deathLevel} AND ts > now() - INTERVAL 30 DAY GROUP BY map FORMAT JSONEachRow`,
  rivals: `SELECT map, toHour(ts) AS h, count() AS seen, uniqExact(toStartOfInterval(ts, INTERVAL 10 SECOND), char) AS snaps
    FROM players_seen WHERE mate = 0 AND ts > now() - INTERVAL 30 DAY GROUP BY map, h FORMAT JSONEachRow`,
  thieves: `SELECT JSONExtractString(data, 'killer') AS killer, count() AS n FROM events WHERE kind = 'golden_kill' AND num2 = 0 AND ts > now() - INTERVAL 30 DAY
    GROUP BY killer ORDER BY n DESC LIMIT 20 FORMAT JSONEachRow`,
};

// --- Lo calculado -----------------------------------------------------------------------------------------------
export type Insights = {
  at: number;
  /** Por mapa de cacería: minutos cazados, cajas propias, kills propias / de otro, rendimiento (cajas por minuto). */
  hunt: Map<number, { minutes: number; boxes: number; mine: number; other: number; seen: number; boxesPerMin: number }>;
  huntTotal: { minutes: number; boxes: number; boxesPerMin: number };
  /** Mapa del Golden Dragon de cada invasión vista: por hora UTC del día y en total. */
  dragonByHour: Map<number, Map<number, number>>;
  dragonAll: Map<number, number>;
  /** Muertes (nivel >= deathLevel) por mapa y celda "cx,cy" de INSIGHT_CELL, y las de jugadores por hora UTC. */
  deathCells: Map<number, Map<string, number>>;
  deathsByMap: Map<number, number>;
  playerDeathsByHour: number[];
  /** Muertes por hora de exposición, por mapa y global. */
  deathsPerHour: Map<number, number>;
  deathsPerHourAll: number;
  exposureMin: Map<number, number>;
  /** Rivales a la vista por foto: `${map}:${horaUTC}` → promedio y fotos; y el promedio global. */
  rivalsAvg: Map<string, { avg: number; snaps: number }>;
  rivalsAvgAll: number;
  /** Rivales que se llevaron dorados a la vista (nombre → cantidad). */
  thieves: { name: string; n: number }[];
  /** Celdas letales por mapa (>= minCellDeaths), con identidad estable para el recorrido. */
  avoid: Map<number, ReadonlySet<string>>;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const MAP_BY_NAME = new Map(Object.entries(MAP_NAMES).map(([k, v]) => [v.toLowerCase(), Number(k)]));
const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function buildInsights(raw: RawInsights, now = Date.now(), cfg: typeof INSIGHT = INSIGHT): Insights {
  const hunt: Insights['hunt'] = new Map();
  const slot = (map: number) => {
    let s = hunt.get(map);
    if (!s) hunt.set(map, (s = { minutes: 0, boxes: 0, mine: 0, other: 0, seen: 0, boxesPerMin: 0 }));
    return s;
  };
  for (const r of raw.hunts) { const s = slot(num(r.map)); s.minutes += num(r.minutes); s.seen += num(r.seen); }
  for (const r of raw.kills) { const s = slot(num(r.map)); s.mine += num(r.mine); s.other += num(r.other); }
  for (const r of raw.boxes) slot(num(r.map)).boxes += num(r.boxes);
  let tMin = 0, tBoxes = 0;
  for (const s of hunt.values()) {
    s.boxesPerMin = s.boxes / (s.minutes + 10);
    tMin += s.minutes;
    tBoxes += s.boxes;
  }

  // Dragón por invasión: hora UTC del día de inicio.
  const dragonByHour = new Map<number, Map<number, number>>();
  const dragonAll = new Map<number, number>();
  for (const r of raw.invasions) {
    const map = MAP_BY_NAME.get(String(r.name ?? '').trim().toLowerCase());
    if (map == null) continue;
    const h = new Date(num(r.hr) * 1000).getUTCHours();
    bump(dragonAll, map);
    const m = dragonByHour.get(h) ?? new Map<number, number>();
    bump(m, map);
    dragonByHour.set(h, m);
  }

  const deathCells = new Map<number, Map<string, number>>();
  const deathsByMap = new Map<number, number>();
  const playerDeathsByHour = new Array<number>(24).fill(0);
  let deathsAll = 0;
  for (const r of raw.deaths) {
    const map = num(r.map);
    const cells = deathCells.get(map) ?? new Map<string, number>();
    bump(cells, `${num(r.cx)},${num(r.cy)}`);
    deathCells.set(map, cells);
    bump(deathsByMap, map);
    deathsAll++;
    if (num(r.player) === 1) playerDeathsByHour[((num(r.h) % 24) + 24) % 24]++;
  }
  const exposureMin = new Map<number, number>();
  let expAll = 0;
  for (const r of raw.exposure) { exposureMin.set(num(r.map), num(r.minutes)); expAll += num(r.minutes); }
  const deathsPerHour = new Map<number, number>();
  for (const [map, d] of deathsByMap) {
    const e = exposureMin.get(map) ?? 0;
    if (e >= cfg.minExposureMin) deathsPerHour.set(map, d / (e / 60));
  }

  const rivalsAvg = new Map<string, { avg: number; snaps: number }>();
  let rSeen = 0, rSnaps = 0;
  for (const r of raw.rivals) {
    const snaps = num(r.snaps);
    if (snaps <= 0) continue;
    rivalsAvg.set(`${num(r.map)}:${num(r.h)}`, { avg: num(r.seen) / snaps, snaps });
    rSeen += num(r.seen);
    rSnaps += snaps;
  }

  const avoid = new Map<number, ReadonlySet<string>>();
  for (const [map, cells] of deathCells) {
    const bad = new Set([...cells].filter(([, n]) => n >= cfg.minCellDeaths).map(([k]) => k));
    if (bad.size) avoid.set(map, bad);
  }

  return {
    at: now, hunt, huntTotal: { minutes: tMin, boxes: tBoxes, boxesPerMin: tBoxes / (tMin + 10) },
    dragonByHour, dragonAll, deathCells, deathsByMap, playerDeathsByHour,
    deathsPerHour, deathsPerHourAll: expAll >= cfg.minExposureMin ? deathsAll / (expAll / 60) : 0, exposureMin,
    rivalsAvg, rivalsAvgAll: rSnaps >= cfg.minRivalSnaps ? rSeen / rSnaps : 0,
    thieves: raw.thieves.filter((t) => t.killer).map((t) => ({ name: t.killer, n: num(t.n) })), avoid,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fresh = (ins: Insights | null, now: number, cfg: typeof INSIGHT = INSIGHT): ins is Insights => !!ins && now - ins.at < cfg.maxAgeMs;

/**
 * Multiplicador (0,5 a 1,5) del valor de cazar en `map` ahora: rendimiento de cajas medido en ese mapa,
 * muertes por hora de exposición y rivales a la vista a esta hora, cada uno contra el promedio global y solo
 * con el mínimo de datos. Sin datos: 1.
 */
export function huntFactor(ins: Insights | null, map: number, now = Date.now(), cfg: typeof INSIGHT = INSIGHT): number {
  if (!fresh(ins, now, cfg)) return 1;
  let f = 1;
  const h = ins.hunt.get(map);
  if (h && h.minutes >= cfg.minHuntMinutes && ins.huntTotal.minutes >= cfg.minTotalHuntMinutes)
    f *= clamp(Math.sqrt((h.boxesPerMin + 0.02) / (ins.huntTotal.boxesPerMin + 0.02)), 0.7, 1.3);
  const dph = ins.deathsPerHour.get(map);
  if (dph != null && ins.deathsPerHourAll > 0) f *= clamp((1 + 0.5 * ins.deathsPerHourAll) / (1 + 0.5 * dph), 0.6, 1.1);
  const r = ins.rivalsAvg.get(`${map}:${new Date(now).getUTCHours()}`);
  if (r && r.snaps >= cfg.minRivalSnaps && ins.rivalsAvgAll > 0) f *= clamp((1 + 0.05 * ins.rivalsAvgAll) / (1 + 0.05 * r.avg), 0.7, 1.1);
  return clamp(f, 0.5, 1.5);
}

export type DragonPrediction = { map: number; n: number; share: number; scope: 'hora' | 'todas' };

/**
 * Mapa probable del Golden Dragon de la invasión de la hora UTC `hourUtc`: el de esa hora si hay datos y
 * ganan por mayoría; si no, el más frecuente en total. null si no alcanza (no se inventa).
 */
export function predictDragonMap(ins: Insights | null, hourUtc: number, now = Date.now(), cfg: typeof INSIGHT = INSIGHT): DragonPrediction | null {
  if (!fresh(ins, now, cfg)) return null;
  const pick = (m: Map<number, number> | undefined, min: number, scope: DragonPrediction['scope']): DragonPrediction | null => {
    if (!m) return null;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (total < min) return null;
    const [map, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    return n / total >= cfg.dragonShare ? { map, n: total, share: n / total, scope } : null;
  };
  return pick(ins.dragonByHour.get(((hourUtc % 24) + 24) % 24), cfg.minDragonHour, 'hora') ?? pick(ins.dragonAll, cfg.minDragonAll, 'todas');
}

/** Celdas "cx,cy" (INSIGHT_CELL) donde murieron personajes parecidos al menos minCellDeaths veces: se recorren al final. */
export function avoidCells(ins: Insights | null, map: number, now = Date.now()): ReadonlySet<string> | undefined {
  return fresh(ins, now) ? ins.avoid.get(map) : undefined;
}

/** Resumen corto y plano (para el log, la tarjeta de decisiones y la estación). */
export function summarize(ins: Insights, now = Date.now()) {
  const hourUtc = new Date(now).getUTCHours();
  const nextHour = new Date(now).getUTCMinutes() >= 50 ? hourUtc : (hourUtc + 1) % 24;
  const dragon = predictDragonMap(ins, nextHour, now);
  const mapNm = (m: number) => MAP_NAMES[m] ?? `mapa ${m}`;
  return {
    dragon: dragon ? { map: dragon.map, name: mapNm(dragon.map), n: dragon.n, share: +dragon.share.toFixed(2), scope: dragon.scope } : null,
    hunt: [...ins.hunt].filter(([, s]) => s.minutes > 0).map(([map, s]) => ({ map, name: mapNm(map), minutes: +s.minutes.toFixed(1), boxes: s.boxes, factor: +huntFactor(ins, map, now).toFixed(2) })),
    thieves: ins.thieves.slice(0, 5),
    lethal: [...ins.avoid].map(([map, cells]) => ({ map, name: mapNm(map), cells: [...cells] })),
  };
}

// --- Carga con caché ------------------------------------------------------------------------------------------------
let current: Insights | null = null;
let loadedAt = 0;
let loading = false;
let fails = 0;
let nextTryAt = 0;
let lastShared = '';

/** Los insights vigentes (o null). Dispara la recarga en segundo plano si está viejo; nunca espera ni tira. */
export function insights(now = Date.now()): Insights | null {
  try {
    if (telemetryOn() && !loading && now >= nextTryAt && (!current || now - loadedAt >= INSIGHT.refreshMs)) {
      loading = true;
      void load(now).finally(() => { loading = false; });
    }
  } catch { /* la base nunca frena el juego */ }
  return fresh(current, now) ? current : null;
}

async function load(now: number) {
  try {
    const keys = Object.keys(INSIGHT_SQL) as (keyof RawInsights)[];
    const rows = await Promise.all(keys.map((k) => queryDb(INSIGHT_SQL[k])));
    // queryDb no distingue "falló" de "vacío": si TODO vino vacío se cuenta como falla y se espacia el reintento.
    if (rows.every((r) => r.length === 0)) throw new Error('sin datos');
    const raw = Object.fromEntries(keys.map((k, i) => [k, rows[i]])) as unknown as RawInsights;
    current = buildInsights(raw, Date.now());
    loadedAt = Date.now();
    fails = 0;
    nextTryAt = 0;
    const s = summarize(current);
    const sig = JSON.stringify({ d: s.dragon?.map, t: s.thieves.map((t) => t.name), l: s.lethal });
    if (sig !== lastShared) {
      lastShared = sig;
      log(`Datos: dragón probable ${s.dragon ? `${s.dragon.name} (${s.dragon.n} invasiones, ${Math.round(s.dragon.share * 100)} %)` : 'sin datos'}, ${s.lethal.length} mapa(s) con celdas letales, ${s.thieves.length} ladrón(es) de cajas.`);
      postInsight(`dragón ${s.dragon?.name ?? '?'}; ladrones ${s.thieves.map((t) => t.name).join(', ') || '-'}`, s);
    }
  } catch {
    fails++;
    nextTryAt = now + Math.min(INSIGHT.retryMaxMs, INSIGHT.retryMinMs * 2 ** Math.min(fails - 1, 6));
  }
}
