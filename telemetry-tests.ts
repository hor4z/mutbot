// Tests de datos (sin red): buffer de telemetry.ts y perilla de party de knowledge.ts.
import { RowBuffer, chTime } from './telemetry';
import { PARTY_MIN_TICKS, decideParty, experimentSlot } from './knowledge';

let fails = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

const b = new RowBuffer(3);
for (let i = 0; i < 5; i++) b.push('ticks', { i });
ok('buffer: con tope se tiran las más viejas', b.size === 3 && b.dropped === 2);
const taken = b.take();
ok('buffer: take vacía y devuelve las filas', b.size === 0 && taken[0][1].map((r) => r.i).join() === '2,3,4');
b.restore('ticks', taken[0][1]);
ok('buffer: restore las devuelve', b.size === 3);
ok('chTime: formato DateTime64(3)', chTime(Date.UTC(2026, 9, 11, 15, 4, 5, 6)) === '2026-10-11 15:04:05.006');

const T = PARTY_MIN_TICKS;
ok('party: sin datos → sí', decideParty([]).use === true);
ok('party: sin party rinde 20 % más → no', decideParty([
  { char: 'Horaz', in_party: 1, ticks: T, exp_min: 400e6 }, { char: 'Melu', in_party: 1, ticks: T, exp_min: 100e6 },
  { char: 'Horaz', in_party: 0, ticks: T, exp_min: 480e6 }, { char: 'Melu', in_party: 0, ticks: T, exp_min: 120e6 },
]).use === false);
ok('party: decide por Horaz (prioritario) aunque Melu gane con party', decideParty([
  { char: 'Horaz', in_party: 1, ticks: T, exp_min: 300e6 }, { char: 'Melu', in_party: 1, ticks: T, exp_min: 300e6 },
  { char: 'Horaz', in_party: 0, ticks: T, exp_min: 400e6 }, { char: 'Melu', in_party: 0, ticks: T, exp_min: 50e6 },
]).use === false);
ok('party: diferencia menor al margen → sí', decideParty([
  { char: 'Horaz', in_party: 1, ticks: T, exp_min: 400e6 }, { char: 'Horaz', in_party: 0, ticks: T, exp_min: 410e6 },
]).use === true);
ok('party: pocos ticks de un lado → sí (faltan datos)', decideParty([
  { char: 'Horaz', in_party: 1, ticks: T, exp_min: 1e6 }, { char: 'Horaz', in_party: 0, ticks: T - 1, exp_min: 900e6 },
]).use === true);
let exp = 0;
for (let i = 0; i < 1000; i++) if (experimentSlot(i * 1_800_000, 1)) exp++;
ok(`experimento: ~10 % de los bloques (${exp / 10} %)`, exp > 60 && exp < 140);

console.log(fails === 0 ? '\nTODOS LOS TESTS PASARON' : `\n${fails} TEST(S) FALLARON`);
process.exit(fails ? 1 : 0);
