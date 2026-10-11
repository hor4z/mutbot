/**
 * Tests offline de los campamentos (camp.ts): correa, primer campamento por
 * mapa, reglas de mudanza (rinde poco, vacío, competencia), pelea en el
 * camino, curiosidad, memoria, hambre y skill de área. Sin red, reloj simulado.
 *
 *   bun run camp-tests.ts
 */
import { CAMP, CampManager, CampMemory, DOWN_ZONE_DEFAULT, Hunger, START_CAMPS, castCandidate, downZone, type PickInput } from './camp';
import { ExpLog, MonsterTypeStats, type Candidate } from './farming';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const S = 1000;
const MIN = 60 * S;

const stats = () => {
  const st = new MonsterTypeStats(() => null);
  st.setExp(1, 1000); st.recordKillSec(1, 1);
  st.setExp(2, 1000); st.recordKillSec(2, 1);
  return st;
};
let nextId = 1;
const mon = (x: number, y: number, type = 1): Candidate => ({ id: nextId++, type, x, y });
const input = (m: CampManager, o: Partial<PickInput<Candidate>> & { now: number; me: { x: number; y: number } }): PickInput<Candidate> => ({
  map: 2, level: 60, monsters: [], players: [], stats: stats(), exp: new ExpLog(0), typeKills: { 1: 9, 2: 9 }, ...o,
});

// --- Correa y primer campamento ----------------------------------------------------------
{
  const m = new CampManager();
  m.onArrival(2, 100, 100, 0, 60);
  ok('Devias: correa de 25 tiles alrededor de la llegada', m.leashFor(2)?.r === 25 && m.leashFor(2)?.x === 100);
  ok('Devias sin nada aprendido: spot "arriba" de la llegada (-x, +y) a 8-18 tiles',
     m.camp != null && m.camp.x < 100 && m.camp.y > 100 && Math.max(100 - m.camp.x, m.camp.y - 100) >= 8 && Math.max(100 - m.camp.x, m.camp.y - 100) <= 18, m.camp);
  ok('fuera de la correa no se considera', !m.inLeash(2, { x: 130, y: 100 }) && m.inLeash(2, { x: 120, y: 120 }));
  ok('otros mapas sin correa', m.leashFor(84) === null);
  // Recién llegado: no elige campamento nuevo, pelea solo a <= 6.
  const m2 = new CampManager();
  m2.onArrival(84, 50, 50, 0, 250);
  ok('Arena: va a la zona de abajo (default aprendido)', m2.camp?.x === DOWN_ZONE_DEFAULT[84].x && m2.camp?.y === DOWN_ZONE_DEFAULT[84].y, m2.camp);
  m2.camp = null;
  const far = mon(60, 50), near = mon(54, 50);
  ok('durante la llegada: solo pelea a <= 6, sin campamento', m2.pick(input(m2, { map: 84, now: 1 * S, me: { x: 50, y: 50 }, monsters: [far, near] }))?.id === near.id && m2.camp === null);
  // Memoria: lo aprendido primero.
  const mem = new CampMemory(CAMP, [{ map: 2, x: 110, y: 112, rate: 5e6, n: 3, level: 70 }, { map: 2, x: 200, y: 200, rate: 9e6, n: 3, level: 70 }]);
  const m3 = new CampManager(CAMP, mem);
  m3.onArrival(2, 100, 100, 0, 60);
  ok('al llegar: el mejor aprendido a nivel parecido y dentro de la correa', m3.camp?.x === 110 && m3.camp.y === 112, m3.camp);
  const m4 = new CampManager(CAMP, mem);
  m4.onArrival(2, 100, 100, 0, 200);
  ok('aprendido a otro nivel (> ±60): regla fija', m4.camp?.x !== 110, m4.camp);
  // Un campamento del mapa anterior se descarta.
  const m5 = new CampManager();
  m5.camp = { map: 2, x: 10, y: 10, since: 0, arrivedAt: null, lastSeen: 0, walkSince: 0, crowdSince: null, counted: false, why: '' };
  m5.onArrival(2, 100, 100, 0, 60);
  ok('campamento fuera de la correa al llegar: se descarta', m5.camp?.x !== 10 && m5.events.some((e) => e.includes('descarto')), m5.events);
  // Lorencia: la cripta.
  const m6 = new CampManager();
  m6.onArrival(0, 135, 128, 0, 15);
  const g = m6.goal(5 * S, 0, { x: 135, y: 128 }, 15, new ExpLog(0));
  ok('Lorencia: directo a la cripta (132,200)', g?.kind === 'camp' && g.x === START_CAMPS[0].x && g.y === START_CAMPS[0].y, g);
  // Fuera de la correa sin campamento: volver a la llegada.
  const m7 = new CampManager();
  m7.onArrival(2, 100, 100, 0, 60);
  m7.camp = null;
  const back = m7.goal(5 * S, 2, { x: 140, y: 100 }, 60, new ExpLog(0));
  ok('lejos de la llegada en Devias: vuelve', back?.kind === 'llegada' && back.x === 100, back);
}

