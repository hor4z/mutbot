/**
 * Tests offline de insights.ts (datos de la base → decisiones). Sin red: las filas son sintéticas, con el
 * formato real de ClickHouse (los números grandes llegan como string), y se comprueba que sin datos todo es
 * neutral.
 *
 *   bun run insights-tests.ts
 */
import { INSIGHT, avoidCells, buildInsights, huntFactor, insights, predictDragonMap, summarize, type RawInsights } from './insights';
import { HUNT_DRAGON_BONUS, HUNT_PREDICTED_FRACTION, pickHuntMap } from './panel-logic';
import type { Invasion } from './panel-protocol';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const NOW = Date.UTC(2026, 9, 23, 18, 0, 0);
const empty = (): RawInsights => ({ hunts: [], kills: [], boxes: [], invasions: [], deaths: [], exposure: [], rivals: [], thieves: [] });
const hr = (day: number, hour: number) => Math.floor(Date.UTC(2026, 9, day, hour) / 1000);

// Datos con la forma de lo medido el 2026-10-23: Devias 12:50 UTC, Noria 13, 14, 15 y 17.
const real = (): RawInsights => ({
  ...empty(),
  hunts: [{ map: 0, minutes: 23.9, hunts: '3', seen: '6' }, { map: 2, minutes: 6.9, hunts: '2', seen: '3' }],
  kills: [{ map: 0, mine: '5', other: '1' }, { map: 2, mine: '1', other: '1' }],
  boxes: [{ map: 0, boxes: '6' }, { map: 2, boxes: '1' }],
  invasions: [{ hr: hr(23, 12), name: 'Devias' }, { hr: hr(23, 13), name: 'Noria' }, { hr: hr(23, 14), name: 'Noria' }, { hr: hr(23, 15), name: 'Noria' }, { hr: hr(23, 17), name: 'Noria' }],
  thieves: [{ killer: '', n: '1' }, { killer: 'cluster', n: '1' }],
});

// --- Sin datos / sin base: todo neutral y nada se rompe ------------------------------------------------------------
{
  ok('insights() sin base (MUBOT_DB_URL vacío): null y sin tirar', insights(NOW) === null);
  ok('huntFactor sin insights: 1', huntFactor(null, 0, NOW) === 1);
  ok('predictDragonMap sin insights: null', predictDragonMap(null, 17, NOW) === null);
  ok('avoidCells sin insights: undefined', avoidCells(null, 3, NOW) === undefined);
  const e = buildInsights(empty(), NOW);
  ok('insights vacíos: factor 1 y sin predicción', huntFactor(e, 0, NOW) === 1 && predictDragonMap(e, 17, NOW) === null && avoidCells(e, 3, NOW) === undefined);
  ok('filas basura no rompen buildInsights', (() => { try { buildInsights({ ...empty(), hunts: [{ map: 'x', minutes: null as never, hunts: 0, seen: NaN }], invasions: [{ hr: 'q', name: undefined as never }], deaths: [{ map: 1, cx: 'a', cy: null as never, player: 1, h: 99 }] }, NOW); return true; } catch { return false; } })());
}

