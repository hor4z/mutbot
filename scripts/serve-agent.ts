/**
 * Sirve browser-agent.js y tuner.js en 127.0.0.1 para (re)instalarlos en la pestaña
 * del juego con un fetch, sin pegar el código entero cada vez.
 *   bun run scripts/serve-agent.ts      (puerto 8788)
 * En la consola del juego:
 *   eval(await (await fetch('http://127.0.0.1:8788/browser-agent.js')).text())
 * Solo escucha en loopback.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const FILES = new Set(['browser-agent.js', 'tuner.js', 'skill-ab.js']);
const CORS = {
  'Access-Control-Allow-Origin': 'https://mu.mormon.garden',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET',
  'Cache-Control': 'no-store',
};
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 8788),
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const name = new URL(req.url).pathname.slice(1);
    if (!FILES.has(name)) return new Response('no', { status: 404, headers: CORS });
    return new Response(Bun.file(ROOT + name), { headers: { ...CORS, 'Content-Type': 'text/javascript' } });
  },
});
console.log('sirviendo el agente en http://127.0.0.1:8788');