// --- Elección de campamento y objetivos --------------------------------------------------
{
  const m = new CampManager();
  const group = [mon(40, 40), mon(42, 41), mon(41, 43)];
  const lone = mon(25, 20);
  const t = m.pick(input(m, { map: 3, now: 10 * S, me: { x: 20, y: 20 }, monsters: [lone, ...group] }));
  ok('campamento donde más exp/s hay junta (no el más cercano)', m.camp != null && m.camp.x >= 40, m.camp);
  ok('en camino pelea con lo que esté a <= 8', t?.id === lone.id, t);
  // Correa: monstruos fuera no cuentan.
  const ml = new CampManager();
  ml.onArrival(2, 100, 100, 0, 60);
  ml.camp = null;
  const out = mon(130, 100), inside = mon(104, 100);
  ok('correa: no elige objetivos fuera', ml.pick(input(ml, { now: 10 * S, me: { x: 100, y: 100 }, monsters: [out, inside] }))?.id === inside.id);
  // En camino: 3 monstruos juntos a <= 8 → acampar ahí.
  const mc = new CampManager();
  mc.camp = { map: 3, x: 100, y: 100, since: 0, arrivedAt: null, lastSeen: 0, walkSince: 0, crowdSince: null, counted: false, why: '' };
  mc.pick(input(mc, { map: 3, now: 5 * S, me: { x: 50, y: 50 }, monsters: [mon(52, 50), mon(55, 52), mon(48, 47)] }));
  ok('3 monstruos juntos en el camino: me quedo ahí', mc.camp?.x === 50 && mc.camp.y === 50, mc.camp);
  // Curiosidad: un tipo con < 3 kills a <= 8 va primero.
  const mq = new CampManager();
  const known = mon(51, 50, 1), novel = mon(56, 50, 2);
  ok('curiosidad: tipo con < 3 kills primero', mq.pick(input(mq, { map: 3, now: 5 * S, me: { x: 50, y: 50 }, monsters: [known, novel], typeKills: { 1: 9, 2: 1 } }))?.id === novel.id);
}

