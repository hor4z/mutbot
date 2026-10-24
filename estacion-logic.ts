/**
 * Lógica pura de la estación (estacion.ts): qué personajes hay, con qué argumentos se lanza el bot,
 * qué órdenes del panel arman cada rutina y qué pedidos del navegador se aceptan. Sin red ni
 * procesos: se testea en estacion-tests.ts.
 */
import { isPanelCommand, type PanelCommand } from './panel-protocol';
import { validCharName } from './util';

/**
 * Un personaje: de un archivo de env (`.env`, `.env.melu`, ... con MUBOT_USER/PASS/CHAR) o del
 * de la base (`estacion-db.ts`; `envFile` = de qué `.env` se importó).
 */
export type CharConfig = { key: string; envFile: string | null; user: string; char: string };

/**
 * Lee un archivo de env (formato de Bun: KEY=valor, comentarios con #, comillas opcionales).
 * Solo devuelve lo que la estación necesita saber; la contraseña la lee el bot, no la estación.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Archivos de env que son personajes: `.env` y `.env.<algo>`, salvo `.env.example`. */
export function isCharEnvFile(name: string): boolean {
  return name === '.env' || (/^\.env\.[A-Za-z0-9_-]+$/.test(name) && name !== '.env.example');
}

/** Personaje de un archivo de env, o null si le falta usuario, contraseña o personaje. */
export function charFromEnv(envFile: string, text: string): CharConfig | null {
  const e = parseEnvFile(text);
  if (!e.MUBOT_USER || !e.MUBOT_PASS || !e.MUBOT_CHAR) return null;
  return { key: e.MUBOT_CHAR.toLowerCase(), envFile, user: e.MUBOT_USER, char: e.MUBOT_CHAR };
}

/** Servidor del juego: el de siempre (PLAN-SIN-NAVEGADOR.md), cambiable por env de la estación. */
export type GameServer = { proxy: string; csHost: string; csPort: number };
export const DEFAULT_SERVER: GameServer = { proxy: 'wss://mu.mormon.garden/ws', csHost: 'mu.mormon.garden', csPort: 44405 };

/**
 * Argumentos de `bun` para lanzar el bot de un personaje. La clave nunca va en la línea de comandos
 * (se ve en `ps`): la estación la pasa por MUBOT_PASS. `--exit-if-in-use`: si la cuenta ya está
 * conectada (la pestaña del navegador), el bot sale con código 3 en vez de insistir. Sin él (recién
 * desconectado desde la estación) espera y reintenta: el server tarda en soltar la sesión vieja.
 */
export function botArgs(c: CharConfig, wsPort: number, server: GameServer, botFile: string, exitIfInUse = true): string[] {
  // Cuenta y personaje de la base (estacion-db.ts) en la línea de comandos (no son secretos); la clave
  // va por MUBOT_PASS. `--env-file=/dev/null` para que Bun no cargue el `.env` de la raíz (otro personaje).
  const who = ['--env-file=/dev/null', 'run', botFile, '--user', c.user, '--char', c.char];
  return [
    ...who,
    '--allow-remote', '--proxy', server.proxy, '--cs-host', server.csHost, '--cs-port', String(server.csPort),
    '--auto-seconds', '0', '--ws-port', String(wsPort), ...(exitIfInUse ? ['--exit-if-in-use'] : []),
  ];
}

/** Rutinas que se eligen en la estación. Cada una es una secuencia de órdenes del panel. */
export type Routine =
  | { kind: 'farm' }
  /** cazar dorados (donde haya más vivos según 0xFD) */
  | { kind: 'hunt' }
  | { kind: 'pause' };


export function isRoutine(v: unknown): v is Routine {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  return (r.kind === 'farm' || r.kind === 'hunt' || r.kind === 'pause') && keys.length === 1;
}

/** Órdenes del panel que ponen al bot en esa rutina (todas pasan por isPanelCommand). */
export function routineCommands(r: Routine): PanelCommand[] {
  switch (r.kind) {
    case 'farm': return [{ cmd: 'farm' }];
    case 'hunt': return [{ cmd: 'hunt' }];
    case 'pause': return [{ cmd: 'pause' }];
  }
}

export function routineLabel(r: Routine): string {
  switch (r.kind) {
    case 'farm': return 'farmear por la ruta';
    case 'hunt': return 'cazar dorados';
    case 'pause': return 'en pausa';
  }
}

