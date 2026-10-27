/**
 * Acceso a la base (ClickHouse por HTTP) desde el bot y la estación: consultas, inserciones, y las funciones de configuración y estado que
 * antes vivían en archivos locales (directivas, personaje, ajustes). Las credenciales de la conexión salen del entorno (`.env.db`):
 * `MUBOT_DB_URL`, `MUBOT_DB_USER`, `MUBOT_DB_PASSWORD` y `MUBOT_DB_NAME` (por defecto `mubot_slow`).
 * El esquema se crea con migrations y los datos del juego con seeds: `bun run db:migrate` y `bun run db:seed` (scripts/db.ts).
 */
export const DB_URL = process.env.MUBOT_DB_URL ?? '';
export const DB_USER = process.env.MUBOT_DB_USER ?? 'mubot';
export const DB_PASSWORD = process.env.MUBOT_DB_PASSWORD ?? '';
export const DB_NAME = process.env.MUBOT_DB_NAME ?? 'mubot_slow';
export const dbOn = () => DB_URL !== '';

const headers = { 'X-ClickHouse-User': DB_USER, 'X-ClickHouse-Key': DB_PASSWORD };

/** Una consulta de lectura: las filas (JSONEachRow). Tira si la base no responde o la consulta falla. */
export async function dbRows<T = Record<string, unknown>>(sql: string, timeoutMs = 8_000): Promise<T[]> {
  if (!dbOn()) throw new Error('sin MUBOT_DB_URL (falta .env.db)');
  const body = /\bFORMAT\s+\w+\s*$/i.test(sql) ? sql : `${sql} FORMAT JSONEachRow`;
  const r = await fetch(`${DB_URL}/?database=${DB_NAME}`, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${text.slice(0, 200)}`);
  return text.trim() ? text.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as T) : [];
}

/** Inserta filas (JSONEachRow); los campos que la tabla no tiene se ignoran. */
export async function dbInsert(table: string, rows: object[], timeoutMs = 30_000): Promise<void> {
  if (!dbOn()) throw new Error('sin MUBOT_DB_URL (falta .env.db)');
  if (!rows.length) return;
  const q = encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`);
  const r = await fetch(`${DB_URL}/?database=${DB_NAME}&query=${q}&input_format_skip_unknown_fields=1`, {
    method: 'POST', body: rows.map((x) => JSON.stringify(x)).join('\n'), headers, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// --- Configuración (tablas de pocas filas con la última versión de cada clave) --------------------------------------------------------

/** Los valores vigentes de una tabla clave/valor (`directives`, `settings`): sin las claves borradas. */
async function kvAll(table: 'directives' | 'settings'): Promise<Record<string, string>> {
  const rows = await dbRows<{ key: string; v: string; d: number }>(`SELECT key, argMax(value, updated_at) AS v, argMax(deleted, updated_at) AS d FROM ${table} GROUP BY key`);
  return Object.fromEntries(rows.filter((r) => !Number(r.d)).map((r) => [r.key, r.v]));
}
async function kvSet(table: 'directives' | 'settings', key: string, value: string) {
  await dbInsert(table, [{ key, value, deleted: 0 }]);
}
async function kvDelete(table: 'directives' | 'settings', key: string) {
  await dbInsert(table, [{ key, value: '', deleted: 1 }]);
}

/** Directivas guardadas: clave a valor (número o booleano). */
export async function readDirectives(): Promise<Record<string, boolean | number>> {
  const out: Record<string, boolean | number> = {};
  for (const [k, v] of Object.entries(await kvAll('directives'))) {
    try { const j = JSON.parse(v); if (typeof j === 'boolean' || typeof j === 'number') out[k] = j; } catch { /* valor roto: se ignora */ }
  }
  return out;
}
export const writeDirective = (key: string, value: boolean | number) => kvSet('directives', key, JSON.stringify(value));
export const deleteDirective = (key: string) => kvDelete('directives', key);

/** Ajustes de la estación (`proxy_token`, `worker_url`, `wanted`). */
export const readSettings = () => kvAll('settings');
export const writeSetting = (key: string, value: string) => kvSet('settings', key, value);

/** El personaje que juega (una fila), o null si todavía no se cargó. */
export type CharacterRow = { user: string; pass: string; char: string };
export async function readCharacter(): Promise<CharacterRow | null> {
  const rows = await dbRows<CharacterRow>(`SELECT argMax(user, updated_at) AS user, argMax(pass, updated_at) AS pass, argMax(char, updated_at) AS char FROM character WHERE id = 1 GROUP BY id`);
  return rows[0] && rows[0].user && rows[0].char ? rows[0] : null;
}
export const writeCharacter = (c: CharacterRow) => dbInsert('character', [{ id: 1, ...c }]);
