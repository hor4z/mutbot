/**
 * Datos del bot a ClickHouse (db/schema.sql): ticks cada 5 s, eventos y jugadores a la vista. Para
 * aprender de lo que pasa (scripts/aprender.ts → ~/.mubot/knowledge.json).
 *
 * Nunca frena el juego: las filas se juntan en memoria y salen cada 5 s por HTTP; si la base no
 * responde se reintenta cada vez más espaciado y, si se acumulan más de MAX_ROWS, se tiran las más viejas.
 * Sin MUBOT_DB_URL (lo pasa la estación desde .env.db) no hace nada.
 */
import { dbInsert, dbOn, dbRows } from './db';
import { bot, hooks, world } from './state';
import { log } from './util';

export type Table = 'ticks' | 'events' | 'players_seen';
type Row = Record<string, unknown>;

const FLUSH_MS = 5_000;
export const MAX_ROWS = 5_000;

/**
 * Commit del bot (para comparar versiones contra la línea base). Con cambios sin commitear le
 * suma `+` y un hash del diff: si no, todas las pruebas sobre el árbol sucio salían con el mismo
 * commit y no se podían comparar (Hume, 2026-10-19).
 */
export const VERSION = (() => {
  try {
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: import.meta.dir });
    const r = git('rev-parse', '--short', 'HEAD');
    if (!r.success) return 'desconocida';
    const head = r.stdout.toString().trim();
    const diff = git('diff', 'HEAD').stdout.toString() + git('ls-files', '--others', '--exclude-standard').stdout.toString();
    return diff ? `${head}+${Bun.hash(diff).toString(16).slice(0, 7)}` : head;
  } catch { return 'desconocida'; }
})();

/** Consulta de solo lectura a la base (db.ts); [] si no hay base o falla (el que consulta sigue con lo que tiene). */
export async function queryDb<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!telemetryOn()) return [];
  try { return await dbRows<T>(sql, 5_000); } catch { return []; }
}

/** Una sesión = un proceso del bot. */
export const SESSION = `${Date.now().toString(36)}-${process.pid}`;

/** Filas pendientes por tabla, con tope: al pasarse se descartan las más viejas. */
export class RowBuffer {
  private rows = new Map<Table, Row[]>();
  dropped = 0;
  constructor(private readonly max = MAX_ROWS) {}
  push(t: Table, r: Row) {
    const list = this.rows.get(t) ?? [];
    list.push(r);
    if (list.length > this.max) {
      this.dropped += list.length - this.max;
      list.splice(0, list.length - this.max);
    }
    this.rows.set(t, list);
  }
  /** Saca todo lo pendiente (para mandar); `restore` lo devuelve si el envío falla. */
  take(): [Table, Row[]][] {
    const out = [...this.rows.entries()].filter(([, r]) => r.length);
    this.rows.clear();
    return out;
  }
  restore(t: Table, r: Row[]) {
    for (const x of r) this.push(t, x);
  }
  get size() {
    let n = 0;
    for (const r of this.rows.values()) n += r.length;
    return n;
  }
}

const buffer = new RowBuffer();
// Reintento: 5 s, 10 s, 20 s… hasta 2 min.
let fails = 0;
let retryAt = 0;
let warned = false;
let timer: ReturnType<typeof setInterval> | null = null;

export const telemetryOn = dbOn;

/** Fecha en el formato que ClickHouse acepta para DateTime64(3) en JSONEachRow. */
export const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** Anotar una fila (con ts, personaje y sesión). */
export function track(t: Table, row: Row, now = Date.now()) {
  if (!telemetryOn()) return;
  buffer.push(t, { ts: chTime(now), char: bot.charName, ...(t === 'players_seen' ? {} : { session: SESSION, version: VERSION }), ...row });
  timer ??= setInterval(() => void flush(), FLUSH_MS);
}

/** Un evento suelto (kind: death, kill, cast, decide, …) con la posición y el nivel de ahora. */
export function trackEvent(kind: string, text = '', num1 = 0, num2 = 0, data: Row = {}) {
  track('events', {
    kind, spot: hooks.placeName(), map: world.map, x: world.x, y: world.y, level: world.level,
    num1, num2, text, data: JSON.stringify(data),
  });
}

async function flush() {
  if (Date.now() < retryAt || !buffer.size) return;
  for (const [t, rows] of buffer.take()) {
    try {
      await dbInsert(t, rows, 4_000);
      if (warned) log('Datos: la base volvió, sigo mandando.');
      warned = false;
      fails = 0;
    } catch (e) {
      buffer.restore(t, rows);
      retryAt = Date.now() + Math.min(120_000, 5_000 * 2 ** fails++);
      if (!warned) log(`Datos: no pude guardar en la base (${(e as Error).message}); sigo jugando y reintento.`);
      warned = true;
      return;
    }
  }
}
