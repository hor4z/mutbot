/** Pruebas offline del selector de mapa por exp medida. */
import { FarmMiddleware } from './farm-middleware';

let fails = 0;
const ok = (name: string, good: boolean, got?: unknown) => {
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${good ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!good) fails++;
};

const hume = { family: 'knight' as const, stats: { str: 4045, agi: 1698, vit: 706, ene: 2044 }, maxHp: 2767 };
const P = 4045 + 1698 + 706 + 2044;
const horaz = { family: 'knight' as const, stats: { str: 65535, agi: 3000, vit: 3000, ene: 65535 }, maxHp: 20000 };
const weakling = { family: 'knight' as const, stats: { str: 300, agi: 100, vit: 100, ene: 50 }, maxHp: 400 };
const MIN = 60_000;
const obs = (p: FarmMiddleware, spot: number, map: number, level: number, rate: number, now = 120_000, f = hume) =>
  p.observe({ spot, map, level, now, arrivalAt: now - 200_000, rate, f, twistingSlash: true });

// Fuerte: sigue con la ruta y la esquina.
const s = new FarmMiddleware();
ok('Horaz fuerte conserva la esquina y la ruta fija', s.profile(horaz, 307, true, 0).corner && s.profile(horaz, 307, true, 0).spot == null);
ok('debajo del 100 manda la ruta fija', s.profile(hume, 80, true, 0).spot == null);

// Sin nada medido: prueba de arriba hacia abajo.
const e = new FarmMiddleware();
ok('sin datos prueba Arena 4 primero', e.profile(hume, 340, true, 0).spot === 26, e.profile(hume, 340, true, 0));
ok('al 250 prueba Arena 3 primero', e.profile(hume, 250, true, 0).spot === 25);
ok('un personaje débil no prueba Arenas imposibles', e.profile(weakling, 340, true, 0).spot !== 26, e.profile(weakling, 340, true, 0));
ok('no juzga un mapa durante el viaje', e.observe({ spot: 26, map: 85, level: 340, now: 60_000, arrivalAt: 0, rate: 0, f: hume, twistingSlash: true }) === null);
const go3 = obs(e, 26, 85, 340, 157e6);
ok('medida Arena 4, prueba Arena 3 sin medir', go3 != null && e.profile(hume, 340, true, 0).spot === 25, go3);
obs(e, 25, 84, 340, 66e6, 240_000);
obs(e, 24, 83, 340, 52e6, 360_000);
ok('con las Arenas medidas va a la mejor (Arena 4)', e.profile(hume, 340, true, 0).spot === 26, e.profile(hume, 340, true, 0));
ok('Arena 1 y Devias no se prueban si las Arenas rinden', ![1, 7, 6, 5].includes(e.profile(hume, 340, true, 0).spot!));

// Grand reset: lo medido con otros stats no cuenta.
const g = new FarmMiddleware();
g.load({ 24: { rate: 261e6, level: 305, n: 2 }, 25: { rate: 77e6, level: 300, n: 7 }, 26: { rate: 562e6, level: 340, n: 29 } });
ok('tras un grand reset vuelve a medir las Arenas', g.profile(hume, 300, true, 0).spot === 26);
ok('Arena 3 a 100M no se descarta por la exp vieja', obs(g, 25, 84, 290, 100e6) != null && g.scores[25]?.power === P);
ok('tras un grand reset no conserva Arena 4 por la exp vieja', !g.keepCurrentArena(85, 345, 60e6, P));

