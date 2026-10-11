import { serveRadarAsset } from './radar-assets';
/**
 * Estación: un panel para conectar y desconectar a los personajes sin navegador y ponerlos en una
 * rutina (farmear, spot fijo, explorar, pausa). Cada personaje es un bot `headless-bot.ts` aparte,
 * con su propio panel en 127.0.0.1:879x que la estación muestra adentro.
 *
 *   bun run estacion            → http://127.0.0.1:8787
 *
 * - Personajes: cada `.env` / `.env.<algo>` de la raíz con MUBOT_USER/PASS/CHAR. La contraseña no
 *   pasa por la estación: el bot la lee de su `--env-file`.
 * - Los bots corren en su propia sesión (`setsid`) y escriben en ~/.mubot/logs/<personaje>.log:
 *   cerrar o reiniciar la estación NO los desconecta. Al arrancar, la estación adopta los que ya
 *   corren (los busca en /proc por cuenta y lee su --ws-port).
 * - Nunca dos sesiones de la misma cuenta: si ya corre un bot con esa cuenta no lanza otro, y el bot
 *   va con `--exit-if-in-use` (si la cuenta está abierta en el navegador, sale con código 3).
 * - Solo 127.0.0.1. Las órdenes (POST /api/do) exigen el Origin de la propia estación y JSON.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BOT_PORT_BASE, DEFAULT_SERVER, GAME_ORIGIN, RECENT_STOP_MS, applyGoldSignal, freshGolds, type GoldSignal, botArgs, charFromEnv, exitStatus, isCharEnvFile, parseStationRequest, processRunsAccount,
  routineCommands, routineLabel, type CharConfig, type CharStatus, type GameServer, type Routine,
} from './estacion-logic';
import { originAllowed } from './ws-server';
import { mapName } from './panel-logic';
import type { PanelServerMessage, PanelState } from './panel-protocol';

const ROOT = import.meta.dir;
const PORT = Number(process.env.ESTACION_PORT ?? 8787);
const LOG_DIR = join(homedir(), '.mubot', 'logs');
const SERVER: GameServer = {
  proxy: process.env.MUBOT_PROXY ?? DEFAULT_SERVER.proxy,
  csHost: process.env.MUBOT_CS_HOST ?? DEFAULT_SERVER.csHost,
  csPort: Number(process.env.MUBOT_CS_PORT ?? DEFAULT_SERVER.csPort),
};

type Slot = {
  cfg: CharConfig;
  port: number;
  pid: number | null;
  status: CharStatus;
  msg: string;
  routine: Routine | null;
  /** rutina a aplicar cuando el bot esté en el mundo */
  pending: Routine | null;
  state: PanelState | null;
  ws: WebSocket | null;
  wsPort: number | null;
  nextId: number;
  waiting: Map<number, (r: { ok: boolean; msg: string }) => void>;
  /** cuándo se lo desconectó desde la estación */
  stoppedAt: number;
};
const slots = new Map<string, Slot>();
const say = (...a: unknown[]) => console.log('[estación]', ...a);

// --- Personajes -----------------------------------------------------------------------------
function discover(): CharConfig[] {
  const out: CharConfig[] = [];
  for (const f of readdirSync(ROOT).filter(isCharEnvFile).sort()) {
    try {
      const c = charFromEnv(f, readFileSync(join(ROOT, f), 'utf8'));
      if (c && !out.some((o) => o.key === c.key)) out.push(c);
    } catch {}
  }
  return out;
}

function refreshSlots() {
  const cfgs = discover();
  for (const cfg of cfgs) {
    const s = slots.get(cfg.key);
    if (s) {
      s.cfg = cfg;
      continue;
    }
    // Puerto estable: el primero libre desde BOT_PORT_BASE (un .env nuevo no le roba el puerto a otro).
    const used = new Set([...slots.values()].map((x) => x.port));
    let port = BOT_PORT_BASE;
    while (used.has(port)) port++;
    slots.set(cfg.key, {
      cfg, port, pid: null, status: 'off', msg: 'desconectado', routine: null, pending: null,
      state: null, ws: null, wsPort: null, nextId: 1, waiting: new Map(), stoppedAt: 0,
    });
  }
}

