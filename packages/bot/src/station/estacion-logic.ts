/**
 * Lógica pura de la estación (estacion.ts): con qué argumentos se lanza el bot, cómo se lee su código de salida y qué pedidos del
 * navegador se aceptan. Sin red ni procesos.
 */
import { isPanelCommand, type PanelCommand } from '@mubot/protocol';

/** Servidor Slow: el connect server es interno (`clasico`); el WebSocket del worker lo reenvía. */
export const SLOW = { csHost: 'clasico', csPort: 44405 } as const;

/** El personaje que juega (tabla `character` de la base): la clave nunca va en la línea de comandos, se pasa por MUBOT_PASS. */
export type Personaje = { user: string; pass: string; char: string };

/**
 * Argumentos de `bun` para lanzar el bot. `--env-file=/dev/null` para que Bun no cargue el `.env` de la raíz. `--exit-if-in-use`: si la
 * cuenta ya está conectada (la pestaña del navegador), el bot sale con código 3 en vez de insistir; sin él (recién desconectado desde la
 * estación) espera y reintenta, porque el server tarda en soltar la sesión vieja.
 */
export function botArgs(p: Personaje, wsPort: number, proxy: string, botFile: string, exitIfInUse = true): string[] {
  return [
    '--env-file=/dev/null', 'run', botFile, '--user', p.user, '--char', p.char,
    '--allow-remote', '--proxy', proxy, '--cs-host', SLOW.csHost, '--cs-port', String(SLOW.csPort),
    '--auto-seconds', '0', '--ws-port', String(wsPort), ...(exitIfInUse ? ['--exit-if-in-use'] : []),
  ];
}

/** Estado del bot en la estación. */
export type BotStatus = 'off' | 'starting' | 'on' | 'stopping' | 'in-use' | 'failed' | 'external';

/** Cómo se lee la salida del bot. */
export function exitStatus(code: number | null): { status: BotStatus; msg: string } {
  if (code === 7) return { status: 'failed', msg: 'faltan los datos del juego en la base: corré `bun run db:seed` (y `db:migrate` si hace falta).' };
  if (code === 6) return { status: 'failed', msg: 'la cuenta no tiene ese personaje en el Slow (¿nombre mal escrito?).' };
  if (code === 3) return { status: 'in-use', msg: 'la cuenta ya está conectada en otro lado (¿la pestaña del navegador?). Cerrala y volvé a conectar.' };
  if (code === 4) return { status: 'failed', msg: 'el server bloqueó la cuenta (AccountBlocked): no la vuelvo a conectar. Consultá a los admins.' };
  if (code === 5) return { status: 'failed', msg: 'el server rechazó el login (clave, cuenta o versión): revisá la tabla `character` de la base.' };
  if (code === 0 || code === null) return { status: 'off', msg: 'desconectado' };
  if (code === 2) return { status: 'failed', msg: 'el bot no arrancó: flag desconocido o servidor no local sin --allow-remote (mirá el log)' };
  return { status: 'failed', msg: `el bot terminó con error (código ${code}); mirá el log` };
}

/** Códigos de salida que no se arreglan reintentando. */
export const NO_RETRY_CODES = [2, 4, 5, 6, 7] as const;

/** Pedido del navegador a la estación. Todo lo demás se rechaza. */
export type StationRequest =
  | { action: 'connect' }
  | { action: 'disconnect' }
  // Reintentar ya: corta el intento de conexión en curso (el bot espera cupo) y lanza otro sin esperar el backoff.
  | { action: 'retry' }
  // Una orden en tiempo real para el bot (panel-protocol.ts).
  | { action: 'order'; command: PanelCommand };

export function parseStationRequest(v: unknown): StationRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r.action === 'connect' || r.action === 'disconnect' || r.action === 'retry') return keys.length === 1 ? { action: r.action } : null;
  if (r.action === 'order') return keys.length === 2 && isPanelCommand(r.command) ? { action: 'order', command: r.command } : null;
  return null;
}

/** Puerto del panel del bot. (8787 la estación.) */
export const BOT_PORT = 8791;

/** Tras desconectar desde la estación, cuánto se considera que la sesión vieja puede seguir abierta. */
export const RECENT_STOP_MS = 90_000;