/** Estado de un personaje en la estación. */
export type CharStatus = 'off' | 'starting' | 'on' | 'stopping' | 'in-use' | 'failed' | 'external';

/** Cómo se lee la salida del bot. */
export function exitStatus(code: number | null): { status: CharStatus; msg: string } {
  if (code === 6) return { status: 'failed', msg: 'el personaje no está en la cuenta (¿nombre mal escrito?) o el server no dejó crearlo (¿nombre tomado o clase bloqueada?). Mirá la consola.' };
  if (code === 3) return { status: 'in-use', msg: 'la cuenta ya está conectada en otro lado (¿la pestaña del navegador?). Cerrala y volvé a conectar.' };
  if (code === 4) return { status: 'failed', msg: 'el server bloqueó la cuenta (AccountBlocked): no la vuelvo a conectar. Consultá a los admins.' };
  if (code === 5) return { status: 'failed', msg: 'el server rechazó el login (clave, cuenta o versión): revisá el .env del personaje.' };
  if (code === 0 || code === null) return { status: 'off', msg: 'desconectado' };
  if (code === 2) return { status: 'failed', msg: 'el bot no arrancó: flag desconocido o servidor no local sin --allow-remote (mirá la consola)' };
  return { status: 'failed', msg: `el bot terminó con error (código ${code}); mirá la consola` };
}

/**
 * Pedido del navegador a la estación: `{ action, char, routine? }`. Todo lo demás se rechaza.
 * Las órdenes que no son de rutina (cazar, ir a un spot puntual) siguen yendo por el panel del bot.
 */
export type StationRequest =
  | { action: 'connect'; char: string; routine: Routine }
  | { action: 'disconnect'; char: string }
  | { action: 'routine'; char: string; routine: Routine }
  ;


export function parseStationRequest(v: unknown): StationRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.char !== 'string' || !/^[a-z0-9_]{1,10}$/.test(r.char)) return null;
  const keys = Object.keys(r);
  if (r.action === 'disconnect') return keys.length === 2 ? { action: 'disconnect', char: r.char } : null;
  if (r.action === 'connect' || r.action === 'routine') {
    if (keys.length !== 3 || !isRoutine(r.routine)) return null;
    return { action: r.action, char: r.char, routine: r.routine };
  }
  return null;
}

// --- Alertas de la flota ----------------------------------------------------------------------------

export type AlertKind = 'gold' | 'invasion' | 'death' | 'pk' | 'blocked' | 'stuck' | 'status' | 'level';
export type AlertTone = 'info' | 'good' | 'warn' | 'bad';
export type Alert = { id: number; at: number; kind: AlertKind; tone: AlertTone; char: string | null; text: string };
export const MAX_ALERTS = 120;
/** Un bot que farmea o caza y no se mueve ni cambia de actividad este tiempo, está trabado. */
export const STUCK_MS = 5 * 60_000;

/** Lo que la estación mira de cada personaje para detectar cambios. */
export type CharSnap = {
  key: string; char: string; status: CharStatus; account: string;
  mode: string | null; doing: string | null; map: string | null; x: number | null; y: number | null;
  level: number | null; deaths: number | null;
};

/** Memoria del detector de alertas (la estación la guarda entre vueltas). */
export type AlertMemory = { prev: Map<string, CharSnap>; movedAt: Map<string, number>; stuck: Set<string> };
export const newAlertMemory = (): AlertMemory => ({ prev: new Map(), movedAt: new Map(), stuck: new Set() });

