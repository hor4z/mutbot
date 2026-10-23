import { FightHeat, HEAT_WINDOW_MS, parseFight } from './fight-heat';

let fails = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

// 0x18 (golpe): C1 09 18 <atacante u16> <dir> <anim> <objetivo u16>
ok('parse: golpe 0x18', JSON.stringify(parseFight(Uint8Array.from([0xc1, 9, 0x18, 0x00, 0x2a, 1, 1, 0x04, 0x10]))) === JSON.stringify({ attacker: 42, target: 0x410 }));
// 0x19 de 8 bytes: C3 08 19 <skill> <atacante u16> <objetivo u16>
ok('parse: skill dirigido de 8 bytes', parseFight(Uint8Array.from([0xc3, 8, 0x19, 43, 0x00, 0x07, 0x04, 0x11]))?.attacker === 7);
ok('parse: curar/buff (skill amistoso) no es pelea', parseFight(Uint8Array.from([0xc3, 8, 0x19, 48, 0x00, 0x07, 0x04, 0x11])) === null);
ok('parse: otro packet → null', parseFight(Uint8Array.from([0xc1, 5, 0x10, 0, 0])) === null);

const t0 = 1_000_000;
const heat = new FightHeat();
heat.record(1, 100, 100, t0); heat.record(2, 103, 101, t0 + 500);
ok('2 jugadores no son una pelea', heat.hotspot(t0 + 1000) === null);
heat.record(3, 101, 104, t0 + 900);
const h = heat.hotspot(t0 + 1000);
ok('3 jugadores juntos → hay pelea', h !== null && h.attackers === 3);
ok('el centro cae entre ellos', h !== null && h.x >= 100 && h.x <= 103 && h.y >= 100 && h.y <= 104);
ok('pasada la ventana se enfría', heat.hotspot(t0 + 900 + HEAT_WINDOW_MS + 1) === null);
const far = new FightHeat();
far.record(1, 10, 10, t0); far.record(2, 100, 100, t0); far.record(3, 200, 200, t0);
ok('jugadores lejos entre sí no suman', far.hotspot(t0 + 10) === null);
const same = new FightHeat();
for (let i = 0; i < 20; i++) same.record(5, 50, 50, t0 + i * 100);
ok('uno solo pegando 20 veces no es multitud', same.hotspot(t0 + 2500) === null);

if (fails) { console.log(`\n${fails} FALLARON`); process.exit(1); }
console.log('\nTODOS LOS TESTS DE LA PELEA A LA VISTA PASARON');
