/**
 * Lógica pura de la estación (estacion.ts): qué personajes hay, con qué argumentos se lanza el bot,
 * qué órdenes del panel arman cada rutina y qué pedidos del navegador se aceptan. Sin red ni
 * procesos: se testea en estacion-tests.ts.
 */
import { isPanelCommand, type PanelCommand } from './panel-protocol';
import { validCharName } from './names';

/**
 * Un personaje: de un archivo de env (`.env`, `.env.melu`, ... con MUBOT_USER/PASS/CHAR) o del
 * de la base (`estacion-db.ts`; `envFile` = de qué `.env` se importó; `cls` si hay que crearlo al entrar).
 */
export type CharConfig = { key: string; envFile: string | null; user: string; char: string; cls?: CharClassKey };

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
  | { kind: 'spot'; warp: number }
  | { kind: 'pause' };

export const ROUTINE_KINDS = ['farm', 'spot', 'pause'] as const;

export function isRoutine(v: unknown): v is Routine {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r.kind === 'spot') return keys.every((k) => k === 'kind' || k === 'warp') && Number.isInteger(r.warp) && (r.warp as number) >= 0 && (r.warp as number) < 256;
  return (r.kind === 'farm' || r.kind === 'pause') && keys.length === 1;
}

/** Órdenes del panel que ponen al bot en esa rutina (todas pasan por isPanelCommand). */
export function routineCommands(r: Routine): PanelCommand[] {
  switch (r.kind) {
    case 'farm': return [{ cmd: 'farm' }];
    case 'spot': return [{ cmd: 'warp', warp: r.warp }];
    case 'pause': return [{ cmd: 'pause' }];
  }
}

