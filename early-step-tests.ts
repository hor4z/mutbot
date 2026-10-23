import { EarlyPlanner } from './early-step';
import { bot, world } from './state';

const saved = { map: world.map, x: world.x, y: world.y, level: world.level, resets: world.resets,
  stats: { ...world.stats }, maxHp: world.maxHp, money: bot.lastMoney, arrival: bot.lastArrivalAt,
  players: new Map(world.players) };
const ok = (name: string, pass: boolean) => { if (!pass) throw new Error(name); console.log(`PASS  ${name}`); };
try {
  Object.assign(world, { map: 0, x: 135, y: 140, level: 10, resets: 4, maxHp: 3000 });
  Object.assign(world.stats, { str: 4000, agi: 1000, vit: 500, ene: 3000 });
  bot.lastMoney = 10_000;
  bot.lastArrivalAt = 12345;
  world.players.clear();
  const early = new EarlyPlanner();
  const normal = early.goal([], 1);
  ok('Lorencia libre: ruta al Lich', normal.camp.y >= 190);
  world.players.set(87, { x: 133, y: 166, name: 'DePaso' });
  ok('jugador en la puerta: es de pasada, sigue al Lich', early.goal([], 2).camp.y >= 190);
  world.players.clear();
  world.players.set(88, { x: 134, y: 200, name: 'CualquierJugador' });
  ok('con stats completos, jugador en el Lich: va al Lich igual (no recorre otro campo)', early.goal([], 3).camp.y >= 190);
} finally {
  Object.assign(world, { map: saved.map, x: saved.x, y: saved.y, level: saved.level, resets: saved.resets, maxHp: saved.maxHp });
  Object.assign(world.stats, saved.stats);
  world.players.clear();
  for (const [id, p] of saved.players) world.players.set(id, p);
  bot.lastMoney = saved.money;
  bot.lastArrivalAt = saved.arrival;
}
