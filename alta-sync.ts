/**
 * Altas que llegan por el worker (workers/edge): cada minuto la estación pide los pendientes, los descifra con su clave
 * privada (~/.mubot/alta/private.jwk, que nunca sale del equipo), agrega la cuenta a su base y le pide al worker que los borre.
 * Sin MUBOT_ALTA_URL (en .env.alta) o sin las claves de ~/.mubot/alta/ no hace nada.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validCharName } from './util';

export const ALTA_DIR = join(homedir(), '.mubot', 'alta');
const POLL_MS = 60_000;
const USER_RE = /^[A-Za-z0-9_]{1,10}$/;
const MAX_PASS = 64;

type Pending = { id: string; ct: string };
export type AltaDeps = {
  url: string;
  /** devuelve el motivo si no se pudo (ver EstacionDb.addChar) */
  addChar: (user: string, pass: string, char: string) => string | null;
  onAdded: () => void;
  say: (...a: unknown[]) => void;
};

const read = (name: string) => { try { return readFileSync(join(ALTA_DIR, name), 'utf8').trim(); } catch { return ''; } };

/** https, salvo el worker local de `wrangler dev`. */
export function validAltaUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u : null;
  } catch { return null; }
}

async function decrypt(ct: string, privateJwk: string): Promise<{ user: string; pass: string; char: string } | null> {
  try {
    const key = await crypto.subtle.importKey('jwk', JSON.parse(privateJwk), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, Buffer.from(ct, 'base64'));
    const { u, p, c } = JSON.parse(new TextDecoder().decode(plain)) as { u?: unknown; p?: unknown; c?: unknown };
    if (typeof u !== 'string' || typeof p !== 'string' || typeof c !== 'string') return null;
    if (!USER_RE.test(u) || !validCharName(c) || p.length < 1 || p.length > MAX_PASS) return null;
    return { user: u, pass: p, char: c };
  } catch { return null; }
}

async function pollOnce(base: URL, d: AltaDeps) {
  const token = read('station-token');
  const priv = read('private.jwk');
  if (!token || !priv) return;
  const headers = { authorization: `Bearer ${token}` };
  const res = await fetch(new URL('/api/pendientes', base), { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) { d.say(`alta: el worker contestó ${res.status}`); return; }
  const items = (await res.json()) as Pending[];
  let added = false;
  for (const it of items) {
    if (typeof it?.id !== 'string' || typeof it?.ct !== 'string') continue;
    const data = await decrypt(it.ct, priv);
    if (!data) d.say(`alta: pendiente ${it.id} ilegible o inválido: se descarta`);
    else {
      const why = d.addChar(data.user, data.pass, data.char);
      // Nunca se loguea la clave. Con o sin error el pendiente se borra: reintentarlo no lo arregla.
      if (why) d.say(`alta de ${data.char}: ${why}`); else { d.say(`alta: ${data.char} (cuenta ${data.user}) agregada`); added = true; }
    }
    await fetch(new URL(`/api/pendientes/${encodeURIComponent(it.id)}`, base), { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) }).catch(() => {});
  }
  if (added) d.onAdded();
}

/** Crea la cuenta en el servidor a través del worker (que es quien habla con él). */
export async function registerAccount(baseUrl: string, a: { user: string; pass: string }): Promise<{ ok: boolean; msg: string }> {
  const base = validAltaUrl(baseUrl);
  if (!base) return { ok: false, msg: 'MUBOT_ALTA_URL no es una URL https válida' };
  const token = read('form-token');
  if (!token) return { ok: false, msg: 'faltan las claves del worker (bun run alta:keys)' };
  try {
    const r = await fetch(new URL('/api/register', base), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: a.user, password: a.pass }), signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
    if (r.ok && j.ok) return { ok: true, msg: 'Cuenta creada en el juego.' };
    const why = j.code === 'taken' ? 'esa cuenta ya existe (si es tuya, desmarcá "crear la cuenta")'
      : j.code === 'throttled' ? 'el servidor frenó los registros por un rato: probá en unos minutos'
      : j.code === 'limit' ? 'ya se crearon 5 cuentas en la última hora (tope del worker)'
      : (j.error ?? `el worker contestó ${r.status}`);
    return { ok: false, msg: `No se pudo crear la cuenta: ${why}` };
  } catch (e) {
    return { ok: false, msg: `no pude hablar con el worker (${(e as Error).message})` };
  }
}

let pollNow: (() => void) | null = null;
/**
 * Consultar al worker ya (después de mandar un alta desde el panel), sin esperar al próximo minuto. La lista de pendientes del
 * worker (KV) tarda un rato en mostrar lo recién escrito, así que se reintenta unas veces.
 */
export const pollAltaNow = () => {
  pollNow?.();
  for (const ms of [8_000, 20_000, 40_000]) setTimeout(() => pollNow?.(), ms);
};

export type AltaInput = { user: string; pass: string; char: string };
/** Valida un alta; devuelve el motivo si no sirve. */
export function altaProblem(a: AltaInput): string | null {
  if (!USER_RE.test(a.user)) return 'usuario inválido (letras, números o _, hasta 10)';
  if (!validCharName(a.char)) return 'nombre de personaje inválido';
  if (a.pass.length < 1 || a.pass.length > MAX_PASS) return `la clave debe tener entre 1 y ${MAX_PASS} caracteres`;
  return null;
}

/** Cifra el alta con la clave pública del worker y la deja en su cola. La clave nunca viaja ni se guarda en claro allá. */
export async function submitAlta(baseUrl: string, a: AltaInput): Promise<{ ok: boolean; msg: string }> {
  const base = validAltaUrl(baseUrl);
  if (!base) return { ok: false, msg: 'MUBOT_ALTA_URL no es una URL https válida' };
  const token = read('form-token');
  if (!token) return { ok: false, msg: 'faltan las claves del worker (bun run alta:keys)' };
  const bad = altaProblem(a);
  if (bad) return { ok: false, msg: bad };
  try {
    const jwk = await (await fetch(new URL('/api/pubkey', base), { signal: AbortSignal.timeout(15_000) })).json();
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const ct = Buffer.from(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(JSON.stringify({ u: a.user, p: a.pass, c: a.char })))).toString('base64');
    const r = await fetch(new URL('/api/alta', base), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ct }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { ok: false, msg: `el worker contestó ${r.status}` };
    pollAltaNow();
    return { ok: true, msg: 'Enviada: la estación la suma en unos segundos.' };
  } catch (e) {
    return { ok: false, msg: `no pude hablar con el worker (${(e as Error).message})` };
  }
}

export function startAltaSync(d: AltaDeps) {
  const base = validAltaUrl(d.url);
  if (!base) { d.say('alta: MUBOT_ALTA_URL no es una URL https válida; el sincronizador no arranca'); return; }
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    pollOnce(base, d).catch((e) => d.say(`alta: no pude consultar el worker (${(e as Error).message})`)).finally(() => { busy = false; });
  };
  pollNow = tick;
  setInterval(tick, POLL_MS);
  setTimeout(tick, 5_000);
}
