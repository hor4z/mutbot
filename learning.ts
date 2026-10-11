/**
 * Lo que el bot aprende y guarda entre corridas, y la ruta fija de farmeo.
 *
 * Lógica PURA (sin red, sin EventBus, sin `world`): se testea offline en `learning-tests.ts`.
 * Se guarda por personaje en ~/.mubot/learning.json: memoria de campamentos (camp.ts), exp y
 * segundos de kill por tipo de monstruo y spots calientes (farming.ts / explore.ts), el registro de
 * tramos por ciclo (CycleLog) y la referencia de exp/min por tramo para el "hambre".
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KnownCamp } from './camp';
import type { CycleRecord } from './farming';

// map: número de mapa al que deja el warp (si se conoce). Sirve para retomar
// sin warpear cuando el bot arranca (o reconecta) ya parado en el mapa del tramo.
export type Spot = { index: number; name: string; reqLevel: number; zen: number; map?: number };

export type HotCellData = { map: number; cx: number; cy: number; exp: number };
export type TypeData = { expByType: Record<number, number>; killSecByType: Record<number, number> };
export type CyclesData = { cur: CycleRecord | null; done: CycleRecord[] };
export type CharLearning = {
  resets: number; hot?: HotCellData[]; types?: TypeData;
  camps?: KnownCamp[]; cycles?: CyclesData; tierRef?: Record<string, number>;
};
export type LearningFile = { version: 1; chars: Record<string, CharLearning> };

export const LEARN = {
  // Dos señales de muerte (HP=0 y ObjectGotKilled) dentro de esta ventana cuentan como UNA.
  DEATH_DEBOUNCE_MS: 15_000,
  // Un spot donde el mapa entero quedó sin monstruos (explore.ts, DRY_MAP_MS) no se vuelve a
  // elegir durante esto.
  DRY_EXCLUDE_MS: 15 * 60_000,
} as const;
export type LearnParams = typeof LEARN;

// Spots secos vigentes: los que se marcaron hace menos de DRY_EXCLUDE_MS.
export function activeDryExclusions(dryAt: ReadonlyMap<number, number>, now: number, p: LearnParams = LEARN): Set<number> {
  const out = new Set<number>();
  for (const [spot, at] of dryAt) if (now - at < p.DRY_EXCLUDE_MS) out.add(spot);
  return out;
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
// Persistencia: JSON fuera del repo, por personaje. Escritura atómica (tmp +
// rename) y tolerante a archivo ausente o corrupto.
// ---------------------------------------------------------------------------
export const emptyLearning = (): LearningFile => ({ version: 1, chars: {} });

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function numRecord(o: any): Record<number, number> {
  const out: Record<number, number> = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (isNum(Number(k)) && isNum(v) && v >= 0) out[Number(k)] = v;
  return out;
}

// Normaliza lo leído: descarta lo mal formado en vez de tirar todo (las "samples" del elegidor de
// spots viejo se ignoran).
export function parseLearning(text: string): LearningFile {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || typeof raw.chars !== 'object' || raw.chars === null) {
    throw new Error('formato inválido (falta "chars")');
  }
  const out = emptyLearning();
  for (const [name, c] of Object.entries<any>(raw.chars)) {
    if (!c || typeof c !== 'object') continue;
    const entry: CharLearning = { resets: isNum(c.resets) ? c.resets : 0 };
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
export async function saveLearningChar(path: string, char: string, entry: CharLearning): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let disk = emptyLearning();
  try {
    disk = parseLearning(await readFile(path, 'utf8'));
  } catch {
    // ausente o corrupto: lo reescribimos con lo nuestro (loadLearning ya
    // guardó el corrupto aparte al arrancar).
  }
  disk.chars[char] = { ...entry };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
  await writeFile(tmp, JSON.stringify(disk, null, 1));
  await rename(tmp, path);
}
