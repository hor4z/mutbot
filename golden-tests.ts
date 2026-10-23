import { nextZone } from './zones';
/**
 * Tests offline de golden.ts (regla fuerte de dorados). Sin red, reloj simulado.
 *
 *   bun run golden-tests.ts
 */
import { DRAGON_RUSH_MS, DragonFight, GOLDEN_RULE, GoldenRule, dragonRush, stickyGolden } from './golden';

import { Finisher } from './finisher';
import { SNIPE_FROM_MS, SNIPE_MIN_GAP_MS, SNIPE_TO_MS, snipeAction } from './snipe';
import { AliveHistory, CROWD_DIVISOR, CROWD_MAX_DROP, dragonBonusFactor, pickHuntMap } from './panel-logic';
import type { Invasion } from './panel-protocol';

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

{
  const F = new Finisher();
  const own = (id: number, dmg: number, at: number) => { F.cast(id, at); F.damage(id, dmg, at + 300); };
  ok('remate: sin muestra propia → none', F.decide(1, 100_000, 0).verdict === 'none');
  own(1, 1000, 0); own(1, 1200, 1000); own(1, 800, 2000); // mediana 1000
  ok('remate: mediana del golpe propio', F.ownHit() === 1000);
  ok('remate: sin otros atacantes → none', F.decide(1, 100_000, 3000).verdict === 'none');
  F.other(1, 77, 3000);
  F.damage(1, 50_000, 3100);
  const r1 = F.decide(1, 100_000, 3200);
  ok('remate: otros pegan y falta mucho → wait', r1.verdict === 'wait' && r1.remaining === 100_000 - 50_000 - 3000, r1);
  F.damage(1, 45_000, 4000); F.other(1, 77, 4000);
  ok('remate: faltan <= 3 golpes → strike', F.decide(1, 100_000, 4100).verdict === 'strike');
  ok('remate: los otros dejaron de pegar hace > 3 s → none', F.decide(1, 100_000, 9000).verdict === 'none');
  F.damage(1, 40_000, 9500); F.other(1, 77, 9500);
  ok('remate: daño visto > HP → none (inconsistente)', F.decide(1, 100_000, 9600).verdict === 'none');
  const G = new Finisher();
  G.cast(2, 0); G.damage(2, 1000, 100); G.cast(2, 1000); G.damage(2, 1000, 1100);
  G.other(2, 5, 0);
  ok('remate: espera', G.decide(2, 200_000, 0).verdict === 'wait' && G.waited(2));
  for (let t = 1000; t <= 24_000; t += 1000) G.other(2, 5, t);
  ok('remate: antes de 25 s sin bajar sigue esperando', G.decide(2, 200_000, 24_000).verdict === 'wait');
  G.other(2, 5, 26_000);
  ok('remate: 25 s sin que baje la vida → strike y se queda en strike', G.decide(2, 200_000, 26_000).verdict === 'strike' && G.decide(2, 200_000, 27_000).verdict === 'strike');
  ok('remate: sin HP conocido → none', new Finisher().decide(3, null, 0).verdict === 'none');
}
{
  const H = new AliveHistory();
  const inv = (d: number, l: number, at: number): Invasion => ({ status: 'active', total: d + l, at, nextAt: at, maps: [{ map: 2, name: 'Devias', alive: d }, { map: 0, name: 'Lorencia', alive: l }] });
  H.record(inv(10, 29, 0), 0);
  ok('multitud: sin historial suficiente → factor 1', H.factor(2, 30_000) === 1);
  H.record(inv(3, 27, 120_000), 120_000);
  ok('multitud: Devias cae 3,5/min → 1/(1+1,75)', Math.abs(H.factor(2, 120_000) - 1 / 2.75) < 1e-9, H.factor(2, 120_000));
  ok('multitud: Lorencia cae 1/min → 0,67', Math.abs(H.factor(0, 120_000) - 1 / 1.5) < 1e-9);
  ok('multitud: tope', (() => { const K = new AliveHistory(); K.record(inv(100, 0, 0), 0); K.record(inv(0, 0, 60_000), 60_000); return K.factor(2, 60_000) === 1 / (1 + CROWD_MAX_DROP / CROWD_DIVISOR); })());
  process.env.MUBOT_COMPETITION = '0';
  ok('multitud: MUBOT_COMPETITION=0 apaga factor y decaimiento', H.factor(2, 120_000) === 1 && dragonBonusFactor(0, 200_000) === 1);
  delete process.env.MUBOT_COMPETITION;
  ok('bonus del dragón: entero al aviso, mitad a los 2 min, 0 a los 4, sin dato entero', dragonBonusFactor(0, 0) === 1 && dragonBonusFactor(0, 120_000) === 0.5 && dragonBonusFactor(0, 240_000) === 0 && dragonBonusFactor(null, 5) === 1);
  const mk = (now: number, dragonAt: number | undefined) => pickHuntMap({ invasion: inv(10, 29, 0), level: 400, dragonMap: 2, dragonAt, now });
  ok('pickHuntMap: bonus fresco → Devias; vencido a los 5 min → Lorencia (29 vivos)', (mk(10_000, 0) as any).hunt.map === 2 && (mk(300_000, 0) as any).hunt.map === 0);
  ok('pickHuntMap: sin dragonAt → como siempre', (mk(300_000, undefined) as any).hunt.map === 2);
}
{
  // Reloj simulado: una caja ajena cae en t=0 y se simula un bucle de 100 ms.
  const picks: number[] = [];
  let last: number | null = null;
  let gaveUp = -1;
  for (let t = 1000; t <= 20_000 && gaveUp < 0; t += 100) {
    const a = snipeAction(t, last == null ? null : t - last, (t / 100) % 10 / 10);
    if (a === 'pick') { picks.push(t); last = t; }
    if (a === 'giveup') gaveUp = t;
  }
  ok('snipe: ni un pedido antes de los 9,5 s', picks.length > 0 && picks[0] >= SNIPE_FROM_MS && picks[0] <= SNIPE_FROM_MS + 100, picks);
  ok('snipe: separación >= 0,6 s entre pedidos (nunca más rápido que lo de siempre)', picks.every((p, i) => i === 0 || p - picks[i - 1] >= SNIPE_MIN_GAP_MS), picks);
  ok('snipe: pedidos dentro de la ventana y se suelta a los 14 s', picks.at(-1)! <= SNIPE_TO_MS && gaveUp > SNIPE_TO_MS && gaveUp <= SNIPE_TO_MS + 100, { picks, gaveUp });
  ok('snipe: varios pedidos en la ventana', picks.length >= 5, picks);
}
console.log(fails === 0 ? '\nTODOS LOS TESTS DE DORADOS PASARON' : `\n${fails} TEST(S) DE DORADOS FALLARON`);
process.exit(fails ? 1 : 0);
