/**
 * Estación: conecta y desconecta al personaje Slow sin navegador, lo mantiene vivo y sirve el panel.
 *
 *   bun run estacion            → http://127.0.0.1:8787
 *
 * - Un solo personaje: tabla `character` de la base ({ user, pass, char }). La clave le llega al bot por MUBOT_PASS, nunca por argumentos.
 * - Nada vive en archivos locales: el personaje, los ajustes (token del worker, URL, "lo quiero conectado") y las directivas están en la base
 *   (`bun run db:migrate`, `db:seed`, `db:importar`). Solo quedan los logs y las credenciales de la base (`.env.db`).
 * - El bot (`src/main.ts`) corre en su propia sesión (`detached`) y escribe en ~/.mubot/logs/<personaje>.log: cerrar o reiniciar la
 *   estación NO lo desconecta. Al arrancar, la estación adopta el que ya corre (lo busca con `ps` y lee su --ws-port).
 * - Nunca dos sesiones de la cuenta: el bot va con `--exit-if-in-use` (si la cuenta está abierta en el navegador, sale con código 3).
 * - Desconectar desde el panel = el usuario va a jugar a mano: no se reconecta solo (`~/.mubot/estado.json`).
 * - Solo 127.0.0.1. Las órdenes (POST /api/do) exigen el Origin de la propia estación y JSON.
 * - Conexión siempre por el worker (workers/edge): URL y token en la tabla `settings` de la base (`worker_url`, `proxy_token`).
 */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { D, ESQUEMA, guardarDirectivas, iniciarDirectivas, leerDirectivas, validar } from '../core/directivas';
import { dbOn, readCharacter, readSettings, writeSetting, type CharacterRow } from '@mubot/db';
import {
  BOT_PORT, NO_RETRY_CODES, RECENT_STOP_MS, botArgs, exitStatus, parseStationRequest,
  type BotStatus,
} from './estacion-logic';
import type { PanelServerMessage, PanelState } from '@mubot/protocol';
import { terrainOf } from '../core/terrain';
import { originAllowed } from '../core/ws-server';

/** `apps/bot`: desde ahí se lanza el bot (cwd) y se encuentra el panel compilado (`apps/panel/dist`). */
const ROOT = join(import.meta.dir, '..', '..');
const BOT_MAIN = join('src', 'main.ts');
const PANEL_HTML = join(ROOT, '..', 'panel', 'dist', 'estacion.html');
const PORT = Number(process.env.ESTACION_PORT ?? 8787);
const DIR = join(homedir(), '.mubot');
const LOG_DIR = join(DIR, 'logs');
const LOG_ROTATE_BYTES = 50 * 1024 * 1024;
const RECONNECT_GAP_MS = 5_000;
const FROZEN_RESTART_MS = 10 * 60_000;
const say = (...a: unknown[]) => console.log('[estación]', ...a);

