/**
 * Tests offline de corner.ts (la esquina de Arena 2). Sin red, reloj simulado.
 *
 *   bun run corner-tests.ts
 */
import { CORNER, CornerSides, SIDE, SIDES, altWarp, cornerActive, cornerFull, cornerTarget, inCorner, nextRoutePoint, spinRange, spinTarget } from './corner';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// --- Camino de la llegada a la esquina ---------------------------------------------------------
{
  const arrival = { x: 61, y: 114 };
  let r = nextRoutePoint(arrival, null);
  ok('desde la llegada (61,114): primer punto (61,98)', r.idx === 0 && r.x === 61 && r.y === 98, r);
  r = nextRoutePoint({ x: 60, y: 99 }, 0);
  ok('a < 4 del punto: avanza al siguiente', r.idx === 1 && r.y === 72, r);
  r = nextRoutePoint({ x: 59, y: 85 }, 1);
  ok('no vuelve atrás aunque el anterior esté más cerca', r.idx === 1, r);
  r = nextRoutePoint({ x: 7, y: 12 }, 7);
  ok('último punto: se queda', r.idx === 7, r);
  ok('en la esquina / viajando', inCorner({ x: 5, y: 11 }) && !inCorner({ x: 30, y: 11 }));
}

// --- A quién pegar --------------------------------------------------------------------------------
{
  const me = { x: 5, y: 11 };
  const group = [{ x: 3, y: 10, id: 1 }, { x: 4, y: 11, id: 2 }, { x: 3, y: 12, id: 3 }];
  const lone = { x: 7, y: 11, id: 4 };
  const r = spinRange(41);
  ok('giro: Twisting Slash 2,5, Evil Spirit 5, desconocido 2,5', r === 2.5 && spinRange(9) === 5 && spinRange(999) === 2.5 && spinRange(null) === 2.5);
  const t = spinTarget(me, [...group, lone], r);
  ok('giro: el que deja más monstruos adentro', t != null && t.id !== 4, t);
  ok('giro: nada a tiro → null', spinTarget(me, [{ x: 20, y: 20 }], r) === null);
  const far = [{ x: 12, y: 12, id: 9 }, { x: 13, y: 12, id: 10 }];
  ok('esquina: camina al grupo', cornerTarget({ x: 2, y: 10 }, far, 0, r)?.id != null);
  ok('esquina con 2 jugadores encima: no camina', cornerTarget({ x: 2, y: 10 }, far, 2, r) === null);
  ok('esquina: ignora lo que está lejos de home', cornerTarget({ x: 2, y: 10 }, [{ x: 30, y: 30 }], 0, r) === null);
  ok('viajando: solo lo que bloquea (<= 1,5)', cornerTarget({ x: 50, y: 30 }, [{ x: 51, y: 31 }, { x: 55, y: 30 }], 0, r)?.x === 51 &&
    cornerTarget({ x: 50, y: 30 }, [{ x: 55, y: 30 }], 0, r) === null);
}

// --- Llena, afuera, activa ------------------------------------------------------------------------
{
  const now = 1_000_000;
  ok('llena: 3 jugadores, > 60 s, rinde < 80 % de 60M', cornerFull({ rivals: 3, inCornerSince: now - 61_000, now, rate1m: 40e6 }));
  ok('no llena: rinde bien', !cornerFull({ rivals: 5, inCornerSince: now - 61_000, now, rate1m: 200e6 }));
  ok('no llena: recién llegado', !cornerFull({ rivals: 5, inCornerSince: now - 30_000, now, rate1m: 0 }));
  ok('no llena: 2 jugadores y 61 s', !cornerFull({ rivals: 2, inCornerSince: now - 61_000, now, rate1m: 0 }));
  ok('no rinde 90 s aunque no haya nadie: se va', cornerFull({ rivals: 0, inCornerSince: now - 91_000, now, rate1m: 30e6 }));
  ok('rinde bien sin nadie: se queda', !cornerFull({ rivals: 0, inCornerSince: now - 300_000, now, rate1m: 300e6 }));
  ok('llena: compara con la Arena de afuera si rinde más', cornerFull({ rivals: 3, inCornerSince: 0, now, rate1m: 100e6, altRate: 200e6 }));
  ok('afuera: Arena 2 / 3 / 4 por nivel', altWarp(150) === 24 && altWarp(250) === 25 && altWarp(350) === 26);
  ok('activa desde 100 y antes del reset', cornerActive({ level: 100, resetLevel: 400, awayUntil: 0, now }) &&
    !cornerActive({ level: 99, resetLevel: 400, awayUntil: 0, now }) && !cornerActive({ level: 400, resetLevel: 400, awayUntil: 0, now }));
  ok('afuera: no activa hasta awayUntil', !cornerActive({ level: 200, resetLevel: 400, awayUntil: now + 1, now }));
  ok('parámetros: esquina (7,11) de Arena 2 (83, warp 24)', CORNER.map === 83 && CORNER.warp === 24 && CORNER.home.x === 7);
}

