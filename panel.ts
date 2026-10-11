/**
 * Panel (panel-protocol.ts, ws-server.ts): modo, órdenes de lista cerrada y el estado que se manda
 * cada 1 s. Todo sale de lo que el bot ya trackea de los packets: funciona igual sin navegador.
 * También las señales de dorados a la estación.
 */
import { sayFromPanel } from './chat';
import { SKILL_TABLE, pickAttackSkill } from './combat';
import { eventTimers } from './events';
import { journal, panelLog } from './journal';
import { drops, lootState } from './loot';
import {
  EVENT_KEYS, GOLD_URL, HuntExplorer, chooseHuntMap, countTickets, mapName, resetsPerDay, toPanelCycle,
  validateWarp, type GoldGone, type GoldSighting,
} from './panel-logic';
import type { BotMode, EventTimer, PanelCommand, PanelState } from './panel-protocol';
import { WARP_SPOTS } from './route';
import { GOLDEN_TYPES, bot, expLog, isMate, learned, monsterName, world } from './state';
import { chebyshev } from './util';
import type { CommandResult } from './ws-server';

export function currentMode(): BotMode {
  if (!bot.inGameAt || bot.kicked) return 'connecting';
  if (bot.resetting) return 'resetting';
  if (world.maxHp > 0 && world.hp <= 0) return 'dead';
  if (bot.paused) return 'paused';
  return bot.hunting ? 'hunt' : 'farm';
}

// Señales de dorados a la estación (GOLD_URL): cada dorado que ve, con posición; POST con timeout
// corto y sin reintentos (si la estación no está, se ignora).
export function publishGold(p: GoldSighting | GoldGone) {
  try {
    void fetch(GOLD_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  } catch {
    // fetch tiró sincrónico: tampoco importa.
  }
}

export function stopHunt(reason: string) {
  if (!bot.hunting) return;
  const h = bot.hunting;
  bot.hunting = null;
  bot.retarget = true;
  bot.goalPoint = null;
  // El spot de la cacería no es de la ruta: que la ruta fija decida (adopta el
  // mapa si es el del tramo, si no warpea).
  bot.currentSpot = null;
  bot.canAdopt = true;
  panelLog(`Cacería en ${h.hunt.name} terminada (${reason}): vuelvo a farmear.`);
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
      return { ok: true, msg: `sigo: ${bot.hunting ? `cazando en ${bot.hunting.hunt.name}` : 'farmeo normal'}` };
    case 'farm': {
      const was = [bot.hunting && 'cacería cancelada', bot.pinnedSpot && `spot fijo (${bot.pinnedSpot.name}) liberado`, bot.paused && 'pausa levantada'].filter(Boolean);
      if (bot.hunting) stopHunt('orden del panel');
      bot.pinnedSpot = null;
      bot.pendingWarp = null;
      bot.paused = false;
      return { ok: true, msg: `farmeo normal por la ruta${was.length ? ` (${was.join(', ')})` : ''}` };
    }
    case 'warp': {
      if (!bot.inGameAt) return { ok: false, msg: 'todavía no estoy en el mundo' };
      if (bot.resetting) return { ok: false, msg: 'estoy reseteando, probá en un rato' };
      const v = validateWarp(c.warp, world.level, WARP_SPOTS);
      if (!v.ok) return { ok: false, msg: v.msg };
      if (bot.hunting) stopHunt('orden warp del panel');
      bot.paused = false;
      bot.pendingWarp = v.spot;
      bot.pinnedSpot = v.spot;
      return { ok: true, msg: `voy a ${v.spot.name} (warp ${v.spot.index}); queda fijo hasta la orden farm` };
    }
    case 'say':
      return sayFromPanel(c);
    case 'hunt': {
      if (!bot.inGameAt) return { ok: false, msg: 'todavía no estoy en el mundo' };
      if (bot.resetting) return { ok: false, msg: 'estoy reseteando, probá en un rato' };
      const ch = chooseHuntMap({ invasion: bot.invasion, level: world.level, map: c.map });
      if (!ch.ok) return { ok: false, msg: ch.msg };
      if (bot.invasion?.status === 'active' && ch.alive === 0) return { ok: false, msg: `el último 0xFD dice 0 dorados vivos en ${ch.hunt.name}` };
      bot.hunting = { hunt: ch.hunt, since: Date.now(), warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set() };
      bot.pinnedSpot = null;
      bot.pendingWarp = null;
      bot.paused = false;
      bot.retarget = true;
      return { ok: true, msg: `cazo dorados en ${ch.hunt.name}${ch.alive != null ? ` (${ch.alive} vivos según el 0xFD)` : ''}; corto a los 15 min o cuando no queden` };
    }
  }
}