// --- Dragón: el historial de invasiones --------------------------------------------------------------------------------
{
  const ins = buildInsights(real(), NOW);
  const p = predictDragonMap(ins, 20, NOW);
  ok('hora sin datos propios: el más frecuente en total (Noria, 4 de 5)', p?.map === 3 && p.scope === 'todas' && p.n === 5 && Math.abs(p.share - 0.8) < 1e-9, p);
  ok('las 12 UTC (una sola invasión): no alcanza para la hora, cae al total', predictDragonMap(ins, 12, NOW)?.scope === 'todas');
  const two = real();
  two.invasions.push({ hr: hr(22, 12), name: 'Devias' }, { hr: hr(21, 12), name: 'Devias' });
  const p2 = predictDragonMap(buildInsights(two, NOW), 12, NOW);
  ok('la hora con 3 invasiones y todas en Devias: Devias por hora', p2?.map === 2 && p2.scope === 'hora', p2);
  const mixed = { ...empty(), invasions: [{ hr: hr(23, 12), name: 'Devias' }, { hr: hr(22, 12), name: 'Noria' }, { hr: hr(21, 13), name: 'Lorencia' }, { hr: hr(20, 14), name: 'Atlans' }] };
  ok('sin mayoría clara (>= 60 %): no inventa', predictDragonMap(buildInsights(mixed, NOW), 12, NOW) === null);
  ok('mapas desconocidos se ignoran', predictDragonMap(buildInsights({ ...empty(), invasions: Array.from({ length: 6 }, (_, i) => ({ hr: hr(10 + i, 3), name: 'Mapa Raro' })) }, NOW), 3, NOW) === null);
  ok('datos viejos (> 2 h): se ignoran', predictDragonMap(ins, 20, NOW + INSIGHT.maxAgeMs + 1) === null);
}

// --- Rendimiento por mapa: exige datos --------------------------------------------------------------------------------
{
  const few = buildInsights(real(), NOW); // 30,8 min cazados en total < 60
  ok('con 31 min cazados en total no mueve nada', huntFactor(few, 0, NOW) === 1 && huntFactor(few, 2, NOW) === 1);
  const raw = real();
  raw.hunts = [{ map: 0, minutes: 120, hunts: 8, seen: 40 }, { map: 2, minutes: 90, hunts: 6, seen: 20 }, { map: 3, minutes: 30, hunts: 3, seen: 9 }];
  raw.boxes = [{ map: 0, boxes: '50' }, { map: 2, boxes: '10' }, { map: 3, boxes: '3' }];
  const ins = buildInsights(raw, NOW);
  const f0 = huntFactor(ins, 0, NOW), f2 = huntFactor(ins, 2, NOW);
  ok('el mapa que da más cajas por minuto sube (Lorencia)', f0 > 1 && f0 <= 1.3, f0);
  ok('el que da menos baja (Devias) y nunca bajo 0,7 por este dato', f2 < 1 && f2 >= 0.7, f2);
  ok('un mapa con 30 min cazados (Noria) queda acotado', huntFactor(ins, 3, NOW) >= 0.5 && huntFactor(ins, 3, NOW) <= 1.5);
  ok('un mapa sin datos: 1', huntFactor(ins, 8, NOW) === 1);
}

// --- Muertes: celdas letales y riesgo por hora de exposición ---------------------------------------------------------
{
  const raw = empty();
  raw.deaths = [
    { map: 3, cx: 7, cy: 5, player: 1, h: 12 }, { map: 3, cx: 7, cy: 5, player: 1, h: 13 }, { map: 3, cx: 5, cy: 7, player: 0, h: 18 },
    { map: 83, cx: 0, cy: 0, player: 1, h: 3 },
  ];
  raw.exposure = [{ map: 3, minutes: 85 }, { map: 83, minutes: 1053 }, { map: 2, minutes: 326 }];
  const ins = buildInsights(raw, NOW);
  ok('dos muertes en la misma celda: celda letal', avoidCells(ins, 3, NOW)?.has('7,5') === true && !avoidCells(ins, 3, NOW)?.has('5,7'));
  ok('la misma identidad entre llamadas (el recorrido no se rearma)', avoidCells(ins, 3, NOW) === avoidCells(ins, 3, NOW));
  ok('mapa sin muertes repetidas: sin celdas', avoidCells(ins, 83, NOW) === undefined);
  const dph3 = ins.deathsPerHour.get(3)!;
  ok('muertes por hora de exposición (Noria: 3 en 85 min)', Math.abs(dph3 - 3 / (85 / 60)) < 1e-9, dph3);
  ok('un mapa con mucha más muerte que el promedio baja su valor (pero no bajo 0,6)', huntFactor(ins, 3, NOW) < 1 && huntFactor(ins, 3, NOW) >= 0.6, huntFactor(ins, 3, NOW));
  ok('un mapa con poca exposición (< 60 min) no cuenta', huntFactor(buildInsights({ ...raw, exposure: [{ map: 3, minutes: 30 }, { map: 83, minutes: 1053 }] }, NOW), 3, NOW) === 1);
}