/** Compara el estado nuevo con el anterior y devuelve las alertas (sin id: lo pone `pushAlert`). */
export function diffAlerts(mem: AlertMemory, cur: CharSnap[], now: number): Omit<Alert, 'id'>[] {
  const out: Omit<Alert, 'id'>[] = [];
  const add = (kind: AlertKind, tone: AlertTone, char: string | null, text: string) => out.push({ at: now, kind, tone, char, text });
  for (const c of cur) {
    const p = mem.prev.get(c.key);
    if (p) {
      if (p.status !== c.status) {
        if (c.status === 'on') add('status', 'good', c.char, `${c.char} entró al juego`);
        else if (c.status === 'failed') add('blocked', 'bad', c.char, `${c.char} no pudo entrar`);
        else if (c.status === 'in-use') add('blocked', 'warn', c.char, `${c.char}: la cuenta está abierta en otro lado`);
        else if (c.status === 'off' && (p.status === 'on' || p.status === 'stopping')) add('status', 'info', c.char, `${c.char} se desconectó`);
      }
      if (c.account === 'blocked' && p.account !== 'blocked') add('blocked', 'bad', c.char, `La cuenta de ${c.char} quedó bloqueada por el server`);
      if (p.deaths != null && c.deaths != null && c.deaths > p.deaths) add('death', 'bad', c.char, `${c.char} murió${c.map ? ` en ${c.map}` : ''} (${c.deaths} en la sesión)`);
      if (p.level != null && c.level != null && c.level > p.level && c.level - p.level < 20) add('level', 'good', c.char, `${c.char} subió a nivel ${c.level}`);
    }
    const active = c.status === 'on' && (c.mode === 'farm' || c.mode === 'hunt');
    const moved = !p || p.x !== c.x || p.y !== c.y || p.map !== c.map || p.doing !== c.doing || !active;
    if (moved || !mem.movedAt.has(c.key)) mem.movedAt.set(c.key, now);
    const frozen = active && now - (mem.movedAt.get(c.key) ?? now) >= STUCK_MS;
    if (frozen && !mem.stuck.has(c.key)) {
      mem.stuck.add(c.key);
      add('stuck', 'warn', c.char, `${c.char} parece trabado: hace ${Math.round(STUCK_MS / 60_000)} min que no se mueve`);
    } else if (!frozen) mem.stuck.delete(c.key);
    mem.prev.set(c.key, c);
  }
  return out;
}

/** Agrega una alerta a la lista (la más nueva primero, tope MAX_ALERTS) numerándola. */
export function pushAlert(list: Alert[], a: Omit<Alert, 'id'>) {
  const id = (list[0]?.id ?? 0) + 1;
  list.unshift({ ...a, id });
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
}

/** Puerto del panel de cada bot: 8791, 8792, ... (8787 la estación, 8788 el agente del navegador). */
export const BOT_PORT_BASE = 8791;

/**
 * ¿Ya corre un bot con esa cuenta? A partir del cmdline y del environ de un proceso (de /proc).
 * Bun carga el env-file por dentro (no aparece en /proc/<pid>/environ), así que se mira en orden:
 * `--user <u>`, `--env-file=<archivo>`, MUBOT_USER del entorno y, si no hay nada, el `.env` de la
 * raíz (lo que carga `bun run bot`).
 */
export function processRunsAccount(cmdline: string[], environ: string[], c: CharConfig): boolean {
  if (!cmdline.some((a) => a.endsWith('headless-bot.ts'))) return false;
  const u = cmdline.indexOf('--user');
  if (u >= 0) {
    const ch = cmdline.indexOf('--char');
    return cmdline[u + 1] === c.user && (ch < 0 || cmdline[ch + 1] === c.char);
  }
  const ef = cmdline.findIndex((a) => a === '--env-file' || a.startsWith('--env-file='));
  if (ef >= 0) {
    const file = cmdline[ef].includes('=') ? cmdline[ef].slice('--env-file='.length) : cmdline[ef + 1] ?? '';
    return file.split('/').pop() === c.envFile;
  }
  const env = environ.find((e) => e.startsWith('MUBOT_USER='));
  if (env) return env === `MUBOT_USER=${c.user}`;
  return c.envFile === '.env';
}

// Sanity: las órdenes de las rutinas tienen que pasar el filtro del bot.
for (const r of [{ kind: 'farm' }, { kind: 'hunt' }, { kind: 'pause' }] as Routine[])
  for (const c of routineCommands(r)) if (!isPanelCommand(c)) throw new Error(`rutina ${r.kind}: orden inválida ${JSON.stringify(c)}`);

/** Tras desconectar desde la estación, cuánto se considera que la sesión vieja puede seguir abierta. */
export const RECENT_STOP_MS = 90_000;

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Pedido de ayuda entre personajes propios (equipo, ver team.ts). */
export type TeamRequest = { from: string; kind: 'golden'; map: number; x: number; y: number; note: string; at: number };
export const TEAM_REQUEST_TTL_MS = 2 * 60_000;

/** Valida un pedido de ayuda de un bot; null si no es válido. */
export function parseTeamRequest(body: unknown, now: number): TeamRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const from = typeof b.from === 'string' ? b.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) : '';
  if (!from || b.kind !== 'golden' || !num(b.map, 0, 255) || !num(b.x, 0, 255) || !num(b.y, 0, 255)) return null;
  return { from, kind: b.kind, map: b.map, x: b.x, y: b.y, note: String(b.note ?? '').slice(0, 80), at: now };
}
