/**
 * Borde de la estación: alta de cuentas y proxy WebSocket hacia el servidor del juego.
 *
 * Proxy: el bot se conecta a `wss://<worker>/p/<PROXY_TOKEN>/ws?host=H&port=P` y el worker abre la conexión con el servidor
 * (`UPSTREAM_HOST`, el mismo `/ws` que usa el cliente web) y devuelve su respuesta: los frames pasan por Cloudflare sin gastar CPU del worker. Solo reenvía a los hosts de
 * `ALLOWED_HOSTS`: no es un relay abierto. El token va en la ruta porque el cliente del bot arma la URL con `?host=&port=`.
 *
 * Registro: `POST /api/register` crea la cuenta en el servidor (el mismo `/api/register` del cliente web). Es la única ruta
 * donde el worker ve la clave en claro (la reenvía por TLS al servidor y no la guarda ni la loguea). Con tope por hora.
 *
 * Alta de cuentas para la estación. El formulario cifra usuario, personaje y clave en el navegador con la clave pública
 * (RSA-OAEP); el worker solo guarda texto cifrado, que no puede leer. La estación (en el equipo del usuario) consulta
 * cada tanto, descifra con su clave privada, agrega la cuenta a su base y le pide al worker que la borre.
 *
 *   GET    /                      formulario (hace falta ALTA_TOKEN para enviarlo)
 *   GET    /api/pubkey            clave pública (JWK)
 *   POST   /api/register          { username, password } → crea la cuenta en el servidor   [Bearer ALTA_TOKEN]
 *   POST   /api/alta              { ct } → guarda pendiente        [Bearer ALTA_TOKEN]
 *   GET    /api/pendientes        [{ id, ct }]                      [Bearer STATION_TOKEN]
 *   DELETE /api/pendientes/:id    borra uno                         [Bearer STATION_TOKEN]
 */

export interface Env {
  ALTAS: KVNamespace;
  /** clave pública RSA-OAEP en JWK (JSON). Pública: se puede ver. */
  PUBLIC_KEY: string;
  ALTA_TOKEN: string;
  STATION_TOKEN: string;
  PROXY_TOKEN: string;
  /** host del servidor cuyo `/ws` (WebSocket → TCP) usa el cliente web */
  UPSTREAM_HOST: string;
  /** Servidor Slow: el host `clasico` (su connect/game server interno) sale por este WebSocket. */
  SLOW_UPSTREAM_HOST?: string;
  /** destinos (`host=`) que el proxy acepta, separados por coma */
  ALLOWED_HOSTS: string;
}

const REGISTER_PER_HOUR = 5;
const REGISTER_KEY = 'r:count';
const NAME_RE = /^[A-Za-z0-9_]{1,10}$/;
const PENDING_PREFIX = 'p:';
const PENDING_TTL_S = 7 * 24 * 3600;
const MAX_PENDING = 50;
/** RSA-2048 → 256 bytes → 344 caracteres en base64 (con relleno). */
const CT_RE = /^[A-Za-z0-9+/]{342}==$|^[A-Za-z0-9+/]{343}=$|^[A-Za-z0-9+/]{344}$/;
const ID_RE = /^p:\d{13}:[0-9a-f-]{36}$/;

const enc = new TextEncoder();

