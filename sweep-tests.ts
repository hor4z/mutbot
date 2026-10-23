/**
 * Tests offline de sweep.ts (rastrillaje por visión) y de smoothPath, contra el terreno REAL de Lorencia,
 * Devias y Noria (los .att del server en ~/.mubot/terrain; si no están, esa parte se salta). Reloj
 * simulado: 380 ms por paso. Mide, contra el recorrido viejo en celdas de 25 (HuntExplorer): % del área
 * caminable VISTA (casillas a <= R del bot), pasos hasta el 90 % / 95 %, casillas pisadas y pasos parado.
 *
 *   bun run sweep-tests.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findPath, smoothPath, straightLine } from './path';
import { HuntExplorer } from './panel-logic';
import { SWEEP, SweepPlanner, scopeRadius, zonePrior } from './sweep';
import { TW, parseAtt } from './terrain';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// --- Lógica sin terreno real -------------------------------------------------------------------------
{
  ok('radio: sin datos 9; observado 11 → 11; 30 → tope 12; 5 → 9', scopeRadius(0) === 9 && scopeRadius(11) === 11 && scopeRadius(30) === 12 && scopeRadius(5) === 9);
  const open = () => true;
  const line = straightLine(open, { x: 0, y: 0 }, { x: 10, y: 4 })!;
  ok('recta: extremos y pasos de a una casilla', line.length === 11 && line.every((p, i) => i === 0 || Math.max(Math.abs(p.x - line[i - 1].x), Math.abs(p.y - line[i - 1].y)) === 1));
  const wall = (x: number, y: number) => !(x === 5 && y >= 0 && y <= 20);
  ok('recta: una pared la corta', straightLine(wall, { x: 0, y: 5 }, { x: 10, y: 5 }) === null);
  const zig = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 }, { x: 6, y: 2 }];
  const sm = smoothPath(open, zig);
  ok('suavizado: mismos extremos y no más largo', sm[0].x === 0 && sm[sm.length - 1].x === 6 && sm[sm.length - 1].y === 2 && sm.length <= zig.length, sm);
  const sq = (x: number, y: number) => x >= 0 && y >= 0 && x < 60 && y < 60;
  const pl = new SweepPlanner(sq, () => false, { x: 5, y: 5 });
  ok('planner: área = 60×60', pl.areaCount === 3600 && pl.wps.length > 4);
  let g = pl.next(5, 5, 0);
  const first = { ...g };
  ok('planner: elige el siguiente antes de llegar (after)', pl.after != null && pl.goal != null);
  for (let i = 0; i < 400 && pl.passes === 0; i++) {
    const dx = Math.sign(g.x - (5 + 0)); void dx;
    break;
  }
  ok('planner: objetivo en el interior (>= 2 de la pared)', first.x >= 2 && first.y >= 2 && first.x <= 57 && first.y <= 57, first);
  const pri = zonePrior([{ x: 50, y: 50, n: 10 }]);
  ok('previo: más alto cerca de la zona, 1 sin zonas', pri(50, 50) > pri(5, 5) && zonePrior([])(1, 1) === 1);
}

// --- Terreno real ------------------------------------------------------------------------------------
const R = SWEEP.defaultR;
const MS = 380;
const BUDGET = 6000; // pasos (~38 min)

function load(world: number): Uint8Array | null {
  const f = join(homedir(), '.mubot', 'terrain', `World${world}`, `EncTerrain${world}.att`);
  return existsSync(f) ? parseAtt(new Uint8Array(readFileSync(f))) : null;
}

type Res = { cov: number; s90: number | null; s95: number | null; stepped: number; stalls: number; steps: number; len: number };

function simulate(grid: Uint8Array, method: 'old' | 'terr' | 'new', smooth: boolean): Res {
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < 256 && y < 256 && (grid[y * 256 + x] & (TW.NoMove | TW.NoGround)) === 0;
  const safe = (x: number, y: number) => (grid[y * 256 + x] & TW.SafeZone) !== 0;
  // Salida: la casilla caminable, no segura, más cercana al centro.
  let start = { x: 128, y: 128 };
  outer: for (let r = 0; r < 128; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    const x = 128 + dx, y = 128 + dy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) === r && walk(x, y) && !safe(x, y)) { start = { x, y }; break outer; }
  }
  const meter = new SweepPlanner(walk, safe, start, R); // solo para medir lo visto (mismo R, mismo área)
  const planner = method === 'new' ? new SweepPlanner(walk, safe, start, R) : null;
  const old = method !== 'new' ? new HuntExplorer() : null;
  if (method === 'terr') old!.useTerrain(0, walk, (x, y) => walk(x, y) && !safe(x, y), start);
  let me = { ...start };
  const stepped = new Set<number>();
  let stalls = 0, s90: number | null = null, s95: number | null = null, len = 0;
  for (let t = 0; t < BUDGET; t++) {
    const now = t * MS;
    const goal = planner ? planner.next(me.x, me.y, now) : old!.next(me.x, me.y, now);
    let path = findPath(walk, me, goal, 6000);
    if (path && smooth) path = smoothPath(walk, path);
    if (path && path.length > 1) { me = path[1]; len++; stepped.add(me.y * 256 + me.x); } else stalls++;
    meter.see(me.x, me.y);
    if (s90 == null && meter.coverage >= 0.9) s90 = t;
    if (s95 == null && meter.coverage >= 0.95) { s95 = t; break; }
  }
  return { cov: meter.coverage, s90, s95, stepped: stepped.size, stalls, steps: len, len };
}

const MAPS: [string, number][] = [['Lorencia', 1], ['Devias', 3], ['Noria', 4]];
for (const [name, world] of MAPS) {
  const grid = load(world);
  if (!grid) { console.log(`SKIP  ${name}: sin ${join('~/.mubot/terrain', `World${world}`)}`); continue; }
  const t0 = Date.now();
  const o = simulate(grid, 'old', false);
  const o2 = simulate(grid, 'terr', false);
  const n = simulate(grid, 'new', true);
  const f = (r: Res) => `vista ${(r.cov * 100).toFixed(1)}%  90%@${r.s90 ?? '-'}  95%@${r.s95 ?? '-'}  pisadas ${r.stepped}  pasos ${r.steps}  parado ${r.stalls}`;
  console.log(`      ${name}: viejo  ${f(o)}\n      ${name}: celdas+terreno  ${f(o2)}\n      ${name}: nuevo  ${f(n)}  (${Date.now() - t0} ms)`);
  ok(`${name}: ve al menos tanto área como el método viejo`, n.cov >= o.cov - 0.001, { o: o.cov, n: n.cov });
  ok(`${name}: llega a 95 % visto en el presupuesto`, n.s95 != null, n.cov);
  ok(`${name}: menos pasos que el viejo para el 90 %`, n.s90 != null && (o.s90 == null || n.s90 <= o.s90), { o: o.s90, n: n.s90 });
  ok(`${name}: más área vista por casilla pisada`, n.cov / n.stepped > o.cov / o.stepped, { o: o.cov / o.stepped, n: n.cov / n.stepped });
  ok(`${name}: casi cero paradas`, n.stalls <= 5, n.stalls);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE RASTRILLAJE PASARON' : `\n${fails} TEST(S) DE RASTRILLAJE FALLARON`);
process.exit(fails ? 1 : 0);
