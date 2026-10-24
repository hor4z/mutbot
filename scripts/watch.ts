/**
 * Monitor de la flota: cada 5 s lee la estación y muestra dónde está cada bot, qué hace y cuánta exp rinde.
 * Marca ⚠ cuando un bot no avanza (misma zona y casi sin exp) durante 45 s o cuando se aleja de su compañero
 * en una ayuda. Solo lectura. Uso: `bun run scripts/watch.ts` (STATION=http://127.0.0.1:8787, EVERY=5).
 */
const STATION = process.env.STATION ?? 'http://127.0.0.1:8787';
const EVERY = Number(process.env.EVERY ?? 5) * 1000;
type Pt = { t: number; map: string; x: number; y: number; exp: number };
const hist = new Map<string, Pt[]>();
const warned = new Map<string, number>();
const hh = () => new Date().toTimeString().slice(0, 8);

async function tick() {
  let d: { chars: any[] };
  try { d = (await (await fetch(`${STATION}/api/state`, { signal: AbortSignal.timeout(3000) })).json()) as { chars: any[] }; }
  catch { console.log(`${hh()} la estación no contesta`); return; }
  const on = d.chars.filter((c) => c.game && c.status === 'on');
  const parts: string[] = [];
  for (const c of on) {
    const g = c.game;
    const p: Pt = { t: Date.now(), map: g.map, x: g.x, y: g.y, exp: g.session?.exp ?? 0 };
    const h = hist.get(c.char) ?? [];
    h.push(p);
    while (h.length && p.t - h[0].t > 60_000) h.shift();
    hist.set(c.char, h);
    const first = h[0];
    const moved = Math.max(Math.abs(p.x - first.x), Math.abs(p.y - first.y));
    const gained = p.exp - first.exp;
    const span = p.t - first.t;
    let flag = '';
    if (span >= 45_000 && p.map === first.map && moved <= 3 && gained <= 0 && !/espero|pausa|conect/.test(g.doing)) flag = ' ⚠SIN-AVANCE';
    if (flag && p.t - (warned.get(c.char) ?? 0) > 60_000) { warned.set(c.char, p.t); console.log(`${hh()} ⚠ ${c.char} sin avanzar ${Math.round(span / 1000)} s en ${p.map} (${p.x},${p.y}): ${g.doing}`); }
    const hp = g.hp?.[1] ? Math.round((100 * g.hp[0]) / g.hp[1]) : 0;
    parts.push(`${c.char} L${g.level} ${p.map}(${p.x},${p.y}) hp${hp}% ${Math.round((g.expPerMin ?? 0) / 1e6)}M/min "${g.doing}"${flag}`);
  }
  const a = on.map((c) => c.game);
  if (on.length === 2 && a[0].map === a[1].map) parts.push(`dist=${Math.max(Math.abs(a[0].x - a[1].x), Math.abs(a[0].y - a[1].y))}`);
  console.log(`${hh()} ${parts.join(' | ') || '(ningún bot en el juego)'}`);
}
setInterval(() => void tick(), EVERY);
void tick();
