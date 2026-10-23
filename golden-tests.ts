import { nextZone } from './zones';
/**
 * Tests offline de golden.ts (regla fuerte de dorados). Sin red, reloj simulado.
 *
 *   bun run golden-tests.ts
 */
import { DRAGON_RUSH_MS, DragonFight, GOLDEN_RULE, GoldenRule, dragonRush, stickyGolden } from './golden';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const golden = (t: number) => t === 78 || t === 53; // Golden Goblin, Golden Titan
const me = { x: 100, y: 100 };

{
  const g = new GoldenRule();
  const goblin = { id: 1, x: 105, y: 100, type: 78 };
  const common = { id: 2, x: 101, y: 100, type: 26 };
  ok('dorado a la vista: lo elige aunque haya un común más cerca', g.pick(me, [common, goblin], golden, 0)?.id === 1);
  ok('mientras tanto y 15 s después: se queda', g.holding(GOLDEN_RULE.lootStayMs - 1) && !g.holding(GOLDEN_RULE.lootStayMs + 1));
  const dragon2 = { id: 3, x: 118, y: 100, type: 79 };
  ok('Golden Dragon primero aunque esté más lejos (a 18 contra 5)', g.pick(me, [goblin, dragon2], golden, 1000)?.id === 3);
  ok('Dragón Rojo (44) también', new GoldenRule().pick(me, [goblin, { id: 4, x: 110, y: 100, type: 44 }], golden, 0)?.id === 4);
  ok('lejos (> 20): no', new GoldenRule().pick(me, [{ id: 5, x: 130, y: 100, type: 78 }], golden, 0) === null);
  ok('dragón a 45: tampoco (el bonus solo ordena)', new GoldenRule().pick(me, [{ id: 6, x: 145, y: 100, type: 79 }], golden, 0) === null);
  const g2 = new GoldenRule();
  g2.pick(me, [{ id: 7, x: 140, y: 100, type: 78 }], golden, 0);
  ok('el reloj de 2 min arranca al entrar al alcance', g2.pick(me, [{ id: 7, x: 110, y: 100, type: 78 }], golden, GOLDEN_RULE.giveUpMs + 5)?.id === 7);
  g2.pick(me, [], golden, GOLDEN_RULE.giveUpMs + 6);
  ok('un id que dejó de verse se olvida (reaparece con el mismo id)', g2.pick(me, [{ id: 7, x: 110, y: 100, type: 78 }], golden, 10 * GOLDEN_RULE.giveUpMs)?.id === 7);
  ok('2 min sin matarlo: se deja', g.pick(me, [goblin], golden, GOLDEN_RULE.giveUpMs + 1) === null);
  ok('sin dorados: null', new GoldenRule().pick(me, [common], golden, 0) === null);
}

// --- Correa (2026-10-23): no repartir el daño entre dorados -------------------------------------------
{
  const goblin = { id: 1, x: 110, y: 100, type: 78 };
  const titan = { id: 2, x: 102, y: 100, type: 53 };
  const dragon = { id: 3, x: 115, y: 100, type: 79 };
  ok('correa: sigue con el que le pega aunque aparezca otro dorado más cerca', stickyGolden(me, 1, [goblin, titan], golden)?.id === 1);
  ok('correa: un dragón desplaza a un dorado chico', stickyGolden(me, 1, [goblin, titan, dragon], golden)?.id === 3);
  ok('correa: un dragón no se suelta por otro dragón más cerca', stickyGolden(me, 3, [dragon, { id: 4, x: 101, y: 100, type: 44 }], golden)?.id === 3);
  ok('correa: sin actual, el dragón antes que el chico más cerca', stickyGolden(me, null, [titan, dragon], golden)?.id === 3);
  ok('correa: el actual ya no se ve → el más cercano', stickyGolden(me, 9, [goblin, titan], golden)?.id === 2);
  ok('valor: sin actual, Titan (+2) a 9 antes que Goblin (+1) a 5', stickyGolden(me, null, [{ id: 10, x: 105, y: 100, type: 78 }, { id: 11, x: 109, y: 100, type: 53 }], golden)?.id === 11);
  ok('valor: un Goblin pegado (a 1) antes que un Titan lejos (a 15)', stickyGolden(me, null, [{ id: 10, x: 101, y: 100, type: 78 }, { id: 11, x: 115, y: 100, type: 53 }], golden)?.id === 10);
  ok('Dragón Rojo (44) desplaza a un chico', stickyGolden(me, 1, [goblin, { id: 12, x: 118, y: 100, type: 44 }], golden)?.id === 12);
  ok('correa: un común no cuenta', stickyGolden(me, null, [{ id: 5, x: 100, y: 101, type: 26 }], golden) === null);
  const g = new GoldenRule();
  ok('regla: con correa sigue con el chico aunque otro esté más cerca', g.pick(me, [goblin, titan], golden, 0, 1)?.id === 1);
  ok('regla: un dragón aguanta 5 min', g.pick(me, [dragon], golden, 0) != null && g.pick(me, [dragon], golden, GOLDEN_RULE.giveUpMs + 1000)?.id === 3);
}

