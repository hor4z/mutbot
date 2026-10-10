/**
 * Sirve browser-agent.js y tuner.js en 127.0.0.1 para (re)instalarlos en la pestaña
 * del juego con un fetch, sin pegar el código entero cada vez.
 *   bun run scripts/serve-agent.ts      (puerto 8788)
 * En la consola del juego:
 *   eval(await (await fetch('http://127.0.0.1:8788/browser-agent.js')).text())
 * Solo escucha en loopback.
 *
 * Dorados de la invasión (buscadores → cazador):
 *   POST /gold  { from, map, x, y, name, id, at } o { from, map, id, gone: true }
 *               lo manda un buscador sin navegador (headless-bot.ts --scout). Se rechaza todo POST
 *               que traiga Origin: una página web no puede inventar avistamientos.
 *   GET  /gold  avistamientos vivos de los últimos 60 s (el cazador de Horaz lo lee cada 2 s).
 */
const ROOT = new URL('..', import.meta.url).pathname;
const FILES = new Set(['browser-agent.js', 'tuner.js', 'skill-ab.js', 'duo.js', 'bg-timers.js', 'hunter.js']);
const CORS = {
  'Access-Control-Allow-Origin': 'https://mu.mormon.garden',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET',
  'Cache-Control': 'no-store',
};
type Sighting = { from: string; map: number; x: number; y: number; name: string; id: number; at: number };
const golds = new Map<string, Sighting>();
const fresh = () => { const now = Date.now(); for (const [k, g] of golds) if (now - g.at > 60_000) golds.delete(k); return [...golds.values()]; };
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 8788),
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const name = new URL(req.url).pathname.slice(1);
    if (name === 'gold') {
      if (req.method === 'POST') {
        if (req.headers.get('origin')) return new Response('no', { status: 403 });
        let g: any; try { g = await req.json(); } catch { return new Response('json', { status: 400 }); }
        const from = String(g?.from ?? '').slice(0, 20);
        if (!from || !num(g.map, 0, 255) || !num(g.id, 0, 65535)) return new Response('datos', { status: 400 });
        const key = `${from}:${g.id}`;
        if (g.gone) golds.delete(key);
        else if (num(g.x, 0, 255) && num(g.y, 0, 255)) golds.set(key, { from, map: g.map, x: g.x, y: g.y, name: String(g.name ?? '').slice(0, 40), id: g.id, at: Date.now() });
        else return new Response('datos', { status: 400 });
        return new Response('ok');
      }
      return new Response(JSON.stringify(fresh()), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!FILES.has(name)) return new Response('no', { status: 404, headers: CORS });
    return new Response(Bun.file(ROOT + name), { headers: { ...CORS, 'Content-Type': 'text/javascript' } });
  },
});
console.log('sirviendo el agente en http://127.0.0.1:8788');