// Histéresis: no salta por poco.
const h = new FarmMiddleware();
h.load({ 26: { rate: 100e6, level: 340, n: 3, power: P }, 25: { rate: 108e6, level: 340, n: 3, power: P }, 24: { rate: 40e6, level: 340, n: 3, power: P } });
ok('en Arena 4 a 100M no se va a Arena 3 por 108M', obs(h, 26, 85, 340, 100e6) === null && h.profile(hume, 340, true, 0).spot === 26);
const h2 = new FarmMiddleware();
h2.load({ 26: { rate: 100e6, level: 340, n: 3, power: P }, 25: { rate: 200e6, level: 340, n: 3, power: P }, 24: { rate: 40e6, level: 340, n: 3, power: P } });
const leave = obs(h2, 26, 85, 340, 60e6);
ok('Arena 4 cae a 60M con Arena 3 a 200M: se va', leave != null && h2.profile(hume, 340, true, 0).spot === 25, leave);

// Competencia que baja la exp: el puntaje baja y elige otro mapa.
const c = new FarmMiddleware();
c.load({ 26: { rate: 150e6, level: 340, n: 5, power: P }, 25: { rate: 90e6, level: 340, n: 3, power: P }, 24: { rate: 40e6, level: 340, n: 3, power: P } });
let why: string | null = null;
for (let i = 0; i < 4 && !why; i++) why = obs(c, 26, 85, 340, 20e6, 120_000 + i * MIN);
ok('Arena 4 llena (20M) termina en Arena 3', why != null && c.profile(hume, 340, true, 0).spot === 25, why);

// Arenas flojas: prueba Devias / Arena 1.
const d = new FarmMiddleware();
d.load({ 26: { rate: 10e6, level: 340, n: 3, power: P }, 25: { rate: 12e6, level: 340, n: 3, power: P }, 24: { rate: 15e6, level: 340, n: 3, power: P } });
ok('Arenas a 10-15M: prueba Arena 1 o Devias', [1, 7].includes(d.profile(hume, 340, true, 0).spot!), d.profile(hume, 340, true, 0));
d.load({ 1: { rate: 0.9e6, level: 340, n: 3, power: P }, 7: { rate: 30e6, level: 340, n: 3, power: P } });
ok('Devias a 30M le gana a Arenas a 15M', d.profile(hume, 340, true, 0).spot === 7);
ok('Devias sin exp pide otra entrada', obs(d, 7, 2, 340, 0) != null);

// Muerte: fuera 10 min.
const m = new FarmMiddleware();
m.load({ 26: { rate: 150e6, level: 340, n: 5, power: P }, 25: { rate: 90e6, level: 340, n: 3, power: P }, 24: { rate: 40e6, level: 340, n: 3, power: P } });
ok('una muerte en Arena 4 la saca 10 min', m.death(85, 0) && m.profile(hume, 340, true, 1000).spot === 25 && m.profile(hume, 340, true, 10 * MIN + 1).spot === 26);

// Semilla de la base: no repite la gira de pruebas.
const sd = new FarmMiddleware();
sd.load({ 26: { rate: 562e6, level: 340, n: 29 } });
sd.seed([{ spot: 26, rate: 157e6, level: 340, n: 14 }, { spot: 25, rate: 66e6, level: 300, n: 2 }, { spot: 24, rate: 52e6, level: 290, n: 2 }], P);
ok('con la base sembrada va directo a Arena 4', sd.profile(hume, 345, true, 0).spot === 26 && sd.scores[26].rate === 157e6, sd.profile(hume, 345, true, 0));
sd.seed([{ spot: 26, rate: 1e6, level: 340, n: 1 }], P);
ok('la semilla no pisa lo medido en vivo con estos stats', sd.scores[26].rate === 157e6);

// Reconexión.
const staying = new FarmMiddleware();
staying.load({ 26: { rate: 80e6, level: 365, n: 5, power: P } });
ok('reconexión conserva Arena 4 rentable', staying.keepCurrentArena(85, 370, 60e6, P));
ok('dato viejo o mapa no medido no la conserva', !staying.keepCurrentArena(85, 470, 60e6, P) && !staying.keepCurrentArena(83, 370, 60e6, P));

console.log(fails ? `${fails} fallo(s)` : 'Middleware OK');
process.exit(fails ? 1 : 0);
