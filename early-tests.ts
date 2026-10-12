/**
 * Tests offline de early.ts (Lorencia y Devias hasta el 100). Sin red; azar y reloj simulados.
 *
 *   bun run early-tests.ts
 */
import { EARLY, INITIAL, biggestCluster, deviasCamp, dist, fieldFor, inField, initialCamp, leashedTarget, lorenciaPlan } from './early';
import { canFight, damageRange, estimateFight, monsterCombat } from './power';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

// --- Farmeo inicial ---------------------------------------------------------------------------------
{
  const F0 = INITIAL.fields[0];
  const me = { x: 135, y: 130 };
  const grp = [{ x: 140, y: 140 }, { x: 141, y: 141 }, { x: 139, y: 141 }, { x: 170, y: 170 }];
  const c = initialCamp({ me, field: F0, monsters: grp, prev: null, rand: () => 0.5 });
  ok('inicial: campamento en el grupo atacable más grande a la vista', dist(c.camp, { x: 140, y: 140 }) <= 1 && c.why.startsWith('grupo de 3'), c);
  const keep = initialCamp({ me, field: F0, monsters: grp, prev: { x: 141, y: 142 }, rand: () => 0.5 });
  ok('inicial: no se recentra por un corrimiento chico', keep.camp.x === 141 && keep.camp.y === 142, keep);
  const lvl1 = initialCamp({ me: INITIAL.town, field: F0, monsters: [], prev: null, rand: () => 0.5 });
  ok('inicial: en el pueblo sin atacables → al campo (no se queda en zona segura)',
    lvl1.camp.x === F0.entry.x && lvl1.camp.y === F0.entry.y && dist(lvl1.camp, INITIAL.town) > 40, lvl1);
  const roam = initialCamp({ me: { x: 195, y: 130 }, field: F0, monsters: [], prev: null, rand: () => 0.9 });
  ok('inicial: ya en el campo sin monstruos → otro punto del campo', inField(roam.camp, F0) && roam.why.includes('recorro'), roam);
  const blocked = initialCamp({ me: INITIAL.town, field: F0, monsters: [], prev: null, rand: () => 0.9, walkable: () => false });
  ok('inicial: punto no caminable → la entrada del campo', blocked.camp.x === F0.entry.x && blocked.camp.y === F0.entry.y, blocked);
  const far = initialCamp({ me, field: F0, monsters: [{ x: 135, y: 160 }], prev: null, rand: () => 0.5 });
  ok('inicial: un monstruo a más de scan no cuenta', far.why.startsWith('sin monstruos'), far);
  ok('inicial: dura hasta el 20', INITIAL.untilLevel === 20);
  // El campo sale de con qué puede, no del nivel.
  const lv = (t: number) => ({ 3: 2, 2: 4, 0: 6, 1: 9, 4: 12, 6: 14 } as Record<number, number>)[t];
  ok('campo: solo arañas → este', fieldFor((t) => t === 3, lv) === INITIAL.fields[0]);
  ok('campo: hasta Bull Fighter → norte', fieldFor((t) => [3, 2, 0].includes(t), lv) === INITIAL.fields[1]);
  ok('campo: con Hound → oeste', fieldFor((t) => [3, 2, 0, 1].includes(t), lv) === INITIAL.fields[2]);
  ok('campo: con todo (Horaz) → Lich', fieldFor(() => true, lv) === INITIAL.fields[3]);
  ok('campo: con nada → el primero', fieldFor(() => false, lv) === INITIAL.fields[0]);
}

// --- Poder del personaje (power.ts) ------------------------------------------------------------------
{
  const nuevo = { family: 'knight' as const, stats: { str: 28, agi: 20, vit: 25, ene: 10 }, maxHp: 112 };
  const horaz = { family: 'knight' as const, stats: { str: 65535, agi: 3000, vit: 3000, ene: 65535 }, maxHp: 20000 };
  ok('poder: DK recién creado puede con arañas', canFight(nuevo, 3));
  ok('poder: DK recién creado NO con Lich ni Hound', !canFight(nuevo, 6) && !canFight(nuevo, 1));
  ok('poder: Horaz puede con el Lich y el Giant', canFight(horaz, 6) && canFight(horaz, 7));
  const e = estimateFight(nuevo, monsterCombat(6)!);
  ok('poder: el Lich mata a un recién creado (pierde más de toda la vida)', e.hpLoss > 1, e);
  ok('poder: tipo sin datos → no', !canFight(horaz, 99999));
  const mago = { family: 'wizard' as const, stats: { str: 18, agi: 18, vit: 15, ene: 30 }, maxHp: 60 };
  ok('poder: el mago pega con energía', damageRange(mago)[1] === 30 / 4);
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
