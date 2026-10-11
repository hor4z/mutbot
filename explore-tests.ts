/**
 * Tests offline del explorador (explore.ts): filtro de monstruos, grilla de
 * spots calientes, salidas del pueblo, elección del próximo objetivo y mapa
 * seco. Sin red, con reloj simulado.
 *
 *   bun run explore-tests.ts
 */
import { isSafeZone, terrainOf } from './terrain';
import {
  EXPLORE, Explorer, HotSpotGrid, exitTargets, isMonsterType, isTownNpcType, nearestDir,
  TOWN_CENTERS, FIRST_EXITS,
} from './explore';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const S = 1000;
const MIN = 60 * S;

// --- Filtro de monstruos -------------------------------------------------------
{
  const known = new Set([3, 14, 247, 400]); // 247 = guardia con stats de combate en monsters.json
  ok('monstruo conocido de monsters.json', isMonsterType(3, known));
  ok('tipo bajo desconocido: no', !isMonsterType(5, known));
  ok('guardia 247 (en monsters.json) igual se excluye', !isMonsterType(247, known));
  ok('guardia 249, cofre 240, Thompson 231, Lumen 255: NPC', [249, 240, 231, 255].every((t) => !isMonsterType(t, known)));
  ok('bordes 200 y 299 son NPC, 199 y 300 no', isTownNpcType(200) && isTownNpcType(299) && !isTownNpcType(199) && !isTownNpcType(300));
  ok('custom alto 690/692 (no está en monsters.json): monstruo', isMonsterType(690, known) && isMonsterType(692, known));
  ok('300 desconocido: monstruo', isMonsterType(300, known));
  ok('400 conocido: monstruo', isMonsterType(400, known));
}

// --- Grilla de spots calientes ---------------------------------------------------
{
  const g = new HotSpotGrid();
  ok('celda de 12x12', g.cellOf(23, 24).join() === '1,2' && g.cellOf(0, 11).join() === '0,0');
  ok('centro de celda', JSON.stringify(g.center({ cx: 1, cy: 2 })) === JSON.stringify({ x: 18, y: 30 }));
  ok('sin registros: nada', g.pick(0, 0) === null);
  g.record(0, 100, 100); g.record(0, 101, 105); g.record(0, 50, 50); g.record(3, 10, 10); g.record(3, 10, 10); g.record(3, 10, 10);
  const c = g.pick(0, 0)!;
  ok('elige la de más exp del MISMO mapa', c.map === 0 && c.exp === 2 && c.cx === 8 && c.cy === 8, c);
  g.markEmpty(0, 8, 8, 10 * S);
  const c2 = g.pick(0, 20 * S)!;
  ok('celda vacía hace < EMPTY_COOLDOWN_MS se saltea', c2.cx === 4 && c2.cy === 4, c2);
  const c3 = g.pick(0, 10 * S + EXPLORE.EMPTY_COOLDOWN_MS)!;
  ok('pasado EMPTY_COOLDOWN_MS vuelve a ser candidata', c3.cx === 8 && c3.cy === 8, c3);
  g.markEmpty(0, 4, 4, 20 * S);
  ok('todas vacías: nada', g.pick(0, 30 * S) === null);
  const t = new HotSpotGrid();
  t.record(1, 10, 10); t.record(1, 200, 200);
  ok('empate: la más cercana', t.pick(1, 0, 190, 190)!.cx === 16 && t.pick(1, 0, 5, 5)!.cx === 0);

  // Ponderación por EXP acumulada, no por conteo: una celda con un solo kill
  // grande le gana a otra con muchos kills chicos.
  const w = new HotSpotGrid();
  for (let i = 0; i < 10; i++) w.record(0, 20, 20, 100); // 10 kills de 100 = 1000
  w.record(0, 100, 100, 1500); w.record(0, 101, 101, 200); // 2 kills = 1700
  const best = w.pick(0, 0)!;
  ok('grilla ponderada por exp: gana la que más exp dio', best.cx === 8 && best.exp === 1700, best);
  w.markEmpty(0, 8, 8, 0);
  ok('vacía la mejor: sigue la segunda en exp', w.pick(0, 1 * S)!.cx === 1);
  w.record(0, 100, 100, 50);
  ok('un kill nuevo en la celda vacía la despierta', w.pick(0, 2 * S)!.cx === 8);
  const copy = new HotSpotGrid();
  copy.load(w.dump());
  ok('dump/load conserva celdas y exp (sobrevive al reset)', copy.get(0, 8, 8)!.exp === 1750 && copy.get(0, 1, 1)!.exp === 1000);
}

