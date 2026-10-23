/**
 * Tests offline del explorador (scout.ts): recorrido seguro de mapas, publicación cada 30-60 s, peligro/muerte/traba,
 * y el consumo de reportes por los cazadores (factor del mapa, pistas, tolerancia a datos viejos o basura).
 * Reloj simulado, sin red.
 *
 *   bun run scout-tests.ts
 */
import { HUNT_MAPS, pickHuntMap } from './panel-logic';
import type { Invasion } from './panel-protocol';
import { SCOUT, SCOUT_FRESH_MS, ScoutPublisher, ScoutTour, buildScoutBody, coveredMaps, freshReports, scoutDanger, scoutFactor, scoutHints, scoutMaps, type ScoutInfo, type TourInput } from './scout';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
// Generador fijo (LCG) para que los tests no dependan del azar.
const seeded = (seed = 7) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const names = (l: { name: string }[]) => l.map((h) => h.name).join(',');
const MIN = 60_000;
const inp = (o: Partial<TourInput>): TourInput => ({ now: 0, map: 0, level: 400, weak: false, deaths: 0, danger: null, lapDone: false, ...o });

// --- Mapas seguros ------------------------------------------------------------------------------------------
{
  ok('nivel 5: ningún mapa', scoutMaps(5, false).length === 0);
  ok('nivel 30 limitado: Lorencia y Noria, no Devias', names(scoutMaps(30, true)) === 'Lorencia,Noria', names(scoutMaps(30, true)));
  ok('nivel 95 limitado: hasta Devias, nunca Atlans', names(scoutMaps(95, true)) === 'Lorencia,Noria,Devias');
  ok('nivel 100 completo: hasta Atlans', names(scoutMaps(100, false)) === 'Lorencia,Noria,Devias,Atlans');
  ok('nivel 400: todos los de la lista', scoutMaps(400, false).length === HUNT_MAPS.length);
  ok('peligro: vida baja', scoutDanger({ hpPct: 40, threats: 0 })?.includes('vida') === true);
  ok('peligro: monstruo que no puede', scoutDanger({ hpPct: 100, threats: 2 })?.includes('2 monstruos') === true);
  ok('sin peligro', scoutDanger({ hpPct: 80, threats: 0 }) === null);
}

