/**
 * Tests offline de early.ts (Lorencia y Devias hasta el 100). Sin red; azar y reloj simulados.
 *
 *   bun run early-tests.ts
 */
import { EARLY, INITIAL, biggestCluster, deviasCamp, dist, initialCamp, initialEligible, leashedTarget, lorenciaPlan } from './early';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

// --- Farmeo inicial ---------------------------------------------------------------------------------
{
  ok('inicial: nivel 1 ataca hasta nivel 4 (Budge Dragon sí, Bull Fighter 6 no)', initialEligible(1, 4) && !initialEligible(1, 6));
  ok('inicial: monstruo sin nivel conocido → no', !initialEligible(5, undefined));
  const me = { x: 135, y: 130 };
  const grp = [{ x: 140, y: 140 }, { x: 141, y: 141 }, { x: 139, y: 141 }, { x: 170, y: 170 }];
  const c = initialCamp({ me, myLevel: 3, monsters: grp, prev: null, rand: () => 0.5 });
  ok('inicial: campamento en el grupo de su nivel más grande a la vista', dist(c.camp, { x: 140, y: 140 }) <= 1 && c.why.startsWith('grupo de 3'), c);
  const keep = initialCamp({ me, myLevel: 3, monsters: grp, prev: { x: 141, y: 142 }, rand: () => 0.5 });
  ok('inicial: no se recentra por un corrimiento chico', keep.camp.x === 141 && keep.camp.y === 142, keep);
  const lvl1 = initialCamp({ me, myLevel: 1, monsters: [], prev: null, rand: () => 0.5 });
  ok('inicial: nivel 1 sin monstruos → junto al pueblo', lvl1.camp.x === INITIAL.town.x && lvl1.camp.y === INITIAL.town.y, lvl1);
  const top = initialCamp({ me, myLevel: INITIAL.untilLevel, monsters: [], prev: null, rand: () => 0.5 });
  ok('inicial: al tope sin monstruos → el Lich', top.camp.x === EARLY.lorencia.lich.x && top.camp.y === EARLY.lorencia.lich.y, top);
  const mid = initialCamp({ me, myLevel: 5, monsters: [], prev: null, rand: () => 0.5 });
  ok('inicial: nivel medio → entre el pueblo y el Lich', mid.camp.y > INITIAL.town.y && mid.camp.y < EARLY.lorencia.lich.y, mid);
  const far = initialCamp({ me, myLevel: 3, monsters: [{ x: 135, y: 160 }], prev: null, rand: () => 0.5 });
  ok('inicial: un monstruo a más de scan no cuenta', far.why.startsWith('sin monstruos'), far);
}

// --- Lorencia --------------------------------------------------------------------------------------
{
  // orden de los sorteos: campamento x, y; los dos pasos (x, y cada uno); cuál salida
  const p = lorenciaPlan(seq(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.1));
  ok('Lorencia: campamento en el Lich (rand 0,5 = sin corrimiento) y salida directa', p.camp.x === 134 && p.camp.y === 202 && p.via === null, p);
  const q = lorenciaPlan(seq(1 - 1e-9, 0, 0.5, 0.5, 0.5, 0.5, 0.3));
  ok('Lorencia: corrimiento de ±3 y paso por el oeste', Math.abs(q.camp.x - 134) <= 3 && Math.abs(q.camp.y - 202) <= 3 && q.via?.x === 130 && q.via?.y === 150, q);
  ok('Lorencia: pared → el Lich exacto y sin paso', JSON.stringify(lorenciaPlan(seq(0.9, 0.9, 0.3), () => false)) === JSON.stringify({ camp: { x: 134, y: 202 }, via: null }));
}

// --- Devias 4 --------------------------------------------------------------------------------------
{
  const arrival = { x: 69, y: 180 };
  const group = [{ x: 60, y: 188 }, { x: 61, y: 189 }, { x: 62, y: 187 }, { x: 60, y: 190 }];
  const c = biggestCluster(group);
  ok('grupo más grande: 4 juntos', c?.n === 4, c);
  let r = deviasCamp({ arrival, monsters: group, prev: null, poorSince: null, now: 0 });
  ok('Devias: campamento en el grupo junto a la llegada', dist(r.camp, { x: 61, y: 188 }) <= 2 && r.poorSince === null, r);
  r = deviasCamp({ arrival, monsters: [], prev: null, poorSince: null, now: 0 });
  ok('Devias: sin grupo → spot (69,181), y queda pobre', r.camp.x === 69 && r.camp.y === 181 && r.poorSince === 0, r);
  r = deviasCamp({ arrival, monsters: [{ x: 50, y: 170 }, { x: 51, y: 171 }], prev: { x: 69, y: 181 }, poorSince: 0, now: EARLY.poorMs + 1 });
  ok('Devias: pobre 10 s → grupo de 2 más lejos (<= 25)', r.camp.x === 50 || r.camp.x === 51, r);
  const d3 = { x: 222, y: 208 }; // llegada de Devias 3 (Horaz, 2026-10-11)
  r = deviasCamp({ arrival: d3, monsters: [], prev: { x: 214, y: 218 }, poorSince: 0, now: EARLY.poorMs + 1 });
  ok('Devias 3 pobre: no cruza el mapa al spot de Devias 4, espera en la llegada', dist(r.camp, d3) <= 1, r);
  r = deviasCamp({ arrival: d3, monsters: [], prev: null, poorSince: null, now: 0 });
  ok('Devias 3 sin grupo: campamento en la llegada', dist(r.camp, d3) <= 1, r);
  r = deviasCamp({ arrival, monsters: [{ x: 61, y: 188 }], prev: { x: 61, y: 188 }, poorSince: 0, now: 5000 });
  ok('Devias: pobre hace 5 s → todavía no se muda', r.camp.x === 61 && r.poorSince === 0, r);
}

// --- Objetivo con correa ---------------------------------------------------------------------------
{
  const camp = { x: 60, y: 188 };
  const inLeash = [{ x: 61, y: 189, id: 1 }, { x: 62, y: 189, id: 2 }];
  const far = { x: 80, y: 188, id: 3 };
  ok('correa: elige dentro de 8 del campamento', leashedTarget({ x: 60, y: 188 }, camp, [...inLeash, far])?.id !== 3);
  const edge = { x: 69, y: 188, id: 4 }; // a 9 del campamento: fuera de la correa (8), dentro de 10
  ok('correa: nada en el campamento → el más cercano a <= 12 de mí, sin pasar 10 del campamento', leashedTarget({ x: 72, y: 188 }, camp, [edge, far])?.id === 4);
  ok('correa: uno a 20 del campamento no se elige aunque esté al lado mío', leashedTarget({ x: 79, y: 188 }, camp, [far]) === null);
  ok('correa: nada cerca → null', leashedTarget({ x: 0, y: 0 }, camp, [far]) === null);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DEL ARRANQUE PASARON' : `\n${fails} TEST(S) DEL ARRANQUE FALLARON`);
process.exit(fails ? 1 : 0);
