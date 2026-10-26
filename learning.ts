/**
 * Lo que el bot aprende jugando, dentro de su proceso. Dos cosas, las dos medidas con lo que pasa de verdad:
 *  - Cuánto rinde cada zona: exp/min por celda de 16×16 tiles (`v_cell_rate`, de los ticks de ClickHouse). area.ts elige dónde farmear con esto.
 *  - Cuánta exp da cada tipo de monstruo: la exp real de cada kill propio, en memoria y en la base (`v_kill_value`). area.ts y el loop eligen a
 *    quién pegarle con esto.
 * Sin datos (base vacía o apagada) rigen valores de arranque que no son del Slow: `valueOf` por nivel del monstruo y zonas por densidad de spawns.
 */
import { monsterLevel, monsterName } from './state';
import { queryDb, telemetryOn, trackEvent } from './telemetry';
import { log } from './util';

/** Celdas de 16×16 tiles: ticks mínimos (5 s cada uno) para fiarse de lo medido en una (5 min). */
export const MIN_TICKS = 60;
const REFRESH_MS = 5 * 60_000;

export const cellKey = (map: number, x: number, y: number) => `${map}:${x >> 4}:${y >> 4}`;
export type CellStat = { ticks: number; expMin: number };
const cells = new Map<string, CellStat>();
/** Muertes recientes por celda (de `v_deaths`): el área las evita aunque rindan. */
const deathCells = new Map<string, number>();
export const cellStat = (map: number, x: number, y: number): CellStat | undefined => cells.get(cellKey(map, x, y));
export const deathsIn = (map: number, x: number, y: number) => deathCells.get(cellKey(map, x, y)) ?? 0;

// --- Valor de cada tipo de monstruo --------------------------------------------------------------------------------------------------
const kills = new Map<number, { n: number; sum: number }>();
/** Exp por kill de arranque, mientras no hay medida: sube con el nivel del monstruo (solo ordena, no es un dato del server). */
const DEFAULT_PER_LEVEL = 100;
const MIN_KILLS = 3;

/** Exp por kill de este tipo: la media medida (desde 3 kills) o, sin datos, nivel × 100. */
export function valueOf(type: number): number {
  const k = kills.get(type);
  if (k && k.n >= MIN_KILLS) return k.sum / k.n;
  return (monsterLevel(type) ?? 1) * DEFAULT_PER_LEVEL;
}
export const killsOf = (type: number) => kills.get(type)?.n ?? 0;

// La exp de un kill llega por uno o varios packets (un kill de más de 65535 llega partido): se junta lo que llega hasta 2,5 s después.
const ATTRIBUTION_MS = 2_500;
let pending: { type: number; at: number; exp: number } | null = null;

function finalize() {
  if (!pending) return;
  const p = pending;
  pending = null;
  if (p.exp <= 0) return;
  const k = kills.get(p.type) ?? { n: 0, sum: 0 };
  k.n++;
  k.sum += p.exp;
  kills.set(p.type, k);
  trackEvent('kill', monsterName(p.type), p.type, p.exp);
}
/** Un kill propio de este tipo. */
export function noteKill(type: number) {
  finalize();
  pending = { type, at: Date.now(), exp: 0 };
}
/** Exp ganada (ExperienceGained): se le atribuye al último kill propio si es reciente. */
export function noteExp(exp: number) {
  if (pending && Date.now() - pending.at <= ATTRIBUTION_MS) pending.exp += exp;
  else if (pending) finalize();
}
// Un solo temporizador aunque el módulo se recargue (hot.ts): el anterior se corta.
const g = globalThis as { __learnTimer?: ReturnType<typeof setInterval> };
if (g.__learnTimer) clearInterval(g.__learnTimer);
g.__learnTimer = setInterval(() => { if (pending && Date.now() - pending.at > ATTRIBUTION_MS) finalize(); }, 1_000);
g.__learnTimer.unref?.();

// --- Lo que dice la base -------------------------------------------------------------------------------------------------------------
let loadedAt = 0;
let loading = false;
/** Lee las vistas (en segundo plano; nunca frena el loop). Sin base, no hace nada. */
export async function refreshLearned(force = false): Promise<void> {
  if (!telemetryOn() || loading || (!force && Date.now() - loadedAt < REFRESH_MS)) return;
  loading = true;
  try {
    const rate = await queryDb<{ map: number; cx: number; cy: number; ticks: number; exp_min: number }>('SELECT map, cx, cy, ticks, exp_min FROM v_cell_rate FORMAT JSONEachRow');
    const dead = await queryDb<{ map: number; cx: number; cy: number; deaths: number }>('SELECT map, cx, cy, deaths FROM v_deaths FORMAT JSONEachRow');
    const value = await queryDb<{ type: number; n: number; exp: number }>('SELECT type, n, exp FROM v_kill_value FORMAT JSONEachRow');
    cells.clear();
    for (const r of rate) cells.set(`${r.map}:${r.cx}:${r.cy}`, { ticks: Number(r.ticks), expMin: Number(r.exp_min) });
    deathCells.clear();
    for (const r of dead) deathCells.set(`${r.map}:${r.cx}:${r.cy}`, Number(r.deaths));
    // Lo medido en esta sesión pesa lo mismo que lo de la base: se suma, no se pisa.
    for (const r of value) {
      const mine = kills.get(Number(r.type));
      if (!mine || mine.n < Number(r.n)) kills.set(Number(r.type), { n: Number(r.n), sum: Number(r.exp) * Number(r.n) });
    }
    loadedAt = Date.now();
  } catch (e) {
    log(`Aprendizaje: no pude leer la base (${(e as Error).message}); sigo con lo que tengo en memoria.`);
  } finally {
    loading = false;
  }
}
