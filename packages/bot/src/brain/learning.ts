/**
 * Lo que el bot aprende jugando, dentro de su proceso. Dos cosas, las dos medidas con lo que pasa de verdad:
 *  - Cuánto rinde cada zona: exp/min por celda de 16×16 tiles (`v_cell_rate`, de los ticks de ClickHouse). area.ts elige dónde farmear con esto.
 *  - Cuánta exp da cada tipo de monstruo: la exp real de cada kill propio, en memoria y en la base (`v_kill_value`). area.ts y el loop eligen a
 *    quién pegarle con esto.
 * Sin datos (base vacía o apagada) rigen valores de arranque que no son del Slow: `valueOf` por nivel del monstruo y zonas por densidad de spawns.
 * Todo el estado vive en `globalThis`: sobrevive a la recarga en caliente del cerebro (hot.ts), así un cambio de código no borra lo aprendido.
 */
import { monsterLevel, monsterName } from '../core/state';
import { queryDb, telemetryOn, trackEvent } from '../core/telemetry';
import { log } from '../core/util';

/** Celdas de 16×16 tiles: ticks mínimos (5 s cada uno) para fiarse de lo medido en una (5 min). */
export const MIN_TICKS = 60;
const REFRESH_MS = 5 * 60_000;
/** Cuánto se espera a la primera lectura de la base antes de decidir sin ella. */
const READY_TIMEOUT_MS = 8_000;

export const cellKey = (map: number, x: number, y: number) => `${map}:${x >> 4}:${y >> 4}`;
export type CellStat = { ticks: number; expMin: number };
type Group = { kills: number[]; exp: number; lastAt: number };
type LearnState = {
  startedAt: number;
  loadedAt: number;
  loading: boolean;
  cells: Map<string, CellStat>;
  /** Muertes recientes por celda (de `v_deaths`): el área las evita aunque rindan. */
  deathCells: Map<string, number>;
  kills: Map<number, { n: number; sum: number }>;
  group: Group | null;
  timer?: ReturnType<typeof setInterval>;
};
const L: LearnState = ((globalThis as { __learn?: LearnState }).__learn ??= {
  startedAt: Date.now(), loadedAt: 0, loading: false, cells: new Map(), deathCells: new Map(), kills: new Map(), group: null,
});

/** Los mapas con zonas medidas (desde MIN_TICKS), de mejor a peor, con lo mejor que rindió una celda de cada uno. */
export function measuredMaps(): { map: number; expMin: number }[] {
  const best = new Map<number, number>();
  for (const [k, st] of L.cells) {
    if (st.ticks < MIN_TICKS) continue;
    const map = Number(k.split(':')[0]);
    best.set(map, Math.max(best.get(map) ?? 0, st.expMin));
  }
  return [...best].map(([map, expMin]) => ({ map, expMin })).sort((a, b) => b.expMin - a.expMin);
}
export const cellStat = (map: number, x: number, y: number): CellStat | undefined => L.cells.get(cellKey(map, x, y));
export const deathsIn = (map: number, x: number, y: number) => L.deathCells.get(cellKey(map, x, y)) ?? 0;

/** ¿Ya se leyó lo aprendido de la base? Sin base no hay nada que esperar; con base, se espera la primera lectura (o READY_TIMEOUT_MS). */
export const learnedReady = () => !telemetryOn() || L.loadedAt > 0 || Date.now() - L.startedAt > READY_TIMEOUT_MS;

// --- Valor de cada tipo de monstruo --------------------------------------------------------------------------------------------------
/** Exp por kill de arranque, mientras no hay medida: sube con el nivel del monstruo (solo ordena, no es un dato del server). */
const DEFAULT_PER_LEVEL = 100;
const MIN_KILLS = 3;

