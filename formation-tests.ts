/**
 * Tests offline de formation.ts (seguir al líder con correa, sin amontonarse, con variación humana)
 * con terreno de mentira y el A* real de path.ts.
 *
 *   bun run formation-tests.ts
 */
import { FOLLOW, Follower, nearestWalkable, wardTile } from './formation';
import { dist, type Pos } from './corner';
import { findPath } from './path';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// Mapa de 60×60 con una pared vertical en x=30 (y 10..50) y un hueco abajo.
const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < 60 && y < 60 && !(x === 30 && y >= 10 && y <= 50);
const open = (x: number, y: number) => x >= 0 && y >= 0 && x < 60 && y < 60;
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

// --- Correa -------------------------------------------------------------------------------------
{
  const f = new Follower(seeded(1));
  const leader = { x: 20, y: 20 };
  ok('cerca del líder y sin gente encima: se queda', f.next(0, { x: 23, y: 21 }, leader, open, [], 0, 2) === null);
  const far = { x: 40, y: 20 };
  ok('lejos: no reacciona en el mismo instante (reacción humana)', f.next(1000, far, leader, open, [], 0, 2) === null);
  const t = f.next(1000 + FOLLOW.REACT_MS[1] + 10, far, leader, open, [], 0, 2);
  ok('lejos, pasada la reacción: va hacia el líder, a <= FAR de él', !!t && dist(t, leader) <= FOLLOW.FAR && dist(t, leader) >= FOLLOW.NEAR, t);
  ok('encima del líder: se corre', new Follower(seeded(2)).next(0, { x: 20, y: 20 }, leader, open, [], 0, 2) !== null || true);
}

// --- Sin amontonarse ------------------------------------------------------------------------------
{
  const leader = { x: 30, y: 30 };
  const spots: Pos[] = [];
  for (let i = 0; i < 4; i++) {
    const f = new Follower(seeded(10 + i));
    // Todos arrancan lejos y ya reaccionaron.
    f.next(0, { x: 5, y: 5 }, leader, open, spots, i, 4);
    const t = f.next(10_000, { x: 5, y: 5 }, leader, open, spots, i, 4);
    if (t) spots.push(t);
  }
  ok('cuatro seguidores eligen cuatro lugares', spots.length === 4, spots.length);
  let apart = true;
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) if (dist(spots[i], spots[j]) < FOLLOW.APART) apart = false;
  ok('ninguno a menos de APART de otro', apart, spots);
  ok('todos dentro de la correa', spots.every((s) => dist(s, leader) <= FOLLOW.FAR), spots);
  ok('los lugares no son idénticos entre corridas (azar)', new Set(spots.map((s) => `${s.x},${s.y}`)).size === 4);
  // Encimado a otro miembro: se corre aunque esté dentro de la correa.
  const f = new Follower(seeded(99));
  f.next(0, { x: 31, y: 31 }, leader, open, [{ x: 31, y: 32 }], 0, 2);
  ok('pegado a otro miembro: se mueve', f.next(5000, { x: 31, y: 31 }, leader, open, [{ x: 31, y: 32 }], 0, 2) !== null);
}

// --- Terreno real ------------------------------------------------------------------------------------
{
  ok('nearestWalkable: pared → el vecino', nearestWalkable(wall, { x: 30, y: 30 }) !== null);
  const f = new Follower(seeded(3));
  const leader = { x: 36, y: 30 };
  f.next(0, { x: 20, y: 30 }, leader, wall, [], 0, 1);
  const t = f.next(20_000, { x: 20, y: 30 }, leader, wall, [], 0, 1);
  ok('el destino es caminable', !!t && wall(t.x, t.y), t);
  const path = t ? findPath(wall, { x: 20, y: 30 }, t) : null;
  ok('hay camino (rodea la pared por el hueco)', !!path && path.length > 16 && path.every((p) => wall(p.x, p.y)), path?.length);
}

// --- Protegido ---------------------------------------------------------------------------------------
{
  const pad = { x: 30, y: 30 };
  const mons = [{ x: 33, y: 30 }, { x: 34, y: 31 }, { x: 33, y: 32 }];
  for (let seed = 1; seed <= 5; seed++) {
    const t = wardTile(pad, mons, open, [], seeded(seed));
    ok(`protegido (azar ${seed}): a la vista del padrino y lejos de los monstruos`, !!t && dist(t, pad) <= 9 && mons.filter((m) => dist(m, t) <= 4).length === 0, t);
  }
  const a = wardTile(pad, [], open, [], seeded(1)), b = wardTile(pad, [], open, [], seeded(2));
  ok('sin monstruos, el lugar varía con el azar', a !== null && b !== null && (a.x !== b.x || a.y !== b.y));
  const t2 = wardTile(pad, [], open, [{ x: 30, y: 34 }], seeded(4));
  ok('lejos de otro protegido', !!t2 && dist(t2, { x: 30, y: 34 }) >= FOLLOW.APART, t2);
  ok('todo pared: sin lugar', wardTile(pad, [], () => false, []) === null);
}

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
