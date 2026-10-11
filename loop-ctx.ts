/**
 * Estado de UNA corrida del loop autónomo (una por conexión) que comparten farm-loop.ts y
 * corner-step.ts, y las dos acciones que lo usan: caminar rodeando obstáculos y tirar un skill de
 * área en el camino.
 */
import { SKILL_PACE_MS, WALK_PACE_MS } from './config';
import { sendAreaSkill, step } from './actions';
import { CAMP, castCandidate } from './camp';
import { AREA_SKILLS, SKILL_MIN_MANA, pickAttackSkill } from './combat';
import type { TimeKind } from './farming';
import { world, type ScopedNpc } from './state';
import { directionTowards, sleep } from './util';

export type LoopCtx = {
  // Monstruos atacables: los de world.npcs que NO están en zona segura (se recalcula cada tick).
  npcs: Map<number, ScopedNpc>;
  target: number | null;
  // Fase de la iteración actual: el tiempo hasta la próxima se le atribuye (SelfReport).
  phase: TimeKind;
  lastCastAt: number;
  skillsUsed: number;
  // Pasos seguidos sin avanzar caminando (walkTowards) y la última posición tras un paso.
  walkStuck: number;
  lastX: number;
  lastY: number;
  // Exp ganada en esta corrida (para medir los lados de la esquina) y monstruos que me pegaron (id → cuándo).
  expTotal: number;
  aggro: Map<number, number>;
};

export function newLoopCtx(): LoopCtx {
  return { npcs: new Map(), target: null, phase: 'other', lastCastAt: 0, skillsUsed: 0, walkStuck: 0, lastX: world.x, lastY: world.y, expTotal: 0, aggro: new Map() };
}

// Un paso hacia (x, y); si no avanza, rodea el obstáculo abriendo de a 45°
// (alternando lados) y vuelve a la recta.
export async function walkTowards(ctx: LoopCtx, x: number, y: number) {
  const straight = directionTowards(world.x, world.y, x, y);
  const k = Math.ceil(ctx.walkStuck / 2);
  const dir = ctx.walkStuck === 0 ? straight : (straight + (ctx.walkStuck % 2 ? k : 8 - k) + 8) % 8;
  const bx = world.x;
  const by = world.y;
  step(dir);
  await sleep(WALK_PACE_MS);
  ctx.walkStuck = world.x === bx && world.y === by ? (ctx.walkStuck % 6) + 1 : 0;
  ctx.lastX = world.x;
  ctx.lastY = world.y;
}

// Skill de área con CUALQUIER monstruo a <= CAST_RANGE, aunque esté
// caminando (Twisting Slash gira alrededor del DK). Respeta SKILL_PACE_MS
// entre casts y no espera: el paso de caminata sigue en la misma iteración.
export function castOnTheWay(ctx: LoopCtx): boolean {
  const now = Date.now();
  if (now - ctx.lastCastAt < SKILL_PACE_MS) return false;
  const skill = pickAttackSkill();
  if (!skill || !AREA_SKILLS.has(skill.number)) return false;
  if (world.maxMana > 0 && world.mana / world.maxMana < SKILL_MIN_MANA) return false;
  const t = ctx.target != null ? ctx.npcs.get(ctx.target) ?? null : null;
  const c = castCandidate({ x: world.x, y: world.y }, ctx.npcs.values(), t, CAMP.CAST_RANGE);
  if (!c) return false;
  sendAreaSkill(skill.index, c.x, c.y, directionTowards(world.x, world.y, c.x, c.y), c.id);
  ctx.lastCastAt = now;
  ctx.skillsUsed++;
  return true;
}
