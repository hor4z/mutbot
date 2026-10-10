/**
 * Servidor de telemetría del bot (headless-bot.ts), SOLO LECTURA.
 *
 * Expone por WebSocket el estado del bot (posición, HP/MP, stats, inventario)
 * y cada decisión que pasa por decide(), para que una UI externa (hoy ninguna,
 * pensado para una futura UI) pueda observar una corrida sin tener que tail-ear
 * el --decision-log a mano.
 *
 * Deliberadamente de solo lectura en esta versión: no hay canal para que un
 * cliente apruebe/rechace una decisión pendiente. Eso cambiaría el
 * comportamiento del decisionHandler por defecto (hoy aprueba todo) y necesita
 * su propio paso de verificación — ver AGENTS.md, sección "Pendiente".
 *
 * Mismo patrón que proxy.ts: Bun.serve con upgrade a WebSocket.
 */

export type DecisionLogEntry = {
  seq: number;
  at: string;
  kind: string;
  what: string;
  detail: Record<string, unknown>;
  autoOk: boolean;
};

export type WorldSnapshot = Record<string, unknown>;

type ServerMessage =
  | { type: 'hello'; botVersion: string }
  | { type: 'history'; decisions: DecisionLogEntry[] }
  | { type: 'state'; at: string; world: WorldSnapshot }
  | { type: 'decision'; decision: DecisionLogEntry };

type WsData = Record<string, never>;

export type StatusServer = {
  broadcastState(snapshot: WorldSnapshot): void;
  broadcastDecision(entry: DecisionLogEntry): void;
  close(): void;
};

const HISTORY_SIZE = 200;
const BOT_VERSION = '0.1.0-telemetry';

export function startStatusServer(opts: { port: number }): StatusServer {
  const history: DecisionLogEntry[] = [];
  const clients = new Set<{ send(data: string): void }>();

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

  const server = Bun.serve<WsData>({
    // Solo esta máquina: sin hostname Bun escucha en todas las interfaces y cualquiera en la red
    // podía ver la telemetría (y, con el canal de órdenes, manejar el bot).
    hostname: '127.0.0.1',
    port: opts.port,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: {} })) return;
      return new Response('Este puerto solo sirve telemetría por WebSocket.', { status: 426 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        send(ws, { type: 'hello', botVersion: BOT_VERSION });
        send(ws, { type: 'history', decisions: history });
      },
      message() {
        // v1 de solo lectura: cualquier mensaje entrante se ignora a propósito.
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
    close() {
      server.stop();
    },
  };
}