// --- Personaje y proxy (de la base) -------------------------------------------------------------------------------------------------------
// Se leen al arrancar y se refrescan cada 15 s y antes de conectar: un cambio en la base se toma sin reiniciar la estación.
let personaje = null as CharacterRow | null;
let settings = {} as Record<string, string>;
let dbOk = false as boolean;
let configLoaded = false;
async function refreshConfig() {
  if (!dbOn()) { dbOk = false; return; }
  try {
    // Las dos lecturas juntas: si una falla no queda la configuración a medias (personaje nuevo con ajustes viejos).
    const [p, s] = await Promise.all([readCharacter(), readSettings()]);
    personaje = p;
    settings = s;
    dbOk = true;
    // "Lo quiero conectado" se toma de la base la primera vez que se lee (aunque la base haya tardado en responder al arrancar); después manda
    // lo que se decide acá y se guarda con setWanted. Si una escritura quedó pendiente, se reintenta.
    if (!configLoaded) { configLoaded = true; wanted = s.wanted === '1'; }
    else if (wantedDirty) setWanted(wanted);
  } catch (e) {
    if (dbOk) say(`no pude leer la configuración de la base (${(e as Error).message}); sigo con la última que tengo.`);
    dbOk = false;
  }
}
/** El proxy del worker (URL y token de la tabla `settings`). */
function proxyUrl(): string | null {
  const token = settings.proxy_token?.trim();
  const url = settings.worker_url?.trim();
  if (!token || !url) return null;
  try { const u = new URL(url); return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/p/${token}/ws`; } catch { return null; }
}

/** Las credenciales de la base que se le pasan al bot (telemetry.ts, db.ts). */
function dbEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('MUBOT_DB_') && v != null) out[k] = v;
  return out;
}

// --- Estado del bot ---------------------------------------------------------------------------------------------------
type Bot = {
  pid: number | null;
  status: BotStatus;
  msg: string;
  state: PanelState | null;
  ws: WebSocket | null;
  nextId: number;
  waiting: Map<number, (r: { ok: boolean; msg: string }) => void>;
  stoppedAt: number;
  exitCode: number | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
};
const bot: Bot = { pid: null, status: 'off', msg: 'desconectado', state: null, ws: null, nextId: 1, waiting: new Map(), stoppedAt: 0, exitCode: null, connectTimer: null };

// `wanted`: el usuario lo quiere conectado (ajuste `wanted` de la base). Un desconectado a mano deja de ser deseado.
let wanted = false;
/** La última escritura de `wanted` falló: se reintenta cuando la base vuelva (refreshConfig). */
let wantedDirty = false;
const setWanted = (v: boolean) => {
  wanted = v;
  wantedDirty = true;
  writeSetting('wanted', v ? '1' : '0').then(() => { wantedDirty = false; }).catch((e) => say(`no pude guardar "lo quiero conectado" en la base (${(e as Error).message}); lo reintento.`));
};

// --- Bot que ya corre (el nuestro o lanzado a mano) -------------------------------------------------------------------
function scanProc(): { pid: number; wsPort: number | null } | null {
  if (!personaje) return null;
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,command=']).stdout.toString();
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[2].split(/\s+/).filter(Boolean);
    if (!cmd.some((a) => a.endsWith('main.ts'))) continue;
    const u = cmd.indexOf('--user'), c = cmd.indexOf('--char');
    if (cmd[u + 1] !== personaje.user || (c >= 0 && cmd[c + 1] !== personaje.char)) continue;
    const i = cmd.indexOf('--ws-port');
    return { pid: Number(m[1]), wsPort: i >= 0 ? Number(cmd[i + 1]) : null };
  }
  return null;
}

function syncRunning() {
  const p = scanProc();
  if (p) {
    if (bot.pid !== p.pid) {
      bot.pid = p.pid;
      if (bot.status === 'off' || bot.status === 'failed' || bot.status === 'in-use') {
        bot.status = p.wsPort ? 'on' : 'external';
        bot.msg = p.wsPort ? 'ya estaba corriendo: lo adopté' : 'corre sin --ws-port: no lo puedo ver ni manejar desde acá (solo desconectar)';
      }
    }
    if (p.wsPort && !bot.ws) attachWs(p.wsPort);
  } else if (bot.pid != null && !ownExits.has(bot.pid)) {
    bot.pid = null;
    if (bot.status !== 'in-use' && bot.status !== 'failed') { bot.status = 'off'; bot.msg = 'desconectado'; }
    detachWs();
  }
}

// --- WebSocket con el bot (sin Origin: el bot lo acepta como cliente local) -------------------------------------------
function attachWs(port: number) {
  detachWs();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  bot.ws = ws;
  ws.onmessage = (ev) => {
    let m: PanelServerMessage;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === 'panel-state') {
      bot.state = m.state;
      if (bot.status === 'starting' && m.state.mode !== 'connecting') { bot.status = 'on'; bot.msg = 'en el juego'; }
    } else if (m.type === 'command-result') {
      bot.waiting.get(m.id)?.({ ok: m.ok, msg: m.msg });
      bot.waiting.delete(m.id);
    }
  };
  ws.onclose = () => {
    if (bot.ws !== ws) return;
    bot.ws = null;
    // El bot todavía no levantó el panel (o se reinició): reintento mientras el proceso viva.
    setTimeout(() => { if (bot.pid != null && !bot.ws) attachWs(port); }, 1500);
  };
}
function detachWs() {
  const ws = bot.ws;
  bot.ws = null;
  bot.state = null;
  try { ws?.close(); } catch { /* ya cerrado */ }
}
function sendCommand(command: unknown): Promise<{ ok: boolean; msg: string }> {
  return new Promise((resolve) => {
    if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return resolve({ ok: false, msg: 'sin conexión con el bot' });
    const id = bot.nextId++;
    const t = setTimeout(() => { bot.waiting.delete(id); resolve({ ok: false, msg: 'el bot no contestó' }); }, 5000);
    bot.waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
    bot.ws.send(JSON.stringify({ type: 'command', id, command }));
  });
}

// --- Conectar / desconectar -------------------------------------------------------------------------------------------
const ownExits = new Set<number>();

function connect(): { ok: boolean; msg: string } {
  syncRunning();
  if (!personaje) return { ok: false, msg: dbOk ? 'Falta el personaje en la tabla `character` de la base (bun run db:importar).' : 'No puedo leer la base: sin ella no hay personaje (revisá .env.db).' };
  const pUrl = proxyUrl();
  if (!pUrl) return { ok: false, msg: 'Falta configurar el worker: sin él el bot no puede conectar (ajustes `worker_url` y `proxy_token` en la base; bun run db:importar).' };
  if (bot.pid != null) return { ok: false, msg: `${personaje.char} ya está corriendo (pid ${bot.pid})` };
  // Recién desconectado: el server todavía tiene la sesión vieja en el mundo y la nueva quedaba "fantasma". Se espera y se conecta solo.
  const waitMs = bot.stoppedAt + RECONNECT_GAP_MS - Date.now();
  if (waitMs > 0) {
    if (bot.connectTimer) clearTimeout(bot.connectTimer);
    bot.status = 'starting';
    bot.msg = `espero ${Math.ceil(waitMs / 1000)} s a que el server suelte la sesión anterior…`;
    bot.connectTimer = setTimeout(() => { bot.connectTimer = null; if (bot.pid == null) connect(); }, waitMs);
    return { ok: true, msg: `conecto en ${Math.ceil(waitMs / 1000)} s (el server suelta la sesión anterior)` };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${personaje.char.toLowerCase()}.log`);
  try { if (statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, `${logPath}.1`); } catch { /* todavía no hay log */ }
  const fd = openSync(logPath, 'a');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && !k.startsWith('MUBOT_')) env[k] = v;
  env.MUBOT_PASS = personaje.pass;
  Object.assign(env, dbEnv());
  const proc = Bun.spawn([process.execPath, ...botArgs(personaje, BOT_PORT, pUrl, BOT_MAIN, Date.now() - bot.stoppedAt > RECENT_STOP_MS)], {
    cwd: ROOT, env, detached: true, stdin: 'ignore', stdout: fd, stderr: fd,
  });
  closeSync(fd);
  bot.pid = proc.pid;
  ownExits.add(proc.pid);
  bot.status = 'starting';
  bot.msg = 'conectando…';
  say(`conecto a ${personaje.char} (pid ${proc.pid}, panel ${BOT_PORT})`);
  void proc.exited.then((code) => {
    ownExits.delete(proc.pid);
    if (bot.pid !== proc.pid) return;
    const st = exitStatus(code);
    bot.exitCode = code;
    bot.pid = null;
    bot.status = st.status;
    bot.msg = st.msg;
    detachWs();
    // Un fallo que no se arregla reintentando saca al personaje de los que se mantienen vivos.
    if ((NO_RETRY_CODES as readonly number[]).includes(code ?? -1)) setWanted(false);
    say(`${personaje!.char} salió (código ${code}): ${st.msg}`);
  });
  setTimeout(() => { if (bot.pid === proc.pid && !bot.ws) attachWs(BOT_PORT); }, 1500);
  return { ok: true, msg: `conectando a ${personaje.char}…` };
}

