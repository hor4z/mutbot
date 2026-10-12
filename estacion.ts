import { serveRadarAsset } from './radar-assets';
/**
 * Estación: un panel para conectar y desconectar a los personajes sin navegador y ponerlos en una
 * rutina (farmear, spot fijo, explorar, pausa). Cada personaje es un bot `headless-bot.ts` aparte,
 * con su propio panel en 127.0.0.1:879x que la estación muestra adentro.
 *
 *   bun run estacion            → http://127.0.0.1:8787
 *
 * - Cuentas y personajes: en la base SQLite (`estacion-db.ts`, ~/.mubot/mubot.db). Los `.env` de la
 *   raíz se importan solos al arrancar. La clave le llega al bot por MUBOT_PASS, nunca por argumentos.
 * - Los bots corren en su propia sesión (`setsid`) y escriben en ~/.mubot/logs/<personaje>.log:
 *   cerrar o reiniciar la estación NO los desconecta. Al arrancar, la estación adopta los que ya
 *   corren (los busca en /proc por cuenta y lee su --ws-port).
 * - Nunca dos sesiones de la misma cuenta: si ya corre un bot con esa cuenta no lanza otro, y el bot
 *   va con `--exit-if-in-use` (si la cuenta está abierta en el navegador, sale con código 3).
 * - Solo 127.0.0.1. Las órdenes (POST /api/do) exigen el Origin de la propia estación y JSON.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statfsSync, statSync } from 'node:fs';
import { coolNames } from './names';
import { EstacionDb, type DbChar } from './estacion-db';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BOT_PORT_BASE, DEFAULT_SERVER, TEAM_REQUEST_TTL_MS, parseTeamRequest, type TeamRequest, GAME_ORIGIN, RECENT_STOP_MS, applyGoldSignal, freshGolds, type GoldSignal, botArgs, charFromEnv, exitStatus, isCharEnvFile, parseStationRequest, processRunsAccount,
  CHAR_CLASSES, parseEnvFile, type NewCharRequest,
  routineCommands, routineLabel, type CharConfig, type CharStatus, type GameServer, type Routine,
} from './estacion-logic';
import { originAllowed } from './ws-server';
import { mapName } from './panel-logic';
import type { PanelServerMessage, PanelState } from './panel-protocol';

const ROOT = import.meta.dir;
const PORT = Number(process.env.ESTACION_PORT ?? 8787);
// Entre desconectar y volver a conectar un personaje (ver connect).
const RECONNECT_GAP_MS = 5_000;
const LOG_DIR = join(homedir(), '.mubot', 'logs');
// Al lanzar un bot, si su log pasa de esto se rota a <personaje>.log.1 (se pisa el anterior).
const LOG_ROTATE_BYTES = 50 * 1024 * 1024;
const SERVER: GameServer = {
  proxy: process.env.MUBOT_PROXY ?? DEFAULT_SERVER.proxy,
  csHost: process.env.MUBOT_CS_HOST ?? DEFAULT_SERVER.csHost,
  csPort: Number(process.env.MUBOT_CS_PORT ?? DEFAULT_SERVER.csPort),
};

type Slot = {
  cfg: DbChar;
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
  // conexión demorada (recién desconectado)
  connectTimer: ReturnType<typeof setTimeout> | null;
};
const slots = new Map<string, Slot>();
// Cuentas y personajes (SQLite, ~/.mubot/mubot.db): ver estacion-db.ts.
const db = new EstacionDb(SERVER);
const say = (...a: unknown[]) => console.log('[estación]', ...a);

// --- Personajes -----------------------------------------------------------------------------
function discover() {
  // Los `.env` de la raíz (Horaz, Melu) se importan a la base la primera vez; después manda la base.
  const envs: { envFile: string; user: string; pass: string; char: string }[] = [];
  for (const f of readdirSync(ROOT).filter(isCharEnvFile).sort()) {
    try {
      const c = charFromEnv(f, readFileSync(join(ROOT, f), 'utf8'));
      const pass = c && parseEnvFile(readFileSync(join(ROOT, f), 'utf8')).MUBOT_PASS;
      if (c && pass && c.envFile) envs.push({ envFile: c.envFile, user: c.user, pass, char: c.char });
    } catch {}
  }
  const imported = db.importEnv(envs);
  if (imported.length) say(`importé a la base: ${imported.join(', ')}`);
  return db.chars();
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
      state: null, ws: null, wsPort: null, nextId: 1, waiting: new Map(), stoppedAt: 0, connectTimer: null,
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
      if (s.status === 'starting' && m.state.mode !== 'connecting') {
        s.status = 'on';
        s.msg = 'en el juego';
        // Entró: la cuenta anda (por si estaba marcada como bloqueada).
        if (s.cfg.status !== 'active') { db.setAccountStatus(s.cfg.user, 'active'); refreshSlots(); }
      }
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

// Aprender de los datos cada 30 min (scripts/aprender.ts → ~/.mubot/knowledge.json), si hay base.
const LEARN_EVERY_MS = 30 * 60_000;
setInterval(() => {
  if (!Object.keys(dbEnv()).length) return;
  Bun.spawn([process.execPath, '--env-file=.env.db', 'scripts/aprender.ts'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' });
}, LEARN_EVERY_MS);

// Disco: si quedan menos de DISK_MIN_GB libres donde está la base, se borran los ticks y jugadores de
// más de 7 días (los eventos se conservan) y se avisa. Se mira cada 10 min.
const DISK_MIN_GB = 5;
setInterval(() => {
  const env = dbEnv();
  if (!env.MUBOT_DB_URL) return;
  let freeGb = Infinity;
  try { const st = statfsSync(join(homedir(), '.mubot')); freeGb = (st.bavail * st.bsize) / 1e9; } catch {}
  if (freeGb >= DISK_MIN_GB) return;
  say(`disco con ${freeGb.toFixed(1)} GB libres: borro datos viejos (ticks y jugadores de más de 7 días)`);
  for (const t of ['ticks', 'players_seen'])
    void fetch(`${env.MUBOT_DB_URL}/?database=mubot`, {
      method: 'POST', body: `ALTER TABLE ${t} DELETE WHERE ts < now() - INTERVAL 7 DAY`,
      headers: { 'X-ClickHouse-User': env.MUBOT_DB_USER ?? 'mubot', 'X-ClickHouse-Key': env.MUBOT_DB_PASSWORD ?? '' },
    }).catch(() => {});
}, 10 * 60_000);

// Ranking a la base cada hora (tabla ranking): ritmo de resets de los rivales.
async function saveRanking() {
  const env = dbEnv();
  if (!env.MUBOT_DB_URL) return;
  const data = (await ranking()) as { resets?: { name: string; classNumber: number; totalResets: number; grandResets?: number; level: number }[] };
  if (!Array.isArray(data?.resets)) return;
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const body = data.resets.slice(0, 100).map((r, i) => JSON.stringify({ ts, name: r.name, class: r.classNumber, resets: r.totalResets, grand_resets: r.grandResets ?? 0, level: r.level, pos: i + 1 })).join('\n');
  await fetch(`${env.MUBOT_DB_URL}/?database=mubot&query=${encodeURIComponent('INSERT INTO ranking FORMAT JSONEachRow')}`, {
    method: 'POST', body, headers: { 'X-ClickHouse-User': env.MUBOT_DB_USER ?? 'mubot', 'X-ClickHouse-Key': env.MUBOT_DB_PASSWORD ?? '' },
  }).catch(() => {});
}
setTimeout(() => void saveRanking(), 30_000);
setInterval(() => void saveRanking(), 60 * 60_000);

/** MUBOT_DB_* de .env.db (ClickHouse local, ver db/docker-compose.yml); vacío si no hay archivo. */
function dbEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env.db'), 'utf8').split('\n')) {
      const m = /^(MUBOT_DB_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

function connect(s: Slot, routine: Routine): { ok: boolean; msg: string } {
  syncRunning();
  if (s.pid != null) return { ok: false, msg: `${s.cfg.char} ya está corriendo (pid ${s.pid})` };
  // Una cuenta juega con un solo personaje a la vez.
  const sibling = [...slots.values()].find((x) => x !== s && x.pid != null && x.cfg.user.toLowerCase() === s.cfg.user.toLowerCase());
  if (sibling) return { ok: false, msg: `la cuenta ${s.cfg.user} ya está jugando con ${sibling.cfg.char}: desconectalo primero` };
  const pass = db.passFor(s.cfg.char);
  if (!pass) return { ok: false, msg: `no tengo la clave de ${s.cfg.char} en la base` };
  // Recién desconectado: el server todavía tiene la sesión vieja en el mundo y la nueva quedaba
  // "fantasma" (sin muertes ni exp). Se espera RECONNECT_GAP_MS desde la desconexión y se conecta solo.
  const waitMs = s.stoppedAt + RECONNECT_GAP_MS - Date.now();
  if (waitMs > 0) {
    if (s.connectTimer) clearTimeout(s.connectTimer);
    s.status = 'starting';
    s.msg = `espero ${Math.ceil(waitMs / 1000)} s a que el server suelte la sesión anterior…`;
    s.connectTimer = setTimeout(() => { s.connectTimer = null; if (s.pid == null) connect(s, routine); }, waitMs);
    return { ok: true, msg: `conecto a ${s.cfg.char} en ${Math.ceil(waitMs / 1000)} s (el server suelta la sesión anterior)` };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${s.cfg.key}.log`);
  try { if (statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, `${logPath}.1`); } catch { /* todavía no hay log */ }
  const fd = openSync(logPath, 'a');
  // Sin MUBOT_* heredados: la estación pudo cargar el .env de otro personaje.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && !k.startsWith('MUBOT_')) env[k] = v;
  env.MUBOT_GOLD_URL = `http://127.0.0.1:${PORT}/api/gold`;
  // Compañeros: todos los personajes de la estación (no son rivales en la esquina ni para la defensa).
  env.MUBOT_MATES = [...slots.values()].map((x) => x.cfg.char).join(',');
  env.MUBOT_TEAM_URL = `http://127.0.0.1:${PORT}/api/team`;
  // Credenciales de la base: la clave por entorno (no en la línea de comandos, que se ve en `ps`).
  env.MUBOT_PASS = pass;
  if (s.cfg.cls) env.MUBOT_CREATE_CLASS = s.cfg.cls;
  // Datos a ClickHouse local (telemetry.ts): credenciales de .env.db, si existe.
  Object.assign(env, dbEnv());
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
  db.setRoutine(s.cfg.char, routine);
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
    if (code === 4) { db.setAccountStatus(s.cfg.user, 'blocked'); refreshSlots(); }
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

// --- Personaje nuevo -------------------------------------------------------------------------
// Registro de cuentas del server: el mismo endpoint que el formulario "Crear cuenta" del cliente web
// (su perfil no trae dominio propio, así que usa `/api/register` del mismo host, como el ranking).
const REGISTER_URL = process.env.MUBOT_REGISTER_URL ?? `https://${new URL(SERVER.proxy).host}/api/register`;

/**
 * Registra la cuenta (salvo que ya exista), guarda cuenta y personaje en la base y lo conecta en
 * pausa: el bot crea el personaje al entrar (MUBOT_CREATE_CLASS). La clave no se loguea ni vuelve
 * al navegador.
 */
async function createChar(r: NewCharRequest): Promise<{ ok: boolean; msg: string }> {
  if (slots.has(r.char.toLowerCase())) return { ok: false, msg: `ya hay un personaje ${r.char} en la estación` };
  const busy = [...slots.values()].find((x) => x.pid != null && x.cfg.user.toLowerCase() === r.user.toLowerCase());
  if (busy) return { ok: false, msg: `la cuenta ${r.user} está jugando con ${busy.cfg.char}: desconectalo primero` };
  if (!r.existing) {
    try {
      const res = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: r.user, password: r.pass }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (!res.ok) {
        const why = j.code === 'taken' ? 'esa cuenta ya existe (si es tuya, marcá "ya tengo la cuenta")'
          : j.code === 'throttled' ? 'el server frenó los registros por un rato: probá en unos minutos'
          : (j.error ?? `HTTP ${res.status}`);
        say(`registro de ${r.user}: ${why}`);
        return { ok: false, msg: `No se pudo crear la cuenta: ${why}` };
      }
      say(`cuenta ${r.user} registrada`);
    } catch {
      return { ok: false, msg: 'No se pudo crear la cuenta: el registro del server no contesta' };
    }
  }
  const err = db.addChar(r.user, r.pass, r.char, r.cls);
  if (err) return { ok: false, msg: r.existing ? err : `Cuenta creada, pero no guardé el personaje: ${err}` };
  refreshSlots();
  const s = slots.get(r.char.toLowerCase());
  if (!s) return { ok: false, msg: `guardé a ${r.char} pero no lo encuentro en la base` };
  say(`personaje ${r.char} (${r.cls ? CHAR_CLASSES[r.cls].label : 'ya existente'}) en la cuenta ${r.user}`);
  const c = connect(s, { kind: 'pause' });
  const what = r.cls ? 'el bot lo crea al entrar y lo deja en pausa' : 'entra con el personaje que ya tenés y queda en pausa';
  return { ok: c.ok, msg: c.ok ? `${r.existing ? 'Guardado' : 'Cuenta creada'}. Conectando a ${r.char}: ${what}.` : c.msg };
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
      key: s.cfg.key, char: s.cfg.char, user: s.cfg.user, account: s.cfg.status, cls: s.cfg.cls ?? null, lastRoutine: s.cfg.lastRoutine, status: s.status, msg: s.msg, pid: s.pid, port: s.wsPort ?? s.port,
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

// Equipo: pedidos de ayuda vigentes (uno por personaje y tipo, vencen a los 2 min).
const teamRequests = new Map<string, TeamRequest>();
function team() {
  const now = Date.now();
  for (const [k, r] of teamRequests) if (now - r.at > TEAM_REQUEST_TTL_MS) teamRequests.delete(k);
  const members = [...slots.values()].filter((s) => s.state && s.pid != null).map((s) => ({
    char: s.cfg.char, level: s.state!.char.level, map: s.state!.where.map, x: s.state!.where.x, y: s.state!.where.y, mode: s.state!.mode,
  }));
  return { members, requests: [...teamRequests.values()] };
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
      // Equipo: dónde está cada personaje y los pedidos de ayuda vigentes (los bots lo consultan).
      if (url.pathname === '/api/team') return json(team());
      // Nombres sugeridos para un personaje nuevo (sin repetir los que ya hay en la estación).
      if (url.pathname === '/api/names') return json({ names: coolNames(8, [...slots.values()].map((s) => s.cfg.char)) });
      if (url.pathname === '/api/state') return json({ chars: view(), golds: freshGolds(golds, Date.now()).map((g) => ({ ...g, mapName: mapName(g.map) })) });
      const lm = url.pathname.match(/^\/api\/log\/([a-z0-9_]{1,10})$/);
      if (lm && slots.has(lm[1])) return new Response(tail(join(LOG_DIR, `${lm[1]}.log`), 200), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return new Response('No encontrado.', { status: 404 });
    }
    if (url.pathname === '/api/team' && req.method === 'POST') {
      // Solo los bots (sin Origin): ninguna página del navegador pide ayuda en su nombre.
      if (req.headers.get('origin')) return json({ ok: false, msg: 'origen no permitido' }, 403);
      const body = await req.text();
      if (body.length > 1024) return json({ ok: false }, 413);
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return json({ ok: false }, 400); }
      const r = parseTeamRequest(raw, Date.now());
      if (!r) return json({ ok: false, msg: 'pedido inválido' }, 400);
      teamRequests.set(`${r.from}:${r.kind}`, r);
      say(`${r.from} pide ayuda (${r.kind}): ${r.note}`);
      return json({ ok: true });
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
      if (r.action === 'create' || r.action === 'add') {
        const pass = r.action === 'add' ? db.passOfAccount(r.user) : null;
        if (r.action === 'add' && !pass) return json({ ok: false, msg: `no tengo la cuenta ${r.user} en la base` }, 404);
        const res = await createChar(r.action === 'add' ? { action: 'create', user: r.user, pass: pass!, char: r.char, cls: r.cls, existing: true } : r);
        return json(res, res.ok ? 200 : 409);
      }
      const s = slots.get(r.char);
      if (!s) return json({ ok: false, msg: `no conozco a ${r.char}` }, 404);
      const res = r.action === 'connect' ? connect(s, r.routine) : r.action === 'disconnect' ? disconnect(s) : await routine(s, r.routine);
      return json(res, res.ok ? 200 : 409);
    }
    return new Response('No.', { status: 405 });
  },
});
say(`http://127.0.0.1:${PORT}  (personajes: ${[...slots.values()].map((s) => s.cfg.char).join(', ') || 'ninguno: falta un .env con MUBOT_USER/PASS/CHAR'})`);
