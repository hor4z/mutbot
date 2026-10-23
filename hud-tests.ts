/**
 * Tests offline de la lógica pura de la vista del personaje (ui/src/hud-logic.ts, radar-model.ts):
 * valor de ítems, bolsa, alertas, feed, diario y capas. Sin DOM.
 *
 *   bun run hud-tests.ts
 */
import type { PanelState } from './panel-protocol';
import { addDecisions, bagUsage, computeAlerts, diffFeed, humanize, itemTier, pushFeed, sparkPoints, tileKind } from './ui/src/hud-logic';
import { DEFAULT_LAYERS, counts, entities } from './ui/src/radar-model';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const item = (group: number, num: number, level = 0, excellent = false, name?: string) => ({ slot: 12, group, num, level, excellent, name });
const base = (): PanelState => ({
  at: 0, mode: 'farm', doing: '', char: { name: 'A', level: 300, resets: 1, hp: [100, 100], mp: [50, 50], stats: { str: 1, agi: 1, vit: 1, ene: 1 }, points: 0, zen: 0 },
  where: { map: 85, mapName: 'Arena 4', x: 10, y: 10 }, exp: { perMin1: 1, perMin5: 1 }, cycle: null, cycles: [], resetsPerDay: null, events: [], invasion: null, tickets: {},
  nearby: { monsters: 3, players: 0 },
});

// Valor de ítems
ok('caja de Kundun = box', itemTier(item(14, 11)) === 'box');
ok('joya de Bless = jewel', itemTier(item(14, 13)) === 'jewel');
ok('Chaos = jewel', itemTier(item(12, 15)) === 'jewel');
ok('excelente = exc', itemTier(item(0, 5, 0, true)) === 'exc');
ok('+9 = high', itemTier(item(7, 1, 9)) === 'high');
ok('poción = potion', itemTier(item(14, 3)) === 'potion');
ok('nombre con Box = box', itemTier(item(14, 99, 0, false, 'Box of Luck')) === 'box');

// Bolsa: tamaños reales
ok('bolsa: 1x1 + 2x2 = 5 casillas', bagUsage([{ ...item(14, 13), slot: 12 }, { ...item(0, 1), slot: 14, w: 2, h: 2 }]).used === 5);
ok('bolsa: ítem fuera de la grilla se ignora', bagUsage([{ ...item(0, 1), slot: 90 }]).used === 0);

// Alertas
{
  const s = base();
  ok('sin alertas con todo bien', computeAlerts(s, { now: 1000, stillMs: 0, online: true }).length === 0);
  s.char.hp = [20, 100];
  ok('vida baja', computeAlerts(s, { now: 0, stillMs: 0, online: true }).some((a) => a.id === 'hp'));
  const t = base();
  t.nearby.monsters = 0;
  ok('traba: quieto 2 min sin monstruos', computeAlerts(t, { now: 0, stillMs: 120_000, online: true }).some((a) => a.id === 'stuck'));
  ok('quieto con monstruos cerca no es traba', !computeAlerts(base(), { now: 0, stillMs: 120_000, online: true }).some((a) => a.id === 'stuck'));
  const b = base();
  b.inventory = Array.from({ length: 63 }, (_, i) => ({ ...item(14, 3), slot: 12 + i }));
  ok('bolsa llena', computeAlerts(b, { now: 0, stillMs: 0, online: true }).some((a) => a.id === 'bag' && a.level === 'bad'));
  ok('bot viejo sin inventario: sin alerta de bolsa', !computeAlerts(base(), { now: 0, stillMs: 0, online: true }).some((a) => a.id === 'bag'));
}