function disconnect(): { ok: boolean; msg: string } {
  syncRunning();
  if (bot.connectTimer) { clearTimeout(bot.connectTimer); bot.connectTimer = null; }
  if (bot.pid == null) return { ok: true, msg: 'no estaba conectado' };
  try { process.kill(bot.pid, 'SIGTERM'); } catch (e) { return { ok: false, msg: `no pude cortarlo: ${(e as Error).message}` }; }
  bot.stoppedAt = Date.now();
  bot.status = 'stopping';
  bot.msg = 'desconectando…';
  return { ok: true, msg: 'desconectando' };
}

/** "Reintentar ahora": corta el intento en curso (el bot espera cupo) y lanza otro sin el backoff. */
async function retryNow(): Promise<{ ok: boolean; msg: string }> {
  syncRunning();
  if (bot.pid != null && bot.state && bot.state.mode !== 'connecting') return { ok: false, msg: 'ya está en el juego: no hace falta reintentar' };
  if (bot.pid != null) {
    disconnect();
    for (let i = 0; i < 40 && bot.pid != null; i++) await Bun.sleep(250);
    if (bot.pid != null) return { ok: false, msg: 'no pude cortar el intento' };
  }
  bot.stoppedAt = 0; // nunca abrió sesión en el server: no hay sesión vieja que esperar
  setWanted(true);
  retry.n = 0;
  return connect();
}

