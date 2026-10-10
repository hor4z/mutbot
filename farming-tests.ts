/**
 * Tests offline del farmeo por exp/segundo (farming.ts): valor de un objetivo,
 * elección, estimación sin datos, exp de kills partida en tramos de 65535 y
 * autoevaluación. Sin red, con reloj simulado.
 *
 *   bun run farming-tests.ts
 */
import { ExpSplitTracker, FARM, MonsterTypeStats, SelfReport, median, pickTarget, targetRate } from './farming';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const S = 1000;
const MIN = 60 * S;

// Vidas de prueba por tipo (en el bot salen de data/monsters.json).
const HP: Record<number, number> = { 1: 100, 2: 400, 3: 2500, 4: 10000 };
const hpOf = (t: number) => HP[t] ?? null;

// --- Estimación sin datos ------------------------------------------------------
{
  const st = new MonsterTypeStats(hpOf);
  ok('mediana', median([5, 1, 3]) === 3 && median([]) === null);
  ok('sin nada medido: exp = sqrt(vida) × default', near(st.expOf(2), 20 * FARM.DEFAULT_EXP_PER_SQRT_HP));
  ok('sin nada medido: segundos = default', st.killSecOf(2) === FARM.DEFAULT_KILL_SEC);
  st.setExp(1, 1000);          // exp/sqrt(hp) = 1000/10 = 100
  st.recordKillSec(1, 2);      // dps = 100/2 = 50
  ok('exp medida se usa tal cual', st.expOf(1) === 1000);
  ok('exp estimada ∝ sqrt(vida) con la mediana medida', near(st.expOf(2), 20 * 100), st.expOf(2));
  ok('segundos estimados = vida / dps × 1.4', near(st.killSecOf(2), (400 / 50) * FARM.UNKNOWN_PESSIMISM), st.killSecOf(2));
  ok('vida desconocida (custom >= 300): mediana de exp medida', st.expOf(690) === 1000);
  ok('vida desconocida: segundos default', st.killSecOf(690) === FARM.DEFAULT_KILL_SEC);
  st.recordKillSec(1, 4);
  ok('segundos de kill con EMA 0.7/0.3', near(st.killSecByType[1], 2 * 0.7 + 4 * 0.3));
  st.recordKillSec(1, 0); st.recordKillSec(1, 600);
  ok('segundos fuera de rango no se aprenden', near(st.killSecByType[1], 2.6));
  const restored = new MonsterTypeStats(hpOf, FARM, st.snapshot());
  ok('snapshot/restaurar conserva lo aprendido', restored.expOf(1) === 1000 && near(restored.killSecOf(1), 2.6));
}

// --- Exp partida en tramos de 65535 ----------------------------------------------
{
  const st = new MonsterTypeStats(hpOf);
  const tr = new ExpSplitTracker(st);
  tr.see(500, { type: 3, x: 10, y: 10, map: 0 });
  tr.see(501, { type: 3, x: 12, y: 10, map: 0 });
  let ev = tr.onExp(500, 65535, 0);
  ok('primer tramo: valor = tramo', st.expByType[3] === 65535 && !ev.continuation);
  ev = tr.onExp(500, 65535, 300);
  ok('mismo id < 1.5 s: se suma (no se promedia)', st.expByType[3] === 131070 && ev.continuation && ev.sum === 131070, st.expByType);
  ev = tr.onExp(500, 20000, 900);
  ok('tercer tramo también se suma', st.expByType[3] === 151070 && ev.sum === 151070);
  ok('el evento trae tipo y posición del id (ya fuera de scope)', ev.info?.type === 3 && ev.info.x === 10);
  // Segundo kill del mismo tipo: EMA sobre la suma, partiendo del valor previo.
  tr.onExp(501, 65535, 5 * S);
  tr.onExp(501, 34465, 5 * S + 200);   // total 100000
  ok('kill partido siguiente: EMA 0.7/0.3 sobre la suma', near(st.expByType[3], 151070 * 0.7 + 100000 * 0.3), st.expByType[3]);
  // Mismo id pero pasada la ventana: es otro kill (ids se reciclan).
  tr.see(502, { type: 1, x: 0, y: 0, map: 0 });
  tr.onExp(502, 100, 10 * S);
  tr.onExp(502, 200, 10 * S + FARM.SPLIT_WINDOW_MS + 1);
  ok('mismo id fuera de la ventana: EMA, no suma', near(st.expByType[1], 100 * 0.7 + 200 * 0.3), st.expByType[1]);
  ev = tr.onExp(999, 50, 20 * S);
  ok('id nunca visto: no se atribuye a ningún tipo', ev.info === null && Object.keys(st.expByType).length === 2);
}