// --- Recorrido: dwell, rotación, peligro, muerte, traba -----------------------------------------------------------
{
  const tour = new ScoutTour(seeded());
  let t = 0;
  const first = tour.start({ now: t, map: 0, level: 400, weak: false });
  ok('empieza por el más seguro (todos sin visitar → el primero)', first?.name === 'Lorencia', first);
  ok('recién llegado: se queda', tour.step(inp({ now: t, map: tour.target!.map })).kind === 'stay');
  t += 30_000;
  ok('a los 30 s sigue', tour.step(inp({ now: t, map: tour.target!.map })).kind === 'stay');
  t += SCOUT.dwellMs * 1.4;
  const s = tour.step(inp({ now: t, map: tour.target!.map }));
  ok('pasado el dwell pasa a otro mapa', s.kind === 'go' && s.to.name !== 'Lorencia', s);
  // rotación: visita todos antes de repetir
  const seen = new Set<string>([first!.name, s.kind === 'go' ? s.to.name : '']);
  for (let i = 0; i < 4; i++) {
    t += 1000;
    tour.step(inp({ now: t, map: tour.target!.map })); // llegó (arrivedAt)
    t += SCOUT.dwellMs * 1.4 + 1000;
    const r = tour.step(inp({ now: t, map: tour.target!.map }));
    if (r.kind === 'go') seen.add(r.to.name);
  }
  seen.add(tour.target!.name);
  ok('rota por todos los mapas antes de repetir', seen.size === HUNT_MAPS.length, [...seen]);
}
{
  // Una vuelta entera del mapa lo saca antes del dwell
  const tour = new ScoutTour(seeded());
  tour.start({ now: 0, map: 0, level: 400, weak: false });
  const r = tour.step(inp({ now: 10_000, map: tour.target!.map, lapDone: true }));
  ok('vuelta completa: pasa de mapa antes del dwell', r.kind === 'go', r);
}
{
  // Peligro: veta el mapa y va al más seguro
  const tour = new ScoutTour(seeded());
  tour.start({ now: 0, map: 0, level: 400, weak: false });
  tour.step(inp({ now: 1, map: 0 }));
  tour.step(inp({ now: 4 * MIN, map: 0 })); // pasa a otro
  const cur = tour.target!;
  const r = tour.step(inp({ now: 4 * MIN + 5000, map: cur.map, danger: '2 monstruos cerca' }));
  ok('peligro: retrocede al más seguro, no a donde estaba', r.kind === 'go' && r.to.map !== cur.map && r.to.name === 'Lorencia', r);
  ok('el mapa del peligro queda vetado un rato', tour.isBanned(cur.map, 5 * MIN) && !tour.isBanned(cur.map, 4 * MIN + SCOUT.banMs + 10_000));
}
{
  // Muerte: veto más largo
  const tour = new ScoutTour(seeded());
  tour.start({ now: 0, map: 0, level: 400, weak: false });
  tour.step(inp({ now: 1, map: 0 }));
  const m = tour.target!.map;
  const r = tour.step(inp({ now: 1000, map: m, deaths: 1 }));
  ok('muerte: cambia de mapa y lo veta 45 min', r.kind === 'go' && tour.isBanned(m, 40 * MIN) && !tour.isBanned(m, 50 * MIN), r);
}
{
  // Traba del vigía
  const tour = new ScoutTour(seeded());
  tour.start({ now: 0, map: 0, level: 400, weak: false });
  tour.step(inp({ now: 1, map: 0 }));
  tour.step(inp({ now: 4 * MIN, map: 0 }));
  const cur = tour.target!;
  const to = tour.onStuck({ now: 5 * MIN, level: 400, weak: false });
  ok('traba: vuelve a un mapa seguro distinto', !!to && to.map !== cur.map && to.name === 'Lorencia', to);
  // sin alternativa (un solo mapa seguro): se queda
  const t2 = new ScoutTour(seeded());
  t2.start({ now: 0, map: 0, level: 30, weak: true });
  t2.ban(3, 0, MIN * 100);
  ok('traba sin alternativa: sigue donde está', t2.onStuck({ now: 1, level: 30, weak: true }) === null);
}
{
  // Sin mapa seguro: para. Llegar es imposible: otro mapa.
  const tour = new ScoutTour(seeded());
  tour.start({ now: 0, map: 0, level: 400, weak: false });
  const r = tour.step(inp({ now: 1, map: 0, level: 5 }));
  ok('el nivel ya no alcanza (reseteó): para', r.kind === 'stop', r);
  const t3 = new ScoutTour(seeded());
  const f = t3.start({ now: 0, map: 99, level: 400, weak: false })!;
  t3.warpFailed(1000);
  const r3 = t3.step(inp({ now: 2000, map: 99 }));
  ok('no llegué al mapa: veto y otro', r3.kind === 'go' && r3.to.map !== f.map, r3);
  const t4 = new ScoutTour(seeded());
  const only = t4.start({ now: 0, map: 0, level: 30, weak: true })!;
  t4.ban(0, 0, MIN * 100);
  t4.ban(3, 0, MIN * 100);
  ok('todos los mapas vetados: para', t4.step(inp({ now: 1, map: only.map, level: 30, weak: true })).kind === 'stop');
}
{
  // Cubierto por otro explorador: se prefiere el menos cubierto
  const tour = new ScoutTour(seeded());
  const covered = new Map<number, number>([[0, 100], [3, 100], [2, 100], [7, 100]]); // todos menos Tarkan (8)
  const f = tour.start({ now: 1000, map: 0, level: 400, weak: false, covered });
  ok('prefiere el mapa que ningún explorador cubrió', f?.map === 8, f);
}

// --- Publicador: cada 30-60 s ------------------------------------------------------------------------------
{
  const pub = new ScoutPublisher(seeded(3));
  let t = 1_000_000;
  ok('recién llegado no publica ya', !pub.due(t, 0));
  t += SCOUT.arriveDelayMs;
  ok('a los segundos de llegar, sí', pub.due(t, 0));
  const gaps: number[] = [];
  let last = t;
  pub.sent(t);
  for (let ms = 0; ms < 20 * MIN; ms += 1000) {
    t += 1000;
    if (pub.due(t, 0)) { gaps.push(t - last); last = t; pub.sent(t); }
  }
  ok('publica cada 30-60 s', gaps.length >= 20 && gaps.every((g) => g >= SCOUT.publishMinMs && g <= SCOUT.publishMaxMs + 1000), gaps);
  ok('hay variación (no metrónomo)', new Set(gaps).size > 3, gaps);
  pub.sent(t);
  ok('cambiar de mapa reinicia el compás (reporte a los 8 s)', !pub.due(t + 1, 3) && pub.due(t + SCOUT.arriveDelayMs + 1, 3));
}
{
  const b = buildScoutBody({ from: 'Melu', map: 2, mapName: 'Devias', x: 100, y: 90, players: 3, monsters: 41, golds: ['Golden Goblin', 'Golden Goblin', 'Golden Titan'] });
  ok('cuerpo del reporte', b.kind === 'scout' && b.golds === 3 && b.goldTypes.join() === 'Golden Goblin,Golden Titan' && b.players === 3 && b.note.length <= 80 && JSON.stringify(b).length < 1000, b);
}

