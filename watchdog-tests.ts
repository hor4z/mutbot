/**
 * Tests offline de watchdog.ts (vigía de trabas). Sin red, reloj simulado.
 *
 *   bun run watchdog-tests.ts
 */
import { STUCK, StuckWatch, type WatchInput } from './watchdog';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const S = STUCK.stepMs;
const base = (o: Partial<WatchInput> = {}): WatchInput => ({
  now: 0, mode: 'farm', map: 83, x: 10, y: 10, level: 391, expTotal: 1000, kills: 5, target: null,
  pk: false, freeSlots: 20, potions: 5, hpPct: 90, monsters: 3, walkStuck: 0, lootingLong: false, silentMs: 100, hunting: false, ...o,
});
/** Corre el vigía con el estado quieto cada segundo hasta `until`; devuelve los veredictos. */
function still(w: StuckWatch, o: Partial<WatchInput>, from: number, until: number) {
  const out: { at: number; v: NonNullable<ReturnType<StuckWatch['feed']>> }[] = [];
  for (let t = from; t <= until; t += 1000) {
    const v = w.feed(base({ ...o, now: t }));
    if (v) out.push({ at: t, v });
  }
  return out;
}

// --- Con progreso no dispara nunca --------------------------------------------------------------------------
{
  const w = new StuckWatch();
  let hit = 0;
  for (let t = 0; t < 30 * 60_000; t += 1000) {
    // sube 1 de exp cada 30 s: progreso lento pero real
    if (w.feed(base({ now: t, expTotal: 1000 + Math.floor(t / 30_000) }))) hit++;
  }
  ok('exp que sube, aunque lenta: ningún aviso en 30 min', hit === 0, hit);
  const w2 = new StuckWatch();
  let hit2 = 0;
  for (let t = 0; t < 30 * 60_000; t += 1000) if (w2.feed(base({ now: t, x: 10 + Math.floor(t / 10_000) % 40 }))) hit2++;
  ok('caminando (cambia de posición): ningún aviso', hit2 === 0, hit2);
}

// --- Trabado sin más: escalones 1, 2, 3 una sola vez cada uno -----------------------------------------------
{
  const w = new StuckWatch();
  const r = still(w, {}, 0, 4 * S);
  ok('3 veredictos (uno por escalón)', r.length === 3 && r.map((x) => x.v.step).join() === '1,2,3', r.map((x) => x.v.step));
  ok('el 1.º llega a stepMs', r[0].at >= S && r[0].at <= S + 1000, r[0]?.at);
  ok('diagnóstico idle: soltar → volver a entrar → reconectar', r.map((x) => x.v.remedy).join() === 'leave_camp,rewarp,reconnect', r.map((x) => x.v.remedy));
}

// --- Diagnósticos --------------------------------------------------------------------------------------------
{
  const v = still(new StuckWatch(), { pk: true }, 0, 2 * S).map((x) => x.v);
  ok('PK: pide /pkclear primero y después solo espera (reconectar no sirve)', v[0].diagnosis === 'pk' && v[0].remedy === 'pkclear' && v[1].remedy === 'log_only', v);
}
{
  const v = still(new StuckWatch(), { silentMs: 120_000 }, 0, S)[0]?.v;
  ok('server mudo: reconectar', v?.diagnosis === 'no_response' && v.remedy === 'reconnect', v);
}
{
  const v = still(new StuckWatch(), { freeSlots: 0, lootingLong: true }, 0, S)[0]?.v;
  ok('bolsa llena con loot pendiente: dejar el loot', v?.diagnosis === 'bag_full' && v.remedy === 'ignore_loot', v);
  const v2 = still(new StuckWatch(), { freeSlots: 0, lootingLong: false }, 0, S)[0]?.v;
  ok('bolsa llena sin loot pendiente: no es la causa', v2?.diagnosis !== 'bag_full', v2);
}
{
  const v = still(new StuckWatch(), { hpPct: 12, potions: 0 }, 0, S)[0]?.v;
  ok('poca vida y sin pociones: retirarse a Lorencia', v?.diagnosis === 'no_potion' && v.remedy === 'warp_town', v);
  const v2 = still(new StuckWatch(), { hpPct: 12, potions: 3 }, 0, S)[0]?.v;
  ok('con pociones no es falta de pociones', v2?.diagnosis !== 'no_potion', v2);
}
{
  const v = still(new StuckWatch(), { walkStuck: 6, target: 7 }, 0, 3 * S).map((x) => x.v);
  ok('contra un muro: soltar objetivo → reentrar → reconectar', v.map((x) => x.diagnosis + ':' + x.remedy).join() === 'wall:drop_target,wall:rewarp,wall:reconnect', v.map((x) => x.remedy));
}
{
  const v = still(new StuckWatch(), { monsters: 0 }, 0, 2 * S).map((x) => x.v);
  ok('mapa seco: cambiar de spot', v[0].diagnosis === 'dry_map' && v[0].remedy === 'rewarp', v[0]);
  const h = still(new StuckWatch(), { monsters: 0, hunting: true }, 0, S)[0]?.v;
  ok('cazando, sin monstruos no es "mapa seco" (los dorados no son comunes)', h?.diagnosis === 'idle', h);
}

// --- Modos exentos: pausa, reseteo, conexión ----------------------------------------------------------------
{
  const w = new StuckWatch();
  ok('en pausa 1 h: nada', still(w, { mode: 'paused' }, 0, 3600_000).length === 0);
  ok('al salir de la pausa el reloj arranca de cero', still(w, {}, 3600_000, 3600_000 + S - 2000).length === 0);
  ok('y recién a stepMs dispara', still(w, {}, 3600_000 + S - 1000, 3600_000 + S + 2000).length === 1);
  ok('reseteando: nada', still(new StuckWatch(), { mode: 'resetting' }, 0, 3600_000).length === 0);
}

// --- Un objetivo nuevo o un cambio de mapa cuenta como progreso ----------------------------------------------
{
  const w = new StuckWatch();
  still(w, {}, 0, S - 2000);
  w.feed(base({ now: S - 1000, target: 42 }));
  ok('objetivo nuevo = progreso', still(w, { target: 42 }, S, 2 * S - 3000).length === 0);
  const w2 = new StuckWatch();
  still(w2, {}, 0, S - 2000);
  w2.feed(base({ now: S - 1000, map: 0 }));
  ok('cambio de mapa = progreso', still(w2, { map: 0 }, S, 2 * S - 3000).length === 0);
}

// --- Después de un remedio con progreso, el próximo episodio vuelve a empezar de 1 ---------------------------
{
  const w = new StuckWatch();
  const a = still(w, {}, 0, S + 1000);
  w.feed(base({ now: S + 2000, expTotal: 5000 }));
  const b = still(w, { expTotal: 5000 }, S + 3000, 2 * S + 5000);
  ok('episodio nuevo: otra vez escalón 1', a[0]?.v.step === 1 && b[0]?.v.step === 1, [a, b]);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DEL VIGÍA PASARON' : `\n${fails} TEST(S) DEL VIGÍA FALLARON`);
process.exit(fails ? 1 : 0);