// --- Que siga vivo (de noche, sin nadie mirando) ----------------------------------------------------------------------
// Si cae, se reconecta con espera creciente (30 s, 1 min, 2 min… hasta 10 min); si lleva 10 min sin sumar exp ni moverse, se reinicia.
// Cuentas bloqueadas, "abierta en otro lado" y fallos de login no se reintentan.
const retry = { at: 0, n: 0, okSince: 0 };
let lastProgress: { sig: string; at: number } | null = null;
function keepAlive() {
  const now = Date.now();
  if (bot.pid != null && bot.status === 'on' && !wanted) setWanted(true);
  if (!wanted) return;
  if (bot.pid == null) {
    lastProgress = null;
    retry.okSince = 0;
    if (bot.status === 'in-use' || bot.connectTimer || (NO_RETRY_CODES as readonly number[]).includes(bot.exitCode ?? -1)) return;
    if (now - retry.at < Math.min(10 * 60_000, 30_000 * 2 ** retry.n)) return;
    retry.at = now;
    retry.n++;
    say(`no está conectado y lo quiero vivo: reconecto (intento ${retry.n})`);
    connect();
    return;
  }
  if (bot.status !== 'on' || !bot.state) return;
  if (!retry.okSince) retry.okSince = now;
  if (now - retry.okSince > 10 * 60_000) retry.n = 0; // sano 10 min seguidos: se perdona el historial de caídas
  if (bot.state.mode === 'paused' || bot.state.mode === 'connecting') { lastProgress = null; return; }
  const sig = `${bot.state.session?.exp ?? 0}|${bot.state.where.map}|${bot.state.where.x}|${bot.state.where.y}`;
  if (!lastProgress || lastProgress.sig !== sig) { lastProgress = { sig, at: now }; return; }
  if (now - lastProgress.at > FROZEN_RESTART_MS) {
    say(`lleva ${FROZEN_RESTART_MS / 60_000} min sin sumar exp ni moverse: lo reinicio`);
    lastProgress = null;
    disconnect();
  }
}
setInterval(keepAlive, 10_000);

// --- HTTP -------------------------------------------------------------------------------------------------------------
// Últimas líneas del log sin leerlo entero (los logs crecen con el bot corriendo días).
function tail(path: string, lines: number, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n').slice(-lines - 1).join('\n');
  } catch { return ''; } finally { if (fd != null) closeSync(fd); }
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Un POST de la propia estación con JSON chico: devuelve el cuerpo o la respuesta de rechazo. */
async function postBody(req: Request, max = 2048): Promise<{ raw: unknown } | { err: Response }> {
  // Una página cualquiera abierta en el navegador podría postear acá: solo la propia estación.
  const origin = req.headers.get('origin');
  if (!origin || !originAllowed(origin, PORT)) return { err: json({ ok: false, msg: 'origen no permitido' }, 403) };
  if (!req.headers.get('content-type')?.startsWith('application/json')) return { err: json({ ok: false, msg: 'solo JSON' }, 415) };
  const body = await req.text();
  if (body.length > max) return { err: json({ ok: false, msg: 'pedido demasiado grande' }, 413) };
  try { return { raw: JSON.parse(body) }; } catch { return { err: json({ ok: false, msg: 'no es JSON' }, 400) }; }
}

