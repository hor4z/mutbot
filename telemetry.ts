/**
 * Datos del bot a ClickHouse (db/schema.sql): ticks cada 5 s, eventos y jugadores a la vista. Para
 * aprender de lo que pasa (scripts/aprender.ts → ~/.mubot/knowledge.json).
 *
 * Nunca frena el juego: las filas se juntan en memoria y salen cada 5 s por HTTP; si la base no
 * responde se reintenta cada vez más espaciado y, si se acumulan más de MAX_ROWS, se tiran las más viejas.
 * Sin MUBOT_DB_URL (lo pasa la estación desde .env.db) no hace nada.
 */
import { bot, world } from './state';
import { log } from './util';

export type Table = 'ticks' | 'events' | 'players_seen';
type Row = Record<string, unknown>;

const DB_URL = process.env.MUBOT_DB_URL ?? '';
const DB_USER = process.env.MUBOT_DB_USER ?? 'mubot';
const DB_PASSWORD = process.env.MUBOT_DB_PASSWORD ?? '';
const FLUSH_MS = 5_000;
export const MAX_ROWS = 5_000;

/** Commit del bot (para comparar versiones contra la línea base). */
export const VERSION = (() => {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: import.meta.dir });
    return r.success ? r.stdout.toString().trim() : 'desconocida';
  } catch { return 'desconocida'; }
})();

/** Política activa (perillas o experimento), la pone knowledge.ts. */
let policy = '';
export const setPolicy = (p: string) => { policy = p; };

/** Consulta de solo lectura a la base (FORMAT JSONEachRow); [] si no hay base o falla. */
export async function queryDb<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!telemetryOn()) return [];
  try {
    const r = await fetch(`${DB_URL}/?database=mubot`, {
      method: 'POST', body: sql, signal: AbortSignal.timeout(5_000),
      headers: { 'X-ClickHouse-User': DB_USER, 'X-ClickHouse-Key': DB_PASSWORD },
    });
    if (!r.ok) return [];
    return (await r.text()).trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as T);
  } catch { return []; }
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

export const telemetryOn = () => DB_URL !== '';

/** Fecha en el formato que ClickHouse acepta para DateTime64(3) en JSONEachRow. */
export const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** Anotar una fila (con ts, personaje y sesión). */
export function track(t: Table, row: Row, now = Date.now()) {
  if (!telemetryOn()) return;
  buffer.push(t, { ts: chTime(now), char: bot.charName, ...(t === 'players_seen' ? {} : { session: SESSION, version: VERSION, policy }), ...row });
  timer ??= setInterval(() => void flush(), FLUSH_MS);
}

/** Un evento suelto (kind: death, kill, cast, decide, …) con la posición y el nivel de ahora. */
export function trackEvent(kind: string, text = '', num1 = 0, num2 = 0, data: Row = {}) {
  track('events', {
    kind, map: world.map, x: world.x, y: world.y, level: world.level, resets: world.resets ?? 0,
    num1, num2, text, data: JSON.stringify(data),
  });
}

async function flush() {
  if (Date.now() < retryAt || !buffer.size) return;
  for (const [t, rows] of buffer.take()) {
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    const url = `${DB_URL}/?database=mubot&query=${encodeURIComponent(`INSERT INTO ${t} FORMAT JSONEachRow`)}&input_format_skip_unknown_fields=1`;
    try {
      const r = await fetch(url, {
        method: 'POST', body, signal: AbortSignal.timeout(4_000),
        headers: { 'X-ClickHouse-User': DB_USER, 'X-ClickHouse-Key': DB_PASSWORD },
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
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
