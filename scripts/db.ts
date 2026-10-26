/**
 * Migrations y seeds de la base (ClickHouse). Credenciales de `.env.db` (`bun --env-file=.env.db scripts/db.ts <comando>`):
 *
 *   migrate          aplica las migrations pendientes de db/migrations/ en orden (NNNN_nombre.sql) y re-aplica las repetibles (R__nombre.sql, p. ej.
 *                    las vistas) cuando cambia su contenido. Una migration ya aplicada no se puede editar: se agrega una nueva.
 *   seed [--force]   carga los datos del juego de db/seeds/ en sus tablas (llena una tabla nueva y la intercambia, así nunca queda a medias); solo si el
 *                    archivo cambió, o siempre con --force.
 *   status           qué migrations y seeds están aplicados y cuáles faltan.
 *   init             migrate + seed.
 *
 * Todo es idempotente: correrlo de nuevo no cambia nada. El control va en las tablas `schema_migrations` y `schema_seeds`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_NAME, DB_URL, DB_USER, DB_PASSWORD, dbOn } from '../db';

const ROOT = join(import.meta.dir, '..', 'db');
const headers = { 'X-ClickHouse-User': DB_USER, 'X-ClickHouse-Key': DB_PASSWORD };

/** Corre una sentencia; `db = null` la corre sin base elegida (para CREATE DATABASE). Devuelve las filas si es un SELECT con JSONEachRow. */
export async function query<T = Record<string, unknown>>(sql: string, db: string | null = DB_NAME): Promise<T[]> {
  const r = await fetch(`${DB_URL}/${db ? `?database=${db}` : ''}`, { method: 'POST', body: sql, headers, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${text.slice(0, 300)}`);
  return text.trim() ? text.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as T) : [];
}
async function insert(table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 4000) {
    const q = encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`);
    const r = await fetch(`${DB_URL}/?database=${DB_NAME}&query=${q}&input_format_skip_unknown_fields=1`, {
      method: 'POST', body: rows.slice(i, i + 4000).map((x) => JSON.stringify(x)).join('\n'), headers, signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`ClickHouse ${r.status} insertando en ${table}: ${(await r.text()).slice(0, 300)}`);
  }
}

/** Las sentencias de un .sql (separadas por ';' al final de línea; sin comentarios). */
export function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, '').split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}
const checksum = (text: string) => Bun.hash(text).toString(16);

// --- Migrations ---------------------------------------------------------------------------------------------------------------------------
type Migration = { kind: 'versioned' | 'repeatable'; version: string; name: string; file: string; sum: string };

function listMigrations(): Migration[] {
  const dir = join(ROOT, 'migrations');
  const out: Migration[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    const v = /^(\d{4})_(.+)\.sql$/.exec(file);
    const rep = /^R__(.+)\.sql$/.exec(file);
    if (v) out.push({ kind: 'versioned', version: v[1]!, name: v[2]!, file, sum: checksum(text) });
    else if (rep) out.push({ kind: 'repeatable', version: file, name: rep[1]!, file, sum: checksum(text) });
  }
  // Primero las numeradas en orden, después las repetibles.
  return [...out.filter((m) => m.kind === 'versioned'), ...out.filter((m) => m.kind === 'repeatable')];
}

