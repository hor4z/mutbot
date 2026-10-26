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
import monstersData from './data/monsters.json';

// TypeNumber reales de monstruos (del propio dataset del juego), para no confundir
// un NPC amistoso del pueblo (vendedor, etc.) con algo atacable.
// monsters.json incluye también los NPC amistosos del pueblo (Amy la de las
// pociones, Berdysh Guard, Malron...), así que el Numb solo no alcanza: hay que
// filtrar también por atributos de combate. Los monstruos reales se mueven poco
// (Move <= 12) y tienen AttType != 0; los NPC de pueblo se quedan quietos y no
// atacan. Antes de este filtro el bot atacaba a Amy y no lograba ninguna kill.
type MonsterRow = {
  Numb: number;
  Name: string;
  Move: number;
  AttType: number;
  HP: number;
  Level: number;
  AttSpeed: number;
};
// Move es el rango de patrulla, no la velocidad: monstruos reales llegan a ~22
// (Skeleton), los guardias del pueblo (no atacables) tienen 100. Con tope 12 el
// bot descartaba Skeletons y quedaba ciego en Dungeon.
//
// Esto es solo "lo que monsters.json conoce como atacable". La regla final la
// aplica isMonsterType() (explore.ts): fuera de 200-299 (NPC de pueblo/servicio
// del 0.97) Y (en este set O TypeNumber >= 300, los custom de este server, ej.
// 690/692, que monsters.json no tiene).
//
// Sin tope de Move (2026-10-11): con Move <= 50 el bot quedaba ciego en Arena 2/3/4 (Deathvim Knight 220,
// Phantom Knight 270, Gaint Drakan 305) y en casi todo lo de nivel alto. Los guardias del pueblo ya los
// excluye isMonsterType (rango 200-299).
export const MONSTER_TYPE_NUMBERS = new Set([
  ...(monstersData as MonsterRow[])
    .filter((m) => m.AttType !== 0 && m.Move > 0 && m.HP > 0)
    .map((m) => m.Numb),
]);
// Nombre por TypeNumber (para el panel y los logs de la cacería).
const MONSTER_NAMES = new Map<number, string>((monstersData as MonsterRow[]).map((m) => [m.Numb, m.Name]));

// Vida máxima por TypeNumber. El cliente web la lee del attributeSystem del
// monstruo (`maxHealth`); en el protocolo headless no llega en ningún packet
// que parseemos (AddNpcsToScope095 trae id/tipo/posición, nada más), así que
// sale de data/monsters.json (`HP` por `Numb`). Para los custom >= 300 de
// este server no hay dato: farming.ts estima con la mediana de lo medido.
const MONSTER_MAX_HP = new Map<number, number>(
  (monstersData as MonsterRow[]).filter((m) => m.HP > 0).map((m) => [m.Numb, m.HP]),
);

/** Vida máxima de un tipo de monstruo según data/monsters.json (null: custom sin dato). */
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
// Nivel por TypeNumber (farmeo inicial: solo monstruos acordes al personaje). Custom >= 300: sin dato.
const MONSTER_LEVELS = new Map<number, number>((monstersData as MonsterRow[]).map((m) => [m.Numb, m.Level]));
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

