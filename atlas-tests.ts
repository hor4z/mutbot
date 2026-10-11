/**
 * Tests offline del explorador / atlas (atlas.ts): lista de mapas por nivel,
 * presupuesto por mapa, conteo de ids distintos, lastSeen, dorados sin
 * duplicar, persistencia y reporte. Sin red, con reloj simulado y un dir temporal.
 *
 *   bun run atlas-tests.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATLAS_GOLD_DEDUPE_MS, Atlas, AtlasSaver, atlasCellKey, atlasMapDone, atlasMapList, formatAtlasReport, loadAtlas, nextAtlasIndex,
  parseAtlasMaps, saveAtlas, type AtlasSighting,
} from './atlas';
import { HuntExplorer } from './panel-logic';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const MIN = 60_000;

// --- Lista de mapas por nivel -----------------------------------------------------
{
  const l120 = atlasMapList(null, 120);
  ok('nivel 120: Lorencia, Noria, Devias, Dungeon, Lost Tower, Atlans', JSON.stringify(l120.maps.map((m) => m.map)) === '[0,3,2,1,4,7]', l120.maps);
  ok('nivel 120: Tarkan (140) se saltea con motivo', l120.skipped.length === 1 && l120.skipped[0].map === 8 && /140/.test(l120.skipped[0].why), l120.skipped);
  const l150 = atlasMapList(null, 150);
  ok('nivel 150: entra Tarkan', l150.maps.some((m) => m.map === 8 && m.warp === 21));
  const l25 = atlasMapList(null, 25);
  ok('nivel 25: solo Lorencia, Noria, Devias', JSON.stringify(l25.maps.map((m) => m.map)) === '[0,3,2]', l25.maps);
  const req = atlasMapList([7, 10, 0, 7], 120);
  ok('pedidos: respeta el orden y no repite', JSON.stringify(req.maps.map((m) => m.map)) === '[7,0]', req.maps);
  ok('pedidos: mapa sin warp en la tabla se saltea con log', req.skipped.length === 1 && req.skipped[0].map === 10 && /warp/.test(req.skipped[0].why), req.skipped);
  ok('--atlas-maps 0,3,2', JSON.stringify(parseAtlasMaps('0, 3,2')) === '[0,3,2]');
  ok('--atlas-maps vacío o basura → default', parseAtlasMaps('') === null && parseAtlasMaps('x,') === null && parseAtlasMaps(undefined) === null);
}

// --- Presupuesto por mapa -------------------------------------------------------
{
  ok('a los 11 min sigue', atlasMapDone({ since: 0, now: 11 * MIN, minutes: 12 }) === null);
  ok('a los 12 min pasa al siguiente', /12 min/.test(atlasMapDone({ since: 0, now: 12 * MIN, minutes: 12 }) ?? ''));
  ok('mapa recorrido entero: pasa aunque sobre tiempo', /celdas/.test(atlasMapDone({ since: 0, now: MIN, minutes: 12, fullPass: true }) ?? ''));
  ok('siguiente mapa: avanza y da la vuelta', nextAtlasIndex(0, 3) === 1 && nextAtlasIndex(2, 3) === 0 && nextAtlasIndex(0, 0) === 0);
  const ex = new HuntExplorer();
  ok('explorador: 100 celdas en un mapa de 256', ex.totalCells() === 100, ex.totalCells());
  let t = 0;
  let p = { x: 12, y: 12 };
  for (let i = 0; i < 101 && ex.passes === 0; i++) {
    p = ex.next(p.x, p.y, t);
    t += 1000;
  }
  ok('explorador: una vuelta entera suma passes', ex.passes === 1, ex.passes);
}

// --- Registro: ids distintos, lastSeen, dorados ------------------------------------------
{
  const a = new Atlas();
  const s = (o: Partial<AtlasSighting>): AtlasSighting => ({ map: 7, x: 30, y: 40, id: 1, type: 45, name: 'Bahamut', golden: false, duringInvasion: false, ...o });
  a.observe(s({}), 1000);
  a.observe(s({}), 2000); // mismo id: no suma
  a.observe(s({ id: 2, x: 31 }), 3000);
  const cell = atlasCellKey(30, 40);
  const e = a.data.maps['7'][cell]['45'];
  ok('celda de 25 tiles', cell === '1,1', cell);
  ok('seen = ids distintos (2)', e.seen === 2, e);
  ok('lastSeen = el último', e.lastSeen === 3000, e);
  ok('sampleXY del último id nuevo', e.sampleXY[0] === 31, e.sampleXY);
  a.observe(s({ id: 1, x: 60 }), 4000);
  ok('el mismo id en otra celda cuenta en esa celda', a.data.maps['7']['2,1']['45'].seen === 1);
  a.beginVisit(7);
  a.observe(s({}), 5000);
  ok('otra visita al mapa: vuelve a contar', a.data.maps['7'][cell]['45'].seen === 3, a.data.maps['7'][cell]['45']);
  ok('dirty tras observar', a.dirty);

  const g1 = a.observe(s({ id: 77, type: 79, name: 'Golden Dragon', golden: true, duringInvasion: true }), 10_000);
  const g2 = a.observe(s({ id: 77, type: 79, name: 'Golden Dragon', golden: true, duringInvasion: true, x: 35 }), 12_000);
  ok('dorado nuevo vuelve para el log', !!g1 && g1.duringInvasion && g1.map === 7, g1);
  ok('mismo dorado (mismo id) no se duplica', g2 === null && a.data.goldens.length === 1, a.data.goldens);
  const g3 = a.observe(s({ id: 77, type: 79, name: 'Golden Dragon', golden: true }), 10_000 + ATLAS_GOLD_DEDUPE_MS + 1);
  ok('id reusado mucho después: otro avistamiento', !!g3 && a.data.goldens.length === 2 && !g3.duringInvasion);
  ok('mismo id en otro mapa: otro dorado', !!a.observe(s({ map: 3, id: 77, type: 79, name: 'Golden Dragon', golden: true }), 20_000));

  // Persistencia y merge entre corridas: se carga, se suma, se guarda.
  const dir = mkdtempSync(join(tmpdir(), 'mubot-atlas-'));
  try {
    const path = join(dir, 'sub', 'atlas.json');
    ok('archivo inexistente → atlas vacío', Object.keys(loadAtlas(path).maps).length === 0);
    saveAtlas(a.data, path);
    const b = new Atlas(loadAtlas(path));
    b.observe(s({ id: 9 }), 50_000);
    ok('corrida nueva: suma sobre lo guardado', b.data.maps['7'][cell]['45'].seen === 4 && b.data.goldens.length === 3, b.data.maps['7'][cell]['45']);
    ok('corrida nueva: dorado guardado sigue sin duplicarse', b.observe(s({ map: 3, id: 77, type: 79, name: 'Golden Dragon', golden: true }), 21_000) === null);
    await Bun.write(path, '{roto');
    ok('archivo roto → vacío, sin tirar', loadAtlas(path).goldens.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const saver = new AtlasSaver(30_000);
  ok('guardar: la primera vez con cambios sí', saver.due(a, 100_000));
  ok('guardar: no antes de 30 s', !saver.due(a, 120_000));
  ok('guardar: a los 30 s sí', saver.due(a, 130_000));
  a.dirty = false;
  ok('guardar: sin cambios no', !saver.due(a, 200_000));

  const rep = formatAtlasReport(a.data, { time: (ms) => `t${ms}` });
  ok('reporte: mapa con su nombre', /== Atlans \(mapa 7\)/.test(rep), rep);
  ok('reporte: tipo más visto (suma de celdas)', /Bahamut \[45\] ×4/.test(rep), rep);
  ok('reporte: dorados con hora y si fue en la invasión', /t10000 {2}Atlans \(30,40\) {2}Golden Dragon \[79\] {2}invasión/.test(rep) && /FUERA de la invasión/.test(rep), rep);
  ok('reporte: dorados ordenados por mapa', rep.indexOf('Noria (30,40)') < rep.indexOf('Atlans (30,40)'), rep);
  ok('reporte vacío', /vacío/.test(formatAtlasReport({ version: 1, maps: {}, goldens: [] })));
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DEL ATLAS PASARON' : `\n${fails} TEST(S) DEL ATLAS FALLARON`);
process.exit(fails ? 1 : 0);
