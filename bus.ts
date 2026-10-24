/**
 * Canal directo entre los bots (UDP en loopback, sin servidor en el medio). Cada bot escucha en su puerto y manda a los
 * demás: su posición cuatro veces por segundo y, en el momento, cada dorado que ve. La latencia es de milisegundos y no hay
 * consulta periódica. La estación es un oyente más (muestra los avisos). Los puertos los pone la estación al lanzar el bot
 * (MUBOT_BUS_PORT / MUBOT_BUS_PEERS); sin ellos el bot juega solo. UDP: si un compañero no está, el paquete se pierde y listo.
 */
import { bot, world } from './state';

export type TeamMember = { char: string; level: number; resets?: number; map: number; x: number; y: number; mode: string; at: number };
export type GoldNotice = { from: string; map: number; x: number; y: number; note: string; at: number };

/** Posición vista hace más que esto = el compañero ya no está. */
const FRESH_MS = 3000;
const STATE_EVERY_MS = 250;

const members = new Map<string, TeamMember>();
let notices: GoldNotice[] = [];
const announcedAt = new Map<string, number>();
let peers: number[] = [];
let sock: { send(data: Uint8Array, port: number, address: string): boolean } | null = null;

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const name = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_]{1,10}$/.test(v);

function onPacket(buf: Uint8Array) {
  let m: Record<string, unknown>;
  try { m = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { return; }
  if (!name(m.c) || m.c.toLowerCase() === bot.charName.toLowerCase()) return;
  if (m.t === 's' && num(m.l, 0, 1000) && num(m.m, 0, 255) && num(m.x, 0, 255) && num(m.y, 0, 255)) {
    members.set(m.c.toLowerCase(), { char: m.c, level: m.l, resets: num(m.r, 0, 100_000) ? m.r : undefined, map: m.m, x: m.x, y: m.y, mode: typeof m.d === 'string' ? m.d.slice(0, 10) : '', at: Date.now() });
  } else if (m.t === 'g' && num(m.m, 0, 255) && num(m.x, 0, 255) && num(m.y, 0, 255)) {
    notices.push({ from: m.c, map: m.m, x: m.x, y: m.y, note: typeof m.n === 'string' ? m.n.slice(0, 80) : '', at: Date.now() });
    if (notices.length > 50) notices.shift();
  }
}

function broadcast(msg: Record<string, unknown>) {
  if (!sock) return;
  const data = Buffer.from(JSON.stringify(msg));
  for (const p of peers) sock.send(data, p, '127.0.0.1');
}

/** Abre el canal (una vez por proceso). Sin puerto en el entorno no hace nada. */
export async function startBus() {
  const port = Number(process.env.MUBOT_BUS_PORT);
  if (!port || sock) return;
  peers = (process.env.MUBOT_BUS_PEERS ?? '').split(',').map(Number).filter((p) => p > 0 && p !== port);
  try {
    sock = (await Bun.udpSocket({ hostname: '127.0.0.1', port, socket: { data: (_s, buf) => onPacket(buf) } })) as unknown as typeof sock;
  } catch {
    return; // puerto ocupado: el bot sigue solo
  }
  setInterval(() => {
    if (!bot.inGameAt || bot.kicked) return;
    broadcast({ t: 's', c: bot.charName, l: world.level, r: world.resets ?? 0, m: world.map, x: world.x, y: world.y, d: bot.paused ? 'paused' : bot.hunting ? 'hunt' : 'farm' });
  }, STATE_EVERY_MS);
}

/** Los compañeros (sin mí) vistos hace poco. */
export const teammates = (): TeamMember[] => {
  const now = Date.now();
  return [...members.values()].filter((m) => now - m.at <= FRESH_MS);
};

/** Avisar un dorado a los compañeros, al instante; como mucho uno por dorado (misma nota) cada `everyMs`. true si salió. */
export function announceGold(map: number, x: number, y: number, note: string, everyMs = 15_000): boolean {
  const now = Date.now();
  if (now - (announcedAt.get(note) ?? 0) < everyMs) return false;
  announcedAt.set(note, now);
  broadcast({ t: 'g', c: bot.charName, m: map, x, y, n: note });
  return true;
}

/** Avisos de dorados de compañeros que todavía no atendí (se vacía). */
export function drainGold(): GoldNotice[] {
  const out = notices;
  notices = [];
  return out;
}
