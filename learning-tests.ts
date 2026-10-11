/**
 * Tests offline de learning.ts: persistencia de lo aprendido, spots secos y la ruta fija por tramo.
 * Sin red; el disco solo en un dir temporal.
 *
 *   bun run learning-tests.ts
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEARN, chooseFixedRoute, routeTier, activeDryExclusions, CROWDED_SPOT_MS,
  loadLearning, saveLearningChar, parseLearning,
  type Spot,
} from './learning';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const MIN = 60_000;

// --- Persistencia --------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), 'mubot-learn-'));
  try {
    const path = join(dir, 'sub', 'learning.json');
    const miss = await loadLearning(path);
    ok('load: ausente = vacío', miss.status === 'missing' && Object.keys(miss.data.chars).length === 0, miss);

    await saveLearningChar(path, 'Horaz', { resets: 3 });
    await saveLearningChar(path, 'Melu', { resets: 1 });
    const back = await loadLearning(path);
    ok('save/load: crea el dir y conserva ambos personajes',
       back.status === 'ok' && back.data.chars.Horaz?.resets === 3 && back.data.chars.Melu?.resets === 1, back.data);
    const left = (await readdir(join(dir, 'sub'))).filter((f) => f.includes('.tmp-'));
    ok('save: no deja temporales (tmp + rename)', left.length === 0, left);

    await writeFile(path, '{"chars": {"Horaz": {"resets": 1, "samples": [{"spot": "x"}]}}}');
    const old = await loadLearning(path);
    ok('load: archivo viejo con "samples" se lee (y las ignora)', old.status === 'ok' && old.data.chars.Horaz.resets === 1 && !('samples' in old.data.chars.Horaz), old.data);

    await writeFile(path, '{"chars": {"Horaz": [trunc');
    const bad = await loadLearning(path);
    const files = await readdir(join(dir, 'sub'));
    ok('load: corrupto = vacío y backup .corrupt-*', bad.status === 'corrupt' && Object.keys(bad.data.chars).length === 0 &&
       files.some((f) => f.startsWith('learning.json.corrupt-')) && !files.includes('learning.json'), { bad, files });
    await saveLearningChar(path, 'Horaz', { resets: 0 });
    ok('save tras corrupto: archivo válido de nuevo', parseLearning(await readFile(path, 'utf8')).chars.Horaz != null);

    let threw = false;
    try { parseLearning('[]'); } catch { threw = true; }
    ok('parse: forma inválida lanza (load la trata como corrupta)', threw);

    await saveLearningChar(path, 'Farm', {
      resets: 1,
      hot: [{ map: 2, cx: 5, cy: 6, exp: 12345 }],
      types: { expByType: { 14: 900 }, killSecByType: { 14: 2.5 } },
    });
    await writeFile(path, (await readFile(path, 'utf8')).replace('"exp": 12345', '"exp": 12345}, {"map": "x"'));
    const farm = (await loadLearning(path)).data.chars.Farm;
    ok('save/load: spots calientes y exp/segundos por tipo (descarta celdas mal formadas)',
       farm.hot?.length === 1 && farm.hot[0].exp === 12345 && farm.types?.expByType[14] === 900 && farm.types.killSecByType[14] === 2.5, farm);

    await saveLearningChar(path, 'Camps', {
      resets: 2,
      camps: [{ map: 2, x: 90, y: 40, rate: 3e6, n: 4, level: 70 }, { map: 2, x: 'mal', y: 1, rate: 1, n: 1, level: 1 } as any],
      cycles: { cur: { start: 1000, marks: { 20: 1.5, 50: 3 } }, done: [{ start: 0, end: 900000, min: 15, marks: { 400: 14.8 } }] },
      tierRef: { t20: 4e6, t300: 'x' as any },
    });
    const camps = (await loadLearning(path)).data.chars.Camps;
    ok('save/load: memoria de campamentos (descarta mal formados)', camps.camps?.length === 1 && camps.camps[0].rate === 3e6 && camps.camps[0].level === 70, camps.camps);
    ok('save/load: ciclos (en curso y cerrados) y referencia por tramo',
       camps.cycles?.cur?.start === 1000 && camps.cycles.cur.marks[50] === 3 && camps.cycles.done[0].min === 15 && camps.tierRef?.t20 === 4e6 && camps.tierRef.t300 === undefined, camps);

  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Spots secos -------------------------------------------------------------------
{
  const dry = new Map([[6, 0], [7, 10 * MIN]]);
  const ex = activeDryExclusions(dry, 16 * MIN);
  ok('secos: vence a los DRY_EXCLUDE_MS', !ex.has(6) && ex.has(7) && LEARN.DRY_EXCLUDE_MS === 15 * MIN, [...ex]);
}

// --- Ruta fija por tramo (chooseFixedRoute) ------------------------------------
{
  const RS: Spot[] = [
    { index: 2, name: 'Lorencia', reqLevel: 10, zen: 0, map: 0 },
    { index: 6, name: 'Devias 3', reqLevel: 20, zen: 0, map: 2 },
    { index: 7, name: 'Devias 4', reqLevel: 20, zen: 0, map: 2 },
    { index: 5, name: 'Devias 2', reqLevel: 20, zen: 0, map: 2 },
    { index: 4, name: 'Devias 1', reqLevel: 20, zen: 0, map: 2 },
    { index: 1, name: 'Arena', reqLevel: 50, zen: 0 },
    { index: 24, name: 'Arena 2', reqLevel: 100, zen: 0, map: 83 },
    { index: 25, name: 'Arena 3', reqLevel: 200, zen: 0, map: 84 },
    { index: 26, name: 'Arena 4', reqLevel: 300, zen: 0, map: 85 },
  ];
  const sp = (i: number) => RS.find((s) => s.index === i)!;
  const base = { spots: RS, allowed: null, currentMap: -1, mapDead: false, crowded: false, crowdedAt: new Map<number, number>(), now: 10 * MIN };
  const go = (o: Partial<Parameters<typeof chooseFixedRoute>[0]> & { level: number; current: Spot | null }) => chooseFixedRoute({ ...base, ...o });

  ok('tramos: <20 Lorencia, 20-99 Devias, 100/200/300 Arenas 2/3/4',
     routeTier(5).warps.join() === '2' && routeTier(19).warps.join() === '2' && routeTier(20).warps.join() === '7,6,5' && routeTier(99).warps.join() === '7,6,5' &&
     routeTier(100).warps.join() === '24' && routeTier(250).warps.join() === '25' && routeTier(399).warps.join() === '26');
  let c = go({ level: 15, current: null, currentMap: 0 });
  ok('nivel < 20 parado en Lorencia: adopta sin warpear', c.reason === 'adopt' && c.spot?.index === 2 && !c.warp, c);
  c = go({ level: 5, current: null, currentMap: 3 });
  ok('nivel < 10 fuera de Lorencia: no puede warpear, se queda', !c.warp, c);
  c = go({ level: 20, current: sp(2) });
  ok('cruza el 20: Devias 4 (la preferida), nunca Devias 1', c.reason === 'new-tier' && c.spot?.index === 7 && c.warp, c);
  c = go({ level: 60, current: sp(7) });
  ok('en Devias 4 a nivel 60, sin nada raro: se queda (no prueba otros mapas)', c.reason === 'stay' && !c.warp, c);
  c = go({ level: 60, current: null, currentMap: 2 });
  ok('reconecta en Devias (mapa 2): adopta', c.reason === 'adopt' && c.spot?.map === 2 && !c.warp, c);
  c = go({ level: 60, current: null, prefer: 7 });
  ok('tras morir: vuelve a la misma entrada', c.reason === 'start' && c.spot?.index === 7 && c.warp, c);
  c = go({ level: 60, current: sp(6), mapDead: true });
  ok('mapa vacío: otra entrada del tramo', c.reason === 'dry' && c.spot?.index === 7, c);
  c = go({ level: 40, current: sp(6), crowded: true });
  ok('competencia antes del 50: otra entrada del tramo', c.reason === 'crowd' && c.spot?.index === 7, c);
  c = go({ level: 60, current: sp(7), crowded: true });
  ok('competencia desde el 50: otra entrada de Devias antes que Arena 1', c.reason === 'crowd' && c.spot?.index === 6, c);
  // Debajo del 100 una entrada "llena" vale 90 s (PR #39).
  const crowdedAt = new Map([[7, 10 * MIN - 30_000], [5, 10 * MIN - 60_000]]);
  c = go({ level: 60, current: sp(6), crowded: true, crowdedAt });
  ok('todas las Devias llenas hace poco (50-99): plan B Arena 1', c.reason === 'crowd' && c.spot?.index === 1, c);
  c = go({ level: 60, current: sp(6), crowded: true, crowdedAt, noFallback: true });
  ok('prioritario con todas llenas: no va a Arena 1, se queda', !c.warp && c.spot?.index === 6, c);
  c = go({ level: 40, current: sp(6), crowded: true, crowdedAt });
  ok('todas llenas pero nivel < 50: se queda', !c.warp && c.spot?.index === 6, c);
  c = go({ level: 40, current: sp(6), crowded: true, crowdedAt: new Map([[7, 10 * MIN - 90_000 - 1], [5, 10 * MIN - 60_000]]) });
  ok('una entrada llena hace > 5 min vuelve a servir', c.spot?.index === 7, c);
  c = go({ level: 70, current: sp(1) });
  ok('en el plan B (Arena 1) a nivel 70: se queda', c.reason === 'stay' && !c.warp, c);
  c = go({ level: 100, current: sp(1) });
  ok('cruza el 100 desde Arena 1: Arena 2', c.reason === 'new-tier' && c.spot?.index === 24, c);
  c = go({ level: 150, current: sp(24), mapDead: true });
  ok('Arena 2 vacía: no hay otra entrada, se queda', !c.warp && c.spot?.index === 24, c);
  c = go({ level: 200, current: sp(24) });
  ok('cruza el 200: Arena 3', c.spot?.index === 25 && c.warp, c);
  c = go({ level: 300, current: sp(25) });
  ok('cruza el 300: Arena 4', c.spot?.index === 26 && c.warp, c);
  c = go({ level: 320, current: null, currentMap: 85 });
  ok('reconecta en Arena 4: adopta', c.reason === 'adopt' && c.spot?.index === 26, c);
  c = go({ level: 60, current: sp(6), allowed: new Set([6, 5]), crowded: true });
  ok('--spots limita la ruta', c.spot?.index === 5, c);
}

// --- Adoptar la entrada correcta al reconectar ----------------------------------------------------
{
  const dv: Spot[] = [
    { index: 7, name: 'Devias 4', reqLevel: 20, zen: 0, map: 2, arrival: { x: 70, y: 179 } },
    { index: 6, name: 'Devias 3', reqLevel: 20, zen: 0, map: 2, arrival: { x: 226, y: 228 } },
  ];
  const base = { spots: dv, level: 60, allowed: null, current: null, currentMap: 2, mapDead: false, crowded: false, crowdedAt: new Map(), now: 0 };
  let c = chooseFixedRoute({ ...base, pos: { x: 205, y: 226 } });
  ok('reconecta junto a Devias 3: adopta Devias 3 (no cruza a Devias 4)', c.reason === 'adopt' && c.spot?.index === 6, c);
  c = chooseFixedRoute({ ...base, pos: { x: 72, y: 182 } });
  ok('reconecta junto a Devias 4: adopta Devias 4', c.reason === 'adopt' && c.spot?.index === 7, c);
  c = chooseFixedRoute({ ...base, pos: { x: 150, y: 100 } });
  ok('reconecta lejos de toda llegada: warp a la preferida', c.warp && c.spot?.index === 7, c);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE APRENDIZAJE PASARON' : `\n${fails} TEST(S) DE APRENDIZAJE FALLARON`);
process.exit(fails ? 1 : 0);
