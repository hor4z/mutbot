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

export type Spot = { index: number; name: string; reqLevel: number; zen: number };

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

export type CharLearning = { resets: number; samples: SpotSample[] };
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

// Normaliza lo leído: descarta muestras mal formadas en vez de tirar todo.
export function parseLearning(text: string): LearningFile {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || typeof raw.chars !== 'object' || raw.chars === null) {
    throw new Error('formato inválido (falta "chars")');
  }
  const out = emptyLearning();
  for (const [name, c] of Object.entries<any>(raw.chars)) {
    if (!c || typeof c !== 'object') continue;
    out.chars[name] = {
      resets: isNum(c.resets) ? c.resets : 0,
      samples: Array.isArray(c.samples) ? c.samples.filter(validSample) : [],
    };
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
  disk.chars[char] = { resets: entry.resets, samples };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
  await writeFile(tmp, JSON.stringify(disk, null, 1));
  await rename(tmp, path);
}