/** Comparación sin filtrar por tiempo: se comparan los hashes, que tienen siempre el mismo largo. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const bearer = (req: Request) => /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json' } });

function page(nonce: string): Response {
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
  return new Response(FORM_HTML.replaceAll('__NONCE__', nonce), {
    headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp },
  });
}

async function proxyWs(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'se espera un WebSocket' }, 426);
  const host = (url.searchParams.get('host') ?? '').toLowerCase();
  const port = Number(url.searchParams.get('port'));
  const allowed = (env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) return json({ error: 'destino no permitido' }, 403);
  // Se devuelve la respuesta del servidor tal cual: Cloudflare pasa los frames del WebSocket sin volver a ejecutar el worker, así que los
  // mensajes no gastan CPU. (Reenviarlos a mano con un WebSocketPair agotaba los 10 ms de CPU del plan gratuito a los ~20 s de juego.)
  const target = new URL(`https://${host === 'clasico' && env.SLOW_UPSTREAM_HOST ? env.SLOW_UPSTREAM_HOST : env.UPSTREAM_HOST}/ws`);
  target.searchParams.set('host', host);
  target.searchParams.set('port', String(port));
  return fetch(new Request(target, req));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    const px = /^\/p\/([^/]+)\/ws$/.exec(path);
    if (px) {
      let given = '';
      try { given = decodeURIComponent(px[1]); } catch { /* token mal formado: no coincide */ }
      if (!(await sameSecret(given, env.PROXY_TOKEN))) return json({ error: 'no autorizado' }, 401);
      return proxyWs(req, env, url);
    }

    if (req.method === 'GET' && path === '/') return page(crypto.randomUUID().replaceAll('-', ''));
    if (req.method === 'GET' && path === '/api/pubkey') {
      try { return json(JSON.parse(env.PUBLIC_KEY)); } catch { return json({ error: 'sin clave pública configurada' }, 503); }
    }

    if (req.method === 'POST' && path === '/api/register') {
      if (!(await sameSecret(bearer(req), env.ALTA_TOKEN))) return json({ error: 'no autorizado' }, 401);
      const text = await req.text();
      if (text.length > 512) return json({ error: 'pedido demasiado grande' }, 413);
      let b: { username?: unknown; password?: unknown };
      try { b = JSON.parse(text); } catch { return json({ error: 'no es JSON' }, 400); }
      if (typeof b.username !== 'string' || !NAME_RE.test(b.username)) return json({ error: 'usuario inválido' }, 400);
      if (typeof b.password !== 'string' || b.password.length < 1 || b.password.length > 64) return json({ error: 'clave inválida' }, 400);
      const used = Number((await env.ALTAS.get(REGISTER_KEY)) ?? 0);
      if (used >= REGISTER_PER_HOUR) return json({ error: 'demasiados registros por hora', code: 'limit' }, 429);
      await env.ALTAS.put(REGISTER_KEY, String(used + 1), { expirationTtl: 3600 });
      const res = await fetch(`https://${env.UPSTREAM_HOST}/api/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: b.username, password: b.password }),
      });
      const j = (await res.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
      if (res.ok) return json({ ok: true });
      return json({ ok: false, code: typeof j.code === 'string' ? j.code.slice(0, 30) : null, error: typeof j.error === 'string' ? j.error.slice(0, 120) : `HTTP ${res.status}` }, 409);
    }

    if (req.method === 'POST' && path === '/api/alta') {
      if (!(await sameSecret(bearer(req), env.ALTA_TOKEN))) return json({ error: 'no autorizado' }, 401);
      const text = await req.text();
      if (text.length > 1024) return json({ error: 'pedido demasiado grande' }, 413);
      let ct: unknown;
      try { ct = (JSON.parse(text) as { ct?: unknown }).ct; } catch { return json({ error: 'no es JSON' }, 400); }
      if (typeof ct !== 'string' || !CT_RE.test(ct)) return json({ error: 'dato cifrado inválido' }, 400);
      const { keys } = await env.ALTAS.list({ prefix: PENDING_PREFIX, limit: MAX_PENDING + 1 });
      if (keys.length >= MAX_PENDING) return json({ error: 'hay demasiados pendientes: esperá a que la estación los tome' }, 429);
      await env.ALTAS.put(`${PENDING_PREFIX}${Date.now()}:${crypto.randomUUID()}`, ct, { expirationTtl: PENDING_TTL_S });
      return json({ ok: true }, 201);
    }

    if (path === '/api/pendientes' || path.startsWith('/api/pendientes/')) {
      if (!(await sameSecret(bearer(req), env.STATION_TOKEN))) return json({ error: 'no autorizado' }, 401);
      if (req.method === 'GET' && path === '/api/pendientes') {
        const { keys } = await env.ALTAS.list({ prefix: PENDING_PREFIX, limit: 20 });
        const items = await Promise.all(keys.map(async (k) => ({ id: k.name, ct: await env.ALTAS.get(k.name) })));
        return json(items.filter((i) => i.ct != null));
      }
      if (req.method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/pendientes/'.length));
        if (!ID_RE.test(id)) return json({ error: 'id inválido' }, 400);
        await env.ALTAS.delete(id);
        return json({ ok: true });
      }
    }

    return json({ error: 'no encontrado' }, 404);
  },
} satisfies ExportedHandler<Env>;

const FORM_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alta de cuenta</title>
<style nonce="__NONCE__">
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--bd:#ccc;--ok:#127a3a;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#9a9a9a;--bd:#444;--ok:#5fd38a;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:420px;margin:0 auto;padding:24px 16px}
label{display:block;margin:14px 0 4px;color:var(--mut);font-size:14px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--bd);border-radius:6px;background:transparent;color:inherit;font:inherit}
button{margin-top:18px;padding:10px 16px;border:0;border-radius:6px;background:var(--fg);color:var(--bg);font:inherit;cursor:pointer}
button:disabled{opacity:.5}
#msg{margin-top:14px;min-height:1.4em}.ok{color:var(--ok)}.bad{color:var(--bad)}
small{color:var(--mut)}
</style></head><body><main>
<h1>Alta de cuenta</h1>
<p><small>La cuenta ya tiene que existir en el juego. Los datos se cifran en este navegador; este sitio no puede leerlos.</small></p>
<form id="f" autocomplete="off">
<label for="t">Clave de acceso</label><input id="t" type="password" required autocomplete="off">
<label for="u">Usuario de la cuenta</label><input id="u" required maxlength="10" pattern="[A-Za-z0-9_]{1,10}" autocomplete="off">
<label for="c">Nombre del personaje</label><input id="c" required maxlength="10" pattern="[A-Za-z0-9_]{1,10}" autocomplete="off">
<label for="p">Contraseña de la cuenta</label><input id="p" type="password" required maxlength="64" autocomplete="new-password">
<button id="b" type="submit">Enviar</button>
</form><div id="msg" role="status"></div>
<script nonce="__NONCE__">
const $=(i)=>document.getElementById(i), msg=(t,k)=>{$('msg').textContent=t;$('msg').className=k||''};
const b64=(buf)=>btoa(String.fromCharCode(...new Uint8Array(buf)));
$('f').addEventListener('submit',async(e)=>{
  e.preventDefault();$('b').disabled=true;msg('Cifrando…');
  try{
    const jwk=await (await fetch('/api/pubkey')).json();
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    const data=new TextEncoder().encode(JSON.stringify({u:$('u').value,p:$('p').value,c:$('c').value}));
    const ct=b64(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,data));
    const r=await fetch('/api/alta',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+$('t').value},body:JSON.stringify({ct})});
    const j=await r.json().catch(()=>({}));
    if(r.ok){msg('Enviado. La estación la toma en un minuto.','ok');$('p').value='';$('u').value='';$('c').value=''}
    else msg(j.error||('Error '+r.status),'bad');
  }catch(err){msg('No se pudo enviar: '+err.message,'bad')}
  finally{$('b').disabled=false}
});
</script></main></body></html>`;
