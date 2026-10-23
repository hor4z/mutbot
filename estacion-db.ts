/**
 * Base local de la estación (SQLite, `bun:sqlite`): servidores, cuentas y personajes. Vive fuera
 * del repo, en `~/.mubot/mubot.db` (`MUBOT_DB_FILE` lo cambia), modo 600: tiene las claves.
 * La telemetría de juego (ticks, eventos, ranking) sigue en ClickHouse (`db/`); esto es solo el
 * "quién es quién" que la estación necesita para lanzar los bots.
 *
 *   servers    (id, name, proxy, cs_host, cs_port)
 *   accounts   (id, server_id → servers, username, password, status, created_at, updated_at)
 *   characters (id, account_id → accounts, name, class, last_routine, env_file, created_at, updated_at)
 *
 * - Nombres sin importar mayúsculas (COLLATE NOCASE), como el server. Un nombre de personaje es
 *   único en todo el server; una cuenta, por server.
 * - Hasta 5 personajes por cuenta (0.97d); solo uno juega a la vez (lo controla la estación).
 * - `accounts.status`: 'active' o 'blocked' (el server contestó AccountBlocked: no se reconecta).
 * - `characters.class`: dk, dw, elf, mg (lo usa el bot para crearlo si todavía no existe).
 * - `characters.env_file`: de qué `.env` se importó (para adoptar bots lanzados a la vieja usanza).
 * - Migraciones versionadas con `PRAGMA user_version`: para cambiar el esquema se agrega una al
 *   final de MIGRATIONS, nunca se edita una vieja.
 *
 * La clave nunca va en la línea de comandos: la estación se la pasa al bot por MUBOT_PASS.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCharClass, type CharClassKey, type CharConfig, type GameServer, type Routine } from './estacion-logic';
import { validCharName } from './names';

/** Personajes por cuenta en el 0.97d. */
export const MAX_CHARS_PER_ACCOUNT = 5;

export const DB_FILE = process.env.MUBOT_DB_FILE ?? join(homedir(), '.mubot', 'mubot.db');

/** Una por versión; la base guarda en `user_version` cuántas aplicó. */
const MIGRATIONS = [
  `CREATE TABLE servers (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     proxy TEXT NOT NULL,
     cs_host TEXT NOT NULL,
     cs_port INTEGER NOT NULL
   );
   CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     server_id INTEGER NOT NULL REFERENCES servers(id),
     username TEXT NOT NULL COLLATE NOCASE,
     password TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (server_id, username)
   );
   CREATE TABLE characters (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     name TEXT NOT NULL COLLATE NOCASE,
     class TEXT CHECK (class IS NULL OR class IN ('dk', 'dw', 'elf', 'mg')),
     last_routine TEXT,
     env_file TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE UNIQUE INDEX characters_server_name ON characters(name);
   CREATE INDEX characters_account ON characters(account_id);`,
];

export type DbChar = CharConfig & { status: 'active' | 'blocked'; lastRoutine: Routine | null };

export class EstacionDb {
  readonly db: Database;
  private serverId: number;