// --- Salidas ---------------------------------------------------------------------
{
  ok('nearestDir: hacia la cripta de Lorencia (-x,+y) = dir 6', nearestDir(-25, 52) === 6, nearestDir(-25, 52));
  ok('nearestDir: este = 3', nearestDir(10, 0) === 3 && nearestDir(0, -10) === 1);
  const lor = exitTargets(0, TOWN_CENTERS[0]);
  ok('Lorencia: primera salida = cripta (110,180)', lor[0].x === FIRST_EXITS[0].x && lor[0].y === FIRST_EXITS[0].y, lor[0]);
  const second = lor[1];
  ok('Lorencia: la segunda va hacia +y (mismo lado que la cripta)', second.y > TOWN_CENTERS[0].y + 20, second);
  ok('Lorencia: 8 salidas más la conocida, sin duplicados cercanos', lor.length >= 8 && lor.length <= 9, lor.length);
  ok('salidas dentro del mapa', lor.every((p) => p.x >= 8 && p.x <= 247 && p.y >= 8 && p.y <= 247));
  const unk = exitTargets(7, { x: 220, y: 40 });
  ok('mapa desconocido con pueblo en un borde: primero hacia el medio', unk[0].x < 220 && unk[0].y > 40, unk[0]);
  const pref = exitTargets(7, { x: 128, y: 128 }, 3);
  ok('--explore-dir manda en mapas sin salida conocida', pref[0].x > 128 && pref[0].y === 128, pref[0]);
}

// --- Explorer: próximo objetivo -----------------------------------------------------
{
  const e = new Explorer();
  let a = e.tick(0, 135, 128, 0);
  ok('sin spots calientes: camina a la primera salida (cripta)', a.action === 'walk' && a.x === 110 && a.y === 180 && a.goal.kind === 'exit', a);
  // Llega y espera 20 s.
  a = e.tick(0, 111, 179, 30 * S);
  ok('al llegar a la salida espera', a.action === 'wait', a);
  a = e.tick(0, 111, 179, 49 * S);
  ok('a los 19 s sigue esperando', a.action === 'wait');
  a = e.tick(0, 111, 179, 50 * S);
  ok('a los 20 s sin monstruos abandona y va a la siguiente', a.action === 'walk' && a.goal.kind === 'exit' && (a.goal as any).index === 1 && e.events[0]?.kind === 'exit-abandoned', { a, ev: e.events });

  // Un monstruo visto en la salida reinicia el plazo.
  const e2 = new Explorer();
  e2.tick(0, 110, 180, 0); // llega enseguida
  e2.sawMonster(15 * S);
  ok('monstruo visto en la salida: el plazo corre de nuevo', e2.tick(0, 110, 180, 30 * S).action === 'wait');

  // Spot caliente tiene prioridad sobre salidas.
  const e3 = new Explorer();
  e3.onExp(0, 60, 60, 500, 0); e3.onExp(0, 61, 62, 500, 0); e3.onExp(0, 85, 85, 300, 0);
  e3.onExp(0, 200, 200, 9000, 0); // el que más rinde, pero a > HOT_MAX_DIST
  a = e3.tick(0, 75, 75, 1 * S);
  ok('con spots calientes: va al de más exp', a.action === 'walk' && a.goal.kind === 'hot' && a.x === 66 && a.y === 66, a);
  a = e3.tick(0, 66, 66, 10 * S);
  ok('en el spot caliente espera', a.action === 'wait' && a.goal.kind === 'hot');
  a = e3.tick(0, 66, 66, 39 * S);
  ok('espera el respawn hasta 30 s', a.action === 'wait' && a.goal.kind === 'hot', a);
  a = e3.tick(0, 66, 66, 40 * S);
  ok('a los 30 s vacío: lo marca y va al siguiente caliente', a.action === 'walk' && a.goal.kind === 'hot' && a.x === 90 && e3.events[0]?.kind === 'hot-empty', { a, ev: e3.events });
  ok('la celda quedó marcada vacía', e3.hot.get(0, 5, 5)!.emptyAt === 40 * S);
  a = e3.tick(0, 90, 90, 42 * S);
  a = e3.tick(0, 90, 90, 72 * S);
  ok('sin calientes disponibles: vuelve a las salidas', a.action === 'walk' && a.goal.kind === 'exit', a);

  // Timeout de caminata: objetivo inalcanzable se abandona.
  const e4 = new Explorer();
  e4.tick(0, 135, 128, 0);
  a = e4.tick(0, 135, 128, EXPLORE.WALK_TIMEOUT_MS);
  ok('no llega en WALK_TIMEOUT_MS: abandona la salida', a.goal.kind === 'exit' && (a.goal as any).index === 1 && e4.events[0]?.kind === 'exit-timeout', e4.events);
  // Pelear en el camino no cuenta para el timeout.
  const e5 = new Explorer();
  e5.tick(0, 135, 128, 0);
  e5.sawMonster(50 * S);
  a = e5.tick(0, 135, 128, EXPLORE.WALK_TIMEOUT_MS + 10 * S);
  ok('pelear en el camino no consume el timeout', a.action === 'walk' && (a.goal as any).index === 0, a);

  // Cambio de mapa: reinicia salidas con el centro de llegada.
  const e6 = new Explorer();
  e6.tick(0, 135, 128, 0);
  a = e6.tick(2, 210, 40, 5 * S);
  ok('cambio de mapa: salidas del mapa nuevo (hacia el medio)', a.goal.kind === 'exit' && a.goal.x < 210 && a.goal.y > 40, a);
}