await refreshConfig();
setInterval(() => void refreshConfig(), 15_000);
syncRunning();
setInterval(syncRunning, 2000);
iniciarDirectivas((m) => say(m));

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/panel' || url.pathname === '/estacion') {
        const panel = Bun.file(PANEL_HTML);
        if (!(await panel.exists())) return new Response('Falta compilar el panel: corré `bun run panel:build` y recargá.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return new Response(panel, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/api/state') return json({
        char: personaje?.char ?? null, db: dbOk, status: bot.status, msg: bot.msg, pid: bot.pid, wanted, panel: bot.ws?.readyState === WebSocket.OPEN,
        game: bot.state, now: Date.now(),
      });
      if (url.pathname === '/api/directivas') return json({ ok: true, esquema: ESQUEMA, valores: await leerDirectivas().catch(() => ({})), vivos: D });
      if (url.pathname === '/api/log' && personaje) return new Response(tail(join(LOG_DIR, `${personaje.char.toLowerCase()}.log`), 200), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      // Terreno del mapa (EncTerrainN.att descifrado, 256×256 bytes de atributos): paredes y zona segura.
      const tm = url.pathname.match(/^\/terrain\/(\d{1,3})$/);
      if (tm) {
        const grid = terrainOf(Number(tm[1]));
        return grid ? new Response(grid, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=3600' } }) : new Response('Sin terreno para ese mapa.', { status: 404 });
      }
      return new Response('No encontrado.', { status: 404 });
    }
    if (req.method === 'POST' && url.pathname === '/api/directivas') {
      // Perillas que el bot lee en caliente (directivas.ts). Mismas reglas de origen y JSON que /api/do.
      const b = await postBody(req);
      if ('err' in b) return b.err;
      const raw = b.raw as { set?: unknown; unset?: unknown } | null;
      const set = raw?.set && typeof raw.set === 'object' && !Array.isArray(raw.set) ? (raw.set as Record<string, unknown>) : {};
      const unset = Array.isArray(raw?.unset) ? raw.unset.filter((k: unknown): k is string => typeof k === 'string') : [];
      const guardar: Record<string, boolean | number> = {};
      for (const [k, v] of Object.entries(set)) {
        const r = validar(k, v);
        if (!r.ok) return json({ ok: false, msg: `${k}: ${r.why}` }, 400);
        guardar[k] = r.v;
      }
      try { await guardarDirectivas(guardar, unset); } catch (e) { return json({ ok: false, msg: `no pude guardar en la base: ${(e as Error).message}` }, 502); }
      say(`directivas: ${JSON.stringify(set)}${unset.length ? ` sin ${unset.join(', ')}` : ''}`);
      return json({ ok: true, msg: 'guardado en la base: el bot lo toma en unos segundos', valores: await leerDirectivas().catch(() => guardar) });
    }
    if (req.method === 'POST' && url.pathname === '/api/do') {
      const b = await postBody(req);
      if ('err' in b) return b.err;
      const r = parseStationRequest(b.raw);
      if (!r) return json({ ok: false, msg: 'pedido inválido' }, 400);
      if (r.action === 'disconnect') setWanted(false);
      if (r.action === 'order') {
        syncRunning();
        if (bot.pid == null) return json({ ok: false, msg: 'no está conectado' }, 409);
        const res = await sendCommand(r.command);
        say(`orden ${JSON.stringify(r.command)}: ${res.ok ? '' : 'rechazada, '}${res.msg}`);
        return json(res, res.ok ? 200 : 409);
      }
      if (r.action === 'connect' || r.action === 'retry') await refreshConfig();
      const res = r.action === 'connect' ? connect() : r.action === 'disconnect' ? disconnect() : await retryNow();
      // Solo se lo quiere vivo si el pedido prosperó.
      if (r.action === 'connect' && res.ok) { setWanted(true); retry.n = 0; }
      return json(res, res.ok ? 200 : 409);
    }
    return new Response('No.', { status: 405 });
  },
});
say(`http://127.0.0.1:${PORT}  (personaje: ${personaje?.char ?? 'ninguno'}; base: ${dbOk ? 'ok' : 'sin conexión'})`);
