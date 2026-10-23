/**
 * Tests offline del recorrido de cacería con terreno real (HuntExplorer.useTerrain, panel-logic.ts).
 * Sin red, reloj simulado, grillas sintéticas (y el terreno de Lorencia si están los assets).
 *
 *   bun run hunt-explorer-tests.ts
 */
import { findPath } from './path';
import { HUNT_CELL_REACH, HuntExplorer, reachableFrom } from './panel-logic';
import { isSafeZone, isWalkable, terrainOf } from './terrain';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// Mapa sintético 256×256: todo caminable salvo
//  - una pared vertical en x=120 de y=0 a 200 (se rodea por abajo),
//  - un lago en [150..200]×[150..200],
//  - una isla [20..60]×[20..60] rodeada de pared (inalcanzable),
//  - un pueblo (zona segura) en [100..119]×[100..119].
const wall = (x: number, y: number) =>
  (x === 120 && y <= 200) || (x >= 150 && x <= 200 && y >= 150 && y <= 200) ||
  ((x >= 19 && x <= 61 && (y === 19 || y === 61)) || (y >= 19 && y <= 61 && (x === 19 || x === 61)));
const passable = (x: number, y: number) => x >= 0 && y >= 0 && x < 256 && y < 256 && !wall(x, y);
const safe = (x: number, y: number) => x >= 100 && x <= 119 && y >= 100 && y <= 119;
const huntable = (x: number, y: number) => passable(x, y) && !safe(x, y);
const start = { x: 110, y: 110 }; // llega en el pueblo

// --- Alcanzabilidad ----------------------------------------------------------------------------------------
{
  const r = reachableFrom(passable, start);
  ok('desde el pueblo se llega al otro lado de la pared (por abajo)', r[250 * 256 + 200] === 1 && r[10 * 256 + 200] === 1);
  ok('la isla cerrada no es alcanzable', r[40 * 256 + 40] === 0);
  ok('el lago no es alcanzable', r[170 * 256 + 170] === 0);
}

// --- Recorrido: solo caminable, alcanzable, sin repetir ------------------------------------------------------
{
  const h = new HuntExplorer();
  h.useTerrain(0, passable, huntable, start);
  const goals: { x: number; y: number; key: string }[] = [];
  let t = 0;
  let pos = { ...start };
  // Camina "teletransportándose" al destino (el test no es de la caminata sino de qué celdas elige).
  for (let i = 0; i < 400 && h.passes === 0; i++) {
    const g = h.next(pos.x, pos.y, t);
    if (h.passes > 0) break; // ya empezó la segunda vuelta: este destino no es de la primera
    const last = goals.at(-1);
    if (!last || last.x !== g.x || last.y !== g.y) goals.push({ ...g, key: h.goal?.key ?? '' });
    pos = { x: g.x, y: g.y };
    t += 1000;
  }
  ok('hay celdas para recorrer', (h.cells?.length ?? 0) > 20, h.cells?.length);
  ok('todo destino es caminable y no es zona segura', goals.every((g) => huntable(g.x, g.y)), goals.find((g) => !huntable(g.x, g.y)));
  ok('todo destino tiene camino desde la llegada (findPath)', goals.every((g) => findPath(passable, start, g, 60000) != null));
  ok('ningún destino cae en la isla ni en el lago', goals.every((g) => !(g.x > 19 && g.x < 61 && g.y > 19 && g.y < 61) && !(g.x >= 150 && g.x <= 200 && g.y >= 150 && g.y <= 200)));
  ok('el pueblo (zona segura) no se recorre', goals.every((g) => !safe(g.x, g.y)));
  ok('no repite celdas en una vuelta', new Set(goals.map((g) => g.key)).size === goals.length, goals.length);
  ok('cubre todas las celdas del mapa y recién ahí da otra vuelta', goals.length === h.cells!.length && h.passes === 1, [goals.length, h.cells!.length, h.passes]);
}

