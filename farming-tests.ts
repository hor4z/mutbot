/**
 * Tests offline del farmeo por exp/segundo (farming.ts): valor de un objetivo,
 * elección, estimación sin datos, exp de kills partida en tramos de 65535 y
 * autoevaluación. Sin red, con reloj simulado.
 *
 *   bun run farming-tests.ts
 */
import { CycleLog, ExpLog, ExpSplitTracker, FARM, MonsterTypeStats, SelfReport, isValuableDrop, median, pickLoot, pickTarget, planStats, capStats, targetRate, classFamily, isFreshChar, planFreshStats } from './farming';

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

  // Competencia: cada jugador a <= 5 del objetivo resta 0.3 (× 0.7), como el agente web.
  const players = [{ x: 11, y: 3 }, { x: 9, y: 0 }, { x: 40, y: 40 }];
  const rc = targetRate(me, b2, pool, players, st);
  ok('competencia: penalización 0.3 por jugador a <= 5', FARM.COMPETITION_FACTOR === 0.7 && rc.rivals === 2 && near(rc.rate, rb.rate * 0.7 * 0.7), rc);
  ok('con jugadores encima del grupo, va al solitario', pickTarget(me, pool, players, st)?.target.id === 10);

  ok('fuera de SCAN no se considera', pickTarget(me, [{ id: 20, type: 1, x: FARM.SCAN, y: 0 }], [], st) === null);
  ok('sin monstruos: null', pickTarget(me, [], [], st) === null);
}

