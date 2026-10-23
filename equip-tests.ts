/**
 * Tests offline de equip.ts (lugar por grupo, mejor ítem, hueco libre en la bolsa). Sin red.
 *
 *   bun run equip-tests.ts
 */
import { betterItem, equipSlotFor, freeBagSlot } from './equip';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

ok('lugar: hacha → mano, escudo → 1, casco → 2, botas → 6, joya → nada',
  equipSlotFor(1) === 0 && equipSlotFor(6) === 1 && equipSlotFor(7) === 2 && equipSlotFor(11) === 6 && equipSlotFor(14) === null);
ok('mejor: Hand Axe (1/1) mejor que Small Axe (1/0); vacío siempre', betterItem({ group: 1, num: 1 }, { group: 1, num: 0 }) && betterItem({ group: 7, num: 5 }, undefined));
ok('mejor: mismo ítem, más +', betterItem({ group: 7, num: 5, level: 3 }, { group: 7, num: 5, level: 1 }) && !betterItem({ group: 7, num: 5 }, { group: 7, num: 5 }));
// Dragon Shield (6/13, 2×2) en 12 y 14: ocupan columnas 0-3 de las filas 0-1.
const bag = [{ slot: 12, group: 6, num: 13 }, { slot: 14, group: 6, num: 13 }];
ok('hueco: un 1×3 entra en la columna 4', freeBagSlot(bag, 1, 3) === 16, freeBagSlot(bag, 1, 3));
ok('hueco: un 2×2 en la columna 4', freeBagSlot(bag, 2, 2) === 16);
const full = Array.from({ length: 64 }, (_, i) => ({ slot: 12 + i, group: 14, num: 0 }));
ok('hueco: bolsa llena → null', freeBagSlot(full, 1, 1) === null);

console.log(fails === 0 ? '\nTODOS LOS TESTS DE EQUIPO PASARON' : `\n${fails} TEST(S) DE EQUIPO FALLARON`);
process.exit(fails ? 1 : 0);
