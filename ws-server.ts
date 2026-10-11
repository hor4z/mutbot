/**
 * Servidor del bot (headless-bot.ts) para el panel (panel.html), detrás de
 * `--ws-port`. Solo escucha en 127.0.0.1.
 *
 * Expone por WebSocket el estado del bot y cada decisión que pasa por
 * decide(), y desde el panel acepta ÚNICAMENTE las órdenes de lista cerrada de
 * panel-protocol.ts (`isPanelCommand`): pause, resume, farm, hunt, warp. Nada
 * se evalúa: un mensaje que no sea una orden válida se contesta con
 * `command-result` ok:false y no llega al bot.
 *
 * Por HTTP (mismo puerto, solo lectura):
 *   GET / y /panel       → panel.html de la raíz del repo (404 si no está)
 *   GET /assets/<path>   → modelos y texturas del cliente desde MU_ASSETS
 *                          (default ~/self/mu/public/game-assets), solo
 *                          extensiones de la lista y sin salir de ese directorio
 *
 * Contrato completo en panel-protocol.ts. Mismo patrón que proxy.ts: Bun.serve
 * con upgrade a WebSocket.
 */
import { terrainOf } from './terrain';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { PANEL_COMMANDS, isPanelCommand, type PanelCommand, type PanelServerMessage, type PanelState } from './panel-protocol';

export type DecisionLogEntry = {
  seq: number;
  at: string;
  kind: string;
  what: string;
  detail: Record<string, unknown>;
  autoOk: boolean;
};

export type WorldSnapshot = Record<string, unknown>;

// Los mensajes del panel (panel-protocol.ts) más los de telemetría de antes
// (history/state/decision), que se conservan para no romper clientes viejos.
type ServerMessage =
  | PanelServerMessage
  | { type: 'history'; decisions: DecisionLogEntry[] }
  | { type: 'state'; at: string; world: WorldSnapshot }
  | { type: 'decision'; decision: DecisionLogEntry };

type WsData = Record<string, never>;

export type CommandResult = { ok: boolean; msg: string };
export type CommandHandler = (command: PanelCommand) => CommandResult | Promise<CommandResult>;

export type StatusServer = {
  broadcastState(snapshot: WorldSnapshot): void;
  broadcastDecision(entry: DecisionLogEntry): void;
  broadcastPanelState(state: PanelState): void;
  broadcastLog(text: string): void;
  /** Registra quién ejecuta las órdenes del panel (una sola; la última gana). */
  onCommand(handler: CommandHandler): void;
  close(): void;
};

const HISTORY_SIZE = 200;
const LOG_HISTORY_SIZE = 100;
const BOT_VERSION = '0.2.0-panel';
// Un mensaje del panel es una orden chiquita: lo que pase de esto se ignora sin parsear.
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
const PANEL_FILE = join(import.meta.dir, 'panel.html');

/**
 * Valida un mensaje crudo del panel. Devuelve la orden (si es válida) o el
 * command-result de rechazo (`reject: null` = ni se contesta, mensaje gigante).
 * Exportada para testearla sin levantar el server.
 */
export function parseClientMessage(
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): { id: number; command: PanelCommand } | { reject: { id: number; msg: string } | null } {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (size > MAX_CLIENT_MESSAGE_BYTES) return { reject: null };
  let msg: unknown;
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString('utf8');
    msg = JSON.parse(text);
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
 * Origen de un navegador: solo el propio panel (127.0.0.1/localhost en este
 * puerto). Sin esto, cualquier página abierta en el navegador podría abrir un
 * WebSocket a 127.0.0.1 (los WebSocket no tienen CORS) y mandarle órdenes al
 * bot. Sin Origin (clientes que no son navegador, ej. un script local) se acepta.
 */
export function originAllowed(origin: string | null, port: number): boolean {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// --- Assets del cliente (modelos/texturas para el 3D del panel) -------------
const ASSET_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ozt': 'application/octet-stream',
  '.tga': 'application/octet-stream',
  '.ozj': 'image/jpeg', // OZJ = JPEG con un header de unos bytes
};

/**
 * Ruta en disco de un asset pedido, o null si no se sirve (extensión fuera de
 * la lista, o la ruta resuelta se sale del directorio base: path traversal).
 * Exportada para testearla.
 */
export function resolveAssetPath(baseDir: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (!ASSET_TYPES[extname(rel).toLowerCase()]) return null;
  const base = resolve(baseDir);
  const full = resolve(base, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (!full.startsWith(base + sep)) return null;
  return full;
}

export const assetContentType = (path: string) => ASSET_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

export function startStatusServer(opts: { port: number; assetsDir?: string }): StatusServer {
  const assetsDir = opts.assetsDir ?? process.env.MU_ASSETS ?? join(homedir(), 'self', 'mu', 'public', 'game-assets');
  const history: DecisionLogEntry[] = [];
  const logs: Array<{ at: number; text: string }> = [];
  const clients = new Set<{ send(data: string): void }>();
  let commandHandler: CommandHandler | null = null;
  let lastPanelState: PanelState | null = null;

  function send(ws: { send(data: string): void }, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // cliente caído; se limpia en close()
    }
  }

  function broadcast(msg: ServerMessage) {
    for (const ws of clients) send(ws, msg);
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
    // Solo esta máquina: sin hostname Bun escucha en todas las interfaces y cualquiera en la red
    // podía ver la telemetría y, con el canal de órdenes, manejar el bot.
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
      // Terreno del mapa (EncTerrainN.att descifrado, 256×256 bytes de atributos): paredes y zona
      // segura para dibujar el mapa en el panel aunque no haya minimapa (Arenas).
      const tm = url.pathname.match(/^\/terrain\/(\d{1,3})$/);
      if (tm) {
        const grid = terrainOf(Number(tm[1]));
        return grid ? new Response(grid, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=3600' } }) : new Response('Sin terreno para ese mapa.', { status: 404 });
      }
      if (url.pathname.startsWith('/assets/')) {
        const path = resolveAssetPath(assetsDir, url.pathname.slice('/assets'.length));
        if (path) {
          const file = Bun.file(path);
          if (await file.exists()) return new Response(file, { headers: { 'content-type': assetContentType(path), 'cache-control': 'max-age=3600' } });
        }
        return new Response('No encontrado.', { status: 404 });
      }
      return new Response('No encontrado.', { status: 404 });
    },
    websocket: {
      maxPayloadLength: 64 * 1024,
      open(ws) {
        clients.add(ws);
        send(ws, { type: 'hello', botVersion: BOT_VERSION, commands: PANEL_COMMANDS });
        send(ws, { type: 'history', decisions: history });
        for (const l of logs) send(ws, { type: 'log', at: l.at, text: l.text });
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
    broadcastState(snapshot) {
      broadcast({ type: 'state', at: new Date().toISOString(), world: snapshot });
    },
    broadcastDecision(entry) {
      history.push(entry);
      if (history.length > HISTORY_SIZE) history.shift();
      broadcast({ type: 'decision', decision: entry });
    },
    broadcastPanelState(state) {
      lastPanelState = state;
      broadcast({ type: 'panel-state', state });
    },
    broadcastLog(text) {
      const l = { at: Date.now(), text };
      logs.push(l);
      if (logs.length > LOG_HISTORY_SIZE) logs.shift();
      broadcast({ type: 'log', at: l.at, text: l.text });
    },
    onCommand(handler) {
      commandHandler = handler;
    },
    close() {
      server.stop();
    },
  };
}
