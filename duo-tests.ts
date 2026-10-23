/**
 * Tests offline de duo.ts (dúo de crianza: reparto de exp de OpenMU, roles, dónde se para el protegido).
 *
 *   bun run duo-tests.ts
 */
import { baseExp, duoRole, partyGain, partyShares, wardSpot, WARD_MAX_DIST } from './duo';
import { dist } from './corner';
import { partyWanted } from './knowledge';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

// --- Fórmula de OpenMU ------------------------------------------------------------------------------
ok('base: monstruo 50, nivel 40 (sin castigo) = 1562,5', near(baseExp(50, 40), 1562.5), baseExp(50, 40));
ok('base: monstruo 50, nivel 80 (castigo 60/80) = 1171,875', near(baseExp(50, 80), 1171.875), baseExp(50, 80));
ok('base: Gaint Drakan (100) para nivel 300 ≈ 3035', near(baseExp(100, 300), 3034.7, 1), baseExp(100, 300));
{
  const [h, z] = partyShares([300, 100], 100);
  ok('party 300+100: el pozo es base(promedio 200) × 2 × 1,05', near(h + z, baseExp(100, 200) * 2.1, 1), h + z);
  ok('party 300+100: a cada uno según su nivel (3:1)', near(h / z, 3, 0.001), h / z);
}
ok('Hume 300 con Zamu 100: ~2× por kill', near(partyGain(300, 100), 2.07, 0.05), partyGain(300, 100));
ok('mismo nivel: solo el 5 % de la party', near(partyGain(300, 300), 1.05, 0.001), partyGain(300, 300));
ok('el de más abajo en party con uno más alto: le cuesta (si no mata nadie más)', partyGain(100, 150) < 1, partyGain(100, 150));

// --- Roles ----------------------------------------------------------------------------------------
ok('fuerte con nuevo: padrino', duoRole(false, true) === 'padrino');
ok('nuevo con fuerte: protegido', duoRole(true, false) === 'protegido');
ok('dos iguales o sin dato: sin dúo de crianza', duoRole(true, true) === null && duoRole(false, false) === null && duoRole(false, undefined) === null);

// --- Party: la cuenta manda ---------------------------------------------------------------------------
{
  const p = partyWanted(Date.now(), { name: 'Zamu', gain: partyGain(300, 100) });
  ok('con un protegido que suma: party sí', p.use && p.why.includes('Zamu'), p);
}

// --- Dónde se para el protegido ---------------------------------------------------------------------
{
  const dk = { x: 2, y: 10 };
  const s = wardSpot(dk, []);
  ok('sin monstruos: en el bolsillo, a la vista del padrino', dist(s, dk) <= WARD_MAX_DIST && s.y >= 12, s);
  const s2 = wardSpot(dk, [{ x: 7, y: 16 }, { x: 8, y: 15 }, { x: 7, y: 15 }]);
  ok('con monstruos en el bolsillo: otro lugar con menos', !(s2.x === 7 && s2.y === 16), s2);
}

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