// --- Autoevaluación -------------------------------------------------------------------
{
  const r = new SelfReport(0);
  r.addExp(1000, 0.5 * MIN);
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

// --- Registro de exp por segundo ---------------------------------------------------------
{
  // Un kill grande a nivel alto: ~60 tramos de 65535 en el mismo segundo.
  const log = new ExpLog(0, 300);
  for (let k = 0; k < 600; k++) for (let i = 0; i < 60; i++) log.add(65535, k * S + i * 10);
  ok('un bucket por segundo, no uno por tramo', log.size === 300, log.size);
  ok('el tope en segundos cubre minutos aunque lleguen 60 tramos/s', near(log.sumSince(500 * S), 100 * 60 * 65535));
  // Antes (un registro por tramo, tope fijo) 5000 lugares cubrían ~83 s acá.
  const full = new ExpLog(0);
  for (let k = 0; k < 180; k++) for (let i = 0; i < 60; i++) full.add(65535, k * S + i * 10);
  ok('3 min de kills partidos: la medición de 3 min no sale truncada', near(full.perMin(180 * S, 3 * MIN), 60 * 65535 * 60), full.perMin(180 * S, 3 * MIN));
  const young = new ExpLog(0);
  for (let k = 0; k < 60; k++) young.add(1000, k * S);
  ok('ventana real: con 1 min de registro, "30 min" divide por 1 min', near(young.perMin(60 * S, 30 * MIN), 60_000), young.perMin(60 * S, 30 * MIN));
  ok('rateSince: exp/min desde un instante', near(full.rateSince(120 * S, 180 * S), 60 * 65535 * 60));
  ok('sin tiempo transcurrido: 0', full.rateSince(180 * S, 180 * S) === 0);
  full.add(0, 200 * S); full.add(-5, 200 * S);
  ok('exp <= 0 no se registra', full.sumSince(190 * S) === 0);
}

// --- Registro de tramos por ciclo -------------------------------------------------------
{
  const c = new CycleLog(0);
  ok('hitos nuevos al subir', c.observe(25, 2 * MIN).join() === '20' && c.observe(120, 4 * MIN).join() === '50,100');
  ok('un hito se registra una sola vez', c.observe(130, 5 * MIN).length === 0 && c.cur.marks[20] === 2);
  c.observe(400, 15 * MIN);
  const closed = c.reset(16 * MIN);
  ok('reset tras el 400: se cierra el ciclo con sus minutos', closed?.min === 16 && closed.marks[400] === 15 && c.done.length === 1, closed);
  c.observe(250, 20 * MIN);
  ok('ciclo empezado sin llegar al 400 no se guarda', c.reset(30 * MIN) === null && c.done.length === 1);
  c.observe(400, 44 * MIN); c.reset(44 * MIN);
  const p = c.projection();
  ok('proyección resets/día = 1440 / promedio', p.cycles === 2 && p.avgMin === 15 && p.perDay === 96, p);
  const restored = new CycleLog(99 * MIN, { cur: c.cur, done: c.done });
  ok('retomar: el ciclo en curso conserva su inicio', restored.cur.start === 44 * MIN && restored.done.length === 2);
  ok('informe con la proyección', c.format().includes('96 resets/día'), c.format());
  ok('sin ciclos: sin proyección', new CycleLog(0).projection().perDay === null);
}

// --- Reparto de puntos ------------------------------------------------------------------------
{
  let p = planStats(1000, 10000, 3000);
  ok('energía lejos de fuerza − 2000: todo a energía salvo 5% vitalidad', p.vit === 50 && p.ene === 950 && p.str === 0, p);
  p = planStats(1000, 10000, 7900);
  ok('cerca: completa el hueco y el resto mitad/mitad', p.vit === 50 && p.ene === 100 + 425 && p.str === 425, p);
  p = planStats(1001, 5000, 5000);
  ok('arriba de fuerza − 2000: mitad/mitad', p.vit === 50 && p.ene + p.str === 951 && Math.abs(p.ene - p.str) <= 1, p);
  ok('sin puntos: nada', planStats(0, 1, 1).ene === 0);
  const full = { str: 65535, agi: 1000, vit: 2000, ene: 65535 };
  let c = capStats({ ene: 400, str: 500, vit: 100 }, full);
  ok('tope: fuerza y energía al tope → todo a agilidad', c.str === 0 && c.ene === 0 && c.agi === 900 && c.vit === 100, c);
  c = capStats({ ene: 400, str: 500, vit: 100 }, { str: 65400, agi: 65535, vit: 0, ene: 0 });
  ok('tope: fuerza casi al tope → 135 a fuerza, el resto a vitalidad (agilidad llena)', c.str === 135 && c.ene === 400 && c.agi === 0 && c.vit === 465, c);
  c = capStats({ ene: 10 }, { str: 65535, agi: 65535, vit: 65535, ene: 65535 });
  ok('tope: todo lleno → nada (no insistir con /add)', c.str + c.agi + c.vit + c.ene === 0, c);
}

// --- Loot valioso ------------------------------------------------------------------------------
{
  ok('solo cajas', isValuableDrop({ group: 14, num: 11 }) && ![13, 14, 16, 22, 31].some((n) => isValuableDrop({ group: 14, num: n })) && !isValuableDrop({ group: 12, num: 15 }));
  ok('excelentes, guantes, pociones y zen: no', !isValuableDrop({ group: 5, num: 3, excellent: true }) && !isValuableDrop({ group: 10, num: 1 }) && !isValuableDrop({ group: 14, num: 1 }) && !isValuableDrop({ group: 14, num: 11, isMoney: true }));
  const me = { x: 50, y: 50 };
  const ds = [
    { id: 1, x: 52, y: 50, group: 14, num: 1 },          // poción: no
    { id: 2, x: 58, y: 50, group: 14, num: 11 },         // caja a 8
    { id: 3, x: 54, y: 50, group: 14, num: 11 },         // caja a 4
    { id: 4, x: 70, y: 50, group: 14, num: 11 },         // caja a 20: lejos
  ];
  ok('la caja más cercana a <= 12', pickLoot(me, ds)?.id === 3);
  ok('nada valioso cerca: null', pickLoot(me, [ds[0], ds[3]]) === null);
}

// --- Personaje nuevo: reparto por clase ---------------------------------------------------
{
  const dk = planFreshStats(45, 'knight');
  ok('nuevo: DK sobre todo fuerza, sin energía, reparte todo', dk.str > dk.agi && dk.agi > 0 && dk.ene === 0 && dk.str + dk.agi + dk.vit === 45, dk);
  const dw = planFreshStats(5, 'wizard');
  ok('nuevo: mago energía primero', dw.ene >= 3 && dw.str === 0 && dw.ene + dw.agi + dw.vit === 5, dw);
  ok('nuevo: clase por classId (DK 4, BK 6, DW 0, SM 2, Elf 8, MG 12)', classFamily(4) === 'knight' && classFamily(6) === 'knight' && classFamily(0) === 'wizard' && classFamily(2) === 'wizard' && classFamily(8) === 'elf' && classFamily(12) === 'gladiator' && classFamily(null) === null);
  ok('nuevo: sin resets y pocos stats sí; con resets o stats altos no',
    isFreshChar(0, { str: 28, agi: 20, vit: 25, ene: 10 }) && isFreshChar(null, { str: 28, agi: 20, vit: 25, ene: 10 })
    && !isFreshChar(120, { str: 28, agi: 20, vit: 25, ene: 10 }) && !isFreshChar(null, { str: 65535, agi: 100, vit: 100, ene: 65535 }));
}

// --- Personaje nuevo: también zen y pociones -----------------------------------------------
{
  const money = { isMoney: true, group: 0, num: 0 } as any;
  const potion = { isMoney: false, group: 14, num: 1 } as any;
  const box = { isMoney: false, group: 14, num: 11 } as any;
  ok('loot: con resets ni zen ni pociones (como siempre)', !isValuableDrop(money) && !isValuableDrop(potion) && isValuableDrop(box));
  ok('loot: personaje nuevo levanta zen, pociones y cajas', isValuableDrop(money, true) && isValuableDrop(potion, true) && isValuableDrop(box, true));
  const zenItem = { isMoney: false, group: 14, num: 15 } as any;
  const sword = { isMoney: false, group: 0, num: 1 } as any;
  ok('loot: zen como ítem 14/15 y joyas (nuevo)', isValuableDrop(zenItem, true) && isValuableDrop({ isMoney: false, group: 14, num: 13 } as any, true));
  ok('loot: equipo solo con lugar (gear)', isValuableDrop(sword, true, true) && !isValuableDrop(sword, true, false) && !isValuableDrop(sword));
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE FARMEO PASARON' : `\n${fails} TEST(S) DE FARMEO FALLARON`);
process.exit(fails ? 1 : 0);