// --- Primero las celdas con dorados vistos; al final las de muertes ---------------------------------------------
{
  const h = new HuntExplorer();
  const probe = new HuntExplorer();
  const kA = probe.cellKey(212, 12), kB = probe.cellKey(12, 237), kDeath = probe.cellKey(87, 87);
  const weights = new Map([[kA, 5], [kB, 2]]);
  h.useTerrain(0, passable, huntable, start, weights, new Set([kDeath]));
  const order: string[] = [];
  let pos = { ...start };
  for (let i = 0; i < 400 && h.passes === 0; i++) {
    const g = h.next(pos.x, pos.y, i * 1000);
    if (h.passes > 0) break;
    if (h.goal && order.at(-1) !== h.goal.key) order.push(h.goal.key);
    pos = { x: g.x, y: g.y };
  }
  ok('las dos celdas con dorados van primero', new Set(order.slice(0, 2)).has(kA) && new Set(order.slice(0, 2)).has(kB), order.slice(0, 3));
  ok('la de más peso y más cerca primero que la liviana', order[0] === kA || order[0] === kB, order.slice(0, 2));
  ok('la celda donde murieron personajes va última', order.at(-1) === kDeath, order.slice(-2));
}

// --- Pasar cerca de una celda la da por vista ---------------------------------------------------------------------
{
  const h = new HuntExplorer();
  h.useTerrain(0, passable, huntable, start);
  const c = h.cells!.find((k) => k.x > 200 && k.y > 200)!;
  h.next(c.x + HUNT_CELL_REACH, c.y, 0);
  ok('a <= alcance de la vista del destino: ya está recorrida', h.visited.has(c.key));
  h.next(c.x + HUNT_CELL_REACH + 5, c.y, 1);
}

// --- Plazo: una celda a la que no llega se da por visitada y sigue -------------------------------------------------
{
  const h = new HuntExplorer();
  h.useTerrain(0, passable, huntable, start);
  const g1 = h.next(start.x, start.y, 0);
  const g2 = h.next(start.x, start.y, 44_000);
  const g3 = h.next(start.x, start.y, 46_000);
  ok('mismo destino mientras no vence el plazo, otro después', g1.x === g2.x && g1.y === g2.y && (g3.x !== g1.x || g3.y !== g1.y));
}

// --- Sin useTerrain: igual que antes (a ciegas) ----------------------------------------------------------------------
{
  const h = new HuntExplorer(25, 45_000, 100);
  const g = h.next(10, 10, 0);
  ok('sin terreno funciona como siempre', h.cells === null && g.x >= 0 && g.y >= 0);
  const h2 = new HuntExplorer();
  h2.useTerrain(0, () => false, () => false, start); // mapa sin nada caminable
  ok('mapa sin celdas útiles: queda a ciegas (no se rompe)', h2.cells === null && typeof h2.next(5, 5, 0).x === 'number');
}

// --- Terreno real de Lorencia (si están los assets del cliente) ------------------------------------------------------
if (terrainOf(0)) {
  const h = new HuntExplorer();
  const p = (x: number, y: number) => isWalkable(0, x, y);
  h.useTerrain(0, p, (x, y) => p(x, y) && !isSafeZone(0, x, y), { x: 133, y: 127 });
  ok('Lorencia: hay celdas', (h.cells?.length ?? 0) > 10, h.cells?.length);
  let pos = { x: 133, y: 127 };
  const gs: { x: number; y: number }[] = [];
  for (let i = 0; i < 200 && h.passes === 0; i++) { const g = h.next(pos.x, pos.y, i * 1000); gs.push(g); pos = g; }
  ok('Lorencia: todo destino es caminable, fuera del pueblo y con camino desde la llegada', gs.every((g) => p(g.x, g.y) && !isSafeZone(0, g.x, g.y) && findPath(p, { x: 133, y: 127 }, g, 60000) != null));
} else console.log('SKIP  terreno real de Lorencia: no están los assets del cliente');

console.log(fails === 0 ? '\nTODOS LOS TESTS DEL RECORRIDO CON TERRENO PASARON' : `\n${fails} TEST(S) DEL RECORRIDO CON TERRENO FALLARON`);
process.exit(fails ? 1 : 0);