  /** `file` = ':memory:' en los tests. `server`: el que usa la estación (se da de alta solo). */
  constructor(server: GameServer, file = DB_FILE) {
    const mem = file === ':memory:';
    if (!mem) mkdirSync(dirname(file), { recursive: true });
    const isNew = !mem && !existsSync(file);
    this.db = new Database(file, { create: true });
    if (isNew) chmodSync(file, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (!mem) this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.serverId = this.upsertServer(server);
  }

  /** Versión del esquema aplicada. */
  get version(): number {
    return this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
  }

  private migrate() {
    for (let v = this.version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  private upsertServer(s: GameServer): number {
    const name = s.csHost;
    this.db.query('INSERT INTO servers (name, proxy, cs_host, cs_port) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET proxy = excluded.proxy, cs_port = excluded.cs_port')
      .run(name, s.proxy, s.csHost, s.csPort);
    return this.db.query<{ id: number }, [string]>('SELECT id FROM servers WHERE name = ?').get(name)!.id;
  }

  /** Personajes de este server, como los ve la estación (sin la clave). */
  chars(): DbChar[] {
    type Row = { name: string; username: string; class: string | null; env_file: string | null; status: 'active' | 'blocked'; last_routine: string | null };
    return this.db.query<Row, [number]>(
      `SELECT c.name, a.username, c.class, c.env_file, a.status, c.last_routine
         FROM characters c JOIN accounts a ON a.id = c.account_id
        WHERE a.server_id = ? ORDER BY c.name`,
    ).all(this.serverId).map((r) => ({
      key: r.name.toLowerCase(), envFile: r.env_file, user: r.username, char: r.name,
      ...(isCharClass(r.class) ? { cls: r.class } : {}),
      status: r.status, lastRoutine: parseRoutine(r.last_routine),
    }));
  }

  /** Clave de la cuenta de un personaje (solo para lanzar el bot). */
  passFor(char: string): string | null {
    return this.db.query<{ password: string }, [string, number]>(
      'SELECT a.password FROM characters c JOIN accounts a ON a.id = c.account_id WHERE c.name = ? AND a.server_id = ?',
    ).get(char, this.serverId)?.password ?? null;
  }

  /**
   * Suma un personaje a una cuenta (la crea si no está). Devuelve el motivo si no se puede.
   * `cls` null = un personaje que ya existe en el server (importado de un `.env`).
   */
  addChar(user: string, pass: string, name: string, cls: CharClassKey | null, envFile: string | null = null): string | null {
    if (!validCharName(name)) return `nombre inválido: ${name}`;
    return this.db.transaction((): string | null => {
      if (this.db.query('SELECT 1 FROM characters WHERE name = ?').get(name)) return `ya hay un personaje ${name} en la estación`;
      let acc = this.db.query<{ id: number; username: string; password: string }, [number, string]>(
        'SELECT id, username, password FROM accounts WHERE server_id = ? AND username = ?',
      ).get(this.serverId, user);
      if (acc && acc.password !== pass) return `la clave no coincide con la guardada para ${acc.username}`;
      if (!acc) {
        const id = Number(this.db.query('INSERT INTO accounts (server_id, username, password) VALUES (?, ?, ?)').run(this.serverId, user, pass).lastInsertRowid);
        acc = { id, username: user, password: pass };
      }
      const n = this.db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM characters WHERE account_id = ?').get(acc.id)!.n;
      if (n >= MAX_CHARS_PER_ACCOUNT) return `${acc.username} ya tiene ${MAX_CHARS_PER_ACCOUNT} personajes`;
      this.db.query('INSERT INTO characters (account_id, name, class, env_file) VALUES (?, ?, ?, ?)').run(acc.id, name, cls, envFile);
      return null;
    })();
  }

  /**
   * Importa los personajes de los `.env` (Horaz, Melu): los que no estén se agregan, con el archivo
   * de origen. Devuelve los nombres importados. Idempotente: se corre en cada arranque.
   */
  importEnv(list: { envFile: string; user: string; pass: string; char: string }[]): string[] {
    const out: string[] = [];
    for (const e of list) {
      if (this.db.query('SELECT 1 FROM characters WHERE name = ?').get(e.char)) continue;
      if (!this.addChar(e.user, e.pass, e.char, null, e.envFile)) out.push(e.char);
    }
    return out;
  }

  hasAccount(user: string): boolean {
    return !!this.db.query('SELECT 1 FROM accounts WHERE server_id = ? AND username = ?').get(this.serverId, user);
  }

  /** Clave guardada de una cuenta (para sumarle personajes sin volver a pedirla). */
  passOfAccount(user: string): string | null {
    return this.db.query<{ password: string }, [number, string]>('SELECT password FROM accounts WHERE server_id = ? AND username = ?').get(this.serverId, user)?.password ?? null;
  }

  setAccountStatus(user: string, status: 'active' | 'blocked') {
    this.db.query("UPDATE accounts SET status = ?, updated_at = datetime('now') WHERE server_id = ? AND username = ?").run(status, this.serverId, user);
  }

  setRoutine(char: string, r: Routine) {
    this.db.query("UPDATE characters SET last_routine = ?, updated_at = datetime('now') WHERE name = ?").run(JSON.stringify(r), char);
  }

  close() {
    this.db.close();
  }
}

function parseRoutine(s: string | null): Routine | null {
  if (!s) return null;
  try {
    const r = JSON.parse(s);
    return r && typeof r.kind === 'string' ? (r as Routine) : null;
  } catch {
    return null;
  }
}