// Feed
{
  const a = base(), b = base();
  a.session = { since: 0, level0: 300, kills: 10, deaths: 0, casts: 0, exp: 0, loot: 0, skill: 'x' };
  b.session = { ...a.session, kills: 11 };
  a.entities = { monsters: [{ id: 1, x: 1, y: 1, type: 79, name: 'Golden Dragon', gold: true, target: true }], players: [], drops: [] };
  b.entities = { monsters: [], players: [], drops: [] };
  const f = diffFeed(a, b);
  ok('feed: dorado derrotado', f.length === 1 && f[0]!.kind === 'gold' && f[0]!.text.includes('Golden Dragon'), f);
  ok('feed: primer estado no genera nada', diffFeed(null, b).length === 0);
  const c = base();
  c.inventory = [item(14, 11, 4, false, 'Box of Kundun +4')];
  ok('feed: bot sin inventario previo no inventa ítems', diffFeed(base(), c).length === 0);
  const e = { ...base(), inventory: [] as PanelState['inventory'] };
  const g = diffFeed(e, c);
  ok('feed: caja nueva en la bolsa', g.length === 1 && g[0]!.tier === 'box', g);
  let feed = pushFeed([], [{ kind: 'kill', text: 'Soldier' }], 1000);
  feed = pushFeed(feed, [{ kind: 'kill', text: '2 monstruos' }], 2000);
  ok('feed: kills seguidos se juntan', feed.length === 1 && feed[0]!.n === 3, feed);
  ok('feed: tope', pushFeed([], Array.from({ length: 100 }, (_, i) => ({ kind: 'map' as const, text: String(i) })), 0).length === 60);
}

// Diario
{
  ok('diario: modo en palabras', humanize({ at: 0, kind: 'mode', what: 'farm → hunt', n: 1 }).title === 'Pasó de farmear a cazar dorados');
  const h = humanize({ at: 0, kind: 'decide', what: 'Campamento (112,112) — 9 monstruos juntos', n: 1 });
  ok('diario: título y motivo', h.title === 'Campamento (112,112)' && h.detail === '9 monstruos juntos', h);
  const t = humanize({ at: 0, kind: 'travel', what: 'Arena 3 rinde poco → Arena 4 (sin costo)', n: 1 });
  ok('diario: viaje muestra el destino y el porqué', t.title === 'Arena 4 (sin costo)' && t.detail === 'Arena 3 rinde poco', t);
  const l = addDecisions([], [{ at: 1, kind: 'decide', what: 'x' }, { at: 2, kind: 'decide', what: 'x' }, { at: 3, kind: 'otro', what: 'y' }]);
  ok('diario: repetidas ×n y tipos ajenos filtrados', l.length === 1 && l[0]!.n === 2, l);
}

// Mapa
{
  const s = base();
  s.entities = {
    monsters: [{ id: 1, x: 5, y: 5, type: 20, name: 'Soldier', gold: false, target: false }, { id: 2, x: 6, y: 6, type: 44, name: 'Red Dragon', gold: true, target: false }],
    players: [{ id: 3, x: 1, y: 1, name: 'Melu', mate: true }, { id: 4, x: 2, y: 2 }],
    drops: [{ x: 3, y: 3, name: 'Box', money: false, valuable: true }],
  };
  s.squad = [{ name: 'Melu', map: 85, x: 1, y: 1 }, { name: 'Scout', map: 85, x: 9, y: 9, role: 'scout' }, { name: 'Lejos', map: 3, x: 9, y: 9 }];
  const all = entities(s, DEFAULT_LAYERS);
  ok('capas: todo activo', all.length === 1 + 2 + 2 + 1 + 1, all.map((e) => e.key));
  ok('capas: escuadra sin duplicar ni otros mapas', all.filter((e) => e.kind === 'mate' || e.kind === 'squad').length === 2);
  ok('capas: apagar dorados y monstruos', entities(s, { ...DEFAULT_LAYERS, monsters: false, golds: false }).every((e) => e.kind !== 'monster' && e.kind !== 'red'));
  ok('capas: conteos', counts(s).golds === 1 && counts(s).monsters === 1 && counts(s).squad === 2, counts(s));
  ok('estado viejo sin entities/squad/hazards no rompe', entities(base(), DEFAULT_LAYERS).length === 1 && counts(base()).hazards === 0);
}
ok('terreno: tipos de celda', tileKind(0) === 'walk' && tileKind(1) === 'safe' && tileKind(4) === 'blocked' && tileKind(8) === 'blocked' && tileKind(16) === 'water');
ok('sparkline con menos de 2 puntos queda vacía', sparkPoints([5], 100, 20) === '' && sparkPoints([1, 2, 3], 100, 20).split(' ').length === 3);

if (fails) {
  console.log(`\n${fails} fallas`);
  process.exit(1);
}
console.log('\ntodo bien');
