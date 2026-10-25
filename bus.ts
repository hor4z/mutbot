/**
 * Canal directo entre los bots (UDP en loopback, sin servidor en el medio). Cada bot escucha en su puerto y manda a los
 * demás: su posición cuatro veces por segundo y, en el momento, cada dorado que ve. La latencia es de milisegundos y no hay
 * consulta periódica. La estación es un oyente más (muestra los avisos). Los puertos los pone la estación al lanzar el bot
 * (MUBOT_BUS_PORT / MUBOT_BUS_PEERS); sin ellos el bot juega solo. UDP: si un compañero no está, el paquete se pierde y listo.
 */
import { bot, world } from './state';
import { statPower } from './util';

export type TeamMember = { char: string; level: number; resets?: number; /** suma de stats (util.statPower); 0 si no la mandó */ power: number; map: number; x: number; y: number; mode: string; at: number; /** espera en la entrada de una Arena a que su líder lo recoja */ waiting: boolean; /** carreo: 0 no lo necesita; 1 necesita que su líder baje a su mapa (todavía no puede pagar un warp); 2 puede hacer warp (que el líder vaya al spot de su nivel) */ carry: 0 | 1 | 2 };
export type GoldNotice = { from: string; map: number; x: number; y: number; note: string; at: number };

/** Posición vista hace más que esto = el compañero ya no está. */
const FRESH_MS = 3000;
const STATE_EVERY_MS = 250;
let waitingForPickup = false;
/** Avisar a los compañeros que estoy esperando en la entrada a que mi líder me recoja (place.ts lo marca cada tick). */
export const setWaiting = (on: boolean) => { waitingForPickup = on; };
let needsCarry: 0 | 1 | 2 = 0;
/** Avisar al líder que soy de nivel bajo y necesito que baje (1) o que vaya al spot de mi nivel porque ya puedo hacer warp (2). place.ts lo marca cada tick. */
export const setNeedsCarry = (v: 0 | 1 | 2) => { needsCarry = v; };

const members = new Map<string, TeamMember>();
// Orden de la estación (orquestador): a quién seguir. Vale mientras llegue; si deja de llegar, el bot vuelve a decidir solo.
let directive: { leader: string; shadows: string[]; at: number; follow: FollowHuman | null } | null = null;
/** Un jugador humano (de los propios, ej. el usuario jugando a mano) al que seguir: se lo ve por el scope, no por el bus. map/x/y: pista de dónde está. */
export type FollowHuman = { name: string; map?: number; x?: number; y?: number };
const DIRECTIVE_FRESH_MS = 3000;
const STATION_PORT = Number(process.env.MUBOT_BUS_STATION) || 9090;
let notices: GoldNotice[] = [];
const announcedAt = new Map<string, number>();
let peers: number[] = [];
let sock: { send(data: Uint8Array, port: number, address: string): boolean } | null = null;

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const name = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_]{1,10}$/.test(v);

function onPacket(buf: Uint8Array, fromPort: number) {
  let m: Record<string, unknown>;
  try { m = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { return; }
  // Las órdenes solo valen si salen del puerto de la estación (loopback: ningún otro programa del usuario las manda).
  if (m.t === 'o' && fromPort === STATION_PORT) {
    // l = a quién sigo (o null); s = quiénes me siguen a mí.
    const shadows = Array.isArray(m.s) ? m.s.filter(name) : [];
    const f = m.f as Record<string, unknown> | undefined;
    const follow: FollowHuman | null = f && name(f.n) ? { name: f.n, map: num(f.m, 0, 255) ? f.m : undefined, x: num(f.x, 0, 255) ? f.x : undefined, y: num(f.y, 0, 255) ? f.y : undefined } : null;
    directive = { leader: typeof m.l === 'string' && name(m.l) ? m.l : '', shadows, at: Date.now(), follow };
    return;
  }
  if (!name(m.c) || m.c.toLowerCase() === bot.charName.toLowerCase()) return;
  if (m.t === 's' && num(m.l, 0, 1000) && num(m.m, 0, 255) && num(m.x, 0, 255) && num(m.y, 0, 255)) {
    members.set(m.c.toLowerCase(), { char: m.c, level: m.l, resets: num(m.r, 0, 100_000) ? m.r : undefined, power: num(m.p, 0, 10_000_000) ? m.p : 0, map: m.m, x: m.x, y: m.y, mode: typeof m.d === 'string' ? m.d.slice(0, 10) : '', at: Date.now(), waiting: m.w === 1, carry: m.k === 2 ? 2 : m.k === 1 ? 1 : 0 });
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
    sock = (await Bun.udpSocket({ hostname: '127.0.0.1', port, socket: { data: (_s, buf, p) => onPacket(buf, p) } })) as unknown as typeof sock;
  } catch {
    return; // puerto ocupado: el bot sigue solo
  }
  setInterval(() => {
    if (!bot.inGameAt || bot.kicked) return;
    broadcast({ t: 's', c: bot.charName, l: world.level, r: world.resets ?? 0, p: statPower(world.stats), m: world.map, x: world.x, y: world.y, d: bot.paused ? 'paused' : bot.hunting ? 'hunt' : 'farm', w: waitingForPickup ? 1 : 0, k: needsCarry });
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

/** El compañero al que la estación me mandó seguir (si la orden es reciente y lo veo), o null. */
export function directedLeader(): TeamMember | null {
  if (!directive?.leader || Date.now() - directive.at > DIRECTIVE_FRESH_MS) return null;
  return teammates().find((m) => m.char.toLowerCase() === directive!.leader.toLowerCase()) ?? null;
}

/** El humano que la estación me mandó a seguir (o null). */
export function followHumanTarget(): FollowHuman | null {
  if (!directive?.follow || Date.now() - directive.at > DIRECTIVE_FRESH_MS) return null;
  return directive.follow;
}

/** Los compañeros que la estación mandó a seguirme (los que veo). */
export function myShadows(): TeamMember[] {
  if (!directive || Date.now() - directive.at > DIRECTIVE_FRESH_MS) return [];
  const names = new Set(directive.shadows.map((s) => s.toLowerCase()));
  return teammates().filter((m) => names.has(m.char.toLowerCase()));
}