// --- Bots que ya corren (los nuestros o lanzados a mano) ------------------------------------
type Running = { pid: number; wsPort: number | null; cmdline: string[]; environ: string[] };
function scanProcs(): Running[] {
  const out: Running[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmdline = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!cmdline.some((a) => a.endsWith('headless-bot.ts'))) continue;
      const environ = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      const i = cmdline.indexOf('--ws-port');
      out.push({ pid: Number(d), wsPort: i >= 0 ? Number(cmdline[i + 1]) : null, cmdline, environ });
    } catch {}
  }
  return out;
}

function syncRunning() {
  const procs = scanProcs();
  for (const s of slots.values()) {
    const p = procs.find((r) => processRunsAccount(r.cmdline, r.environ, s.cfg));
    if (p) {
      if (s.pid !== p.pid) {
        s.pid = p.pid;
        if (s.status === 'off' || s.status === 'failed' || s.status === 'in-use') {
          s.status = p.wsPort ? 'on' : 'external';
          s.msg = p.wsPort ? 'ya estaba corriendo: lo adopté' : 'corre sin --ws-port: no lo puedo ver ni manejar desde acá (solo desconectar)';
        }
      }
      if (p.wsPort && p.wsPort !== s.wsPort) attachWs(s, p.wsPort);
    } else if (s.pid != null && !ownExits.has(s.pid)) {
      // Murió y no era hijo nuestro (o no nos enteramos del código de salida).
      s.pid = null;
      if (s.status !== 'in-use' && s.status !== 'failed') { s.status = 'off'; s.msg = 'desconectado'; }
      detachWs(s);
    }
  }
}

// --- WebSocket con cada bot (sin Origin: el bot lo acepta como cliente local) ---------------
function attachWs(s: Slot, port: number) {
  detachWs(s);
  s.wsPort = port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  s.ws = ws;
  ws.onmessage = (ev) => {
    let m: PanelServerMessage;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === 'panel-state') {
      s.state = m.state;
      if (s.status === 'starting' && m.state.mode !== 'connecting') { s.status = 'on'; s.msg = 'en el juego'; }
      if (s.pending && m.state.mode !== 'connecting' && m.state.char.level > 0) {
        const r = s.pending;
        s.pending = null;
        void applyRoutine(s, r);
      }
    } else if (m.type === 'command-result') {
      s.waiting.get(m.id)?.({ ok: m.ok, msg: m.msg });
      s.waiting.delete(m.id);
    }
  };
  ws.onclose = () => {
    if (s.ws !== ws) return;
    s.ws = null;
    // El bot todavía no levantó el panel (o se reinició): reintento mientras el proceso viva.
    setTimeout(() => { if (s.pid != null && s.wsPort === port && !s.ws) attachWs(s, port); }, 1500);
  };
}

function detachWs(s: Slot) {
  const ws = s.ws;
  s.ws = null;
  s.wsPort = null;
  s.state = null;
  try { ws?.close(); } catch {}
}

function sendCommand(s: Slot, command: unknown): Promise<{ ok: boolean; msg: string }> {
  return new Promise((resolve) => {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return resolve({ ok: false, msg: 'sin conexión con el bot' });
    const id = s.nextId++;
    const t = setTimeout(() => { s.waiting.delete(id); resolve({ ok: false, msg: 'el bot no contestó' }); }, 5000);
    s.waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
    s.ws.send(JSON.stringify({ type: 'command', id, command }));
  });
}

async function applyRoutine(s: Slot, r: Routine) {
  for (const c of routineCommands(r)) {
    const res = await sendCommand(s, c);
    say(`${s.cfg.char} ← ${c.cmd}: ${res.ok ? '' : 'rechazada, '}${res.msg}`);
    if (!res.ok) { s.msg = `rutina "${routineLabel(r)}": ${res.msg}`; return; }
  }
  s.routine = r;
  s.msg = routineLabel(r);
}

// --- Conectar / desconectar ------------------------------------------------------------------
const ownExits = new Set<number>();

