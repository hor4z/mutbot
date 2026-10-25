/**
 * Estrategia por servidor: lo que el bucle de farmeo (farm-loop.ts) decide distinto en el Fast y en el Slow. El servidor sale de
 * `SERVER_KEY` (config.ts). La del Fast es el código de siempre, sin cambios; la del Slow arranca en modo seguro (sin reset, sin
 * cacería y sin viajes por la esquina) hasta tener datos del Slow.
 * Para sumar una decisión que difiere: un campo acá, las dos estrategias la definen y el bucle la lee por `strategy.<campo>`.
 */
import { SERVER_KEY } from './config';
import { monsterName, world } from './state';
import { lootPolicy, type StatValues } from './farming';
import { choosePlace, isStrong, type Place } from './place';
import { warp } from './warps';

export type Strategy = {
  server: 'fast' | 'slow';
  /** Salir a cazar dorados (y atender los avisos de los compañeros). */
  hunts: boolean;
  /** `/reset` al llegar al nivel de reset. */
  resets: boolean;
  /** Repartir los puntos de stats. */
  spendsPoints: boolean;
  /** Levantar siempre las joyas (Bless, Soul, Life, Chaos, Creation) y con prioridad. En el Fast no valen nada para comerciar; en el Slow son lo más valioso. */
  jewels: boolean;
  /** Levantar también el Zen, las pociones y el equipo (el modo "personaje nuevo" de lootStep). */
  lootAll: boolean;
  /** Reparto de puntos propio (null: el de siempre, progress.ts). */
  statPlan: ((points: number, stats: StatValues) => StatValues) | null;
  /** Puntos que se juntan antes de repartir (null: el de config.ts, 200, pensado para el Fast con resets). */
  statBatchMin: number | null;
  /** Cuánto vale matar a este tipo de monstruo (exp por kill estimada): elige el de más valor por distancia en vez del más cercano. null: el más cercano. */
  targetValue: ((type: number) => number) | null;
  /** Dónde pararse (null: esperar). */
  choosePlace(): Place | null;
};

export const fastStrategy: Strategy = { server: 'fast', hunts: true, resets: true, spendsPoints: true, jewels: false, lootAll: false, statPlan: null, statBatchMin: null, targetValue: null, choosePlace };

/**
 * El Slow, primera versión: sin reset ni cacería; sube de nivel por los spots de siempre según el nivel (Lorencia, Devias 4), levanta Zen,
 * pociones, joyas y equipo, y reparte los puntos pensando en aguantar (Str y Vit: sin pociones la vida es lo que más falta). Los lugares y
 * el reparto son una estimación hasta tener datos del Slow (`server = 'slow'` en ClickHouse); aprender cuánto rinde cada spot es lo que sigue.
 */
export const SLOW_AGI_TARGET = 90; // velocidad de ataque = Agi / 15: con 90 pasa de 5 a 6 con muy pocos puntos
export const SLOW_STATS = { str: 0.45, agi: 0.3, vit: 0.15, ene: 0.1 } as const;
/** Primero Agi hasta 90; el resto 45 % Str, 30 % Agi, 15 % Vit, 10 % Ene (lo que sobra del redondeo, a Str). Estimado con lo medido, a ajustar con datos. */
export function slowStatPlan(points: number, stats: StatValues): StatValues {
  const agiFirst = Math.min(points, Math.max(0, SLOW_AGI_TARGET - stats.agi));
  const rest = points - agiFirst;
  const agi = agiFirst + Math.floor(rest * SLOW_STATS.agi);
  const vit = Math.floor(rest * SLOW_STATS.vit);
  const ene = Math.floor(rest * SLOW_STATS.ene);
  return { str: points - agi - vit - ene, agi, vit, ene };
}

/**
 * Spots del Slow, todos en Lorencia (mapa 0), medidos en la sesión del cliente web del 2026-10-25 (avistamientos de monstruos y exp por
 * kill, `scripts/analyze-session.ts`): Spiders hasta el nivel ~12, Bull Fighters hasta el ~45 y Giants desde ahí (~26.000 exp por kill a
 * los niveles 48-74). En este server los Giants viven en Lorencia, no en Devias: la v1 mandaba a Devias 4 y no había nada que matar.
 */
export const SLOW_SPOTS = [
  { minLevel: 0, anchor: { x: 200, y: 137 }, radius: 20, name: 'Lorencia (Spiders)' },
  { minLevel: 12, anchor: { x: 165, y: 55 }, radius: 25, name: 'Lorencia (Bull Fighters)' },
  { minLevel: 45, anchor: { x: 30, y: 35 }, radius: 30, name: 'Lorencia (Giants)' },
] as const;
export function slowPlace(level: number): Place {
  const t = [...SLOW_SPOTS].reverse().find((x) => level >= x.minLevel)!;
  return { kind: 'tier', warp: warp(2), anchor: t.anchor, radius: t.radius, name: t.name };
}

/**
 * Exp por kill medida en el Slow (`scripts/analyze-session.ts`, niveles 48-74): Giant ~26.000; el resto (Bull Fighter, Hound, Spider…)
 * rinde mucho menos. Los que no están medidos valen poco a propósito: se prefiere el Giant aunque esté más lejos.
 */
export const SLOW_EXP_PER_KILL: Record<string, number> = { Giant: 26_000 };
export const SLOW_DEFAULT_EXP = 3_000;
export const slowTargetValue = (type: number) => SLOW_EXP_PER_KILL[monsterName(type)] ?? SLOW_DEFAULT_EXP;

export const slowStrategy: Strategy = {
  server: 'slow', hunts: false, resets: false, spendsPoints: true, jewels: true, lootAll: true, statPlan: slowStatPlan, statBatchMin: 10, targetValue: slowTargetValue,
  choosePlace: () => (isStrong() == null ? null : slowPlace(world.level)),
};

export const strategy: Strategy = SERVER_KEY === 'slow' ? slowStrategy : fastStrategy;
lootPolicy.jewels = strategy.jewels;
