/**
 * Servidor del bot (headless-bot.ts) para su mapa y para la estación, detrás de `--ws-port`. Solo escucha en 127.0.0.1.
 *
 * Por WebSocket manda el estado del bot (`panel-state`, una vez por segundo) y acepta ÚNICAMENTE las órdenes de lista
 * cerrada de panel-protocol.ts (`isPanelCommand`: pause, resume, farm, hunt). Nada se evalúa: un mensaje que no sea una
 * orden válida se contesta con `command-result` ok:false y no llega al bot.
 *
 * Por HTTP (mismo puerto, solo lectura):
 *   GET / y /panel       → panel.html de la raíz del repo (el mapa)
 *   GET /terrain/<mapa>  → terreno del mapa (terrain.ts) para dibujarlo
 */
import { terrainOf } from './terrain';
import { join } from 'node:path';
import { PANEL_COMMANDS, isPanelCommand, type PanelCommand, type PanelServerMessage, type PanelState } from './panel-protocol';

type WsData = Record<string, never>;

export type CommandResult = { ok: boolean; msg: string };
type CommandHandler = (command: PanelCommand) => CommandResult | Promise<CommandResult>;

export type StatusServer = {
  broadcastPanelState(state: PanelState): void;
  /** Registra quién ejecuta las órdenes del panel (una sola; la última gana). */
  onCommand(handler: CommandHandler): void;
  close(): void;
};

const BOT_VERSION = '0.3.0';
// Un mensaje del cliente es una orden chiquita: lo que pase de esto se ignora sin parsear.
const MAX_CLIENT_MESSAGE_BYTES = 4096;
const PANEL_FILE = join(import.meta.dir, 'panel.html');

/** Valida un mensaje crudo del cliente: la orden, o el rechazo (`reject: null` = ni se contesta, mensaje gigante). */
function parseClientMessage(raw: string | Buffer | ArrayBuffer | Uint8Array): { id: number; command: PanelCommand } | { reject: { id: number; msg: string } | null } {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (size > MAX_CLIENT_MESSAGE_BYTES) return { reject: null };
  let msg: unknown;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString('utf8'));
  } catch {
    return { reject: { id: -1, msg: 'mensaje inválido (no es JSON)' } };
  }
  const m = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>;
  const id = Number.isInteger(m.id) ? (m.id as number) : -1;
  if (m.type !== 'command') return { reject: { id, msg: 'solo acepto mensajes {type:"command"}' } };
  if (!isPanelCommand(m.command)) return { reject: { id, msg: `orden rechazada: solo ${PANEL_COMMANDS.join(', ')} con sus campos` } };
  return { id, command: m.command };
}

/**
 * Origen de un navegador: solo el propio panel (127.0.0.1/localhost en este puerto). Sin esto, cualquier página abierta
 * podría abrir un WebSocket a 127.0.0.1 (no tienen CORS) y mandarle órdenes al bot. Sin Origin (un script local) se acepta.
 */
export function originAllowed(origin: string | null, port: number): boolean {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function startStatusServer(opts: { port: number }): StatusServer {
  const clients = new Set<{ send(data: string): void }>();
  let commandHandler: CommandHandler | null = null;
  let lastPanelState: PanelState | null = null;

  function send(ws: { send(data: string): void }, msg: PanelServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // cliente caído; se limpia en close()
    }
  }

  async function runCommand(ws: { send(data: string): void }, id: number, command: PanelCommand) {
    let res: CommandResult;
    if (!commandHandler) res = { ok: false, msg: 'el bot todavía no acepta órdenes' };
    else {
      try {
        res = await commandHandler(command);
      } catch (e) {
        res = { ok: false, msg: `la orden falló: ${(e as Error).message}` };
      }
    }
    send(ws, { type: 'command-result', id, ok: res.ok, msg: res.msg });
  }

  const server = Bun.serve<WsData>({
    // Solo esta máquina: sin hostname Bun escucha en todas las interfaces.
    hostname: '127.0.0.1',
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (!originAllowed(req.headers.get('origin'), opts.port)) return new Response('Origen no permitido.', { status: 403 });
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('No pude abrir el WebSocket.', { status: 400 });
      }
      if (req.method !== 'GET') return new Response('Solo lectura.', { status: 405 });
      if (url.pathname === '/' || url.pathname === '/panel' || url.pathname === '/panel.html') {
        const file = Bun.file(PANEL_FILE);
        if (await file.exists()) return new Response(file, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
        return new Response('No hay panel.html en la raíz del repo.', { status: 404 });
      }
      // Terreno del mapa (EncTerrainN.att descifrado, 256×256 bytes de atributos): paredes y zona segura.
      const tm = url.pathname.match(/^\/terrain\/(\d{1,3})$/);
      if (tm) {
        const grid = terrainOf(Number(tm[1]));
        return grid ? new Response(grid, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=3600' } }) : new Response('Sin terreno para ese mapa.', { status: 404 });
      }
      return new Response('No encontrado.', { status: 404 });
    },
    websocket: {
      maxPayloadLength: 64 * 1024,
      open(ws) {
        clients.add(ws);
        send(ws, { type: 'hello', botVersion: BOT_VERSION, commands: PANEL_COMMANDS });
        if (lastPanelState) send(ws, { type: 'panel-state', state: lastPanelState });
      },
      message(ws, raw) {
        // Nunca se evalúa nada: solo órdenes de la lista cerrada (isPanelCommand).
        const r = parseClientMessage(raw);
        if ('reject' in r) {
          if (r.reject) send(ws, { type: 'command-result', id: r.reject.id, ok: false, msg: r.reject.msg });
          return;
        }
        void runCommand(ws, r.id, r.command);
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  return {
    broadcastPanelState(state) {
      lastPanelState = state;
      for (const ws of clients) send(ws, { type: 'panel-state', state });
    },
    onCommand(handler) {
      commandHandler = handler;
    },
    close() {
      server.stop();
    },
  };
}
