/**
 * Estado compartido del bot. Un proceso = un personaje (la estación lanza el del personaje), así
 * que son singletons de módulo. Lo que varios módulos escriben vive en objetos explícitos (`world`,
 * `bot`): los `let` de un módulo ES no se pueden asignar desde otro.
 *
 *   world    lo que el bot cree de sí mismo y de su alrededor, según los packets S2C
 *   bot      decisiones y estado para el panel (spot, modo, cacería, órdenes pendientes...)
 */
import { CHAR_NAME, type StatName } from './config';
import { ExpLog } from './farming';
import type { Warp } from './warps';
import type { StatusServer } from './ws-server';
import { monsters, onGameData } from './gamedata';

// Tablas derivadas de la de monstruos del cliente (base, `gamedata.ts`): se llenan cuando los datos llegan y se rehacen si se recargan.
// MONSTER_TYPE_NUMBERS: los tipos que son monstruos de verdad (AttType != 0, se mueven y tienen vida). Los NPC de pueblo y los custom del server
// que no atacan (vendedores, cofres: AttType 0) quedan afuera, así que el bot no los toma por algo atacable. Sin tope de Move: los de nivel alto
// (Deathvim Knight, Phantom Knight, Gaint Drakan…) se mueven mucho.
export const MONSTER_TYPE_NUMBERS = new Set<number>();
const MONSTER_NAMES = new Map<number, string>();
const MONSTER_MAX_HP = new Map<number, number>();
const MONSTER_LEVELS = new Map<number, number>();
onGameData('state', () => {
  MONSTER_TYPE_NUMBERS.clear(); MONSTER_NAMES.clear(); MONSTER_MAX_HP.clear(); MONSTER_LEVELS.clear();
  for (const m of monsters) {
    if (m.AttType !== 0 && m.Move > 0 && m.HP > 0) MONSTER_TYPE_NUMBERS.add(m.Numb);
    MONSTER_NAMES.set(m.Numb, m.Name);
    if (m.HP > 0) MONSTER_MAX_HP.set(m.Numb, m.HP);
    MONSTER_LEVELS.set(m.Numb, m.Level);
  }
});

/** Vida máxima de un tipo de monstruo según la tabla del cliente (null: sin dato). */
export const monsterMaxHp = (type: number): number | null => MONSTER_MAX_HP.get(type) ?? null;

/**
 * Lo último que se sabe de la vida de un monstruo golpeado (id → estado). `pct` viene del server (ObjectHitExtended: la barra roja del
 * cliente) y es null si todavía no llegó; `dealt` es el daño que suma lo que vimos (0x15), para estimarla si el server no la manda.
 */
export type HitInfo = { pct: number | null; dealt: number; at: number };

export type ScopedNpc = { id: number; type: number; x: number; y: number };
/** `raw`: los 5 bytes del ítem tal como llegaron (el packet de mover ítem los lleva). */
export type ItemSlot = { slot: number; group: number; num: number; level?: number; excellent?: boolean; raw?: Uint8Array };
export type SkillInfo = { index: number; number: number; level: number };

export const monsterName = (type: number) => MONSTER_NAMES.get(type) ?? `tipo ${type}`;
export const monsterLevel = (type: number): number | null => MONSTER_LEVELS.get(type) ?? null;
// ---------------------------------------------------------------------------
// Estado del mundo (lo que el bot cree de sí mismo) — se actualiza con los
// packets S2C (world.ts). Es la única fuente de verdad del loop autónomo.
// ---------------------------------------------------------------------------
export const world = {
  x: 0,
  y: 0,
  map: 0,
  hp: 0,
  maxHp: 0,
  mana: 0,
  maxMana: 0,
  level: 0,
  levelUpPoints: 0,
  stats: { str: 0, agi: 0, vit: 0, ene: 0 } as Record<StatName, number>,
  skills: new Map<number, SkillInfo>(), // por número de skill
  inventory: new Map<number, ItemSlot>(), // por slot de inventario
  npcs: new Map<number, ScopedNpc>(), // solo monstruos (isMonsterType)
  hits: new Map<number, HitInfo>(), // vida conocida de los golpeados (ver HitInfo)
  // Otros jugadores en scope (para no competirles el objetivo, ver farming.ts).
  players: new Map<number, { x: number; y: number; name?: string }>(),
  // NPC de pueblo/servicio (TypeNumber 200-299) en scope: no son monstruos.
  townNpcs: new Map<number, ScopedNpc>(),
  // Clase cruda del CharacterList (ver parseCharacterList097); null = no se sabe.
  classId: null as number | null,
};

/**
 * Lo que el cerebro (farm-loop, area, combat, learning…, recargable en caliente: hot.ts) le muestra al núcleo (panel, telemetría). El cerebro los
 * instala al cargarse (brain.ts `install`); mientras tanto valen los defaults. Así el núcleo nunca importa el cerebro.
 */
export const hooks = {
  /** Nombre del lugar donde farmea (para ticks y eventos). */
  placeName: (): string => '',
  /** Exp que da un tipo de monstruo (para resaltar en el radar). */
  value: (_type: number): number => 0,
  /** Skill de ataque actual. */
  skill: (): { number: number; name: string } | null => null,
  /** Plan de reparto de puntos. */
  plan: (): { agiTarget: number; shares: { str: number; agi: number; vit: number; ene: number }; batch: number } | null => null,
};

export const bot = {
  // Id propio en el game server (GameServerEntered), sin el bit alto.
  playerId: -1,
  // Se cerró el socket del game server: el loop termina y main() reconecta.
  kicked: false,
  // Servidor de telemetría opcional (--ws-port). Solo lectura: ver ws-server.ts.
  statusServer: undefined as StatusServer | undefined,
  // 0 = fuera del mundo (conectando, en la selección de personaje).
  inGameAt: 0,
  charName: CHAR_NAME,
  // El bot no compra ni vende (pedido del usuario): solo lleva el zen para el panel.
  lastMoney: 0,
  currentSpot: null as Warp | null,
  // Se puede adoptar el mapa actual como spot sin warpear (al entrar al mundo);
  // tras una muerte no (respawnea en el pueblo: hay que volver a warpear).
  canAdopt: true,
  // Último spot en el que estuvo (tras morir se vuelve a esa entrada).
  lastSpotIndex: null as number | null,
  lastWarpAt: 0,
  // Último MapChanged / entrada al mundo (el hambre no mira el primer minuto).
  lastArrivalAt: Date.now(),
  // Pausa: el loop no camina, no pelea ni warpea; las pociones siguen.
  paused: false,
  // Orden del panel: ir a Lorencia y quedarse en pausa (lo consume el loop en pausa).
  townNow: false,
  // El loop descarta su objetivo en el próximo tick (cambio de modo).
  retarget: false,
  // En party (PartyList recibido; RemovePartyMember lo saca).
  inParty: false,
  // Cambió el cerebro (hot.ts): el loop termina limpio y la sesión lo vuelve a arrancar con el nuevo, sin reconectar.
  reloadBrain: false,
  // La sesión terminó por ceguera (farm-loop): la reconexión espera más (el server suelta la vieja).
  blind: false,
  // Frase corta de lo que hace ahora (la pone el loop).
  doing: 'conectando',
  // Punto al que va ahora (campamento, salida, celda de la cacería).
  goalPoint: null as [number, number] | null,
};

// Registro de exp por segundo (farming.ts, ExpLog): TODAS las mediciones de exp/min salen de acá.
export const expLog = new ExpLog(Date.now());

