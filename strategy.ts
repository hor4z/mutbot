/**
 * Estrategia por servidor: lo que el bucle de farmeo (farm-loop.ts) decide distinto en el Fast y en el Slow. El servidor sale de
 * `SERVER_KEY` (config.ts). La del Fast es el código de siempre, sin cambios; la del Slow arranca en modo seguro (sin reset, sin
 * repartir puntos, sin cacería ni viajes: se queda donde está y pelea lo que tiene cerca) hasta tener datos del Slow.
 * Para sumar una decisión que difiere: un campo acá, las dos estrategias la definen y el bucle la lee por `strategy.<campo>`.
 */
import { SERVER_KEY } from './config';
import { lootPolicy } from './farming';
import { choosePlace, type Place } from './place';
import { bot, world } from './state';
import type { Pos } from './util';

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
  /** Dónde pararse (null: esperar). */
  choosePlace(): Place | null;
};

export const fastStrategy: Strategy = { server: 'fast', hunts: true, resets: true, spendsPoints: true, jewels: false, choosePlace };

/** El Slow en modo seguro: el ancla es donde se entró (o donde se paró al cambiar de mapa) y el radio, el de la pelea cercana. */
let stay: { map: number; anchor: Pos } | null = null;
export const SLOW_RADIUS = 12;
const stayPlace = (): Place => {
  if (!stay || stay.map !== world.map) stay = { map: world.map, anchor: { x: world.x, y: world.y } };
  return { kind: 'tier', warp: { index: -1, name: 'donde estoy', reqLevel: 0, map: world.map }, anchor: stay.anchor, radius: SLOW_RADIUS, name: 'donde estoy' };
};
export const slowStrategy: Strategy = {
  server: 'slow', hunts: false, resets: false, spendsPoints: false, jewels: true,
  choosePlace: () => (bot.playerId < 0 ? null : stayPlace()),
};

export const strategy: Strategy = SERVER_KEY === 'slow' ? slowStrategy : fastStrategy;
lootPolicy.jewels = strategy.jewels;
