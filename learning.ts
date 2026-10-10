/**
 * Capa de aprendizaje del bot: mide qué tan bien rinde cada spot de farmeo y
 * elige a dónde ir con esa experiencia en vez de una regla fija.
 *
 * Todo lo de este archivo es lógica PURA (sin red, sin EventBus, sin `world`):
 * recibe datos y el reloj por parámetro, así se testea offline en
 * `learning-tests.ts`. `headless-bot.ts` lo engancha a los eventos reales.
 *
 * Ver AGENTS.md, sección "Aprendizaje".
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KnownCamp } from './camp';
import type { CycleRecord } from './farming';

// map: número de mapa al que deja el warp (si se conoce). Sirve para retomar
// sin warpear cuando el bot arranca (o reconecta) ya parado en el mapa del tramo.
export type Spot = { index: number; name: string; reqLevel: number; zen: number; map?: number };

// Una muestra = un tramo continuo de farmeo en un spot (se corta cada ~2 min,
// al cambiar de spot, al morir y al terminar). Guarda el nivel y el reset al
// que se midió: la exp/min de un spot cambia mucho con el nivel y las stats.
export type SpotSample = {
  spot: number;   // índice de warp (Spot.index)
  level: number;  // nivel al empezar el tramo
  reset: number;  // resets del personaje (contador local, ver AGENTS.md)
  ms: number;     // duración del tramo
  exp: number;
  kills: number;
  deaths: number;
  at: string;     // ISO, fin del tramo
};

// Además de las muestras por spot, se guarda lo que aprende el farmeo
// (farming.ts / explore.ts) para que sobreviva a un reinicio del bot, como el
// localStorage del agente web: exp y segundos de kill por tipo de monstruo, y
// la grilla de spots calientes (exp acumulada por celda de 12x12 y mapa).
export type HotCellData = { map: number; cx: number; cy: number; exp: number };
export type TypeData = { expByType: Record<number, number>; killSecByType: Record<number, number> };
// camps: memoria de campamentos (camp.ts); cycles: registro de tramos por ciclo
// (farming.ts, CycleLog), con el ciclo en curso para retomarlo tras un
// reinicio; tierRef: referencia de exp/min por tramo para el "hambre" (camp.ts).
export type CyclesData = { cur: CycleRecord | null; done: CycleRecord[] };
export type CharLearning = {
  resets: number; samples: SpotSample[]; hot?: HotCellData[]; types?: TypeData;
  camps?: KnownCamp[]; cycles?: CyclesData; tierRef?: Record<string, number>;
};
export type LearningFile = { version: 1; chars: Record<string, CharLearning> };

// ---------------------------------------------------------------------------
// Parámetros. Están acá (y no como flags) porque son del modelo, no del uso.
// ---------------------------------------------------------------------------
export const LEARN = {
  // Permanencia mínima en un spot antes de evaluar un cambio. Cada warp cuesta
  // zen y un humano no salta de mapa cada minuto.
  MIN_DWELL_MS: 5 * 60_000,
  // Un tramo más corto que esto no se guarda (ruido: warp + pararse a vender).
  MIN_SAMPLE_MS: 30_000,
  // Dos señales de muerte (HP=0 y ObjectGotKilled) dentro de esta ventana
  // cuentan como UNA muerte.
  DEATH_DEBOUNCE_MS: 15_000,
  // Una muerte "cuesta" estos minutos de farmeo (respawn, volver, pociones):
  // la tasa efectiva es exp / (minutos + muertes * DEATH_COST_MIN).
  DEATH_COST_MIN: 3,
  // Muestras a más de estos niveles de distancia no cuentan; las más cercanas
  // pesan más (triangular). Muestras de otro reset pesan la mitad.
  LEVEL_WINDOW: 40,
  OTHER_RESET_WEIGHT: 0.5,
  // Minutos ponderados mínimos para considerar que un spot "tiene datos".
  MIN_DATA_MIN: 1,
  // Exploración: solo se prueban spots sin datos si están entre los K de
  // mayor reqLevel elegibles. Sin esto, a nivel 400 probaría los 22 mapas.
  EXPLORE_TOP_K: 4,
  // Peso del bonus de exploración de UCB1 (el clásico es 1; acá menos porque
  // explorar cuesta zen y tiempo de viaje).
  UCB_C: 0.3,
  // Hace falta superar al spot actual por este margen (en recompensa
  // normalizada) para moverse: evita oscilar entre dos spots casi iguales.
  SWITCH_MARGIN: 0.05,
  // Tope de muestras por personaje para que el JSON no crezca sin límite.
  MAX_SAMPLES: 2000,
  // Un spot donde el mapa entero quedó sin monstruos (ver explore.ts,
  // DRY_MAP_MS) no se vuelve a elegir durante esto. El tramo seco en sí ya
  // queda como muestra mala (0 exp en >= 2 min).
  DRY_EXCLUDE_MS: 15 * 60_000,
} as const;
export type LearnParams = typeof LEARN;

// ---------------------------------------------------------------------------
// Medición: acumula exp/kills/muertes del tramo actual en el spot actual.
// ---------------------------------------------------------------------------
export class SpotMeter {
  private spot: number | null = null;
  private level = 0;
  private reset = 0;
  private since = 0;
  private exp = 0;
  private kills = 0;
  private deaths = 0;
  private lastDeathAt = -Infinity;

  constructor(private readonly params: Pick<LearnParams, 'MIN_SAMPLE_MS' | 'DEATH_DEBOUNCE_MS'> = LEARN) {}

  get activeSpot(): number | null {
    return this.spot;
  }

  start(spot: number, level: number, reset: number, now: number) {
    this.spot = spot;
    this.level = level;
    this.reset = reset;
    this.since = now;
    this.exp = this.kills = this.deaths = 0;
  }

  stop() {
    this.spot = null;
  }

  addExp(n: number) {
    if (this.spot != null && n > 0) this.exp += n;
  }

  addKill() {
    if (this.spot != null) this.kills++;
  }

  // Devuelve true si se contó como muerte nueva (no un duplicado de la otra señal).
  addDeath(now: number): boolean {
    if (now - this.lastDeathAt < this.params.DEATH_DEBOUNCE_MS) return false;
    this.lastDeathAt = now;
    if (this.spot != null) this.deaths++;
    return true;
  }

  // El tramo en curso como muestra, sin cortarlo (para decidir con lo último).
  peek(now: number): SpotSample | null {
    if (this.spot == null) return null;
    return {
      spot: this.spot, level: this.level, reset: this.reset, ms: Math.max(0, now - this.since),
      exp: this.exp, kills: this.kills, deaths: this.deaths, at: new Date(now).toISOString(),
    };
  }

  // Corta el tramo: devuelve la muestra (o null si es muy corta y sin muertes)
  // y arranca uno nuevo en el mismo spot con el nivel actual.
  flush(now: number, level = this.level): SpotSample | null {
    const s = this.peek(now);
    if (!s) return null;
    this.start(s.spot, level, this.reset, now);
    if (s.ms < this.params.MIN_SAMPLE_MS && s.deaths === 0) return null;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Agregado: tabla por spot, ponderando las muestras por cercanía de nivel.
// ---------------------------------------------------------------------------
export type SpotStats = {
  spot: number;
  n: number;          // muestras que cuentan (peso > 0)
  minutes: number;    // minutos ponderados
  expPerMin: number;  // exp / minuto, cruda
  killsPerMin: number;
  deaths: number;     // muertes ponderadas
  rate: number;       // exp/min efectiva, con el costo de las muertes
};

export function sampleWeight(s: SpotSample, level: number, reset: number, p: LearnParams = LEARN): number {
  const dl = Math.abs(s.level - level);
  if (dl > p.LEVEL_WINDOW) return 0;
  const wl = 1 - dl / (p.LEVEL_WINDOW + 1);
  return wl * (s.reset === reset ? 1 : p.OTHER_RESET_WEIGHT);
}

export function aggregate(samples: SpotSample[], level: number, reset: number, p: LearnParams = LEARN): Map<number, SpotStats> {
  const acc = new Map<number, { n: number; ms: number; exp: number; kills: number; deaths: number }>();
  for (const s of samples) {
    const w = sampleWeight(s, level, reset, p);
    if (w <= 0) continue;
    const a = acc.get(s.spot) ?? { n: 0, ms: 0, exp: 0, kills: 0, deaths: 0 };
    a.n++;
    a.ms += w * s.ms;
    a.exp += w * s.exp;
    a.kills += w * s.kills;
    a.deaths += w * s.deaths;
    acc.set(s.spot, a);
  }
  const out = new Map<number, SpotStats>();
  for (const [spot, a] of acc) {
    const minutes = a.ms / 60_000;
    out.set(spot, {
      spot,
      n: a.n,
      minutes,
      expPerMin: minutes > 0 ? a.exp / minutes : 0,
      killsPerMin: minutes > 0 ? a.kills / minutes : 0,
      deaths: a.deaths,
      rate: minutes + a.deaths * p.DEATH_COST_MIN > 0 ? a.exp / (minutes + a.deaths * p.DEATH_COST_MIN) : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elección de spot: bandit UCB1.
//
// Por qué UCB1 y no epsilon-greedy: epsilon-greedy explora tirando una moneda,
// o sea warps AL AZAR para siempre (cada uno cuesta zen y minutos de viaje, y
// un personaje que salta de mapa sin motivo se ve raro). UCB1 es determinista:
// explora solo donde hay poca evidencia, el bonus se apaga solo a medida que
// se acumulan minutos, y cada decisión se puede explicar con números ("X da
// 412 exp/min vs Y 380"). Adaptaciones:
//   - una "jugada" es MIN_DWELL_MS de farmeo, no un warp (pulls = minutos/5);
//   - la recompensa es la tasa efectiva normalizada por la mejor (0..1);
//   - los spots sin datos (bonus infinito en UCB1 puro) solo se prueban si
//     están entre los EXPLORE_TOP_K de mayor reqLevel, en ese orden: sin datos
//     en absoluto, eso es exactamente la regla vieja (mayor reqLevel);
//   - histéresis (SWITCH_MARGIN) y permanencia mínima (MIN_DWELL_MS).
// ---------------------------------------------------------------------------
export type ChoiceReason =
  | 'none'        // no hay spot elegible
  | 'dwell'       // todavía no se cumplió la permanencia mínima
  | 'ineligible'  // el spot actual ya no sirve (nivel/--spots): cambio forzado
  | 'dry'         // el mapa actual se quedó sin monstruos: cambio forzado
  | 'no-data'     // sin datos de nada: regla vieja (mayor reqLevel)
  | 'explore'     // probar un spot sin datos para este nivel
  | 'exploit'     // otro spot rinde mejor
  | 'stay';       // el actual sigue siendo el mejor

export type SpotChoice = {
  spot: Spot | null;          // a dónde ir (== current si no hay que moverse)
  reason: ChoiceReason;
  what: string;               // explicación legible para decide() y el log
  stats: Map<number, SpotStats>;
  ucb: Map<number, number>;
};

export type ChooseInput = {
  spots: Spot[];
  level: number;
  reset: number;
  allowed: Set<number> | null;
  current: Spot | null;
  dwellMs: number;            // cuánto hace que está en `current`
  samples: SpotSample[];      // historial + el tramo en curso
  // Spots "secos" (mapa sin monstruos hace poco): no se eligen, y si el actual
  // está acá, se cambia aunque no cumpla la permanencia mínima.
  exclude?: ReadonlySet<number>;
};

// Spots secos vigentes: los que se marcaron hace menos de DRY_EXCLUDE_MS.
export function activeDryExclusions(dryAt: ReadonlyMap<number, number>, now: number, p: LearnParams = LEARN): Set<number> {
  const out = new Set<number>();
  for (const [spot, at] of dryAt) if (now - at < p.DRY_EXCLUDE_MS) out.add(spot);
  return out;
}

export function eligibleSpots(spots: Spot[], level: number, allowed: Set<number> | null): Spot[] {
  return spots
    .filter((sp) => sp.reqLevel <= level && (!allowed || allowed.has(sp.index)))
    .sort((a, b) => b.reqLevel - a.reqLevel);
}

const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

export function chooseSpot(inp: ChooseInput, p: LearnParams = LEARN): SpotChoice {
  const { level, reset, current, dwellMs } = inp;
  const exclude = inp.exclude ?? new Set<number>();
  const curDry = current != null && exclude.has(current.index);
  const cands = eligibleSpots(inp.spots, level, inp.allowed).filter((sp) => !exclude.has(sp.index));
  const stats = aggregate(inp.samples, level, reset, p);
  const ucb = new Map<number, number>();
  const base = { stats, ucb };
  if (!cands.length) return { ...base, spot: current, reason: 'none', what: `sin spots elegibles para nivel ${level}` };

  const curEligible = current != null && cands.some((c) => c.index === current.index);
  if (curEligible && dwellMs < p.MIN_DWELL_MS) {
    return { ...base, spot: current, reason: 'dwell', what: `en ${current!.name} hace ${fmt(dwellMs / 60_000)} min (mínimo ${p.MIN_DWELL_MS / 60_000})` };
  }

  const hasData = (sp: Spot) => (stats.get(sp.index)?.minutes ?? 0) >= p.MIN_DATA_MIN;
  const withData = cands.filter(hasData);
  const stat = (sp: Spot) => stats.get(sp.index)!;
  const describe = (sp: Spot) => {
    const s = stats.get(sp.index);
    return s && hasData(sp) ? `${sp.name} ${fmt(s.rate)} exp/min (n=${s.n})` : `${sp.name} sin datos`;
  };
  const curTxt = current ? describe(current) : 'sin spot';
  const prefix = curEligible || current == null ? '' : curDry ? `${current.name} sin monstruos; ` : `${current.name} ya no es elegible; `;
  const reasonIfMoving = (r: ChoiceReason): ChoiceReason => (curEligible || current == null ? r : curDry ? 'dry' : 'ineligible');

  if (!withData.length) {
    const sp = cands[0];
    if (curEligible && sp.index === current!.index) return { ...base, spot: current, reason: 'stay', what: `${curTxt}; sin datos de otros spots` };
    return { ...base, spot: sp, reason: reasonIfMoving('no-data'), what: `${prefix}${sp.name}: sin datos a nivel ~${level}, el de mayor nivel requerido (${sp.reqLevel})` };
  }

  // Exploración acotada: spots sin datos entre los K de mayor reqLevel.
  const unexplored = cands.slice(0, p.EXPLORE_TOP_K).filter((sp) => !hasData(sp));
  if (unexplored.length && !(curEligible && !hasData(current!))) {
    const sp = unexplored[0];
    return { ...base, spot: sp, reason: reasonIfMoving('explore'), what: `${prefix}explorar ${sp.name} (sin datos a nivel ~${level}); ahora ${curTxt}` };
  }
  if (curEligible && !hasData(current!)) {
    // Estamos midiendo un spot que todavía no juntó MIN_DATA_MIN: seguir.
    return { ...base, spot: current, reason: 'stay', what: `${curTxt}, todavía midiendo` };
  }

  const maxRate = Math.max(...withData.map((sp) => stat(sp).rate));
  const pulls = (sp: Spot) => Math.max(stat(sp).minutes / (p.MIN_DWELL_MS / 60_000), 1e-6);
  const N = withData.reduce((acc, sp) => acc + pulls(sp), 0);
  for (const sp of withData) {
    const reward = maxRate > 0 ? stat(sp).rate / maxRate : 0;
    ucb.set(sp.index, reward + p.UCB_C * Math.sqrt((2 * Math.log(Math.max(N, 1) + 1)) / pulls(sp)));
  }
  let best = withData[0];
  for (const sp of withData) if (ucb.get(sp.index)! > ucb.get(best.index)!) best = sp;

  if (curEligible) {
    if (best.index === current!.index || ucb.get(best.index)! < ucb.get(current!.index)! + p.SWITCH_MARGIN) {
      return { ...base, spot: current, reason: 'stay', what: `${curTxt} sigue siendo el mejor` };
    }
  }
  const b = stat(best);
  const vs = current && current.index !== best.index ? ` vs ${curTxt.replace(/ \(n=\d+\)$/, '')}` : '';
  const exploring = b.rate < maxRate ? ' (poca evidencia, vale revisar)' : '';
  return {
    ...base,
    spot: best,
    reason: reasonIfMoving('exploit'),
    what: `${prefix}${best.name}: ${fmt(b.rate)} exp/min${vs} (n=${b.n})${exploring}`,
  };
}

// ---------------------------------------------------------------------------
// Ruta de spots del usuario (la regla del agente web, `browser-agent.js`, que
// es la que sube rápido). Spot = exp/min:
//   - al habilitarse por nivel un mapa de un tier nuevo, se va a probarlo;
//   - tras EVAL_MS en un spot, si rinde < MIN_FRAC_OF_BEST del mejor conocido
//     (o 0), se cambia: primero a uno sin medir (el de mayor nivel), si no al
//     mejor medido si supera al actual;
//   - lo medido vale para el ciclo de reset actual: después de un /reset el
//     rendimiento por mapa se vuelve a medir (cambian stats y nivel).
// Reemplaza al bandit UCB1 (`chooseSpot`) en el bot: el UCB1 tardaba 5 min
// mínimos por spot y no reaccionaba a un tier nuevo.
// ---------------------------------------------------------------------------
export const ROUTE = {
  EVAL_MS: 2 * 60_000,
  MIN_FRAC_OF_BEST: 0.5,
} as const;
export type RouteParams = typeof ROUTE;

export type RouteReason =
  | 'none'        // no hay spot elegible (o no hay a dónde ir)
  | 'stay'        // el actual sigue sirviendo
  | 'start'       // no hay spot actual (arranque, muerte, reset)
  | 'new-tier'    // se habilitó un tier de mapas nuevo por nivel
  | 'ineligible'  // el actual ya no es elegible
  | 'dry'         // el mapa actual se quedó sin monstruos
  | 'poor';       // el actual rinde < MIN_FRAC_OF_BEST del mejor conocido

export type RouteInput = {
  spots: Spot[];
  level: number;
  allowed: Set<number> | null;
  current: Spot | null;
  stayMs: number;               // cuánto hace que está en `current`
  stayExp: number;              // exp ganada desde que llegó a `current`
  scores: ReadonlyMap<number, number>; // exp/min medida por spot en este ciclo de reset
  tierSeen: number;             // mayor reqLevel ya visto en este ciclo
  exclude?: ReadonlySet<number>;
};

export type RouteChoice = {
  spot: Spot | null;            // a dónde ir (== current si se queda)
  reason: RouteReason;
  what: string;
  tier: number;                 // mayor reqLevel elegible: el caller lo guarda como tierSeen
  curRate: number;              // exp/min de la estadía actual
  bestKnown: number;
  restartEval: boolean;         // rinde poco pero no hay alternativa: medir de nuevo
};

// exp/min por spot en el ciclo de reset `reset`, ponderada por cercanía de
// nivel (aggregate). Solo cuentan spots con al menos EVAL_MS medidos (tiempo
// real, sin ponderar: si no, subir unos niveles dejaba a un spot recién
// medido por debajo del umbral).
export function routeScores(samples: SpotSample[], level: number, reset: number, p: RouteParams = ROUTE, lp: LearnParams = LEARN): Map<number, number> {
  const mine = samples.filter((s) => s.reset === reset && sampleWeight(s, level, reset, lp) > 0);
  const rawMs = new Map<number, number>();
  for (const s of mine) rawMs.set(s.spot, (rawMs.get(s.spot) ?? 0) + s.ms);
  const out = new Map<number, number>();
  for (const [spot, st] of aggregate(mine, level, reset, lp)) if ((rawMs.get(spot) ?? 0) >= p.EVAL_MS) out.set(spot, st.rate);
  return out;
}

export function chooseRouteSpot(inp: RouteInput, p: RouteParams = ROUTE): RouteChoice {
  const { current, scores } = inp;
  const exclude = inp.exclude ?? new Set<number>();
  // Desde nivel 100, solo spots acordes: reqLevel >= nivel/2, o el más alto habilitado.
  // Sin esto, a nivel 367 "probar uno sin medir" mandó al agente web a Devias 2.
  const allowedNow = eligibleSpots(inp.spots, inp.level, inp.allowed);
  const topReq = Math.max(0, ...allowedNow.map((sp) => sp.reqLevel));
  const eligible = allowedNow
    .filter((sp) => inp.level < 100 || sp.reqLevel >= inp.level * 0.5 || sp.reqLevel === topReq)
    .filter((sp) => !exclude.has(sp.index));
  const curRate = current && inp.stayMs > 0 ? inp.stayExp / (inp.stayMs / 60_000) : 0;
  const bestKnown = Math.max(0, ...scores.values());
  const tier = eligible.length ? eligible[0].reqLevel : inp.tierSeen;
  const base = { tier, curRate, bestKnown, restartEval: false };
  if (!eligible.length) return { ...base, spot: current, reason: 'none', what: `sin spots elegibles para nivel ${inp.level}` };

  const curEligible = current != null && eligible.some((sp) => sp.index === current.index);
  const curDry = current != null && exclude.has(current.index);
  const newTier = tier > inp.tierSeen;
  const evalDone = inp.stayMs >= p.EVAL_MS;
  const poor = curEligible && evalDone && (curRate === 0 || curRate < bestKnown * p.MIN_FRAC_OF_BEST);
  const r = (n: number) => Math.round(n);
  const curTxt = current ? `${current.name} ${r(curRate)} exp/min` : 'sin spot';

  if (curEligible && !poor && (!newTier || current!.reqLevel === tier)) {
    return { ...base, spot: current, reason: 'stay', what: `${curTxt}${evalDone ? '' : ' (midiendo)'}` };
  }

  const others = eligible.filter((sp) => sp.index !== current?.index);
  const untried = others.filter((sp) => !scores.has(sp.index)); // ya ordenados por reqLevel desc
  const tried = others.filter((sp) => scores.has(sp.index)).sort((a, b) => scores.get(b.index)! - scores.get(a.index)!);
  const curScore = curEligible ? curRate : -1;
  let to: Spot | null;
  let reason: RouteReason;
  if (!current) reason = 'start';
  else if (curDry) reason = 'dry';
  else if (!curEligible) reason = 'ineligible';
  else if (poor) reason = 'poor';
  else reason = 'new-tier';
  if (newTier && reason !== 'poor') to = others.find((sp) => sp.reqLevel === tier) ?? untried[0] ?? null;
  // Sin spot (murió y respawneó en otro lado) y sin tier nuevo: volver al
  // mejor medido; si no hay medidos, probar el de mayor nivel.
  else if (reason === 'start') to = tried[0] ?? untried[0] ?? null;
  else to = untried[0] ?? (tried[0] && scores.get(tried[0].index)! > curScore ? tried[0] : null);
  if (!to && !curEligible) to = tried[0] ?? null;

  if (!to) {
    if (curEligible) return { ...base, spot: current, reason: 'stay', restartEval: poor, what: `${curTxt}: rinde poco pero no hay alternativa mejor` };
    return { ...base, spot: current, reason: 'none', what: `${current?.name ?? 'sin spot'}: no hay otro spot elegible` };
  }
  const toTxt = scores.has(to.index) ? `${to.name} (${r(scores.get(to.index)!)} exp/min medidos)` : `${to.name} (sin medir)`;
  const why = {
    start: 'inicio',
    'new-tier': `nuevo tier de mapas (nivel ${tier})`,
    dry: `${current?.name} sin monstruos`,
    ineligible: `${current?.name} ya no es elegible`,
    poor: `${curTxt} < ${Math.round(p.MIN_FRAC_OF_BEST * 100)}% del mejor (${r(bestKnown)})`,
    none: '', stay: '',
  }[reason];
  return { ...base, spot: to, reason, what: `${why} → ${toTxt}` };
}

// ---------------------------------------------------------------------------
// Ruta FIJA por tramo de nivel (`fixedRoute` del agente web). Probar mapas "a
// ver si rinden más" costaba más en warps y cargas de lo que ganaba (el
// usuario lo vio en pantalla). Reglas:
//   - Lorencia (warp 2) solo < 20; Devias 3/4/2 (6, 7, 5) de 20 a 99; Arena 2
//     (24) >= 100; Arena 3 (25) >= 200; Arena 4 (26) >= 300.
//   - Devias 1 (4) y Arena 1 (1) fuera, salvo Arena 1 como plan B si todas las
//     Devias están llenas de competencia (nivel 50-99).
//   - Cambiar de mapa solo al cruzar un tramo, si el mapa está vacío (90 s,
//     explore.ts DRY_MAP_MS) o por competencia que baje la exp (camp.ts:
//     campamentos abandonados por gente, o "hambre").
// Si el bot ya está parado en el mapa del tramo (arranque, reconexión), se
// adopta ese spot sin warpear.
// ---------------------------------------------------------------------------
export type RouteTier = { minLevel: number; warps: readonly number[]; map: number };
export const FIXED_ROUTE: readonly RouteTier[] = [
  { minLevel: 0, warps: [2], map: 0 },
  { minLevel: 20, warps: [6, 7, 5], map: 2 },
  { minLevel: 100, warps: [24], map: 83 },
  { minLevel: 200, warps: [25], map: 84 },
  { minLevel: 300, warps: [26], map: 85 },
];
export const CROWD_FALLBACK = { warp: 1, minLevel: 50, maxLevel: 99 } as const;
// Una entrada llena de gente no se vuelve a probar durante esto.
export const CROWDED_SPOT_MS = 5 * 60_000;

export function routeTier(level: number, route: readonly RouteTier[] = FIXED_ROUTE): RouteTier {
  let t = route[0];
  for (const r of route) if (level >= r.minLevel) t = r;
  return t;
}

export type FixedRouteInput = {
  spots: Spot[];                 // incluye el plan B (Arena 1)
  level: number;
  allowed: Set<number> | null;
  current: Spot | null;
  currentMap: number;
  mapDead: boolean;              // mapa vacío (DRY_MAP_MS)
  crowded: boolean;              // competencia que bajó la exp (campamentos o hambre)
  crowdedAt: ReadonlyMap<number, number>; // spot → cuándo se lo dejó por gente
  now: number;
  prefer?: number | null;        // sin spot actual (tras morir): volver a esta entrada si es del tramo
};
export type FixedRouteReason = 'stay' | 'start' | 'adopt' | 'new-tier' | 'dry' | 'crowd' | 'none';
export type FixedRouteChoice = { spot: Spot | null; reason: FixedRouteReason; what: string; tier: number; warp: boolean };

export function chooseFixedRoute(inp: FixedRouteInput, route: readonly RouteTier[] = FIXED_ROUTE): FixedRouteChoice {
  const tier = routeTier(inp.level, route);
  const byIndex = (i: number) => inp.spots.find((s) => s.index === i);
  const ok = (s: Spot | undefined): s is Spot => !!s && (!inp.allowed || inp.allowed.has(s.index));
  const tierSpots = tier.warps.map(byIndex).filter(ok);
  const fb = ok(byIndex(CROWD_FALLBACK.warp)) && inp.level >= CROWD_FALLBACK.minLevel && inp.level <= CROWD_FALLBACK.maxLevel ? byIndex(CROWD_FALLBACK.warp)! : null;
  const cur = inp.current;
  const base = { tier: tier.minLevel };
  const stay = (what: string): FixedRouteChoice => ({ ...base, spot: cur, reason: cur ? 'stay' : 'none', what, warp: false });
  if (!tierSpots.length) return stay(`sin spots de la ruta para nivel ${inp.level}`);
  const inTier = !!cur && (tierSpots.some((s) => s.index === cur.index) || (fb != null && cur.index === fb.index));

  if (!cur) {
    // Ya está en el mapa del tramo: adoptarlo sin warpear.
    if (inp.currentMap === tier.map) return { ...base, spot: tierSpots[0], reason: 'adopt', what: `ya estoy en el mapa ${tier.map} (${tierSpots[0].name})`, warp: false };
    const usable = tierSpots.filter((s) => s.reqLevel <= inp.level);
    const to = usable.find((s) => s.index === inp.prefer) ?? usable[0];
    if (!to) return stay(`nivel ${inp.level}: ${tierSpots[0].name} pide ${tierSpots[0].reqLevel}`);
    return { ...base, spot: to, reason: 'start', what: `inicio → ${to.name}`, warp: true };
  }
  if (!inTier) {
    const to = tierSpots.find((s) => s.reqLevel <= inp.level);
    if (!to) return stay(`${cur.name}: el tramo nuevo todavía no está habilitado`);
    return { ...base, spot: to, reason: 'new-tier', what: `tramo nuevo (nivel ${tier.minLevel}) → ${to.name}`, warp: true };
  }
  if (inp.crowded) {
    const fresh = tierSpots.filter((s) => s.index !== cur.index && s.reqLevel <= inp.level && inp.now - (inp.crowdedAt.get(s.index) ?? -Infinity) > CROWDED_SPOT_MS);
    const to = fresh[0] ?? (fb && fb.index !== cur.index ? fb : null);
    if (to) return { ...base, spot: to, reason: 'crowd', what: `${cur.name} con mucha competencia → ${to.name}${to === fb ? ' (plan B)' : ''}`, warp: true };
    return stay(`${cur.name} con competencia pero no hay otra entrada libre`);
  }
  if (inp.mapDead) {
    const to = tierSpots.find((s) => s.index !== cur.index && s.reqLevel <= inp.level);
    if (to) return { ...base, spot: to, reason: 'dry', what: `${cur.name} sin monstruos → ${to.name}`, warp: true };
    return stay(`${cur.name} sin monstruos pero no hay otra entrada del tramo`);
  }
  return stay(cur.name);
}

// ---------------------------------------------------------------------------
// Resumen legible para la consola.
// ---------------------------------------------------------------------------
export function formatSpotTable(spots: Spot[], stats: Map<number, SpotStats>, current: number | null, ucb?: Map<number, number>): string {
  const rows = [...stats.values()].sort((a, b) => b.rate - a.rate);
  if (!rows.length) return '  (sin datos todavía)';
  const name = (i: number) => spots.find((s) => s.index === i)?.name ?? `warp ${i}`;
  const pad = (s: string, n: number) => s.padEnd(n);
  const lpad = (s: string, n: number) => s.padStart(n);
  const lines = [`  ${pad('spot', 15)}${lpad('n', 4)}${lpad('min', 7)}${lpad('exp/min', 9)}${lpad('kill/min', 9)}${lpad('muertes', 8)}${lpad('efectiva', 9)}${ucb ? lpad('ucb', 6) : ''}`];
  for (const r of rows) {
    const mark = r.spot === current ? '*' : ' ';
    lines.push(
      `${mark} ${pad(name(r.spot), 15)}${lpad(String(r.n), 4)}${lpad(r.minutes.toFixed(1), 7)}${lpad(fmt(r.expPerMin), 9)}` +
        `${lpad(r.killsPerMin.toFixed(1), 9)}${lpad(r.deaths.toFixed(1), 8)}${lpad(fmt(r.rate), 9)}` +
        `${ucb ? lpad(ucb.has(r.spot) ? ucb.get(r.spot)!.toFixed(2) : '-', 6) : ''}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Persistencia: JSON fuera del repo, por personaje. Escritura atómica (tmp +
// rename) y tolerante a archivo ausente o corrupto.
// ---------------------------------------------------------------------------
export const emptyLearning = (): LearningFile => ({ version: 1, chars: {} });

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function validSample(s: any): s is SpotSample {
  return s && isNum(s.spot) && isNum(s.level) && isNum(s.reset) && isNum(s.ms) && s.ms >= 0 &&
    isNum(s.exp) && isNum(s.kills) && isNum(s.deaths) && typeof s.at === 'string';
}

function numRecord(o: any): Record<number, number> {
  const out: Record<number, number> = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (isNum(Number(k)) && isNum(v) && v >= 0) out[Number(k)] = v;
  return out;
}

// Normaliza lo leído: descarta muestras mal formadas en vez de tirar todo.
export function parseLearning(text: string): LearningFile {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || typeof raw.chars !== 'object' || raw.chars === null) {
    throw new Error('formato inválido (falta "chars")');
  }
  const out = emptyLearning();
  for (const [name, c] of Object.entries<any>(raw.chars)) {
    if (!c || typeof c !== 'object') continue;
    const entry: CharLearning = {
      resets: isNum(c.resets) ? c.resets : 0,
      samples: Array.isArray(c.samples) ? c.samples.filter(validSample) : [],
    };
    if (Array.isArray(c.hot)) {
      entry.hot = c.hot
        .filter((h: any) => h && isNum(h.map) && isNum(h.cx) && isNum(h.cy) && isNum(h.exp))
        .map((h: any) => ({ map: h.map, cx: h.cx, cy: h.cy, exp: h.exp }));
    }
    if (c.types && typeof c.types === 'object') entry.types = { expByType: numRecord(c.types.expByType), killSecByType: numRecord(c.types.killSecByType) };
    if (Array.isArray(c.camps)) {
      entry.camps = c.camps
        .filter((k: any) => k && [k.map, k.x, k.y, k.rate, k.n, k.level].every(isNum))
        .map((k: any) => ({ map: k.map, x: k.x, y: k.y, rate: k.rate, n: k.n, level: k.level }));
    }
    if (c.cycles && typeof c.cycles === 'object') {
      const cyc = (r: any): CycleRecord | null =>
        r && isNum(r.start) && r.marks && typeof r.marks === 'object'
          ? { start: r.start, marks: numRecord(r.marks), ...(isNum(r.end) ? { end: r.end } : {}), ...(isNum(r.min) ? { min: r.min } : {}) }
          : null;
      entry.cycles = {
        cur: cyc(c.cycles.cur),
        done: Array.isArray(c.cycles.done) ? c.cycles.done.map(cyc).filter((r: CycleRecord | null): r is CycleRecord => r != null) : [],
      };
    }
    if (c.tierRef && typeof c.tierRef === 'object') {
      entry.tierRef = {};
      for (const [k, v] of Object.entries(c.tierRef)) if (isNum(v) && v >= 0) entry.tierRef[k] = v;
    }
    out.chars[name] = entry;
  }
  return out;
}

export type LoadResult = { data: LearningFile; status: 'ok' | 'missing' | 'corrupt'; error?: string; backup?: string };

// Archivo ausente → vacío. Corrupto → vacío, y el original se renombra a
// `.corrupt-<ts>` para no perder la evidencia ni pisarlo en el próximo save.
export async function loadLearning(path: string): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { data: emptyLearning(), status: 'missing' };
    return { data: emptyLearning(), status: 'corrupt', error: String(e?.message ?? e) };
  }
  try {
    return { data: parseLearning(text), status: 'ok' };
  } catch (e: any) {
    const backup = `${path}.corrupt-${Date.now()}`;
    await rename(path, backup).catch(() => {});
    return { data: emptyLearning(), status: 'corrupt', error: String(e?.message ?? e), backup };
  }
}

// Escribe SOLO la entrada de `char`: relee el archivo y mergea, así dos bots
// con personajes distintos no se pisan. Atómico: tmp en el mismo dir + rename.
let tmpSeq = 0;
export async function saveLearningChar(path: string, char: string, entry: CharLearning, p: LearnParams = LEARN): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let disk = emptyLearning();
  try {
    disk = parseLearning(await readFile(path, 'utf8'));
  } catch {
    // ausente o corrupto: lo reescribimos con lo nuestro (loadLearning ya
    // guardó el corrupto aparte al arrancar).
  }
  const samples = entry.samples.length > p.MAX_SAMPLES ? entry.samples.slice(-p.MAX_SAMPLES) : entry.samples;
  disk.chars[char] = { ...entry, samples };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
  await writeFile(tmp, JSON.stringify(disk, null, 1));
  await rename(tmp, path);
}