// --- Valor y elección de objetivo --------------------------------------------------
{
  const st = new MonsterTypeStats(hpOf);
  st.setExp(1, 100); st.recordKillSec(1, 1);    // débil: 100 exp en 1 s
  st.setExp(3, 600); st.recordKillSec(3, 10);   // duro: 600 exp en 10 s
  const me = { x: 0, y: 0 };
  const weak = { id: 1, type: 1, x: 5, y: 0 };
  const r = targetRate(me, weak, [weak], [], st);
  ok('valor = exp / (seg_kill + dist × 0.4)', near(r.rate, 100 / (1 + 5 * 0.4)), r);

  // Por exp/segundo, no por cercanía: uno débil más lejos le gana a uno duro al lado.
  const hard = { id: 2, type: 3, x: 1, y: 0 };
  const farWeak = { id: 3, type: 1, x: 10, y: 0 };
  ok('elige por exp/s, no por cercanía', pickTarget(me, [hard, farWeak], [], st)?.target.id === 3);

  // Duros (> 8 s) se descartan si hay alguno más rápido, aunque rindan más exp/s.
  st.setExp(4, 100000); st.recordKillSec(4, 20);  // 5000 exp/s pero tarda 20 s
  const boss = { id: 4, type: 4, x: 1, y: 1 };
  ok('> 8 s se descarta si hay alguno más rápido', pickTarget(me, [boss, farWeak], [], st)?.target.id === 3);
  ok('si solo hay duros, se elige igual', pickTarget(me, [boss], [], st)?.target.id === 4);

  // Densidad: otros a <= 3 tiles suman la mitad de su valor.
  const a = { id: 10, type: 1, x: 0, y: 6 };
  const b1 = { id: 11, type: 1, x: 10, y: 0 }, b2 = { id: 12, type: 1, x: 11, y: 1 }, b3 = { id: 13, type: 1, x: 12, y: 0 };
  const pool = [a, b1, b2, b3];
  const ra = targetRate(me, a, pool, [], st);
  const rb = targetRate(me, b2, pool, [], st);
  ok('densidad: +0.5 × valor de cada vecino a <= 3', near(rb.rate, (100 + 2 * 50) / (1 + 11 * 0.4)), rb);
  ok('sin vecinos: sin bonus', near(ra.rate, 100 / (1 + 6 * 0.4)));
  ok('un grupo un poco más lejos le gana al solitario (al más cercano del grupo)', pickTarget(me, pool, [], st)?.target.id === 11);

  // Competencia: cada jugador a <= 5 del objetivo multiplica por 0.4.
  const players = [{ x: 11, y: 3 }, { x: 9, y: 0 }, { x: 40, y: 40 }];
  const rc = targetRate(me, b2, pool, players, st);
  ok('competencia: × 0.4 por jugador a <= 5', rc.rivals === 2 && near(rc.rate, rb.rate * 0.4 * 0.4), rc);
  ok('con jugadores encima del grupo, va al solitario', pickTarget(me, pool, players, st)?.target.id === 10);

  ok('fuera de SCAN no se considera', pickTarget(me, [{ id: 20, type: 1, x: FARM.SCAN, y: 0 }], [], st) === null);
  ok('sin monstruos: null', pickTarget(me, [], [], st) === null);
}

// --- Autoevaluación -------------------------------------------------------------------
{
  const r = new SelfReport(0);
  r.addExp(1000, 1 * MIN);
  r.addExp(5000, 20 * MIN);
  r.addExp(3000, 31 * MIN);
  ok('exp/min en 5 min', near(r.expPerMin(31 * MIN, 5 * MIN), 3000 / 5));
  ok('exp/min en 30 min (lo de hace > 30 min no cuenta)', near(r.expPerMin(31 * MIN, 30 * MIN), 8000 / 30));
  r.addTime('fight', 600); r.addTime('walk', 300); r.addTime('wait', 100);
  const pct = r.timePct();
  ok('% de tiempo por fase', pct.fight === 60 && pct.walk === 30 && pct.wait === 10 && pct.other === 0, pct);
  r.cycleDone(45 * MIN);
  r.cycleDone(75 * MIN);
  ok('duración de cada ciclo de reset', r.cyclesMin.join() === '45,30', r.cyclesMin);
  const txt = r.format(80 * MIN, 123, 2);
  ok('informe legible con nivel, resets, exp/min y ciclos', txt.includes('nivel 123') && txt.includes('resets 2') && txt.includes('45 min, 30 min') && txt.includes('peleando 60%'), txt);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE FARMEO PASARON' : `\n${fails} TEST(S) DE FARMEO FALLARON`);
process.exit(fails ? 1 : 0);
