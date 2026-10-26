/**
 * Panel (panel-protocol.ts, ws-server.ts): modo, órdenes de lista cerrada y el estado que se manda cada 1 s. Todo sale de lo que el
 * bot ya trackea de los packets: funciona igual sin navegador. Las órdenes se aplican en el próximo tick del loop (< 1 s).
 */
import { decide, recentNotes } from './journal';
import { drops, lootState } from './loot-state';
import { mapName } from './panel-logic';
import type { BotMode, PanelCommand, PanelState } from './panel-protocol';
import { bot, expLog, hooks, monsterName, world } from './state';
import type { CommandResult } from './ws-server';

export function currentMode(): BotMode {
  if (!bot.inGameAt || bot.kicked) return 'connecting';
  if (world.maxHp > 0 && world.hp <= 0) return 'dead';
  if (bot.paused) return 'paused';
  return 'farm';
}

function runPanelCommand(c: PanelCommand): CommandResult {
  switch (c.cmd) {
    case 'pause':
      if (bot.paused) return { ok: true, msg: 'ya estaba en pausa' };
      bot.paused = true;
      bot.retarget = true;
      return { ok: true, msg: 'en pausa: no camino, no peleo ni warpeo (las pociones siguen)' };
    case 'resume':
      if (!bot.paused) return { ok: true, msg: 'no estaba en pausa' };
      bot.paused = false;
      return { ok: true, msg: 'sigo farmeando' };
    case 'town':
      bot.paused = true;
      bot.townNow = true;
      bot.retarget = true;
      return { ok: true, msg: 'voy a Lorencia y me quedo en pausa' };
  }
}

export async function handlePanelCommand(c: PanelCommand): Promise<CommandResult> {
  const r = runPanelCommand(c);
  decide(`Orden del panel ${JSON.stringify(c)}: ${r.ok ? '' : 'rechazada, '}${r.msg}.`, { kind: 'order', command: c, ok: r.ok });
  return r;
}

// Cambios de modo: se detectan en el tick de 1 s del panel (cubre todo: órdenes, muerte, reconexión) y se cuentan en palabras.
const MODE_TEXT: Record<string, string> = {
  'connecting>farm': 'Entró al juego y empieza a farmear.',
  'connecting>paused': 'Entró al juego en pausa.',
  'farm>paused': 'Quedó en pausa.',
  'paused>farm': 'Volvió a farmear.',
  'farm>dead': 'Murió.',
  'paused>dead': 'Murió.',
  'dead>farm': 'Revivió y vuelve a farmear.',
  'dead>paused': 'Revivió y sigue en pausa.',
};
let lastMode: BotMode | null = null;
export function noteModeChange() {
  const m = currentMode();
  if (m === lastMode) return;
  const from = lastMode;
  lastMode = m;
  if (from == null) return;
  const text = m === 'connecting' ? 'Se desconectó del juego, reconecta.' : (MODE_TEXT[`${from}>${m}`] ?? `Cambió de estado: ${from} a ${m}.`);
  decide(text, { kind: 'system', from, to: m });
}

// Rastro para el radar: una posición cada 2 s, solo del mapa actual.
const TRAIL_MAX = 60;
const trail: [number, number][] = [];
let trailMap = -1;
let lastTrailAt = 0;
export function updateTrail(now: number) {
  if (world.map !== trailMap) {
    trail.length = 0;
    trailMap = world.map;
  }
  if (now - lastTrailAt < 2000) return;
  lastTrailAt = now;
  trail.push([world.x, world.y]);
  if (trail.length > TRAIL_MAX) trail.shift();
}

// Lo que el bucle autónomo cuenta en variables locales, expuesto al panel (sesión y objetivo).
export type LoopView = () => { kills: number; deaths: number; casts: number; exp: number; target: number | null };
let loopView: LoopView | null = null;
export function setLoopView(v: LoopView) {
  loopView = v;
}
export const sessionStart = { at: Date.now(), level: 0 };

function buildPanelEntities(): NonNullable<PanelState['entities']> {
  const tgt = loopView?.().target ?? null;
  return {
    monsters: [...world.npcs.values()].slice(0, 150).map((n) => ({ id: n.id, x: n.x, y: n.y, type: n.type, name: monsterName(n.type), target: n.id === tgt, value: hooks.value(n.type) })),
    players: [...world.players.entries()].slice(0, 60).map(([id, p]) => ({ id, x: p.x, y: p.y, ...(p.name ? { name: p.name } : {}) })),
    drops: [...drops.values()].slice(0, 80).map((d) => ({ x: d.x, y: d.y, money: !!d.isMoney, valuable: !d.isMoney && (d.group === 14 && d.num === 11 || !!d.excellent), name: d.isMoney ? `${d.amount ?? ''} zen` : `${d.group}/${d.num}${d.excellent ? ' exc' : ''}` })),
  };
}

export function buildPanelState(now: number): PanelState {
  return {
    at: now,
    mode: currentMode(),
    doing: bot.paused ? 'en pausa' : bot.doing,
    char: {
      name: bot.charName,
      level: world.level,
      ...(world.classId != null ? { classId: world.classId } : {}),
      hp: [world.hp, world.maxHp],
      mp: [world.mana, world.maxMana],
      stats: { ...world.stats },
      points: world.levelUpPoints,
      zen: bot.inGameAt ? bot.lastMoney : null,
    },
    where: { map: world.map, mapName: mapName(world.map), x: world.x, y: world.y, spot: bot.currentSpot?.name ?? null },
    exp: { perMin1: Math.round(expLog.perMin(now, 60_000)), perMin5: Math.round(expLog.perMin(now, 5 * 60_000)) },
    nearby: {
      monsters: [...world.npcs.values()].filter((n) => Math.hypot(n.x - world.x, n.y - world.y) <= 10).length,
      players: world.players.size,
    },
    trail: trail.map(([x, y]) => [x, y] as [number, number]),
    camp: bot.goalPoint,
    entities: buildPanelEntities(),
    plan: hooks.plan() ?? undefined,
    notes: recentNotes(),
    session: (() => {
      const v = loopView?.();
      const skill = hooks.skill();
      return { since: sessionStart.at, level0: sessionStart.level || world.level, kills: v?.kills ?? 0, deaths: v?.deaths ?? 0, casts: v?.casts ?? 0, exp: v?.exp ?? 0, loot: lootState.count, skill: skill ? skill.name : 'golpe' };
    })(),
  };
}