function connect(s: Slot, routine: Routine): { ok: boolean; msg: string } {
  syncRunning();
  if (s.pid != null) return { ok: false, msg: `${s.cfg.char} ya está corriendo (pid ${s.pid})` };
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${s.cfg.key}.log`);
  const fd = openSync(logPath, 'a');
  // Sin MUBOT_* heredados: la estación pudo cargar el .env de otro personaje.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && !k.startsWith('MUBOT_')) env[k] = v;
  env.MUBOT_GOLD_URL = `http://127.0.0.1:${PORT}/api/gold`;
  // Compañeros: todos los personajes de la estación (no son rivales en la esquina ni para la defensa).
  env.MUBOT_MATES = [...slots.values()].map((x) => x.cfg.char).join(',');
  const proc = Bun.spawn(['setsid', process.execPath, ...botArgs(s.cfg, s.port, SERVER, 'headless-bot.ts', Date.now() - s.stoppedAt > RECENT_STOP_MS)], {
    cwd: ROOT, env, stdin: 'ignore', stdout: fd, stderr: fd,
  });
  closeSync(fd);
  s.pid = proc.pid;
  ownExits.add(proc.pid);
  s.status = 'starting';
  s.msg = 'conectando…';
  s.routine = null;
  s.pending = routine;
  say(`conecto a ${s.cfg.char} (pid ${proc.pid}, panel ${s.port}, rutina: ${routineLabel(routine)})`);
  void proc.exited.then((code) => {
    ownExits.delete(proc.pid);
    if (s.pid !== proc.pid) return;
    const st = exitStatus(code);
    s.pid = null;
    s.status = st.status;
    s.msg = st.msg;
    s.pending = null;
    detachWs(s);
    say(`${s.cfg.char} salió (código ${code}): ${st.msg}`);
  });
  setTimeout(() => { if (s.pid === proc.pid && !s.ws) attachWs(s, s.port); }, 1500);
  return { ok: true, msg: `conectando a ${s.cfg.char}…` };
}

function disconnect(s: Slot): { ok: boolean; msg: string } {
  syncRunning();
  if (s.pid == null) return { ok: true, msg: `${s.cfg.char} no estaba conectado` };
  try { process.kill(s.pid, 'SIGTERM'); } catch (e) { return { ok: false, msg: `no pude cortarlo: ${(e as Error).message}` }; }
  s.stoppedAt = Date.now();
  s.status = 'stopping';
  s.msg = 'desconectando…';
  s.pending = null;
  return { ok: true, msg: `desconectando a ${s.cfg.char}` };
}

async function routine(s: Slot, r: Routine): Promise<{ ok: boolean; msg: string }> {
  if (s.pid == null) return { ok: false, msg: `${s.cfg.char} no está conectado` };
  if (s.status === 'external' || s.wsPort == null) return { ok: false, msg: `${s.cfg.char} corre sin panel: no le puedo mandar órdenes (solo desconectar)` };
  if (!s.state || s.state.mode === 'connecting') {
    s.pending = r;
    return { ok: true, msg: `la aplico cuando ${s.cfg.char} entre al juego` };
  }
  await applyRoutine(s, r);
  return { ok: s.routine === r, msg: s.msg };
}

// --- HTTP -----------------------------------------------------------------------------------
function view() {
  return [...slots.values()].map((s) => {
    const st = s.state;
    return {
      key: s.cfg.key, char: s.cfg.char, status: s.status, msg: s.msg, pid: s.pid, port: s.wsPort ?? s.port,
      panel: s.ws?.readyState === WebSocket.OPEN, routine: s.routine, pending: s.pending,
      game: st && {
        mode: st.mode, doing: st.doing, level: st.char.level, resets: st.char.resets, cls: st.char.cls ?? null,
        map: st.where.mapName, x: st.where.x, y: st.where.y, hp: st.char.hp, expPerMin: st.exp.perMin5 || st.exp.perMin1,
      },
    };
  });
}

