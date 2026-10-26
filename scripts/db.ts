/**
 * Consultas a ClickHouse local (db/docker-compose.yml) con las credenciales de .env.db.
 * `bun --env-file=.env.db scripts/db.ts init` aplica db/schema.sql y db/views.sql.
 */
import { join } from 'node:path';

const URL = process.env.MUBOT_DB_URL ?? 'http://127.0.0.1:8123';
const HEADERS = { 'X-ClickHouse-User': process.env.MUBOT_DB_USER ?? 'mubot', 'X-ClickHouse-Key': process.env.MUBOT_DB_PASSWORD ?? '' };

/** Corre una consulta; con FORMAT JSONEachRow devuelve las filas. */
const DB_NAME = process.env.MUBOT_DB_NAME ?? 'mubot_slow';
export async function query<T = Record<string, unknown>>(sql: string, db: string | null = DB_NAME): Promise<T[]> {
  const r = await fetch(`${URL}/${db ? `?database=${db}` : ''}`, { method: 'POST', body: sql, headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${text.slice(0, 300)}`);
  return text.trim() ? text.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as T) : [];
}

/** Las sentencias de un .sql (separadas por ';' al final de línea; sin comentarios). */
export function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, '').split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

if (import.meta.main && process.argv[2] === 'init') {
  // La base del Slow es nueva y vacía; `mubot` (Fast) queda intacta.
  await query(`CREATE DATABASE IF NOT EXISTS ${DB_NAME}`, null);
  console.log(`db: base ${DB_NAME} lista`);
  for (const f of ['schema.sql', 'views.sql']) {
    const file = Bun.file(join(import.meta.dir, '..', 'db', f));
    if (!(await file.exists())) continue;
    for (const s of statements(await file.text())) await query(s);
    console.log(`db: ${f} aplicado`);
  }
}