async function ensureControl() {
  await query(`CREATE DATABASE IF NOT EXISTS ${DB_NAME}`, null);
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (kind LowCardinality(String), version String, name String, checksum String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY (kind, version, applied_at)`);
  await query(`CREATE TABLE IF NOT EXISTS schema_seeds (name String, checksum String, rows UInt32, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY (name, applied_at)`);
}

async function appliedMigrations(): Promise<Map<string, string>> {
  const rows = await query<{ version: string; sum: string }>(`SELECT version, argMax(checksum, applied_at) AS sum FROM schema_migrations GROUP BY version FORMAT JSONEachRow`);
  return new Map(rows.map((r) => [r.version, r.sum]));
}

export async function migrate(): Promise<void> {
  await ensureControl();
  const applied = await appliedMigrations();
  let ran = 0;
  for (const m of listMigrations()) {
    const done = applied.get(m.version);
    if (done === m.sum) continue;
    if (done && m.kind === 'versioned') throw new Error(`La migration ${m.file} ya estaba aplicada y cambió. No se edita: agregá una nueva.`);
    for (const s of statements(readFileSync(join(ROOT, 'migrations', m.file), 'utf8'))) await query(s);
    await insert('schema_migrations', [{ kind: m.kind, version: m.version, name: m.name, checksum: m.sum }]);
    console.log(`db: aplicada ${m.file}`);
    ran++;
  }
  console.log(ran ? `db: ${ran} migration(s) aplicadas` : 'db: migrations al día');
}

// --- Seeds -------------------------------------------------------------------------------------------------------------------------------
/** `version`: se suma al checksum; subirla fuerza a recargar un seed cuando cambia el mapeo (no el archivo). */
type Seed = { name: string; file: string; table: string; version?: number; rows: (json: any) => object[] };
/** Los datos del juego (del cliente web): cada seed vacía su tabla y la vuelve a llenar desde su archivo. */
const SEEDS: Seed[] = [
  { name: 'monsters', file: 'monsters.json', table: 'monsters', rows: (j: Record<string, unknown>[]) => j },
  { name: 'skills', file: 'skills.json', table: 'skills', rows: (j: Record<string, unknown>[]) => j },
  {
    name: 'items', file: 'items.json', table: 'items', version: 3,
    // El cliente nombra distinto las mismas columnas según el tipo de ítem (ReqLvl o RequiredLvl, Def o DefRate…): se unifican acá.
    rows: (j: Record<string, any>[]) => j.map((i) => ({
      grp: i.Group, idx: i.Index, name: i.ItemName, w: i.X || 1, h: i.Y || 1, raw: JSON.stringify(i),
      equip_slot: i.ItemSlot ?? -1,
      req_level: i.ReqLvl ?? i.RequiredLvl ?? 0,
      cls: (i['DK/BK'] > 0 ? 1 : 0) | (i['DW/SM'] > 0 ? 2 : 0) | (i['Elf/ME'] > 0 ? 4 : 0) | (i.MG > 0 ? 8 : 0),
      def: Math.max(i.Def || 0, i.DefRate || 0), dmg: i.DmgMax || 0, mag: i.MagicPwr || 0,
    })),
  },
  {
    name: 'spawns', file: 'spawns.json', table: 'spawns',
    rows: (j: Record<string, { type: number; rect: number[]; qty: number; trigger?: number; wave?: number }[]>) =>
      Object.entries(j).flatMap(([map, list]) => list.map((s) => ({ map: Number(map), type: s.type, x1: s.rect[0], y1: s.rect[1], x2: s.rect[2], y2: s.rect[3], qty: s.qty, trigger: s.trigger ?? 0, wave: s.wave ?? 0 }))),
  },
];

export async function seed(force = false): Promise<void> {
  await ensureControl();
  const done = new Map((await query<{ name: string; sum: string }>(`SELECT name, argMax(checksum, applied_at) AS sum FROM schema_seeds GROUP BY name FORMAT JSONEachRow`)).map((r) => [r.name, r.sum]));
  let ran = 0;
  for (const s of SEEDS) {
    const text = readFileSync(join(ROOT, 'seeds', s.file), 'utf8');
    const sum = checksum(`${text}#${s.version ?? 1}`);
    if (!force && done.get(s.name) === sum) continue;
    const rows = s.rows(JSON.parse(text));
    // Atómico: se llena una tabla nueva y se intercambia (EXCHANGE TABLES); si algo falla en el medio, la tabla vigente queda como estaba.
    const tmp = `${s.table}__new`;
    await query(`DROP TABLE IF EXISTS ${tmp}`);
    await query(`CREATE TABLE ${tmp} AS ${s.table}`);
    try {
      await insert(tmp, rows);
      await query(`EXCHANGE TABLES ${s.table} AND ${tmp}`);
    } finally {
      await query(`DROP TABLE IF EXISTS ${tmp}`);
    }
    await insert('schema_seeds', [{ name: s.name, checksum: sum, rows: rows.length }]);
    console.log(`db: seed ${s.name}: ${rows.length} filas`);
    ran++;
  }
  console.log(ran ? `db: ${ran} seed(s) cargados` : 'db: seeds al día');
}

export async function status(): Promise<void> {
  await ensureControl();
  const applied = await appliedMigrations();
  for (const m of listMigrations()) console.log(`${applied.get(m.version) === m.sum ? 'aplicada ' : applied.has(m.version) ? 'CAMBIÓ   ' : 'pendiente'} ${m.file}`);
  const done = new Map((await query<{ name: string; sum: string; rows: number }>(`SELECT name, argMax(checksum, applied_at) AS sum, argMax(rows, applied_at) AS rows FROM schema_seeds GROUP BY name FORMAT JSONEachRow`)).map((r) => [r.name, r]));
  for (const s of SEEDS) {
    const sum = checksum(`${readFileSync(join(ROOT, 'seeds', s.file), 'utf8')}#${s.version ?? 1}`);
    const d = done.get(s.name);
    console.log(`${d?.sum === sum ? 'cargado  ' : d ? 'CAMBIÓ   ' : 'pendiente'} seed ${s.name}${d ? ` (${d.rows} filas)` : ''}`);
  }
}

if (import.meta.main) {
  if (!dbOn()) {
    console.error('Falta MUBOT_DB_URL: corré esto con `bun run db:migrate` / `db:seed` (cargan .env.db) o con `bun --env-file=.env.db scripts/db.ts <comando>`.');
    process.exit(2);
  }
  const [cmd, flag] = process.argv.slice(2);
  if (cmd === 'migrate') await migrate();
  else if (cmd === 'seed') await seed(flag === '--force');
  else if (cmd === 'status') await status();
  else if (cmd === 'init') { await migrate(); await seed(); }
  else { console.error('Uso: scripts/db.ts migrate | seed [--force] | status | init'); process.exit(2); }
}