// --- Zonas de dragones (zones.ts) -------------------------------------------------------------------
{
  const zs = [{ x: 229, y: 176, n: 5 }, { x: 223, y: 218, n: 2 }, { x: 240, y: 183, n: 1 }];
  const me = { x: 222, y: 210 };
  ok('zonas: la más cercana sin visitar', nextZone(zs, me, new Set())?.y === 218);
  ok('zonas: salta las visitadas', nextZone(zs, me, new Set(['223,218']))?.x === 240);
  ok('zonas: todas visitadas → null', nextZone(zs, me, new Set(['223,218', '229,176', '240,183'])) === null);
}

// --- Datos de la pelea con el dragón (dragon_fight) y carrera por el dragón ---------------------------------
{
  const f = new DragonFight((t) => (t === 79 ? 100_000 : null));
  const d = { id: 9, type: 79, x: 192, y: 155 };
  ok('pelea: sin pelea no hay registro', f.lost() === null && f.killed(9, 0, 'x', false) === null);
  f.see(d, 12_000, 0);
  f.players(['camberra1', undefined, 'camberra1']);
  f.hit(9, 20_000);
  f.hit(9, 21_000);
  f.damage(9, 700);
  f.damage(8, 5000); // otro id: no cuenta
  f.see({ ...d, x: 190 }, 30_000, 0);
  const r = f.killed(9, 72_000, 'camberra1', false)!;
  ok('pelea: tiempos desde el aviso y desde que se lo vio', r.seenS === 12 && r.firstHitS === 20 && r.seenToHitS === 8 && r.seenToEndS === 60 && r.hitToEndS === 52, r);
  ok('pelea: golpes, daño visto, vida estimada, killer y jugadores', r.hits === 2 && r.dmgSeen === 700 && r.hpEst === 99_300 && r.killer === 'camberra1' && !r.mine && r.others.join() === 'camberra1', r);
  ok('pelea: posición de inicio y de fin', r.sx === 192 && r.ex === 190);
  ok('pelea: cerrada, la siguiente empieza limpia', f.current === null);
  const g = new DragonFight();
  g.see(d, 0, null);
  ok('pelea: sin aviso → seenS null; sin golpe → firstHitS null', (() => { const x = g.lost()!; return x.seenS === null && x.firstHitS === null && x.outcome === 'lost' && x.hpEst === null; })());
  const h = new DragonFight();
  h.see(d, 0, null);
  ok('pelea: no vencida a los 10 s, vencida a los 20 s', !h.expired(10_000) && h.expired(20_000));
  const lostRec = h.see({ id: 11, type: 79, x: 1, y: 1 }, 30_000, null);
  ok('pelea: otro dragón tras perder al anterior → registro de "lost" con el último instante visto', lostRec?.outcome === 'lost' && lostRec.seenToEndS === 0 && h.current === 11, lostRec);
}
{
  const base = { now: 60_000, announceAt: 0, huntMap: 2, dragonMap: 2, dragonVisible: false, hasZone: true };
  ok('carrera: en la ventana, en el mapa, sin dragón y con zona', dragonRush(base));
  ok('carrera: con un dragón a la vista no (se lo ataca)', !dragonRush({ ...base, dragonVisible: true }));
  ok('carrera: pasados 3 min no', !dragonRush({ ...base, now: DRAGON_RUSH_MS }));
  ok('carrera: otro mapa / sin aviso / sin zona: como siempre', !dragonRush({ ...base, huntMap: 3 }) && !dragonRush({ ...base, announceAt: null }) && !dragonRush({ ...base, hasZone: false }));
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE DORADOS PASARON' : `\n${fails} TEST(S) DE DORADOS FALLARON`);
process.exit(fails ? 1 : 0);
