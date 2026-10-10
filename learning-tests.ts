/**
 * Tests offline de la capa de aprendizaje (learning.ts): medición, agregado,
 * bandit de spots y persistencia. Sin red; el disco solo en un dir temporal.
 *
 *   bun run learning-tests.ts
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEARN, SpotMeter, aggregate, chooseSpot, eligibleSpots, formatSpotTable,
  loadLearning, saveLearningChar, parseLearning, sampleWeight,
  type Spot, type SpotSample,
} from './learning';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const MIN = 60_000;
const SPOTS: Spot[] = [
  { index: 2, name: 'Lorencia', reqLevel: 10, zen: 1000 },
  { index: 8, name: 'Dungeon', reqLevel: 30, zen: 3000 },
  { index: 11, name: 'Atlans', reqLevel: 70, zen: 4000 },
  { index: 12, name: 'Atlans 2', reqLevel: 80, zen: 4500 },
  { index: 13, name: 'Atlans 3', reqLevel: 90, zen: 5000 },
  { index: 21, name: 'Tarkan', reqLevel: 140, zen: 8000 },
];
const byIdx = (i: number) => SPOTS.find((s) => s.index === i)!;
const sample = (spot: number, minutes: number, exp: number, o: Partial<SpotSample> = {}): SpotSample => ({
  spot, level: 150, reset: 0, ms: minutes * MIN, exp, kills: Math.round(exp / 100), deaths: 0, at: '2026-10-10T00:00:00Z', ...o,
});
const base = { spots: SPOTS, level: 150, reset: 0, allowed: null, dwellMs: Infinity };

// --- SpotMeter --------------------------------------------------------------
{
  const m = new SpotMeter();
  m.addExp(100); m.addKill();
  ok('meter: sin spot no acumula', m.peek(0) === null);
  m.start(13, 150, 2, 0);
  m.addExp(500); m.addExp(300); m.addKill(); m.addKill();
  const s = m.flush(2 * MIN, 151)!;
  ok('meter: tramo con exp/kills/nivel/reset', s.spot === 13 && s.exp === 800 && s.kills === 2 && s.ms === 2 * MIN && s.level === 150 && s.reset === 2, s);
  const next = m.peek(3 * MIN)!;
  ok('meter: flush arranca tramo nuevo con el nivel actual', next.exp === 0 && next.level === 151 && next.ms === MIN, next);
  ok('meter: tramo corto sin muertes se descarta', m.flush(2 * MIN + 5_000) === null);
  ok('meter: muerte cuenta', m.addDeath(10 * MIN) === true);
  ok('meter: HP0 + ObjectGotKilled juntos = 1 muerte', m.addDeath(10 * MIN + 2_000) === false);
  ok('meter: otra muerte pasado el debounce', m.addDeath(11 * MIN) === true);
  const d = m.flush(11 * MIN + 1_000)!;
  ok('meter: tramo corto CON muerte se guarda', d != null && d.deaths === 2, d);
  m.stop(); m.addExp(9);
  ok('meter: stop deja de medir', m.peek(12 * MIN) === null);
}

// --- Agregado ----------------------------------------------------------------
{
  ok('peso: mismo nivel/reset = 1', sampleWeight(sample(13, 1, 0), 150, 0) === 1);
  ok('peso: fuera de ventana = 0', sampleWeight(sample(13, 1, 0, { level: 100 }), 150, 0) === 0);
  ok('peso: otro reset pesa la mitad', sampleWeight(sample(13, 1, 0, { reset: 1 }), 150, 0) === LEARN.OTHER_RESET_WEIGHT);
  const st = aggregate([sample(13, 5, 2000), sample(13, 5, 3000), sample(21, 10, 3000, { deaths: 1 })], 150, 0);
  const a3 = st.get(13)!;
  ok('agregado: exp/min de Atlans 3 = 500', Math.abs(a3.expPerMin - 500) < 1e-9 && a3.n === 2 && a3.minutes === 10, a3);
  const t = st.get(21)!;
  ok('agregado: muerte baja la tasa efectiva (3000/(10+3))', Math.abs(t.rate - 3000 / (10 + LEARN.DEATH_COST_MIN)) < 1e-9 && t.expPerMin === 300, t);
}

// --- Bandit ------------------------------------------------------------------
{
  ok('elegibles: por nivel y --spots, mayor reqLevel primero',
     eligibleSpots(SPOTS, 85, new Set([2, 11, 12, 13])).map((s) => s.index).join() === '12,11,2');

  const c0 = chooseSpot({ ...base, current: null, samples: [] });
  ok('sin datos: regla vieja (mayor reqLevel)', c0.spot?.index === 21 && c0.reason === 'no-data', c0);

  const c1 = chooseSpot({ ...base, current: null, samples: [] , allowed: new Set([8, 13]) });
  ok('sin datos + --spots: el mayor permitido', c1.spot?.index === 13, c1.spot);

  const cNone = chooseSpot({ ...base, level: 5, current: null, samples: [] });
  ok('sin elegibles: none', cNone.spot === null && cNone.reason === 'none', cNone.reason);

  const dw = chooseSpot({ ...base, current: byIdx(13), dwellMs: 2 * MIN, samples: [sample(21, 30, 30000)] });
  ok('permanencia mínima: no se mueve antes de 5 min', dw.spot?.index === 13 && dw.reason === 'dwell', dw);

  // Explora spots sin datos del top-K antes de explotar.
  const ex = chooseSpot({ ...base, current: byIdx(21), samples: [sample(21, 20, 8000)] });
  ok('explora el top-K sin datos (Atlans 3)', ex.spot?.index === 13 && ex.reason === 'explore', ex);

  // Todos los del top-K con datos: explota al mejor y lo explica.
  const lots = [sample(21, 60, 60 * 380), sample(13, 60, 60 * 412), sample(12, 60, 60 * 200), sample(11, 60, 60 * 150)];
  const best = chooseSpot({ ...base, current: byIdx(21), samples: lots });
  ok('explota: Atlans 3 (412) le gana a Tarkan (380)', best.spot?.index === 13 && best.reason === 'exploit', best);
  ok('what explica el porqué', /Atlans 3: 412 exp\/min vs Tarkan 380 exp\/min \(n=1\)/.test(best.what), best.what);

  const stay = chooseSpot({ ...base, current: byIdx(13), samples: lots });
  ok('ya en el mejor: se queda', stay.spot?.index === 13 && stay.reason === 'stay', stay.reason);

  // Histéresis: casi iguales -> no se mueve.
  const close = [sample(21, 60, 60 * 400), sample(13, 60, 60 * 404), sample(12, 60, 60 * 100), sample(11, 60, 60 * 100)];
  const h = chooseSpot({ ...base, current: byIdx(21), samples: close });
  ok('histéresis: 404 vs 400 no justifica el warp', h.spot?.index === 21 && h.reason === 'stay', h);

  // Muertes penalizan: más exp cruda pero muriendo seguido pierde.
  const deadly = [sample(21, 30, 30 * 500, { deaths: 6 }), sample(13, 30, 30 * 400), sample(12, 30, 30 * 100), sample(11, 30, 30 * 100)];
  const d = chooseSpot({ ...base, current: byIdx(21), samples: deadly });
  ok('muertes: Tarkan 500 exp/min con 6 muertes pierde contra Atlans 3 400', d.spot?.index === 13, { spot: d.spot, what: d.what });

  // Poca evidencia: UCB vuelve a mirar un spot con pocos minutos aunque su tasa sea algo menor.
  const thin = [sample(21, 300, 300 * 400), sample(13, 1.5, 1.5 * 380), sample(12, 300, 300 * 100), sample(11, 300, 300 * 100)];
  const u = chooseSpot({ ...base, current: byIdx(21), samples: thin });
  ok('UCB: revisa un spot con poca evidencia', u.spot?.index === 13 && u.ucb.get(13)! > u.ucb.get(21)!, { spot: u.spot?.name, ucb: [...u.ucb] });

  // Spot actual inelegible (p.ej. después de un reset): cambio forzado.
  const inel = chooseSpot({ ...base, level: 40, current: byIdx(21), dwellMs: MIN, samples: [] });
  ok('actual inelegible: cambia aunque no cumpla permanencia', inel.spot?.index === 8 && inel.reason === 'ineligible', inel);

  // Muestras de otro nivel no cuentan: a nivel 40, lo medido en 150 no influye.
  const old = chooseSpot({ ...base, level: 40, current: null, samples: [sample(2, 60, 60 * 9999)] });
  ok('muestras de otro nivel se ignoran', old.spot?.index === 8 && old.reason === 'no-data', old);

  const table = formatSpotTable(SPOTS, best.stats, 13, best.ucb);
  ok('tabla: marca el actual y ordena por tasa', /^\* Atlans 3/m.test(table) && table.indexOf('Atlans 3') < table.indexOf('Tarkan'), table);
}

// --- Persistencia --------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), 'mubot-learn-'));
  try {
    const path = join(dir, 'sub', 'learning.json');
    const miss = await loadLearning(path);
    ok('load: ausente = vacío', miss.status === 'missing' && Object.keys(miss.data.chars).length === 0, miss);

    await saveLearningChar(path, 'Horaz', { resets: 3, samples: [sample(13, 5, 2000)] });
    await saveLearningChar(path, 'Melu', { resets: 0, samples: [sample(2, 5, 100)] });
    const back = await loadLearning(path);
    ok('save/load: crea el dir y conserva ambos personajes',
       back.status === 'ok' && back.data.chars.Horaz?.resets === 3 && back.data.chars.Horaz.samples[0].exp === 2000 &&
       back.data.chars.Melu?.samples.length === 1, back.data);
    const left = (await readdir(join(dir, 'sub'))).filter((f) => f.includes('.tmp-'));
    ok('save: no deja temporales (tmp + rename)', left.length === 0, left);

    await writeFile(path, '{"chars": {"Horaz": {"resets": 1, "samples": [{"spot": "x"}, ' + JSON.stringify(sample(13, 1, 50)) + ']}}}');
    const partial = await loadLearning(path);
    ok('load: descarta muestras mal formadas, no todo', partial.status === 'ok' && partial.data.chars.Horaz.samples.length === 1, partial.data);

    await writeFile(path, '{"chars": {"Horaz": [trunc');
    const bad = await loadLearning(path);
    const files = await readdir(join(dir, 'sub'));
    ok('load: corrupto = vacío y backup .corrupt-*', bad.status === 'corrupt' && Object.keys(bad.data.chars).length === 0 &&
       files.some((f) => f.startsWith('learning.json.corrupt-')) && !files.includes('learning.json'), { bad, files });
    await saveLearningChar(path, 'Horaz', { resets: 0, samples: [] });
    ok('save tras corrupto: archivo válido de nuevo', parseLearning(await readFile(path, 'utf8')).chars.Horaz != null);

    let threw = false;
    try { parseLearning('[]'); } catch { threw = true; }
    ok('parse: forma inválida lanza (load la trata como corrupta)', threw);

    const many = Array.from({ length: LEARN.MAX_SAMPLES + 10 }, (_, i) => sample(13, 1, i));
    await saveLearningChar(path, 'Big', { resets: 0, samples: many });
    const big = (await loadLearning(path)).data.chars.Big.samples;
    ok('save: recorta a MAX_SAMPLES, conserva las últimas', big.length === LEARN.MAX_SAMPLES && big.at(-1)!.exp === many.at(-1)!.exp, big.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE APRENDIZAJE PASARON' : `\n${fails} TEST(S) DE APRENDIZAJE FALLARON`);
process.exit(fails ? 1 : 0);
