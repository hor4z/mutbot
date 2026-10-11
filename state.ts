/**
 * Estado compartido del bot. Un proceso = un personaje (la estación lanza uno por personaje), así
 * que son singletons de módulo. Lo que varios módulos escriben vive en objetos explícitos (`world`,
 * `bot`, `learned`): los `let` de un módulo ES no se pueden asignar desde otro.
 *
 *   world    lo que el bot cree de sí mismo y de su alrededor, según los packets S2C
 *   bot      decisiones y estado para el panel (spot, modo, cacería, órdenes pendientes...)
 *   learned  lo aprendido que se guarda en learning.json (se reemplaza al cargarlo)
 */
import { CampManager, Hunger } from './camp';
import { CHAR_NAME, type StatName } from './config';
import { HotSpotGrid } from './explore';
import { CycleLog, ExpLog, ExpSplitTracker, MonsterTypeStats } from './farming';
import type { CharLearning, Spot } from './learning';
import { goldenTypes, type HuntExplorer, type HuntMap } from './panel-logic';
import type { Invasion } from './panel-protocol';
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
// Los dorados de la invasión (Golden Dragon Move 88, Golden Titan 77, ...) se
// pasan del tope de Move: sin sumarlos aparte el bot no los veía nunca.
// Sin tope de Move (2026-10-11): con Move <= 50 el bot quedaba ciego en Arena 2/3/4 (Deathvim Knight 220,
// Phantom Knight 270, Gaint Drakan 305) y en casi todo lo de nivel alto. Los guardias del pueblo ya los
// excluye isMonsterType (rango 200-299).
export const GOLDEN_TYPES = goldenTypes(monstersData as MonsterRow[]);
export const MONSTER_TYPE_NUMBERS = new Set([
  ...(monstersData as MonsterRow[])
    .filter((m) => m.AttType !== 0 && m.Move > 0 && m.HP > 0)
    .map((m) => m.Numb),
  ...GOLDEN_TYPES,
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

export type ScopedNpc = { id: number; type: number; x: number; y: number };
export type ItemSlot = { slot: number; group: number; num: number; level?: number; excellent?: boolean };
export type SkillInfo = { index: number; number: number; level: number };

export const isGolden = (n: ScopedNpc) => GOLDEN_TYPES.has(n.type);
export const monsterName = (type: number) => MONSTER_NAMES.get(type) ?? `tipo ${type}`;

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
  // Otros jugadores en scope (para no competirles el objetivo, ver farming.ts).
  players: new Map<number, { x: number; y: number; name?: string }>(),
  resets: null as number | null, // CharacterResets del server (packet propio)
  grandResets: 0,
  // NPC de pueblo/servicio (TypeNumber 200-299) en scope: no son monstruos.
  townNpcs: new Map<number, ScopedNpc>(),
  // Clase cruda del CharacterList (ver parseCharacterList097); null = no se sabe.
  classId: null as number | null,
};

// Cacería de dorados (orden `hunt` del panel).
// auto: la arrancó el cazador automático (corta con pocos vivos); si no, una orden del panel.
export type HuntState = { hunt: HuntMap; since: number; warpTries: number; nextWarpAt: number; explorer: HuntExplorer; seen: Set<number>; auto?: boolean };

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
  currentSpot: null as Spot | null,
  // Se puede adoptar el mapa actual como spot sin warpear (al entrar al mundo);
  // tras una muerte no (respawnea en el pueblo: hay que volver a warpear).
  canAdopt: true,
  // Último spot en el que estuvo (tras morir se vuelve a esa entrada).
  lastSpotIndex: null as number | null,
  lastWarpAt: 0,
  // Último MapChanged / entrada al mundo (el hambre no mira el primer minuto).
  lastArrivalAt: Date.now(),
  // Pausa: el loop no camina, no pelea, no warpea ni resetea; las pociones siguen.
  paused: false,
  // Cacería de dorados (orden `hunt`). null = farmeo normal.
  hunting: null as HuntState | null,
  // Orden `warp`: el loop la ejecuta en su próximo tick; el spot queda fijo hasta `farm`.
  pendingWarp: null as Spot | null,
  pinnedSpot: null as Spot | null,
  resetting: false,
  // El loop descarta su objetivo en el próximo tick (cambio de modo).
  retarget: false,
  // En party (PartyList recibido; RemovePartyMember lo saca).
  inParty: false,
  // Frase corta de lo que hace ahora (la pone el loop).
  doing: 'conectando',
  // Punto al que va ahora (campamento, salida, celda de la cacería).
  goalPoint: null as [number, number] | null,
  // Última invasión (0xFD).
  invasion: null as Invasion | null,
};

// ---------------------------------------------------------------------------
// Farmeo por exp/segundo (farming.ts): lo aprendido por tipo de monstruo, el
// registro id → tipo para atribuir la exp, y la grilla de spots calientes
// (explore.ts). Viven a nivel módulo: sobreviven a los resets, y se guardan
// en el mismo learning.json para sobrevivir a un reinicio del bot.
// ---------------------------------------------------------------------------
export const typeStats = new MonsterTypeStats((type) => MONSTER_MAX_HP.get(type) ?? null);
export const expTracker = new ExpSplitTracker(typeStats);
export const hotGrid = new HotSpotGrid();
// Registro de exp por segundo (farming.ts, ExpLog): TODAS las mediciones de
// exp/min por ventana (informe, campamentos, hambre) salen de acá.
export const expLog = new ExpLog(Date.now());

// Campamentos (camp.ts): correa, memoria, vara por mapa. Hambre por tramo.
// Registro de tramos por ciclo. Se recrean al cargar learning.json (route.ts).
export const learned = {
  char: { resets: 0 } as CharLearning,
  camps: new CampManager(),
  hunger: new Hunger(),
  cycleLog: new CycleLog(Date.now()),
};

// Personajes propios (compañeros): no son rivales (esquina, lados, defensa) y con ellos sí hay party.
// La estación los pasa en MUBOT_MATES (todos sus personajes); sin eso, Horaz y Melu.
export const MATES: ReadonlySet<string> = new Set(
  (process.env.MUBOT_MATES ?? 'Horaz,Melu').split(',').map((n) => n.trim().toLowerCase()).filter((n) => n && n !== CHAR_NAME.toLowerCase()),
);
export const isMate = (name: string) => MATES.has(name.toLowerCase());
