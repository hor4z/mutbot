/**
 * Tests offline de path.ts (caminos con el terreno). Sin red.
 *
 *   bun run path-tests.ts
 */
import { findPath } from './path';
import { isWalkable, terrainOf } from './terrain';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// Grilla sintética: una pared en x=5 de y=0 a 8, con paso arriba (y=9).
const wall = (x: number, y: number) => !(x === 5 && y <= 8) && x >= 0 && y >= 0 && x < 20 && y < 20;
const p = findPath(wall, { x: 2, y: 2 }, { x: 8, y: 2 });
ok('rodea la pared por el paso', p != null && p.some((q) => q.y >= 9) && p.every((q) => wall(q.x, q.y)), p);
ok('empieza y termina donde corresponde', p?.[0].x === 2 && p?.at(-1)?.x === 8);
ok('sin camino → null', findPath((x, y) => x !== 5, { x: 2, y: 2 }, { x: 8, y: 2 }, 2000) === null);
ok('destino en una pared: va al caminable más cercano', findPath(wall, { x: 2, y: 2 }, { x: 5, y: 2 })?.at(-1)?.x !== 5);
// Sin cortar esquinas: de (4,9) a (6,8) en diagonal pasaría por la punta de la pared.
const corner = findPath(wall, { x: 4, y: 8 }, { x: 6, y: 8 });
ok('no corta esquinas de una pared', corner != null && corner.every((q, i) => i === 0 || !(Math.abs(q.x - corner[i - 1].x) === 1 && Math.abs(q.y - corner[i - 1].y) === 1 && (!wall(q.x, corner[i - 1].y) || !wall(corner[i - 1].x, q.y)))), corner);

// Terreno real: el corral de Arena 2 donde quedó Melu (52,34) → (52,28).
if (terrainOf(83)) {
  const q = findPath((x, y) => isWalkable(83, x, y), { x: 52, y: 34 }, { x: 52, y: 28 });
  ok('Arena 2: sale del corral de (52,34) a (52,28) rodeando la cerca', q != null && q.length > 7 && q.every((s) => isWalkable(83, s.x, s.y)), q?.length);
} else console.log('SKIP  terreno real: no están los assets del cliente');

console.log(fails === 0 ? '\nTODOS LOS TESTS DE CAMINOS PASARON' : `\n${fails} TEST(S) DE CAMINOS FALLARON`);
process.exit(fails ? 1 : 0);
