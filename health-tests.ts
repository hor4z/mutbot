/**
 * Tests offline de health.ts (vida real sin el tope de 16 bits). Sin red.
 *
 *   bun run health-tests.ts
 */
import { HP_WRAP, HpTracker } from './health';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const MAX = 65_535; // lo que informa CharacterInformation (u16)

// --- Hume a plena vida: 65.682 reales llegan como 146 ------------------------------------------------------------
{
  const t = new HpTracker();
  t.feed(60_000, MAX);
  t.feed(65_500, MAX);
  const hp = t.feed(146, MAX); // 65.682 - envuelto
  ok('salto de 65.500 a 146: es el envoltorio, la vida real es 65.682', hp === 146 + HP_WRAP && t.wraps === 1, hp);
  ok('el máximo sube a lo que se vio (el porcentaje no pasa de 100 %)', t.maxFor(MAX) === 65_682, t.maxFor(MAX));
  ok('sigue des-envuelta mientras baja de a poco', t.feed(100, MAX) === 100 + HP_WRAP);
  ok('y al volver al otro lado (un golpe baja hasta 65.400) se vuelve a la lectura directa', t.feed(65_400, MAX) === 65_400 && t.wraps === 0);
}

// --- Una lectura baja de verdad (golpes seguidos) no se confunde --------------------------------------------------
{
  const t = new HpTracker();
  let hp = 0;
  for (const v of [65_000, 58_000, 40_000, 22_000, 9_000, 2_500, 800]) hp = t.feed(v, MAX);
  ok('bajando de a golpes hasta 800: es 800, no 66.336', hp === 800 && t.wraps === 0, hp);
  ok('la muerte (0) tampoco', t.feed(0, MAX) === 0);
}
{
  const t = new HpTracker();
  t.feed(30_000, MAX);
  ok('de 30.000 a 100 de un golpe (salto menor al umbral) es real', t.feed(100, MAX) === 100);
}

// --- Prudencia: sin un máximo cerca del tope no toca nada ----------------------------------------------------------
{
  const t = new HpTracker();
  t.feed(5_000, 5_000);
  ok('personaje normal (máximo 5.000): lecturas tal cual', t.feed(100, 5_000) === 100 && t.wraps === 0);
  const t2 = new HpTracker();
  ok('primera lectura sin historia: tal cual (no adivina)', t2.feed(146, MAX) === 146);
  t2.feed(100, MAX);
  ok('y sin un salto visto no se inventa el envoltorio', t2.wraps === 0);
}

// --- Respawn después de morir en estado envuelto -------------------------------------------------------------------
{
  const t = new HpTracker();
  t.feed(65_500, MAX);
  t.feed(146, MAX); // envuelto
  ok('morir (0) en estado envuelto sigue siendo 0, no 65.536', t.feed(0, MAX) === 0 && t.wraps === 0);
  ok('al reaparecer con 60.000 se vuelve a lectura directa', t.feed(60_000, MAX) === 60_000 && t.wraps === 0);
}

// --- reset() al entrar al mundo -----------------------------------------------------------------------------------------
{
  const t = new HpTracker();
  t.feed(65_500, MAX); t.feed(146, MAX);
  t.reset();
  ok('reset limpia el estado', t.wraps === 0 && t.maxFor(MAX) === MAX && t.feed(300, MAX) === 300);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE VIDA REAL PASARON' : `\n${fails} TEST(S) DE VIDA REAL FALLARON`);
process.exit(fails ? 1 : 0);
