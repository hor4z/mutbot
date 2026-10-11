/**
 * Tests offline de golden.ts (regla fuerte de dorados). Sin red, reloj simulado.
 *
 *   bun run golden-tests.ts
 */
import { GOLDEN_RULE, GoldenRule } from './golden';

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

console.log(fails === 0 ? '\nTODOS LOS TESTS DE DORADOS PASARON' : `\n${fails} TEST(S) DE DORADOS FALLARON`);
process.exit(fails ? 1 : 0);