// --- Lados de la esquina --------------------------------------------------------------------------
{
  const cs = new CornerSides();
  ok('lados: arranca en la esquina', cs.pick(0, []).name === 'esquina');
  ok('lados: se queda 40 s aunque haya gente', cs.pick(10_000, [{ x: 2, y: 10 }, { x: 3, y: 10 }]).name === 'esquina');
  // Mide la esquina: 30M en 20 s cerca → 90M/min.
  cs.record(41_000, { x: 2, y: 10 }, 0);
  cs.record(61_000, { x: 2, y: 10 }, 30e6);
  ok('lados: mide exp/min con ventanas de 15 s', Math.round(cs.stats.get('esquina')!.rate / 1e6) === 90, cs.stats.get('esquina'));
  // A los 40 s: medio y este sin medir valen 90 × 1,2 = 108 > 90 × 1,15 → prueba otro lado.
  ok('lados: un lado sin medir se prueba', cs.pick(61_000, []).name !== 'esquina');
  const c3 = new CornerSides();
  c3.record(0, { x: 2, y: 10 }, 0); c3.record(20_000, { x: 2, y: 10 }, 0);
  ok('lados: medido en 0 cuenta como medido (no "sin medir")', c3.stats.get('esquina')?.windows === 1 && c3.stats.get('esquina')?.rate === 0);
  ok('lados: lejos del lado no mide', (() => { const c2 = new CornerSides(); c2.record(0, { x: 30, y: 30 }, 0); c2.record(20_000, { x: 30, y: 30 }, 5e6); return !c2.stats.has('esquina'); })());
  ok('lados: tres posiciones', SIDES.length === 3 && SIDE.dwellMs === 40_000);
}

// --- Esquina en dúo (compañero en un lado) -----------------------------------------------------
{
  const melu = { x: 7, y: 11 }; // Melu en el medio
  const dk = new CornerSides();
  ok('dúo: el DK se planta en la esquina (2,10) con Melu en el medio', dk.pick(0, [], [melu], true).name === 'esquina');
  ok('dúo: y se queda aunque haya rivales en la esquina', dk.pick(100_000, [{ x: 2, y: 10 }, { x: 2, y: 11 }, { x: 3, y: 10 }], [melu], true).name === 'esquina');
  const mage = new CornerSides();
  ok('dúo: con Horaz en la esquina, el mago toma otro lado (ya, sin esperar)', mage.pick(0, [], [{ x: 2, y: 10 }], false).name !== 'esquina');
  const dk2 = new CornerSides();
  dk2.pick(0, [], [], true);
  ok('dúo: si el compañero ocupa su lado, cambia ya', dk2.pick(1000, [], [{ x: 2, y: 10 }], true).name !== 'esquina');
  ok('solo (sin compañero): elige normal y respeta los 40 s', new CornerSides().pick(0, [], [], true).name === 'esquina');
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE LA ESQUINA PASARON' : `\n${fails} TEST(S) DE LA ESQUINA FALLARON`);
process.exit(fails ? 1 : 0);