// --- Mudanzas ---------------------------------------------------------------------------------
{
  const mk = () => {
    const m = new CampManager();
    m.camp = { map: 3, x: 50, y: 50, since: 0, arrivedAt: null, lastSeen: 0, walkSince: 0, crowdSince: null, counted: false, why: '' };
    return m;
  };
  // Vacío: el reloj corre solo desde que llegó.
  const m = mk();
  m.pick(input(m, { map: 3, now: 30 * S, me: { x: 90, y: 90 } }));
  ok('viajando 30 s sin monstruos: no abandona', m.camp != null);
  m.pick(input(m, { map: 3, now: 31 * S, me: { x: 50, y: 50 } }));
  m.pick(input(m, { map: 3, now: 40 * S, me: { x: 50, y: 50 } }));
  ok('llegó hace 9 s: sigue', m.camp != null);
  m.pick(input(m, { map: 3, now: 44 * S, me: { x: 50, y: 50 } }));
  ok('vacío > 12 s desde que llegó: se muda', m.camp === null && m.events.some((e) => e.includes('sin monstruos')), m.events);

  // Rinde poco: < 50% de la vara (promedio móvil) tras 90 s.
  const exp = new ExpLog(0);
  const mp = mk();
  mp.best[3] = 10e6;
  const monsters = [mon(51, 50)];
  mp.pick(input(mp, { map: 3, now: 1 * S, me: { x: 50, y: 50 }, monsters, exp }));
  for (let t = 2; t <= 92; t++) exp.add(60_000, t * S); // ~3.6M exp/min
  mp.pick(input(mp, { map: 3, now: 80 * S, me: { x: 50, y: 50 }, monsters, exp }));
  ok('antes de 90 s no evalúa', mp.camp != null);
  mp.pick(input(mp, { map: 3, now: 92 * S, me: { x: 50, y: 50 }, monsters, exp }));
  ok('tras 90 s rindiendo < 50% de la vara: se muda', mp.camp === null, mp.events);
  ok('la vara es promedio móvil (0.7/0.3), no máximo', Math.abs(mp.best[3] - (10e6 * 0.7 + exp.rateSince(1 * S, 92 * S) * 0.3)) < 1, mp.best[3]);
  ok('al irse lo guarda en la memoria con la exp/min real', mp.memory.list(3)[0]?.x === 50 && mp.memory.list(3)[0].n === 1, mp.memory.dump());

  // Competencia: >= 3 jugadores 20 s Y exp < 70% de la vara.
  const players = [{ x: 52, y: 50 }, { x: 48, y: 50 }, { x: 50, y: 55 }];
  const good = new ExpLog(0);
  for (let t = 0; t <= 120; t++) good.add(200_000, t * S); // 12M/min
  const mg = mk();
  mg.best[3] = 10e6;
  for (let t = 1; t <= 100; t += 3) mg.pick(input(mg, { map: 3, now: t * S, me: { x: 50, y: 50 }, monsters, players, exp: good }));
  ok('con gente pero rindiendo bien: se queda ("no es mejor que yo")', mg.camp != null);
  const bad = new ExpLog(0);
  for (let t = 0; t <= 120; t++) bad.add(50_000, t * S); // 3M/min < 7M
  const mb = mk();
  mb.best[3] = 10e6;
  let t = 1;
  for (; t <= 100 && mb.camp; t += 3) mb.pick(input(mb, { map: 3, now: t * S, me: { x: 50, y: 50 }, monsters, players, exp: bad }));
  ok('con gente y la exp cayó < 70%: se muda (antes que la regla de 90 s)', mb.camp === null && mb.crowdLeaves.length === 1 && t < 92, { t, ev: mb.events });
  mb.crowdLeaves.push(t * S);
  ok('2 mudanzas por gente en 2 min: el spot entero está lleno', mb.crowdedSpot(t * S));
  ok('pasados 2 min se olvida', !mb.crowdedSpot(t * S + 3 * MIN));

  // Un campamento al que no llega en 60 s se abandona.
  const mw = mk();
  ok('caminando hacia el campamento', mw.goal(30 * S, 3, { x: 90, y: 90 }, 60, new ExpLog(0))?.kind === 'camp');
  mw.goal(61 * S, 3, { x: 90, y: 90 }, 60, new ExpLog(0));
  ok('no llega en 60 s: lo abandona', mw.camp === null || mw.camp.x !== 50, mw.events);
}