/** Exp por kill de este tipo: la media medida (desde 3 kills) o, sin datos, nivel × 100. */
export function valueOf(type: number): number {
  const k = L.kills.get(type);
  if (k && k.n >= MIN_KILLS) return k.sum / k.n;
  return (monsterLevel(type) ?? 1) * DEFAULT_PER_LEVEL;
}
// La exp de un kill llega por uno o varios packets (un kill de más de 65535 llega partido), y un skill de área puede matar a varios a la vez:
// los kills seguidos forman un grupo y la exp que llega hasta ATTRIBUTION_MS después del último se junta. Solo se anota una muestra cuando el
// grupo es de un único tipo (con tipos mezclados no se puede saber cuánta exp es de cada uno: se repartiría mal y ensuciaría la media).
const ATTRIBUTION_MS = 2_500;
const SAME_GROUP_MS = 1_500;

function finalize() {
  const g = L.group;
  L.group = null;
  if (!g || g.exp <= 0 || !g.kills.length) return;
  const type = g.kills[0]!;
  if (!g.kills.every((t) => t === type)) return;
  const each = g.exp / g.kills.length;
  const k = L.kills.get(type) ?? { n: 0, sum: 0 };
  k.n += g.kills.length;
  k.sum += g.exp;
  L.kills.set(type, k);
  trackEvent('kill', monsterName(type), type, each, { group: g.kills.length });
}
/** Un kill propio de este tipo. */
export function noteKill(type: number) {
  const now = Date.now();
  if (L.group && now - L.group.lastAt <= SAME_GROUP_MS) {
    L.group.kills.push(type);
    L.group.lastAt = now;
    return;
  }
  finalize();
  L.group = { kills: [type], exp: 0, lastAt: now };
}
/** Exp ganada (ExperienceGained): se le atribuye al grupo de kills propios reciente. */
export function noteExp(exp: number) {
  if (L.group && Date.now() - L.group.lastAt <= ATTRIBUTION_MS) L.group.exp += exp;
  else if (L.group) finalize();
}
// Un solo temporizador aunque el módulo se recargue: el anterior se corta.
if (L.timer) clearInterval(L.timer);
L.timer = setInterval(() => { if (L.group && Date.now() - L.group.lastAt > ATTRIBUTION_MS) finalize(); }, 1_000);
L.timer.unref?.();

// --- Lo que dice la base -------------------------------------------------------------------------------------------------------------
/** Lee las vistas (en segundo plano; nunca frena el loop). Sin base, no hace nada. */
export async function refreshLearned(force = false): Promise<void> {
  if (!telemetryOn() || L.loading || (!force && L.loadedAt > 0 && Date.now() - L.loadedAt < REFRESH_MS)) return;
  L.loading = true;
  try {
    const rate = await queryDb<{ map: number; cx: number; cy: number; ticks: number; exp_min: number }>('SELECT map, cx, cy, ticks, exp_min FROM v_cell_rate FORMAT JSONEachRow');
    const dead = await queryDb<{ map: number; cx: number; cy: number; deaths: number }>('SELECT map, cx, cy, deaths FROM v_deaths FORMAT JSONEachRow');
    const value = await queryDb<{ type: number; n: number; exp: number }>('SELECT type, n, exp FROM v_kill_value FORMAT JSONEachRow');
    L.cells.clear();
    for (const r of rate) L.cells.set(`${r.map}:${r.cx}:${r.cy}`, { ticks: Number(r.ticks), expMin: Number(r.exp_min) });
    L.deathCells.clear();
    for (const r of dead) L.deathCells.set(`${r.map}:${r.cx}:${r.cy}`, Number(r.deaths));
    // Lo medido en esta sesión pesa lo mismo que lo de la base: gana el que tenga más kills (no se suman: la base ya los incluye).
    for (const r of value) {
      const mine = L.kills.get(Number(r.type));
      if (!mine || mine.n < Number(r.n)) L.kills.set(Number(r.type), { n: Number(r.n), sum: Number(r.exp) * Number(r.n) });
    }
    L.loadedAt = Date.now();
  } catch (e) {
    log(`Aprendizaje: no pude leer la base (${(e as Error).message}); sigo con lo que tengo en memoria.`);
  } finally {
    L.loading = false;
  }
}