// --- Rivales a la vista a esta hora ---------------------------------------------------------------------------------------
{
  const raw = empty();
  raw.rivals = [{ map: 0, h: 18, seen: '708', snaps: '102' }, { map: 2, h: 18, seen: '90', snaps: '100' }, { map: 83, h: 18, seen: '2000', snaps: '500' }];
  const ins = buildInsights(raw, NOW); // NOW = 18 UTC
  ok('Lorencia a las 18 UTC (~6,9 rivales por foto) vale menos que Devias (~0,9)', huntFactor(ins, 0, NOW) < huntFactor(ins, 2, NOW) && huntFactor(ins, 0, NOW) >= 0.7, [huntFactor(ins, 0, NOW), huntFactor(ins, 2, NOW)]);
  ok('otra hora sin datos: 1', huntFactor(ins, 0, NOW + 3 * 3600_000) === 1);
}

// --- pickHuntMap con los datos --------------------------------------------------------------------------------------------
{
  const inv = (alive: Record<number, number>): Invasion => ({ status: 'active', total: 0, at: NOW, nextAt: NOW + 3600_000, maps: Object.entries(alive).map(([m, a]) => ({ map: +m, name: String(m), alive: a })) });
  const base = { invasion: inv({ 0: 20, 3: 20 }), level: 391 };
  ok('sin datos: igual que antes (Lorencia, valor 2, contra Noria, valor 1)', pickHuntMap(base).ok && (pickHuntMap(base) as { hunt: { map: number } }).hunt.map === 0);
  const f = pickHuntMap({ ...base, factor: (m) => (m === 0 ? 0.4 : 1) });
  ok('un factor bajo en Lorencia pasa a Noria', f.ok && f.hunt.map === 3, f);
  const pred = pickHuntMap({ invasion: inv({ 0: 14, 3: 20 }), level: 391, predictedDragon: 0 });
  const none = pickHuntMap({ invasion: inv({ 0: 14, 3: 20 }), level: 391 });
  ok('con una ventaja grande de valor (Lorencia 14×2 = 28 contra Noria 20) la predicción no cambia nada', pred.ok && none.ok && pred.hunt.map === 0 && none.hunt.map === 0);
  const close = pickHuntMap({ invasion: inv({ 0: 8, 3: 20 }), level: 391, predictedDragon: 0 });
  const closeNo = pickHuntMap({ invasion: inv({ 0: 8, 3: 20 }), level: 391 });
  ok(`Noria 20 contra Lorencia 16: sin predicción gana Noria; con el dragón probable en Lorencia (bonus ${HUNT_DRAGON_BONUS * HUNT_PREDICTED_FRACTION}) gana Lorencia`, closeNo.ok && closeNo.hunt.map === 3 && close.ok && close.hunt.map === 0, [closeNo, close]);
  const real = pickHuntMap({ invasion: inv({ 0: 8, 3: 20 }), level: 391, dragonMap: 3, predictedDragon: 0 });
  ok('con el aviso real del server la predicción no cuenta', real.ok && real.hunt.map === 3, real);
}

// --- Resumen para la estación ---------------------------------------------------------------------------------------------
{
  const s = summarize(buildInsights(real(), NOW), NOW);
  ok('resumen: dragón probable Noria y lista de ladrones sin vacíos', s.dragon?.name === 'Noria' && s.thieves.every((t) => t.name), s);
  ok('el resumen entra en el tope de 1 KB del POST', JSON.stringify(s).length < 1000, JSON.stringify(s).length);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE DATOS PASARON' : `\n${fails} TEST(S) DE DATOS FALLARON`);
process.exit(fails ? 1 : 0);