// --- Memoria ------------------------------------------------------------------------------------
{
  const mem = new CampMemory();
  mem.record(2, 100, 100, 4e6, 60);
  mem.record(2, 102, 101, 2e6, 62);
  ok('mismo campamento (<= 4 tiles): EMA 0.6/0.4 y n++', mem.list(2).length === 1 && mem.list(2)[0].n === 2 && Math.abs(mem.list(2)[0].rate - (4e6 * 0.6 + 2e6 * 0.4)) < 1);
  mem.record(2, 130, 100, 9e6, 60);
  ok('el mejor primero', mem.list(2)[0].x === 130);
  ok('cerca: puntaje por rate / (1 + d/12)', mem.nearBest(2, { x: 100, y: 100 }, 60, () => true)?.x === 100);
  ok('dump/restore', new CampMemory(CAMP, mem.dump()).list(2).length === 2);
}

// --- Hambre ---------------------------------------------------------------------------------------
{
  const h = new Hunger();
  let r = h.check({ now: 30 * S, tier: 20, recentRate: 2e6, lastWarpAt: 0, rivalsNear: 1 });
  ok('recién llegado (< 45 s): no hay hambre', !r.starving);
  r = h.check({ now: 50 * S, tier: 20, recentRate: 2e6, lastWarpAt: 0, rivalsNear: 1 });
  ok('sin referencia: ganando algo (2M/min) con un jugador cerca → no hay hambre (aprende primero)', !r.starving && r.ref === null, r);
  r = h.check({ now: 50 * S, tier: 20, recentRate: 0, lastWarpAt: 0, rivalsNear: 1 });
  ok('sin referencia: 0 exp con un jugador cerca → hambre', r.starving && r.ref === null, r);
  ok('primer minuto tras el warp no entra en la referencia', h.ref.t20 === undefined);
  r = h.check({ now: 50 * S, tier: 20, recentRate: 2e6, lastWarpAt: 0, rivalsNear: 0 });
  ok('sin jugadores cerca: no hay hambre', !r.starving);
  for (let t = 61; t < 200; t++) h.check({ now: t * S, tier: 20, recentRate: 20e6, lastWarpAt: 0, rivalsNear: 0 });
  ok('la referencia aprende (promedio móvil 0.95/0.05)', h.ref.t20 > 15e6, h.ref);
  r = h.check({ now: 300 * S, tier: 20, recentRate: 4e6, lastWarpAt: 0, rivalsNear: 2 });
  ok('con referencia: < 25% de ella con jugadores → hambre', r.starving, r);
  r = h.check({ now: 301 * S, tier: 20, recentRate: 8e6, lastWarpAt: 0, rivalsNear: 2 });
  ok('con referencia: > 25% → no', !r.starving, r);
  ok('referencia por tramo', h.check({ now: 400 * S, tier: 300, recentRate: 0, lastWarpAt: 0, rivalsNear: 0 }).ref === null);
}

// --- Skill de área en el camino y zona de abajo ---------------------------------------------------
{
  const me = { x: 10, y: 10 };
  const a = { x: 12, y: 10 }, b = { x: 11, y: 11 }, c = { x: 16, y: 10 };
  ok('cualquier monstruo a <= 3 (el más cercano)', castCandidate(me, [a, b, c], null) === b);
  ok('el objetivo si está a <= 3', castCandidate(me, [a, b, c], a) === a);
  ok('nada a <= 3: no gira en el aire', castCandidate(me, [c], c) === null);
  // Grilla sintética: caminable el triángulo x − y >= 0 hasta 100; "abajo" = mayor x − y.
  const z = downZone((x, y) => x <= 100 && y >= 10 && y <= x);
  ok('zona de abajo: mayor x − y entre lo caminable', z != null && z.x > 80 && z.y < 30, z);
  ok('sin grilla caminable: null', downZone(() => false) === null);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE CAMPAMENTOS PASARON' : `\n${fails} TEST(S) DE CAMPAMENTOS FALLARON`);
process.exit(fails ? 1 : 0);