export async function handlePanelCommand(c: PanelCommand): Promise<CommandResult> {
  const r = runPanelCommand(c);
  panelLog(`Orden del panel ${JSON.stringify(c)}: ${r.ok ? '' : 'rechazada, '}${r.msg}.`);
  journal('command', `${c.cmd}: ${r.msg}`, { command: c, ok: r.ok });
  return r;
}

// Cambios de modo: se detectan en el tick de 1 s del panel (cubre todo: órdenes,
// muerte, reset, reconexión) y van al log del panel y al de decisiones.
let lastMode: BotMode | null = null;
export function noteModeChange() {
  const m = currentMode();
  if (m === lastMode) return;
  const from = lastMode;
  lastMode = m;
  if (from == null) return;
  panelLog(`Modo: ${from} → ${m}.`);
  journal('mode', `${from} → ${m}`, { from, to: m });
}

// Rastro para el minimapa: una posición cada 2 s, solo del mapa actual.
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
    monsters: [...world.npcs.values()].slice(0, 150).map((n) => ({ id: n.id, x: n.x, y: n.y, type: n.type, name: monsterName(n.type), gold: GOLDEN_TYPES.has(n.type), target: n.id === tgt })),
    players: [...world.players.entries()].slice(0, 60).map(([id, p]) => ({ id, x: p.x, y: p.y, ...(p.name ? { name: p.name, mate: isMate(p.name) } : {}) })),
    drops: [...drops.values()].slice(0, 80).map((d) => ({ x: d.x, y: d.y, money: !!d.isMoney, valuable: !d.isMoney && (d.group === 14 && d.num === 11 || !!d.excellent), name: d.isMoney ? `${d.amount ?? ''} zen` : `${d.group}/${d.num}${d.excellent ? ' exc' : ''}` })),
  };
}

export function buildPanelState(now: number): PanelState {
  const cycleLog = learned.cycleLog;
  const cycles = cycleLog.done.slice(-20).map((c) => toPanelCycle(c));
  const equipment = [...world.inventory.values()]
    .filter((it) => it.slot >= 0 && it.slot <= 11)
    .sort((a, b) => a.slot - b.slot)
    .map((it) => ({ slot: it.slot, group: it.group, num: it.num, level: it.level ?? 0, excellent: !!it.excellent }));
  return {
    at: now,
    mode: currentMode(),
    doing: bot.paused ? 'en pausa' : bot.doing,
    char: {
      name: bot.charName,
      level: world.level,
      resets: world.resets ?? (learned.char.resets || null),
      ...(world.classId != null ? { classId: world.classId } : {}),
      hp: [world.hp, world.maxHp],
      mp: [world.mana, world.maxMana],
      stats: { ...world.stats },
      points: world.levelUpPoints,
      zen: bot.inGameAt ? bot.lastMoney : null,
    },
    where: { map: world.map, mapName: mapName(world.map), x: world.x, y: world.y, spot: bot.hunting ? `cacería ${bot.hunting.hunt.name}` : (bot.currentSpot?.name ?? null) },
    exp: { perMin1: Math.round(expLog.perMin(now, 60_000)), perMin5: Math.round(expLog.perMin(now, 5 * 60_000)) },
    cycle: toPanelCycle(cycleLog.cur, true),
    cycles,
    resetsPerDay: resetsPerDay(cycles),
    events: EVENT_KEYS.map((k) => eventTimers.get(k)).filter((t): t is EventTimer => !!t),
    invasion: bot.invasion,
    tickets: countTickets(world.inventory.values()),
    nearby: {
      monsters: [...world.npcs.values()].filter((n) => chebyshev(n.x, n.y, world.x, world.y) <= 10).length,
      players: world.players.size,
    },
    equipment,
    trail: trail.map(([x, y]) => [x, y] as [number, number]),
    camp: bot.goalPoint,
    entities: buildPanelEntities(),
    session: (() => {
      const v = loopView?.();
      const skill = pickAttackSkill();
      return { since: sessionStart.at, level0: sessionStart.level || world.level, kills: v?.kills ?? 0, deaths: v?.deaths ?? 0, casts: v?.casts ?? 0, exp: v?.exp ?? 0, loot: lootState.count, skill: skill ? (SKILL_TABLE.get(skill.number)?.name ?? `skill ${skill.number}`) : 'golpe' };
    })(),
  };
}