// --- Consumo: reportes frescos, factor, pistas ---------------------------------------------------------------------
{
  const NOW = 10_000_000;
  const rep = (o: Partial<ScoutInfo> = {}): ScoutInfo => ({ from: 'Melu', map: 2, x: 100, y: 90, players: 0, monsters: 30, golds: 3, note: '', at: NOW - MIN, ...o });
  ok('basura: no es lista', freshReports(null, 'Horaz', NOW).length === 0 && freshReports({ a: 1 }, 'Horaz', NOW).length === 0 && freshReports('x', 'Horaz', NOW).length === 0);
  ok('descarta inválidos, propios y viejos', freshReports([null, 5, { from: 'Melu' }, rep({ from: 'Horaz' }), rep({ at: NOW - SCOUT_FRESH_MS - 1 }), rep({ map: 999 }), rep({ at: NOW + 10 * MIN }), rep()], 'horaz', NOW).length === 1);
  ok('deja el más nuevo por explorador y mapa', freshReports([rep({ at: NOW - 5 * MIN, golds: 1 }), rep({ at: NOW - MIN, golds: 4 })], 'Horaz', NOW)[0].golds === 4);
  ok('cubiertos: último reporte por mapa', coveredMaps([rep({ at: 5 }), rep({ from: 'Zamu', at: 9 }), rep({ map: 3, at: 2 })]).get(2) === 9);

  ok('sin reportes: factor 1 (como antes)', scoutFactor([], 2, NOW) === 1 && scoutFactor([rep({ map: 3 })], 2, NOW) === 1);
  const fresh = scoutFactor([rep({ at: NOW - 10_000 })], 2, NOW);
  const old = scoutFactor([rep({ at: NOW - 9 * MIN })], 2, NOW);
  ok('dorados vivos reportados suben el mapa y decae con la edad', fresh > 1.5 && old > 1 && old < fresh, [fresh, old]);
  ok('pasados los 10 min vuelve a 1', scoutFactor([rep({ at: NOW - SCOUT_FRESH_MS - 5 })], 2, NOW) === 1);
  const crowded = scoutFactor([rep({ golds: 0, players: 8, at: NOW - 5000 })], 2, NOW);
  const busy = scoutFactor([rep({ golds: 0, players: 3, at: NOW - 5000 })], 2, NOW);
  ok('competencia alta penaliza (5+ jugadores más que 2-4)', crowded < busy && busy < 1 && crowded >= 0.5, [crowded, busy]);
  const both = scoutFactor([rep({ golds: 4, players: 8, at: NOW - 5000 })], 2, NOW);
  ok('dorados con el campo lleno: gana el neto', both > crowded, both);

  // Integrado a pickHuntMap: Noria (3) vale 1/caja, Devias (2) vale 2; invasión pareja.
  const inv: Invasion = { status: 'active', total: 40, at: NOW, nextAt: NOW + 60 * MIN, maps: [{ map: 3, name: 'Noria', alive: 20 }, { map: 2, name: 'Devias', alive: 12 }] };
  const base = pickHuntMap({ invasion: inv, level: 400 });
  ok('base: Noria (20 × 1) vs Devias (12 × 2): Devias', base.ok && base.hunt.map === 2, base);
  const reps = [rep({ map: 3, golds: 5, players: 0, at: NOW - 5000 }), rep({ map: 2, golds: 0, players: 9, at: NOW - 5000 })];
  const withScout = pickHuntMap({ invasion: inv, level: 400, factor: (m) => scoutFactor(reps, m, NOW) });
  ok('un explorador con dorados en Noria y Devias llena: va a Noria', withScout.ok && withScout.hunt.map === 3, withScout);
  const stale = pickHuntMap({ invasion: inv, level: 400, factor: (m) => scoutFactor([], m, NOW) });
  ok('sin reportes (estación caída): decide igual que antes', stale.ok && stale.hunt.map === 2, stale);

  const hints = scoutHints([rep({ at: NOW - 30_000 }), rep({ from: 'Zamu', x: 10, y: 10, at: NOW - 10 * MIN }), rep({ map: 3 }), rep({ golds: 0 })], 2, NOW, 3 * MIN);
  ok('pistas: solo con dorados, de ese mapa y frescas', hints.length === 1 && hints[0].x === 100 && hints[0].key === -(NOW - 30_000), hints);
}

if (fails) {
  console.log(`\n${fails} test(s) FALLARON`);
  process.exit(1);
}
console.log('\nTodos los tests del explorador pasan.');