export function routineLabel(r: Routine): string {
  switch (r.kind) {
    case 'farm': return 'farmear por la ruta';
    case 'spot': return `farmear fijo en el warp ${r.warp}`;
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
  | NewCharRequest
  | { action: 'add'; user: string; char: string; cls: CharClassKey | null };

/**
 * Personaje nuevo desde la estación: cuenta (se registra en el server salvo `existing`), nombre y
 * clase. Va al almacén de cuentas (`accounts.ts`) y el bot crea el personaje al entrar.
 */
export type NewCharRequest = { action: 'create'; user: string; pass: string; char: string; cls: CharClassKey | null; existing: boolean };

/**
 * Clases que se pueden crear en este server (0.97d) y su número de red (`CharacterClassNumber` del
 * cliente; el packet lo lleva corrido 2 bits). MG pide un personaje de nivel alto en la cuenta.
 */
export const CHAR_CLASSES = {
  dk: { id: 4, label: 'Dark Knight' },
  dw: { id: 0, label: 'Dark Wizard' },
  elf: { id: 8, label: 'Fairy Elf' },
  mg: { id: 12, label: 'Magic Gladiator' },
} as const;
export type CharClassKey = keyof typeof CHAR_CLASSES;
export const isCharClass = (v: unknown): v is CharClassKey => typeof v === 'string' && Object.hasOwn(CHAR_CLASSES, v);

/** Cuenta y clave como las valida el registro del cliente web. Devuelve el motivo o null. */
export function accountProblem(user: string, pass: string): string | null {
  if (!/^[A-Za-z0-9]{4,10}$/.test(user)) return 'la cuenta tiene que tener de 4 a 10 letras o números';
  if (pass.length < 4 || pass.length > 10) return 'la clave tiene que tener de 4 a 10 caracteres';
  if (!/^[!-~]+$/.test(pass)) return 'la clave solo puede tener caracteres visibles, sin espacios ni acentos';
  return null;
}


export function parseStationRequest(v: unknown): StationRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.action === 'create') {
    const keys = Object.keys(r).sort().join();
    if (keys !== 'action,char,cls,existing,pass,user') return null;
    if (typeof r.user !== 'string' || typeof r.pass !== 'string' || typeof r.char !== 'string' || typeof r.existing !== 'boolean') return null;
    // Clase null = el personaje ya existe en el server (solo con una cuenta que ya existe).
    if (accountProblem(r.user, r.pass) || !validCharName(r.char) || !(isCharClass(r.cls) || (r.cls === null && r.existing))) return null;
    return { action: 'create', user: r.user, pass: r.pass, char: r.char, cls: r.cls, existing: r.existing };
  }
  // Otro personaje en una cuenta que ya está en la base: la clave la pone la estación.
  if (r.action === 'add') {
    if (Object.keys(r).sort().join() !== 'action,char,cls,user') return null;
    if (typeof r.user !== 'string' || !/^[A-Za-z0-9]{4,10}$/.test(r.user) || typeof r.char !== 'string' || !validCharName(r.char) || !(isCharClass(r.cls) || r.cls === null)) return null;
    return { action: 'add', user: r.user, char: r.char, cls: r.cls };
  }
  if (typeof r.char !== 'string' || !/^[a-z0-9_]{1,10}$/.test(r.char)) return null;
  const keys = Object.keys(r);
  if (r.action === 'disconnect') return keys.length === 2 ? { action: 'disconnect', char: r.char } : null;
  if (r.action === 'connect' || r.action === 'routine') {
    if (keys.length !== 3 || !isRoutine(r.routine)) return null;
    return { action: r.action, char: r.char, routine: r.routine };
  }
  return null;
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
for (const r of [{ kind: 'farm' }, { kind: 'spot', warp: 26 }, { kind: 'pause' }] as Routine[])
  for (const c of routineCommands(r)) if (!isPanelCommand(c)) throw new Error(`rutina ${r.kind}: orden inválida ${JSON.stringify(c)}`);

/** Tras desconectar desde la estación, cuánto se considera que la sesión vieja puede seguir abierta. */
export const RECENT_STOP_MS = 90_000;

/** Señal de dorado (de un bot sin navegador o del navegador si el usuario juega ahí). */
export type GoldSignal = { from: string; map: number; x: number; y: number; name: string; id: number; at: number };
export const GOLD_TTL_MS = 60_000;
/** Origen del juego en el navegador: puede mandar señales (POST /api/gold) con CORS. */
export const GAME_ORIGIN = 'https://mu.mormon.garden';

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Aplica una señal `{ from, map, x, y, name, id }` (visto/movido) o `{ from, map, id, gone: true }` al
 * registro de avistamientos (clave from:id). Devuelve false si el cuerpo no es válido.
 */
export function applyGoldSignal(golds: Map<string, GoldSignal>, body: unknown, now: number): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const g = body as Record<string, unknown>;
  const from = typeof g.from === 'string' ? g.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20) : '';
  if (!from || !num(g.map, 0, 255) || !num(g.id, 0, 65535)) return false;
  const key = `${from}:${g.id}`;
  if (g.gone === true) {
    golds.delete(key);
    return true;
  }
  if (!num(g.x, 0, 255) || !num(g.y, 0, 255)) return false;
  golds.set(key, { from, map: g.map, x: g.x, y: g.y, name: String(g.name ?? '').slice(0, 40), id: g.id, at: now });
  return true;
}

/** Avistamientos vigentes (los de más de GOLD_TTL_MS se borran). */
export function freshGolds(golds: Map<string, GoldSignal>, now: number): GoldSignal[] {
  for (const [k, g] of golds) if (now - g.at > GOLD_TTL_MS) golds.delete(k);
  return [...golds.values()].sort((a, b) => b.at - a.at);
}

/** Pedido de ayuda entre personajes propios (equipo, ver team.ts). */
export type TeamRequest = { from: string; kind: 'corner' | 'golden'; map: number; x: number; y: number; note: string; at: number };
export const TEAM_REQUEST_TTL_MS = 2 * 60_000;

/** Valida un pedido de ayuda de un bot; null si no es válido. */
export function parseTeamRequest(body: unknown, now: number): TeamRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const from = typeof b.from === 'string' ? b.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) : '';
  if (!from || (b.kind !== 'corner' && b.kind !== 'golden') || !num(b.map, 0, 255) || !num(b.x, 0, 255) || !num(b.y, 0, 255)) return null;
  return { from, kind: b.kind, map: b.map, x: b.x, y: b.y, note: String(b.note ?? '').slice(0, 80), at: now };
}