// --- Correa (Devias) -------------------------------------------------------------------
{
  const e = new Explorer();
  e.onExp(2, 100, 100, 5000, 0);   // celda caliente dentro de 30 tiles pero fuera de la correa
  e.onExp(2, 125, 125, 100, 0);    // dentro de la correa
  e.setLeash({ x: 130, y: 130, r: 25 });
  let a = e.tick(2, 120, 120, 1 * S);
  ok('con correa: el spot caliente fuera de ella no se elige', a.goal.kind === 'hot' && a.goal.x === 126 && a.goal.y === 126, a);
  const e2 = new Explorer();
  e2.setLeash({ x: 130, y: 130, r: 25 });
  a = e2.tick(2, 130, 130, 0);
  const exits = e2.exitList;
  ok('con correa: las salidas quedan alrededor de la llegada', exits.length > 0 && exits.every((p) => Math.max(Math.abs(p.x - 130), Math.abs(p.y - 130)) <= 25), exits);
  ok('con correa: la primera salida es "arriba" (-x, +y)', exits[0].x < 130 && exits[0].y > 130, exits[0]);
  e2.setLeash(null);
  ok('sin correa: salidas normales (hacia el medio/afuera)', e2.exitList.some((p) => Math.max(Math.abs(p.x - 130), Math.abs(p.y - 130)) > 25), e2.exitList);
}

// --- Mapa seco ---------------------------------------------------------------------
{
  const e = new Explorer();
  e.tick(0, 135, 128, 0);
  ok('recién llegado: no seco', !e.isDry(MIN));
  ok('90 s sin monstruos: seco', e.isDry(EXPLORE.DRY_MAP_MS));
  e.sawMonster(EXPLORE.DRY_MAP_MS);
  ok('ver un monstruo reinicia el reloj', !e.isDry(EXPLORE.DRY_MAP_MS + MIN));
  e.tick(2, 50, 50, 3 * MIN);
  ok('cambiar de mapa reinicia el reloj', !e.isDry(4 * MIN) && e.isDry(3 * MIN + EXPLORE.DRY_MAP_MS));
  e.resetDry(10 * MIN);
  ok('resetDry posterga', !e.isDry(11 * MIN));
  ok('sin tick todavía: nunca seco', !new Explorer().isDry(10 * MIN));
}

// --- Zona segura (terreno del cliente; se saltea si no están los assets) ---------------------------
if (terrainOf(0)) {
  ok('zona segura: pueblo de Lorencia (130,126), donde Horaz quedó pegándole a Lord centurion', isSafeZone(0, 130, 126));
  ok('zona segura: spot del Lich (134,202) no lo es', !isSafeZone(0, 134, 202));
  ok('zona segura: fuera del mapa no', !isSafeZone(0, -1, 300));
} else console.log('SKIP  zona segura: no están los assets del cliente (MU_ASSETS)');
ok('zona segura: mapa sin terreno no', !isSafeZone(250, 10, 10));

console.log(fails === 0 ? '\nTODOS LOS TESTS DEL EXPLORADOR PASARON' : `\n${fails} TEST(S) DEL EXPLORADOR FALLARON`);
process.exit(fails ? 1 : 0);
