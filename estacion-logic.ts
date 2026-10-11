/**
 * Lógica pura de la estación (estacion.ts): qué personajes hay, con qué argumentos se lanza el bot,
 * qué órdenes del panel arman cada rutina y qué pedidos del navegador se aceptan. Sin red ni
 * procesos: se testea en estacion-tests.ts.
 */
import { isPanelCommand, type PanelCommand } from './panel-protocol';

/** Un personaje = un archivo de env (`.env`, `.env.melu`, ...) con MUBOT_USER/PASS/CHAR. */
export type CharConfig = { key: string; envFile: string; user: string; char: string };

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
 * Argumentos de `bun` para lanzar el bot de un personaje. Las credenciales van por --env-file
 * (nunca en la línea de comandos, que se ve en `ps`). `--exit-if-in-use`: si la cuenta ya está
 * conectada (la pestaña del navegador), el bot sale con código 3 en vez de insistir. Sin él (recién
 * desconectado desde la estación) espera y reintenta: el server tarda en soltar la sesión vieja.
 */
export function botArgs(c: CharConfig, wsPort: number, server: GameServer, botFile: string, exitIfInUse = true): string[] {
  return [
    `--env-file=${c.envFile}`, 'run', botFile,
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
  if (code === 3) return { status: 'in-use', msg: 'la cuenta ya está conectada en otro lado (¿la pestaña del navegador?). Cerrala y volvé a conectar.' };
  if (code === 0 || code === null) return { status: 'off', msg: 'desconectado' };
  if (code === 2) return { status: 'failed', msg: 'el bot rechazó el servidor (no es local y falta --allow-remote)' };
  return { status: 'failed', msg: `el bot terminó con error (código ${code}); mirá la consola` };
}

/**
 * Pedido del navegador a la estación: `{ action, char, routine? }`. Todo lo demás se rechaza.
 * Las órdenes que no son de rutina (cazar, ir a un spot puntual) siguen yendo por el panel del bot.
 */
export type StationRequest =
  | { action: 'connect'; char: string; routine: Routine }
  | { action: 'disconnect'; char: string }
  | { action: 'routine'; char: string; routine: Routine };

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
  if (u >= 0) return cmdline[u + 1] === c.user;
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