// Últimas líneas del log sin leerlo entero (los logs crecen sin rotación con bots corriendo días).
function tail(path: string, lines: number, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n').slice(-lines - 1).join('\n');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// Señales de dorados (POST /api/gold): de los bots (sin Origin) o del juego en el navegador.
const golds = new Map<string, GoldSignal>();
const GOLD_CORS = {
  'access-control-allow-origin': GAME_ORIGIN,
  'access-control-allow-private-network': 'true',
  'access-control-allow-methods': 'GET, POST',
  'access-control-allow-headers': 'content-type',
};

// Ranking: la API del server del juego (la que usa el cliente web para /ranking), con caché de 1 min.
const RANKING_URL = process.env.MUBOT_RANKING_URL ?? `https://${new URL(SERVER.proxy).host}/api/ranking`;
let rankingCache: { at: number; data: unknown } | null = null;
async function ranking(): Promise<unknown> {
  if (rankingCache && Date.now() - rankingCache.at < 60_000) return rankingCache.data;
  try {
    const r = await fetch(RANKING_URL, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    rankingCache = { at: Date.now(), data: await r.json() };
    return rankingCache.data;
  } catch (e) {
    return rankingCache?.data ?? { error: `no pude leer el ranking: ${(e as Error).message}` };
  }
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

refreshSlots();
syncRunning();
setInterval(() => { refreshSlots(); syncRunning(); }, 2000);

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const visualAsset = await serveRadarAsset(req);
    if (visualAsset) return visualAsset;
    const url = new URL(req.url);
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/panel' || url.pathname === '/estacion') {
        return new Response(Bun.file(join(ROOT, 'estacion.html')), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      // Los avistamientos vigentes, también para el cazador del navegador (CORS del juego).
      if (url.pathname === '/api/gold') return new Response(JSON.stringify(freshGolds(golds, Date.now())), { headers: { ...GOLD_CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
      // Ranking del server (top de resets y ELO de Arena), el mismo que muestra el cliente web.
      if (url.pathname === '/api/ranking') return json(await ranking());
      if (url.pathname === '/api/state') return json({ chars: view(), golds: freshGolds(golds, Date.now()).map((g) => ({ ...g, mapName: mapName(g.map) })) });
      const lm = url.pathname.match(/^\/api\/log\/([a-z0-9_]{1,10})$/);
      if (lm && slots.has(lm[1])) return new Response(tail(join(LOG_DIR, `${lm[1]}.log`), 200), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return new Response('No encontrado.', { status: 404 });
    }
    if (url.pathname === '/api/gold') {
      const origin = req.headers.get('origin');
      if (origin && origin !== GAME_ORIGIN && !originAllowed(origin, PORT)) return new Response('origen no permitido', { status: 403 });
      if (req.method === 'OPTIONS') return new Response(null, { headers: GOLD_CORS });
      if (req.method !== 'POST') return new Response('No.', { status: 405 });
      const body = await req.text();
      if (body.length > 1024) return new Response('grande', { status: 413, headers: GOLD_CORS });
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return new Response('json', { status: 400, headers: GOLD_CORS }); }
      return applyGoldSignal(golds, raw, Date.now()) ? new Response('ok', { headers: GOLD_CORS }) : new Response('datos', { status: 400, headers: GOLD_CORS });
    }
    if (req.method === 'POST' && url.pathname === '/api/do') {
      // Una página cualquiera abierta en el navegador podría postear acá: solo la propia estación.
      const origin = req.headers.get('origin');
      if (!origin || !originAllowed(origin, PORT)) return json({ ok: false, msg: 'origen no permitido' }, 403);
      if (!req.headers.get('content-type')?.startsWith('application/json')) return json({ ok: false, msg: 'solo JSON' }, 415);
      const body = await req.text();
      if (body.length > 2048) return json({ ok: false, msg: 'pedido demasiado grande' }, 413);
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return json({ ok: false, msg: 'no es JSON' }, 400); }
      const r = parseStationRequest(raw);
      if (!r) return json({ ok: false, msg: 'pedido inválido' }, 400);
      refreshSlots();
      const s = slots.get(r.char);
      if (!s) return json({ ok: false, msg: `no conozco a ${r.char}` }, 404);
      const res = r.action === 'connect' ? connect(s, r.routine) : r.action === 'disconnect' ? disconnect(s) : await routine(s, r.routine);
      return json(res, res.ok ? 200 : 409);
    }
    return new Response('No.', { status: 405 });
  },
});
say(`http://127.0.0.1:${PORT}  (personajes: ${[...slots.values()].map((s) => s.cfg.char).join(', ') || 'ninguno: falta un .env con MUBOT_USER/PASS/CHAR'})`);
