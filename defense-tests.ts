/**
 * Tests offline de defense.ts (defensa propia contra jugadores). Sin red, reloj simulado.
 *
 *   bun run defense-tests.ts
 */
import { DEFENSE, Defense } from './defense';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const me = { x: 50, y: 50 };
{
  const d = new Defense();
  const pk = { id: 7, x: 53, y: 50, name: 'Malo' };
  const other = { id: 8, x: 51, y: 50, name: 'Otro' };
  ok('sin golpes: no pelea con nadie', d.target(me, [pk, other], 0) === null);
  ok('golpe nuevo se avisa una vez', d.hit(7, 1000) && !d.hit(7, 2000));
  ok('contesta solo al que le pegó (no al más cercano que no)', d.target(me, [pk, other], 2500)?.id === 7);
  ok('pasados 10 s sin golpes: lo deja', d.target(me, [pk], 2000 + DEFENSE.memoryMs + 1) === null);
  d.hit(9, 0);
  ok('lejos (> 10 tiles): no lo persigue', d.target(me, [{ id: 9, x: 70, y: 50 }], 1) === null);
  d.hit(10, 0);
  ok('a los propios nunca', d.target(me, [{ id: 10, x: 51, y: 50, name: 'Melu' }], 1) === null);
  ok('huir con < 35 % y evitar el mapa 5 min', d.shouldFlee(0.3, 85, 0) && d.avoiding(85, DEFENSE.avoidMapMs - 1) && !d.avoiding(85, DEFENSE.avoidMapMs + 1));
  ok('con 50 % no huye', !d.shouldFlee(0.5, 84, 0) && !d.avoiding(84, 1));
  ok('skill: Death Stab si lo tiene, si no el siguiente', Defense.skill((n) => n === 43 || n === 41) === 43 && Defense.skill((n) => n === 41) === 41 && Defense.skill(() => false) === null);
}
console.log(fails === 0 ? '\nTODOS LOS TESTS DE DEFENSA PASARON' : `\n${fails} TEST(S) DE DEFENSA FALLARON`);
process.exit(fails ? 1 : 0);
