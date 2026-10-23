import { FEED_MAX_AGE_MS, feedHints, parseFeed } from './gold-feed';

let fails = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };
const t0 = 1_000_000;
const g = (o: Partial<{ from: string; map: number; x: number; y: number; name: string; id: number; at: number }> = {}) => ({ from: 'Zamu', map: 2, x: 194, y: 79, name: 'Golden Dragon', id: 77, at: t0, ...o });

ok('parse: acepta una señal válida', parseFeed([g()]).length === 1);
ok('parse: descarta basura y campos que faltan', parseFeed([null, 3, { from: 'x' }, { ...g(), x: 'a' }]).length === 0);
ok('parse: no-array → vacío', parseFeed({ a: 1 }).length === 0);
ok('pista: señal fresca de otro en el mismo mapa', feedHints([g()], 2, 'Hume', t0 + 3000).length === 1);
ok('pista: la clave es negativa (no choca con ids de monstruos)', feedHints([g()], 2, 'Hume', t0 + 1000)[0].key < 0);
ok('pista: no se usa lo propio', feedHints([g({ from: 'Hume' })], 2, 'Hume', t0 + 1000).length === 0);
ok('pista: otro mapa no sirve', feedHints([g({ map: 0 })], 2, 'Hume', t0 + 1000).length === 0);
ok('pista: vieja (> tope) no sirve', feedHints([g()], 2, 'Hume', t0 + FEED_MAX_AGE_MS + 1).length === 0);
ok('pista: justo en el tope sirve', feedHints([g()], 2, 'Hume', t0 + FEED_MAX_AGE_MS).length === 1);
ok('pista: reloj adelantado de la estación (> 5 s) no sirve', feedHints([g({ at: t0 + 60_000 })], 2, 'Hume', t0).length === 0);

if (fails) { console.log(`\n${fails} FALLARON`); process.exit(1); }
console.log('\nTODOS LOS TESTS DEL FEED DE DORADOS PASARON');
