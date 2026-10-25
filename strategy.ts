/**
 * Estrategia por servidor: lo que el bucle de farmeo (farm-loop.ts) decide distinto en el Fast y en el Slow. El servidor sale de
 * `SERVER_KEY` (config.ts). La del Fast es el código de siempre, sin cambios; la del Slow arranca en modo seguro (sin reset, sin
 * cacería y sin viajes por la esquina) hasta tener datos del Slow.
 * Para sumar una decisión que difiere: un campo acá, las dos estrategias la definen y el bucle la lee por `strategy.<campo>`.
 */
import { SERVER_KEY } from './config';
import { world } from './state';
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
  statPlan: ((points: number) => StatValues) | null;
  /** Dónde pararse (null: esperar). */
  choosePlace(): Place | null;
};

export const fastStrategy: Strategy = { server: 'fast', hunts: true, resets: true, spendsPoints: true, jewels: false, lootAll: false, statPlan: null, choosePlace };

/**
 * El Slow, primera versión: sin reset ni cacería; sube de nivel por los spots de siempre según el nivel (Lorencia, Devias 4), levanta Zen,
 * pociones, joyas y equipo, y reparte los puntos pensando en aguantar (Str y Vit: sin pociones la vida es lo que más falta). Los lugares y
 * el reparto son una estimación hasta tener datos del Slow (`server = 'slow'` en ClickHouse); aprender cuánto rinde cada spot es lo que sigue.
 */
export const SLOW_STATS = { str: 0.5, vit: 0.4, agi: 0.1 } as const;
export function slowStatPlan(points: number): StatValues {
  const vit = Math.floor(points * SLOW_STATS.vit);
  const agi = Math.floor(points * SLOW_STATS.agi);
  return { str: points - vit - agi, agi, vit, ene: 0 };
}
/**
 * Spots del Slow, todos en Lorencia (mapa 0), medidos en la sesión del cliente web del 2026-10-25 (avistamientos de monstruos y exp por
 * kill, `scripts/analyze-session.ts`): Spiders hasta el nivel ~12, Bull Fighters hasta el ~45 y Giants desde ahí (~26.000 exp por kill a
 * los niveles 48-74). En este server los Giants viven en Lorencia, no en Devias: la v1 mandaba a Devias 4 y no había nada que matar.
 */
export const SLOW_SPOTS = [
  { minLevel: 0, anchor: { x: 200, y: 137 }, radius: 20, name: 'Lorencia (Spiders)' },
  { minLevel: 12, anchor: { x: 165, y: 55 }, radius: 25, name: 'Lorencia (Bull Fighters)' },
  { minLevel: 45, anchor: { x: 30, y: 22 }, radius: 25, name: 'Lorencia (Giants)' },
] as const;
export function slowPlace(level: number): Place {
  const t = [...SLOW_SPOTS].reverse().find((x) => level >= x.minLevel)!;
  return { kind: 'tier', warp: warp(2), anchor: t.anchor, radius: t.radius, name: t.name };
}
export const slowStrategy: Strategy = {
  server: 'slow', hunts: false, resets: false, spendsPoints: true, jewels: true, lootAll: true, statPlan: slowStatPlan,
  choosePlace: () => (isStrong() == null ? null : slowPlace(world.level)),
};

export const strategy: Strategy = SERVER_KEY === 'slow' ? slowStrategy : fastStrategy;
lootPolicy.jewels = strategy.jewels;
