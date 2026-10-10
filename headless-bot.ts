/**
 * Bot headless de MU — autonomous farming + progression, SIN GUI.
 *
 * Juega usando el protocolo real del cliente (mismos packets y cifrado que
 * src/store.ts), pero sin interfaz ni eventos de mouse/teclado. Corre un
 * personaje que progresa solo: pelea, sube exp y stats, recoge loot, vende la
 * basura y repone pociones, siempre a ritmo humano.
 *
 * Solo para TU propio OpenMU de prueba, con una cuenta de prueba.
 *
 *   bun run headless-bot.ts [opciones]
 *
 * Conexión:
 *   --proxy ws://127.0.0.1:3000        proxy WebSocket (WS -> TCP)
 *   --cs-host 127.0.0.1 --cs-port 44405  connect server
 *   --user test1 --pass test1 --char test1Dk
 *   --allow-remote       permite apuntar a hosts no locales
 *
 * Loop autónomo (juega solo, sin GUI, sin flood):
 *   --auto-seconds 600  cuánto tiempo corre el loop autónomo (0 = sin límite:
 *                       farmea y encadena resets indefinidamente, reconectando
 *                       con backoff si se corta la conexión)
 *   --reset-level 400   nivel al que hace /reset (default 400)
 *   --build str:50,ene:33,vit:17  reparto fijo de puntos (default: el del agente
 *                       web, planStats: energía hasta fuerza − 2000, después
 *                       mitad/mitad, 5% vitalidad)
 *   --max-stat 300      tope por atributo (default 10000 = sin tope)
 *   --heal-at 60        usa potion cuando HP% <= este valor
 *   --skills 41,42      números de skill de ataque, en orden de preferencia
 *                       (default: los conocidos de DEFAULT_ATTACK_SKILLS)
 *
 * Economía (ver AGENTS.md para el detalle del flujo):
 *   --merchant 500,510  Ids de NPC merchant conocidos. Si no se pasan, el bot
 *                       los descubre probando los NPCs que ve en scope.
 *   --buy-slot 12,13    índices de pociones DENTRO de la lista del merchant.
 *                       El server valida el índice; si está mal contesta
 *                       NpcItemBuyFailed y no cobra nada.
 *   --warp 26           antes de arrancar, viaja con el menú de warp (índice de
 *                       la lista de movimiento del cliente; valida nivel y cobra zen)
 *   --explore-dir 1     en mapas sin salida conocida, primera dirección a
 *                       explorar desde el pueblo (0..7, 1=norte; ver explore.ts)
 *   --move dungeon      antes de arrancar, manda "/move <mapa>" por chat
 *                       (warp del server: valida nivel y cobra zen)
 *   --spots 2,5,1       limita a qué warps de la ruta puede ir el bot (default:
 *                       toda la ruta, ver WARP_SPOTS)
 *   --free-route        en vez de la ruta fija por tramo (chooseFixedRoute),
 *                       la regla vieja que prueba mapas por exp/min (chooseRouteSpot)
 *
 * Aprendizaje (ver AGENTS.md, "Aprendizaje"):
 *   --learn-file p.json  dónde guarda exp/min por spot, exp/segundos por tipo
 *                        de monstruo y spots calientes, por personaje
 *                        (default ~/.mubot/learning.json)
 *   --no-learn           no mide ni aprende: vuelve a la regla fija
 *                        (spot de mayor nivel requerido)
 *
 * Control / UI:
 *   --decision-log r.jsonl  appendea cada decisión como JSONL (una por línea)
 *                           para que una UI pueda tail-earla.
 *   --ws-port 8787          panel en http://127.0.0.1:8787/panel (ver
 *                           ws-server.ts y AGENTS.md, "Panel externo"): estado
 *                           cada 1 s, decisiones y órdenes de lista cerrada.
 */
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SpotMeter, chooseRouteSpot, chooseFixedRoute, routeScores, routeTier, aggregate, formatSpotTable, loadLearning, saveLearningChar, activeDryExclusions,
  CROWD_FALLBACK,
  type Spot, type SpotSample, type CharLearning,
} from './learning';
import { EXPLORE, Explorer, HotSpotGrid, isMonsterType, isTownNpcType } from './explore';
import { CycleLog, ExpLog, ExpSplitTracker, MonsterTypeStats, SelfReport, pickLoot, planStats, type TimeKind } from './farming';
import { CAMP, CampManager, CampMemory, Hunger, castCandidate } from './camp';
import { Backoff, PARTY_DECLINE_DELAY_MS, buildPartyDecline, isExcellentItemData, parseItemDropRemoved, parsePartyRequest } from './protocol097';
import { EventBus } from './net/eventBus';
import { createSocket } from './net/socket';
import { startStatusServer, type CommandResult, type StatusServer } from './ws-server';
import {
  EVENT_KEYS, HuntExplorer, buildOpeningStateRequest, chooseHuntMap, countTickets, goldenTypes, mapName,
  parseInvasion, parseOpeningState, resetsPerDay, shouldStopHunt, toPanelCycle, validateWarp, type HuntMap,
} from './panel-logic';
import type { BotMode, EventKey, EventTimer, Invasion, PanelCommand, PanelState } from './panel-protocol';
import {
  SimpleModulusEncryptor,
  Xor32Encryptor,
  Xor3Byte,
} from './net/encryption';
import { stringToBytes } from './net/utils';
import {
  ConnectionInfoPacket,
  ConnectionInfoRequestPacket,
  ServerListRequestOldPacket,
  ServerListResponseOldPacket,
  ServerListResponsePacket,
} from './packets';
import {
  LoginShortPasswordPacket,
  RequestCharacterListPacket,
  SelectCharacterPacket,
  ConsumeItemRequest075Packet,
  IncreaseCharacterStatPointPacket,
  ClientReadyAfterMapChangePacket,
  TalkToNpcRequestPacket,
  SellItemToNpcRequestPacket,
  BuyItemFromNpcRequestPacket,
  CloseNpcRequestPacket,
  PickupItemRequest075Packet,
} from './packets';
import {
  LoginResponsePacket,
  LoginResponseLoginResultEnum,
  MapObjectOutOfScopePacket,
  ObjectGotKilledPacket,
  ExperienceGainedPacket,
  GameServerEnteredPacket,
  ObjectWalked075Packet,
  ObjectMovedPacket,
  SkillListUpdatePacket,
  MapChanged075Packet,
  CurrentHealthAndShieldPacket,
  CurrentManaAndAbilityPacket,
  CharacterLevelUpdatePacket,
  ItemsDroppedPacket,
  MoneyDropped075Packet,
  ItemAddedToInventoryPacket,
  NpcItemSellResultPacket,
  InventoryMoneyUpdatePacket,
  NpcItemBuyFailedPacket,
  NpcWindowResponsePacket,
  NpcWindowResponseNpcWindowEnum,
  MasterStatsUpdatePacket,
  MasterCharacterLevelUpdatePacket,
  MasterSkillLevelUpdatePacket,
} from './packets';
import monstersData from './data/monsters.json';
import itemsData from './data/items.json';

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
const GOLDEN_TYPES = goldenTypes(monstersData as MonsterRow[]);
const MONSTER_TYPE_NUMBERS = new Set([
  ...(monstersData as MonsterRow[])
    .filter((m) => m.AttType !== 0 && m.Move > 0 && m.Move <= 50 && m.HP > 0)
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

// ---------------------------------------------------------------------------
// Args + guard de "solo local"
// ---------------------------------------------------------------------------
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(argv[i], next);
      i++;
    } else args.set(argv[i], 'true');
  }
}

const PROXY = args.get('--proxy') ?? 'ws://127.0.0.1:3000';
const CS_HOST = args.get('--cs-host') ?? '127.0.0.1';
const CS_PORT = parseInt(args.get('--cs-port') ?? '44405');
// Credenciales: mejor en .env (Bun lo carga solo, está en .gitignore) que en
// la línea de comandos, donde quedan en el historial del shell.
const USERNAME = args.get('--user') ?? process.env.MUBOT_USER ?? 'test1';
const PASSWORD = args.get('--pass') ?? process.env.MUBOT_PASS ?? 'test1';
const CHAR_NAME = args.get('--char') ?? process.env.MUBOT_CHAR ?? 'test1Dk';
const ALLOW_REMOTE = args.has('--allow-remote');
// El mundo de mu.mormon.garden está configurado con el perfil de cliente 0.97d
// (V097D), NO season6. Estos son sus bytes de versión y serial: el server valida
// ambos y descarta el login en silencio si no coinciden.
const CLIENT_VERSION = [49, 59, 58, 52, 57]; // "1;:49"
const CLIENT_SERIAL = 'St0n3agemu97d99i';
const MAX_USERNAME_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 10;

const LOCAL = /^(127\.|localhost$|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const proxyHost = new URL(PROXY).hostname;
if (!ALLOW_REMOTE && !(LOCAL.test(proxyHost) && LOCAL.test(CS_HOST))) {
  console.error(`Rechazado: ${proxyHost} / ${CS_HOST} no parecen locales. Agregá --allow-remote si es tuyo.`);
  process.exit(2);
}

const log = (...a: unknown[]) => console.log(`[bot]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Estado de envío: misma lógica que Store.sendToCS / Store.sendToGS
// ---------------------------------------------------------------------------
const xor32 = new Xor32Encryptor();
let csSocket: WebSocket | undefined;
let gsSocket: WebSocket | undefined;
let gsEncryptor: InstanceType<typeof SimpleModulusEncryptor> | undefined;

function sendToCS(buffer: DataView) {
  csSocket?.send(buffer);
}

// El perfil de cliente 0.97d (V097D) que usa mu.mormon.garden tiene SU PROPIO
// xor32 key. Con el default de season6 el server no puede descifrar los packets
// C2S y descarta el login sin responder.
const XOR32_KEY_097D = new Uint8Array([
  231, 109, 58, 137, 188, 178, 159, 115, 35, 168, 254, 182, 73, 93, 57, 93,
  138, 203, 99, 141, 234, 125, 43, 95, 195, 177, 233, 131, 41, 81, 232, 86,
]);

function sendToGS(buffer: DataView) {
  // Socket cerrado (corte, reconexión en curso): no se manda nada.
  if (!gsSocket || gsSocket.readyState !== WebSocket.OPEN) return;
  let packet = new Uint8Array(buffer.buffer);
  const header = packet[0];
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  if (process.env.MUBOT_DEBUG) console.log(`[dbg] C2S plano  (${packet.length}): ${hex(packet)}`);
  if (!process.env.MUBOT_XOR32_DEFAULT) xor32.xor32Key = XOR32_KEY_097D;
  xor32.Encrypt(packet);
  if (process.env.MUBOT_DEBUG) console.log(`[dbg] C2S xor32  (${packet.length}): ${hex(packet)}`);
  if (gsEncryptor && header >= 0xc3) {
    packet = gsEncryptor.Encrypt(packet);
    if (process.env.MUBOT_DEBUG) console.log(`[dbg] C2S cifrado (${packet.length}): ${hex(packet)}`);
  }
  gsSocket?.send(packet);
}

// ---------------------------------------------------------------------------
// Estado del mundo (lo que el bot cree de sí mismo) — se actualiza con los
// packets S2C. Es la única fuente de verdad del loop autónomo.
// ---------------------------------------------------------------------------
type StatName = 'str' | 'agi' | 'vit' | 'ene';

// En MU el orden de los atributos es fijo: strength, agility, vitality, energy.
// IncreaseCharacterStatPoint.StatType usa exactamente esos mismos índices.
const STAT_ORDER: StatName[] = ['str', 'agi', 'vit', 'ene'];
const STAT_INDEX: Record<StatName, number> = { str: 0, agi: 1, vit: 2, ene: 3 };

type ItemSlot = { slot: number; group: number; num: number; level?: number; excellent?: boolean };
type SkillInfo = { index: number; number: number; level: number };

const world = {
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
  players: new Map<number, { x: number; y: number }>(),
  // NPC de pueblo/servicio (TypeNumber 200-299) en scope: candidatos para
  // descubrir merchants. Antes no se guardaban en ningún lado y
  // discoverMerchant() sondeaba monstruos.
  townNpcs: new Map<number, ScopedNpc>(),
  // Master skill tree: solo tracking pasivo por ahora (ver AGENTS.md,
  // "Pendiente"). El perfil del server es V097D (pre-season); no sabemos si
  // manda estos packets hasta verlo en un login real.
  masterLevel: 0,
  masterLevelUpPoints: 0,
  masterSeen: false,
  // Clase cruda del CharacterList (ver parseCharacterList097); null = no se sabe.
  classId: null as number | null,
};

// Servidor de telemetría opcional (--ws-port). Solo lectura: ver ws-server.ts.
let statusServer: StatusServer | undefined;

function snapshotWorld() {
  return {
    x: world.x,
    y: world.y,
    map: world.map,
    hp: world.hp,
    maxHp: world.maxHp,
    mana: world.mana,
    maxMana: world.maxMana,
    level: world.level,
    levelUpPoints: world.levelUpPoints,
    stats: world.stats,
    inventoryCount: world.inventory.size,
    inventory: [...world.inventory.values()],
  };
}

// Las pociones del set clásico están en el Group 14 (curación 1-3, mana 4-6,
// SD 35-37) y el Group 13 (Potion of Illusion). Salen de data/items.json.
// Para un bot que solo necesita sobrevivir, la Small Healing Potion (14/1) es
// la mejor: se compra barata, se stacks (X=1 Y=1) y alcanza para todo el farm.
const POTION_GROUP = 14;
const HEAL_POTION_NUMS = new Set([1, 2, 3]); // small / normal / large healing
const SELL_INTERVAL_MS = 600;   // respiro entre ventas para no parecer un burst
// Con esto lleno (de 40 slots) vamos a vender antes de no poder recoger más.
const SELL_AT_PRESSURE = 0.6;

// Skills de ataque configurables (números de skill, NO índices de lista).
// Los defaults son los de Dark Knight / Blade Knight del set clásico.
// Twisting Slash (41) primero: es el skill fijo de Horaz. Rageful Blow (42)
// fuera: el usuario lo descartó (lento). El resto queda para otros personajes.
const DEFAULT_ATTACK_SKILLS = [41, 19, 49, 14, 15, 40, 43, 45, 46, 47, 48, 50, 51, 55];

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------
let kicked = false;
let playerId = -1;
EventBus.on('wsClosed', (e: any) => {
  // Solo cuenta si es el socket del game server el que se cerró; cerrar
  // nosotros mismos el del connect server al pasar al game server no es un "kick".
  if (gsSocket && e?.socket === gsSocket) {
    kicked = true;
  }
});

function waitFor<T extends string>(event: T | T[], timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      handler.off();
      reject(new Error(`timeout esperando '${event}'`));
    }, timeoutMs);
    const handler = (bytes: any) => {
      clearTimeout(t);
      handler.off();
      resolve(bytes);
    };
    handler.off = () => {
      for (const ev of events) EventBus.off(ev as any, handler);
    };
    const events = Array.isArray(event) ? event : [event];
    for (const ev of events) EventBus.on(ev as any, handler);
  });
}

// ---------------------------------------------------------------------------
// 1. Connect server: hello -> server list -> connection info
// ---------------------------------------------------------------------------
async function connectToConnectServer() {
  const { socket } = createSocket({ wsAddress: PROXY, tcpIP: CS_HOST, tcpPort: CS_PORT });
  csSocket = socket;
  await waitFor('Hello');
  log('Connect server: Hello recibido');
}

async function getGameServerAddress(): Promise<{ ip: string; port: number }> {
  sendToCS(ServerListRequestOldPacket.createPacket().buffer);
  const bytes = await waitFor(['ServerListResponse', 'ServerListResponseOld']);

  // F4/06 (ServerListResponse) y F4/02 (ServerListResponseOld) traen layouts
  // distintos. El moderno solo trae ServerId + LoadPercentage y NO trae la
  // dirección, así que la dirección siempre sale de --server.
  // F4/06 y F4/02 traen layouts distintos. El moderno no trae la dirección, así
// que --server/--connect-addr manda igual. Distinguimos por el subcode (byte 4).
const sub = bytes.getUint8(4);
const modern = sub === 0x06;
const serverId = modern
  ? new ServerListResponsePacket(bytes).getServers(1)[0]?.ServerId
  : (() => {
      const p = new ServerListResponseOldPacket(bytes);
      return p.getServers(p.ServerCount)[0]?.ServerId;
    })();
if (serverId == null) throw new Error(`ServerList raro: subcode=0x${sub.toString(16)} len=${bytes.byteLength}`);
log(`ServerList (F4/${sub.toString(16).padStart(2, '0')}): ServerId ${serverId}`);

  const reqInfo = ConnectionInfoRequestPacket.createPacket();
  reqInfo.ServerId = serverId;
  sendToCS(reqInfo.buffer);

  const infoBytes = await waitFor('ConnectionInfo');
  const info = new ConnectionInfoPacket(infoBytes);
  // El cliente real (src/ui/pages/serversPage/index.tsx) IGNORA a propósito la IP
  // que manda el connect server acá ("//use local host") y usa el host configurado.
  // La imitamos: el connect server puede anunciar una IP pública autodetectada
  // (le pasó a esta prueba: devolvió una IP pública real), y conectar el proxy
  // a lo que diga el server sin validar es justo el open relay que ya reportamos.
  log(`ConnectionInfo: server anunció ${info.IpAddress}:${info.Port}; uso ${CS_HOST}:${info.Port} (igual que el cliente real)`);
  return { ip: CS_HOST, port: info.Port };
}

// ---------------------------------------------------------------------------
// 2. Game server: hello -> login -> character list -> select
// ---------------------------------------------------------------------------
async function connectToGameServer(ip: string, port: number) {
  csSocket?.close();
  const { socket } = createSocket({ wsAddress: PROXY, tcpIP: ip, tcpPort: port });
  gsSocket = socket;
  gsEncryptor = new SimpleModulusEncryptor();
  gsEncryptor.encryptionKeys = SimpleModulusEncryptor.DefaultClientKey;

  const bytes = await waitFor('GameServerEntered');
  const p = new GameServerEnteredPacket(bytes);
  playerId = p.PlayerId & 0x7fff;
  log(`Game server: GameServerEntered recibido (playerId=${playerId})`);
}

function login(username: string, password: string) {
  const usernameBytes = stringToBytes(username, MAX_USERNAME_LENGTH);
  const passwordBytes = stringToBytes(password, MAX_PASSWORD_LENGTH);
  Xor3Byte(usernameBytes);
  Xor3Byte(passwordBytes);

  if (process.env.MUBOT_LONGLOGIN) {
    // Experimento: OpenMU trata como LoginLongPassword todo packet >= 42 bytes
    // (LogInHandlerPlugIn.cs), y el corto de 50 bytes cae ahí con otro layout.
    const long = new Uint8Array(60);
    long.set([0xc3, 60, 0xf1, 0x01], 0);
    const lp = stringToBytes(password, 20);
    Xor3Byte(lp);
    long.set(usernameBytes, 4);
    long.set(lp, 14);
    new DataView(long.buffer).setUint32(34, Math.floor(performance.now()) >>> 0, false);
    long.set(CLIENT_VERSION, 38);
    long.set(stringToBytes(CLIENT_SERIAL, 16), 43);
    sendToGS(new DataView(long.buffer));
    return;
  }
  const p = LoginShortPasswordPacket.createPacket();
  // Los setters generados están tipados como number[] pero reciben Uint8Array.
  p.setUsername(usernameBytes as unknown as number[], usernameBytes.length);
  p.setPassword(passwordBytes as unknown as number[], passwordBytes.length);
  p.TickCount = Math.floor(performance.now()) >>> 0;
  p.setClientVersion(CLIENT_VERSION as unknown as number[]);
  // Sin serial, OpenMU descarta el login sin mandar LoginResponse (ni error).
  p.setClientSerial(stringToBytes(CLIENT_SERIAL, 16) as unknown as number[]);
  sendToGS(p.buffer);
}

// El XML de packets define el CharacterList "Extended" (34 bytes por personaje y
// flags extra), pero un server 0.95/0.97 manda el layout chico: CharacterCount en
// el índice 4, sin UnlockFlags/MoveCnt/IsVaultExtended, y cada CharacterData con
// 26 bytes. Con el parser del XML el acceso desborda, así que lo parseamos a mano.
const CHAR_DATA_097_LENGTH = 26;
const CHAR_LIST_097_HEADER = 5;

// createSocket emite un DataView; otros paths pueden dar Uint8Array. Normalizamos.
function toBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error(`payload inesperado: ${typeof data}`);
}

function parseCharacterList097(raw: any) {
  const bytes = toBytes(raw);
  const count = bytes[4];
  const out: Array<{ SlotIndex: number; Name: string; Level: number; ClassId: number | null }> = [];

  for (let i = 0; i < count; i++) {
    const base = CHAR_LIST_097_HEADER + i * CHAR_DATA_097_LENGTH;
    if (base + CHAR_DATA_097_LENGTH > bytes.length) break;
    const nameBytes = bytes.subarray(base + 1, base + 11);
    const nul = nameBytes.indexOf(0);
    out.push({
      SlotIndex: bytes[base],
      Name: new TextDecoder().decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul)),
      Level: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(base + 12, true),
      // Apariencia desde [15] (slot 1 + nombre 10 + 1 + nivel 2 + estado 1): la
      // clase va en los 5 bits altos del primer byte, como deserializeAppearance
      // del cliente (GetByteValue(b, 5, 3)). SIN VERIFICAR en 0.97d: es solo para el panel.
      ClassId: (bytes[base + 15] >> 3) & 0x1f,
    });
  }
  return out;
}

// CharacterInformation del XML es el layout Extended. El server 0.95/0.97 manda el
// layout chico (52 bytes, X/Y en 4/5), así que leemos ese a mano.
function parseCharacterInformation097(raw: any) {
  const bytes = toBytes(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    x: bytes[4],
    y: bytes[5],
    map: bytes[6],
    exp: view.getUint32(8, true),
    expForNext: view.getUint32(12, true),
    levelUpPoints: view.getUint16(16, true),
    str: view.getUint16(18, true),
    agi: view.getUint16(20, true),
    vit: view.getUint16(22, true),
    ene: view.getUint16(24, true),
    hp: view.getUint16(26, true),
    maxHp: view.getUint16(28, true),
    mana: view.getUint16(30, true),
    maxMana: view.getUint16(32, true),
    money: view.getUint32(40, true),
  };
}

// ---------------------------------------------------------------------------
// Parsers legacy de items y skills (layouts 0.97d, no los del XML)
// ---------------------------------------------------------------------------
// El item serializado del server son 12 bytes. Mirando SerializeItem /
// DeserializeItem del cliente MU JS (src/common/itemSerializer.ts) (que son el par que usa
// OpenMU para estos packets): byte[0] = num, byte[5] nibble alto = group.
const ITEM_DATA_LENGTH = 12;

// Nivel del ítem (+N): bits 3-6 del byte 1 (LevelMask 0x78 del itemSerializer).
function parseItemData097(itemData: Uint8Array): { group: number; num: number; level: number; excellent: boolean } {
  return {
    num: itemData[0],
    group: (itemData[5] & 0xf0) >> 4,
    level: (itemData[1] & 0x78) >> 3,
    excellent: isExcellentItemData(itemData),
  };
}

// CharacterInventory (F3/10, header C4): count en byte 5, luego StoredItem[].
// StoredItem = slot (1 byte) + ItemData de 12 bytes.
function parseInventory097(raw: any): ItemSlot[] {
  const bytes = toBytes(raw);
  const count = bytes[5];
  const out: ItemSlot[] = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * (1 + ITEM_DATA_LENGTH);
    if (base + 1 + ITEM_DATA_LENGTH > bytes.length) break;
    const { group, num, level, excellent } = parseItemData097(bytes.subarray(base + 1, base + 1 + ITEM_DATA_LENGTH));
    out.push({ slot: bytes[base], group, num, level, excellent });
  }
  return out;
}

// StoreItemList (C2/0x31): mismo layout que CharacterInventory (count en byte
// 5, items desde byte 6, stride 1+12), pero el getItems() generado tiene el
// mismo bug de stride que ya rompía CharacterInventory (calcula el ItemData
// con longitud 0) — lo parseamos a mano, igual que el inventario.
type ShopItem = { shopSlot: number; group: number; num: number };
function parseStoreItemList097(raw: any): ShopItem[] {
  const bytes = toBytes(raw);
  const count = bytes[5];
  const out: ShopItem[] = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * (1 + ITEM_DATA_LENGTH);
    if (base + 1 + ITEM_DATA_LENGTH > bytes.length) break;
    const { group, num } = parseItemData097(bytes.subarray(base + 1, base + 1 + ITEM_DATA_LENGTH));
    out.push({ shopSlot: bytes[base], group, num });
  }
  return out;
}

// ItemAddedToInventory (0x22, header C3): slot en byte 3, ItemData desde byte 4.
function parseItemAdded097(raw: any): ItemSlot | null {
  const bytes = toBytes(raw);
  if (bytes.length < 4 + ITEM_DATA_LENGTH) return null;
  const { group, num, level, excellent } = parseItemData097(bytes.subarray(4, 4 + ITEM_DATA_LENGTH));
  return { slot: bytes[3], group, num, level, excellent };
}

// SkillListUpdate (F3/11): count en byte 4 (0xFE = agregó una, 0xFF = quitó una).
  // Los entries empiezan en el offset 6 (el byte 5 es reservado en 0.97d) y son
  // de 4 bytes: SkillIndex(1) + SkillNumber(2 LE) + SkillLevel(1).
  //
  // OJO: createSocket resuelve por code con `find(p => p.SubCode == null ||
  // p.SubCode === subCode)`, así que para F3/11 gana el PRIMERO de la lista, que
  // es 'SkillAdded'. El evento 'SkillListUpdate' nunca se emite contra este
  // server: hay que escucharlo por 'SkillAdded' y deducir el caso del byte Count.
  // Bug real encontrado probando un personaje de nivel 1 (pocas/ninguna
  // skill): para ese caso el packet llega más corto de lo que getSkills()
  // asume (offset 6 + 4 bytes/entry), y Count puede no caer en 0xfe/0xff ni
  // matchear cuántas entries realmente caben en el buffer — getSkills()
  // intentaba leer fuera de rango y tiraba abajo el proceso entero. Por eso
  // clampeamos Count al tamaño real del buffer: fail-safe (mejor una lista de
  // skills incompleta que un bot caído), no un fix del protocolo en sí
  // (todavía no sabemos cuál es el layout correcto para este caso corto).
  // Layout 0.97d (verificado contra el server real, personaje Horaz): Count en
  // [4] (0xfe = agregar una, 0xff = quitar una, otro = lista completa) y desde
  // [5] entradas de 3 bytes {index, number, level}. El parser generado asume 4
  // bytes/entry (layout 1.xs) y leía basura: "skill 259", world.skills vacío.
  function readSkillsUpdate(raw: any): { added: SkillInfo[]; removed: SkillInfo[]; full: SkillInfo[] } {
    const b = toBytes(raw);
    if (process.env.MUBOT_DEBUG_SKILLS) log(`SkillAdded raw: ${Buffer.from(b).toString('hex')}`);
    const count = b[4];
    const entry = (i: number): SkillInfo => ({ index: b[i], number: b[i + 1], level: b[i + 2] });
    if (count === 0xfe && b.length >= 8) return { added: [entry(5)], removed: [], full: [] };
    if (count === 0xff && b.length >= 8) return { added: [], removed: [entry(5)], full: [] };
    const safe = Math.min(count, Math.floor((b.length - 5) / 3));
    return { added: [], removed: [], full: Array.from({ length: safe }, (_, k) => entry(5 + k * 3)) };
  }

// ---------------------------------------------------------------------------
// Tracker de estado: mantiene `world` al día con todo lo que manda el server.
// Es lo que permite que el bot decida solo (pocarse,=subir stats, Etc.).
// ---------------------------------------------------------------------------
function trackWorld() {
  EventBus.on('CharacterLevelUpdate', (raw: any) => {
    const p = new CharacterLevelUpdatePacket(raw);
    world.level = p.Level;
    world.levelUpPoints = p.LevelUpPoints;
    if (p.MaximumHealth) world.maxHp = p.MaximumHealth;
    if (p.MaximumMana) world.maxMana = p.MaximumMana;
  });

  EventBus.on('CurrentHealthAndShield', (raw: any) => {
    const p = new CurrentHealthAndShieldPacket(raw);
    world.hp = p.Health;
  });

  EventBus.on('CurrentManaAndAbility', (raw: any) => {
    const p = new CurrentManaAndAbilityPacket(raw);
    world.mana = p.Mana;
  });

  // F3/11 trae la lista completa, un alta (Count=0xFE) o una baja (0xFF).
  // Según la tabla de rutas se emite con uno u otro nombre; el cliente web
  // engancha el mismo handler a los tres, así que hacemos lo mismo.
  const onSkills = (raw: any) => {
    const { added, removed, full } = readSkillsUpdate(raw);
    if (full.length || (!added.length && !removed.length)) {
      world.skills.clear();
      for (const s of full) world.skills.set(s.number, s);
    }
    for (const s of added) world.skills.set(s.number, s);
    for (const s of removed) world.skills.delete(s.number);
    log(`Skills: ${[...world.skills.values()].map((s) => `${s.number}@${s.index}`).join(', ') || 'ninguno'}`);
  };
  for (const ev of ['SkillListUpdate', 'SkillAdded', 'SkillRemoved']) EventBus.on(ev, onSkills);

  EventBus.on('CharacterInventory', (raw: any) => {
    world.inventory.clear();
    for (const it of parseInventory097(raw)) world.inventory.set(it.slot, it);
    log(`Inventario: ${world.inventory.size} item(s).`);
  });

  EventBus.on('ItemAddedToInventory', (raw: any) => {
    const it = parseItemAdded097(raw);
    if (it) world.inventory.set(it.slot, it);
  });

  // Master skill tree: SOLO escucha, no manda nada (ver AGENTS.md, "Pendiente").
  // Si el server no manda nunca estos tres eventos, confirma que el perfil
  // V097D no tiene el sistema master activo para este personaje.
  EventBus.on('MasterStatsUpdate', (raw: any) => {
    const p = new MasterStatsUpdatePacket(raw);
    world.masterSeen = true;
    world.masterLevel = p.MasterLevel;
    world.masterLevelUpPoints = p.MasterLevelUpPoints;
    log(`Master stats: nivel ${p.MasterLevel}, ${p.MasterLevelUpPoints} punto(s) disponibles.`);
  });
  EventBus.on('MasterCharacterLevelUpdate', (raw: any) => {
    const p = new MasterCharacterLevelUpdatePacket(raw);
    world.masterSeen = true;
    world.masterLevel = p.MasterLevel;
    world.masterLevelUpPoints = p.CurrentMasterPoints;
    log(`Master level up: nivel ${p.MasterLevel}, ${p.CurrentMasterPoints} punto(s) disponibles.`);
  });
  EventBus.on('MasterSkillLevelUpdate', (raw: any) => {
    const p = new MasterSkillLevelUpdatePacket(raw);
    world.masterSeen = true;
    log(`MasterSkillLevelUpdate: success=${p.Success} índice=${p.MasterSkillIndex} nivel=${p.Level} puntos restantes=${p.MasterLevelUpPoints}`);
  });

  // El server re-sincroniza nuestra posición acá (rubber-band) cuando rechaza
  // un movimiento. Sin esto el dead-reckoning queda desfasado para siempre.
  //
  // OJO con el nombre del evento: createSocket resuelve el packet por code y
  // emite pDef.Name. El code 0x10 de 0.97d es ObjectWalked075; ObjectWalked es
  // el 0xD4 de seasons modernas y NUNCA se emite contra este server. Escuchar
  // 'ObjectWalked' dejaba al bot sin resync para siempre.
  EventBus.on('ObjectWalked075', (raw: any) => {
    const p = new ObjectWalked075Packet(raw);
    const id = p.ObjectId & 0x7fff;
    if (id === playerId) {
      if (p.TargetX !== world.x || p.TargetY !== world.y) {
        log(`Resync del server: creía (${world.x},${world.y}), real (${p.TargetX},${p.TargetY})`);
      }
      world.x = p.TargetX;
      world.y = p.TargetY;
      return;
    }
    // Bug real encontrado jugando (cuenta horaz, nivel 48): un monstruo
    // detectado por AddNpcsToScope quedaba con su posición CONGELADA para
    // siempre, porque este handler solo actualizaba la posición del jugador.
    // El bot entonces perseguía la última posición conocida del monstruo,
    // que ya se había movido — 0 kills a pesar de "ver" monstruos todo el
    // tiempo. Se arregla actualizando también la posición de cualquier NPC
    // ya trackeado en world.npcs.
    const npc = world.npcs.get(id);
    if (npc) {
      npc.x = p.TargetX;
      npc.y = p.TargetY;
      expTracker.see(id, { type: npc.type, x: npc.x, y: npc.y, map: world.map });
    }
    const pl = world.players.get(id);
    if (pl) {
      pl.x = p.TargetX;
      pl.y = p.TargetY;
    }
  });

  // ObjectMoved (0x15): "un objeto se movió instantáneamente" (teleport/salto,
  // no caminata) — mismo problema de posición congelada que ObjectWalked075 si
  // no se trackea para NPCs ya vistos.
  //
  // OJO: a diferencia de ObjectWalked075 (verificado a fondo, es la única
  // fuente de la posición del JUGADOR), este packet NO se usa para actualizar
  // world.x/y del jugador — apareció 367 veces en una corrida de 130s (mucho
  // más que los pasos propios) y una corrida terminó con "posición final
  // (0,0)", probablemente por confiar en este packet para el jugador sin
  // verificarlo. Conservador: solo actualiza NPCs ya trackeados, nunca al
  // jugador, hasta confirmar el campo/formato con más cuidado.
  EventBus.on('ObjectMoved', (raw: any) => {
    const p = new ObjectMovedPacket(raw);
    const id = p.ObjectId & 0x7fff;
    if (id === playerId) return;
    const npc = world.npcs.get(id);
    if (npc) {
      npc.x = p.PositionX;
      npc.y = p.PositionY;
    }
    const pl = world.players.get(id);
    if (pl) {
      pl.x = p.PositionX;
      pl.y = p.PositionY;
    }
  });

  // Scope de NPCs: se registra al entrar al mundo, NO al arrancar el loop. El
  // server manda el scope inicial (y el del mapa nuevo tras /move) antes de que
  // el loop exista; enganchar tarde = bot ciego a los monstruos.
  const npcs = world.npcs;
  const onAdd = (raw: any) => {
    for (const n of parseNpcs095(raw)) {
      // MUBOT_DEBUG_NPCS=1: loguea todo tipo que aparezca, pase o no el filtro
      // (así se vieron los custom 690/692 que monsters.json no conoce).
      const isMonster = isMonsterType(n.TypeNumber, MONSTER_TYPE_NUMBERS);
      if (process.env.MUBOT_DEBUG_NPCS) {
        log(`NPC en scope (debug): Id=${n.Id} tipo=${n.TypeNumber} monstruo=${isMonster} en (${n.CurrentPositionX},${n.CurrentPositionY})`);
      }
      if (!isMonster) {
        if (isTownNpcType(n.TypeNumber)) {
          const tid = n.Id & 0x7fff;
          world.townNpcs.set(tid, { id: tid, type: n.TypeNumber, x: n.CurrentPositionX, y: n.CurrentPositionY });
        }
        continue;
      }
      // Bug real (cuenta horaz, nivel 48, 22 monstruos detectados, 0 kills):
      // n.Id viene CRUDO (con el bit alto de "vivo" puesto, ej. 33356), pero
      // HitRequest.TargetId necesita el id real sin ese bit — el server hace
      // `currentMap.GetObject(message.TargetId)` con el id exacto (confirmado
      // en HitHandlerPlugInBase.cs de OpenMU) y no lo encuentra si mandamos el
      // crudo, así que el golpe no hace nada (ni error ni log del lado
      // server, falla en silencio). El resto del código SIEMPRE enmascara con
      // `& 0x7fff` (onRemove, onKilled, ObjectWalked075) — acá faltaba, y
      // además por eso `onRemove` nunca lograba borrar estos NPCs del mapa
      // (comparaba contra una clave que nunca existía).
      const id = n.Id & 0x7fff;
      const isNew = !npcs.has(id);
      npcs.set(id, { id, type: n.TypeNumber, x: n.CurrentPositionX, y: n.CurrentPositionY });
      // El tipo de cada id visto: cuando llega ExperienceGained el monstruo ya
      // salió del scope (ver farming.ts, ExpSplitTracker).
      expTracker.see(id, { type: n.TypeNumber, x: n.CurrentPositionX, y: n.CurrentPositionY, map: world.map });
      if (isNew) log(`Monstruo en scope: Id=${id} tipo=${n.TypeNumber} en (${n.CurrentPositionX},${n.CurrentPositionY})`);
    }
  };
  const onRemove = (raw: any) => {
    const p = new MapObjectOutOfScopePacket(raw);
    for (const o of p.getObjects()) {
      npcs.delete(o.Id & 0x7fff);
      world.townNpcs.delete(o.Id & 0x7fff);
      world.players.delete(o.Id & 0x7fff);
    }
  };
  EventBus.on('AddNpcsToScope', onAdd);
  // Otros jugadores: solo id y posición (ver parseCharacters095).
  EventBus.on('AddCharactersToScope', (raw: any) => {
    for (const c of parseCharacters095(raw)) {
      if (c.id === playerId) continue;
      world.players.set(c.id, { x: c.x, y: c.y });
    }
  });
  EventBus.on('MapObjectOutOfScope', onRemove);

  // Cambiar de mapa: hay que confirmarlo con ClientReadyAfterMapChange (F3/12)
  // o el server nos cuelga en el limbo. El evento que se emite es
  // 'MapChanged075' (code 0x1C sin subcode), no 'MapChanged' (que espera 0x1C/0x15).
  EventBus.on('MapChanged075', (raw: any) => {
    const p = new MapChanged075Packet(raw);
    world.map = p.MapNumber;
    world.x = p.PositionX;
    world.y = p.PositionY;
    log(`Cambio de mapa → map=${world.map} pos=(${world.x},${world.y})`);
    // Lo que había en scope era del mapa viejo: si no se limpia, el bot
    // persigue NPCs y drops que ya no existen (el server no manda el remove).
    world.npcs.clear();
    world.townNpcs.clear();
    world.players.clear();
    drops.clear();
    sendToGS(ClientReadyAfterMapChangePacket.createPacket().buffer);
    // Punto de llegada (correa de Devias) y primer campamento (camp.ts).
    onMapArrival();
  });

  // Invitaciones a party: rechazar siempre (pedido del usuario), con un
  // respiro humano antes de contestar (ver protocol097.ts).
  EventBus.on('PartyRequest', (raw: any) => {
    const id = parsePartyRequest(toBytes(raw));
    if (id == null) return;
    const [lo, hi] = PARTY_DECLINE_DELAY_MS;
    setTimeout(() => {
      sendToGS(new DataView(buildPartyDecline(id).buffer));
      log(`Party rechazada (de #${id}).`);
    }, lo + Math.random() * (hi - lo));
  });
}

async function loginAndSelectCharacter() {
  login(USERNAME, PASSWORD);
  const loginBytes = await waitFor('LoginResponse');
  const loginResp = new LoginResponsePacket(loginBytes);
  if (loginResp.Success !== LoginResponseLoginResultEnum.Okay) throw new LoginError(loginResp.Success);
  log('Login OK');

  const listWaiter = waitFor('CharacterList');
  requestCharacterList();
  return selectCharacter(await listWaiter);
}

function requestCharacterList() {
  const p = RequestCharacterListPacket.createPacket();
  p.Language = 0;
  sendToGS(p.buffer);
}

async function selectCharacter(charListBytes: any) {
  const characters = parseCharacterList097(charListBytes);
  log(
    `Personajes: ${characters.map((c: any) => `${c.Name}(lv.${c.Level})`).join(', ')}`,
  );

  const target = characters.find((c: any) => c.Name === CHAR_NAME) ?? characters[0];
  if (!target) throw new Error('La cuenta no tiene personajes');

  const selP = SelectCharacterPacket.createPacket();
  selP.setName(target.Name);
  sendToGS(selP.buffer);

  const infoBytes = await waitFor('CharacterInformation');
  const info = parseCharacterInformation097(infoBytes);
  Object.assign(world, {
    x: info.x,
    y: info.y,
    map: info.map,
    hp: info.hp,
    maxHp: info.maxHp,
    mana: info.mana,
    maxMana: info.maxMana,
    level: target.Level ?? world.level,
    classId: target.ClassId ?? null,
    levelUpPoints: info.levelUpPoints,
    stats: { str: info.str, agi: info.agi, vit: info.vit, ene: info.ene },
  });
  log(
    `Entré al mundo con ${target.Name}: pos=(${info.x},${info.y}) map=${info.map} nivel=${world.level} puntos=${info.levelUpPoints} exp=${info.exp} HP=${info.hp}/${info.maxHp}`,
  );
  // Retomar desde el estado real: si ya está en el mapa del tramo, la ruta lo
  // adopta sin warpear (chooseFixedRoute, 'adopt').
  canAdopt = true;
  lastMoney = info.money;
  inGameAt = Date.now();
  charName = target.Name;
  // El panel pregunta las aperturas de eventos (0x91) apenas entra al mundo.
  scheduleEventPolls(inGameAt);
  onMapArrival();
  return { name: target.Name, startX: info.x, startY: info.y, startExp: info.exp };
}

// ---------------------------------------------------------------------------
// 3. Movimiento (mismo encoding que Store.sendWalkPath)
// ---------------------------------------------------------------------------
// Un server 0.95/0.97 no entiende el WalkRequest moderno (code 0xD4): espera el
// WalkRequest075 (code 0x10), que además empuja TargetRotation en el nibble alto
// del mismo byte que StepCount. Con 0xD4 el server ignora el paso en silencio.
// Un packet armado byte a byte, listo para sendToGS.
function rawPacket(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes, (b) => b & 0xff).buffer);
}

// Mismo encoding que Store.sendWalkPath del cliente web: StepCount en el nibble
// bajo del byte 5, rotación (= última dirección) en el alto, y las direcciones
// empaquetadas de a dos por byte desde el 6. El cliente lo arma como 0xD4 y su
// adaptador de salida lo reescribe a 0x10 para este server.
function buildWalkPacket(x: number, y: number, dirs: number[]) {
  const packed = new Array<number>(Math.ceil(dirs.length / 2)).fill(0);
  dirs.forEach((d, i) => (packed[i >> 1] |= (d & 15) << (i % 2 === 0 ? 4 : 0)));
  const rotation = dirs[dirs.length - 1] ?? 0;
  return { buffer: rawPacket([0xc1, 6 + packed.length, 0x10, x, y, ((rotation & 15) << 4) | (dirs.length & 15), ...packed]) };
}

// ---------------------------------------------------------------------------
// Packets con los códigos REALES de este server (ver AGENTS.md, "Protocolo
// real, capturado del cliente web"). El cliente web arma packets season6 y su
// adaptador de salida los reescribe antes de mandarlos; los parsers de
// packets/ tienen el código season6, que acá no sirve:
//   HitRequest 0x11 → 0x15          (por eso el bot nunca mataba nada)
//   TargetedSkill/AreaSkill: el skill va como ÍNDICE de la lista, no número.
// ---------------------------------------------------------------------------
let hitAnimToggle = false;
function sendHit(targetId: number, dir: number) {
  // El cliente alterna Attack1/Attack2 (0x78/0x79) en cada golpe.
  hitAnimToggle = !hitAnimToggle;
  sendToGS(rawPacket([0xc1, 0x07, 0x15, targetId >> 8, targetId, hitAnimToggle ? 0x78 : 0x79, dir]));
}

function sendTargetedSkill(skillIndex: number, targetId: number) {
  sendToGS(rawPacket([0xc3, 0x06, 0x19, skillIndex, targetId >> 8, targetId]));
}

function sendAreaSkill(skillIndex: number, x: number, y: number, dir: number, targetId: number) {
  // Rotación en 0..255 (el cliente la saca del ángulo del modelo).
  sendToGS(rawPacket([0xc3, 0x09, 0x1e, skillIndex, x, y, dir * 32, targetId >> 8, targetId]));
}

// Ping (C3 0E/00) cada 5s con el TickCount, como el cliente: el server lo usa
// para su detector de speed hack. AttackSpeed en 0, igual que en la captura.
const botStart = performance.now();
function sendPing() {
  const tick = Math.floor(performance.now() - botStart) >>> 0;
  sendToGS(rawPacket([0xc3, 0x0c, 0x0e, 0x00, tick, tick >> 8, tick >> 16, tick >>> 24, 0, 0, 0, 0]));
}

// Eco propio de este server (C1 FB/02) cada 2s; el server contesta PingRelay.
function sendEcho() {
  sendToGS(rawPacket([0xc1, 0x04, 0xfb, 0x02]));
}

// Menú de warp (C1 8E/02): índice de la lista de movimiento del cliente
// (Lorencia = 2). El server valida nivel y zen.
function warpTo(warpIndex: number) {
  sendToGS(rawPacket([0xc1, 0x0a, 0x8e, 0x02, 0, 0, 0, 0, warpIndex, warpIndex >> 8]));
  log(`Warp → índice ${warpIndex}`);
}

// Chat público: C1 len 00 <nombre 10 bytes> <texto>. Los comandos del server
// (/add, /reset) viajan por acá.
function sayChat(name: string, text: string) {
  const nameBytes = new Array<number>(10).fill(0);
  [...Buffer.from(name, 'latin1').subarray(0, 10)].forEach((b, i) => (nameBytes[i] = b));
  const textBytes = [...Buffer.from(text, 'latin1')];
  sendToGS(rawPacket([0xc1, 3 + 10 + textBytes.length, 0x00, ...nameBytes, ...textBytes]));
  log(`Chat: ${text}`);
}

// Deltas de las 8 direcciones del compass de MU, medidos empíricamente con --probe-dir.
const DIR_DELTA: Record<number, [number, number]> = {
  0: [-1, -1],
  1: [0, -1],
  2: [1, -1],
  3: [1, 0],
  4: [1, 1],
  5: [0, 1],
  6: [-1, 1],
  7: [-1, 0],
};

// ---------------------------------------------------------------------------
// 4. Modo "farm": el bot hace todo solo, a ritmo HUMANO (no flood), el tiempo
//    que se le pida: explora, encuentra un monstruo, lo pelea, repite.
//    Ritmos usados (ver config real leída de la DB con SpeedHackDetectPlugIn):
//      - paso de caminata: ~380ms (coincide con la velocidad base medida antes)
//      - golpe: ~500ms (por debajo de AttackSpeedBaseDelayMs=450 + margen del
//        token bucket de 5, para quedar cómodo del lado legítimo)
// ---------------------------------------------------------------------------
type ScopedNpc = { id: number; type: number; x: number; y: number };

function chebyshev(ax: number, ay: number, bx: number, by: number) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function directionTowards(fromX: number, fromY: number, toX: number, toY: number): number {
  const dx = Math.sign(toX - fromX);
  const dy = Math.sign(toY - fromY);
  for (const [dir, [ddx, ddy]] of Object.entries(DIR_DELTA)) {
    if (ddx === dx && ddy === dy) return Number(dir);
  }
  // Si no hay una dirección exacta (ya llegamos en un eje), probamos la que achique más distancia.
  return dx !== 0 ? (dx > 0 ? 3 : 7) : dy > 0 ? 5 : 1;
}

// AddNpcsToScope del XML es el layout Extended; el server 0.95/0.97 manda el
// layout chico (NpcData de 12 bytes, Id BigEndian). Con el parser del XML el
// TypeNumber cae en otro offset y nunca matchea un monstruo, así que el bot
// exploraba sin ver objetivos.
const NPC_DATA_095_LENGTH = 12;

function parseNpcs095(raw: any): Array<{ Id: number; TypeNumber: number; CurrentPositionX: number; CurrentPositionY: number }> {
  const bytes = toBytes(raw);
  const count = bytes[4];
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = 5 + i * NPC_DATA_095_LENGTH;
    if (base + NPC_DATA_095_LENGTH > bytes.length) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    out.push({
      Id: view.getUint16(base, false), // BigEndian
      TypeNumber: bytes[base + 2],
      CurrentPositionX: bytes[base + 6],
      CurrentPositionY: bytes[base + 7],
    });
  }
  return out;
}

// AddCharactersToScope (C2 12): otros jugadores que entran al scope. El
// evento se emite con el nombre 'AddCharactersToScope' (gana el primero de la
// tabla para el code 0x12), pero el layout es el de 0.95d (el server corre el
// inicializador Version095d, igual que AddNpcsToScope095): count en [4] y
// desde [5] CharacterData de 31 bytes (075: 27) con Id BE@0, X@2, Y@3
// (ServerToClientPackets.xml de OpenMU). Solo leemos id y posición: es para
// penalizar objetivos con jugadores cerca. El stride se deduce del largo
// (31 o 27); si no cierra con ninguno, se ignora el packet entero en vez de
// leer basura. SIN VERIFICAR contra el server real.
const CHAR_DATA_095_LENGTH = 31;
const CHAR_DATA_075_LENGTH = 27;
function parseCharacters095(raw: any): Array<{ id: number; x: number; y: number }> {
  const bytes = toBytes(raw);
  const count = bytes[4];
  if (!count) return [];
  const body = bytes.length - 5;
  const stride = body === count * CHAR_DATA_095_LENGTH ? CHAR_DATA_095_LENGTH : body === count * CHAR_DATA_075_LENGTH ? CHAR_DATA_075_LENGTH : 0;
  if (!stride) {
    if (process.env.MUBOT_DEBUG_NPCS) log(`AddCharactersToScope con layout inesperado (${bytes.length} bytes, count=${count}), lo ignoro.`);
    return [];
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = 5 + i * stride;
    out.push({ id: ((bytes[base] << 8) | bytes[base + 1]) & 0x7fff, x: bytes[base + 2], y: bytes[base + 3] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capa de decisión — el punto de control para una UI futura.
//
// El bot NO ejecuta nada sin pasar por acá. Cada acción de alto nivel se
// propone como una Decision y espera el veredicto del handler. Hoy el handler
// por defecto aprueba todo, pero cambiarlo es lo único que hay que hacer para
// que una UI decida: `setDecisionHandler()`.
//
// Cada decisión también se escribe a un JSONL, así una UI puede tail-ear el
// archivo y ver la actividad en vivo sin tocar el bot.
// ---------------------------------------------------------------------------
type DecisionKind =
  | 'pickup'      // recoger un item del piso
  | 'sell'        // vender un item a un merchant
  | 'buy'         // comprar (pociones)
  | 'reset'       // /reset al llegar al nivel (irreversible)
  | 'stat'        // subir un punto de atributo
  | 'skill'       // usar una skill
  | 'travel'      // viajar a otro mapa
  | 'engage'      // pelear a un objetivo
  // Solo registro (no piden veredicto, ver logDecision): órdenes del panel y
  // cambios de modo. Una pausa no puede quedar rechazada por el handler.
  | 'command'     // orden recibida del panel (panel-protocol.ts)
  | 'mode';       // cambio de modo (farm/hunt/paused/...)

type Decision = {
  kind: DecisionKind;
  what: string;                  // descripción legible
  detail: Record<string, unknown>;// datos crudos para la UI
  autoOk: boolean;               // si el bot puede seguir solo con esto
};

type Verdict = { allow: boolean; reason?: string };

const decisionLogPath = args.get('--decision-log') ?? '';
let decisionHandler: (d: Decision) => Verdict | Promise<Verdict> = () => ({ allow: true });
let decisionSeq = 0;

export function setDecisionHandler(h: (d: Decision) => Verdict | Promise<Verdict>) {
  decisionHandler = h;
}

// Propone una decisión y devuelve si se puede actuar. Nunca lanza: si el
// handler falla, la decisión se rechaza (fail-safe: no gastamos recursos sin
// permiso).
// Escribe una decisión al JSONL y al WebSocket, sin pedir veredicto.
async function logDecision(full: Decision): Promise<void> {
  const entry = { seq: ++decisionSeq, at: new Date().toISOString(), ...full };
  if (decisionLogPath) {
    // appendFile (no Bun.write: ese sobrescribe el archivo entero en cada llamada,
    // así que en una corrida larga solo quedaba la última decisión). Si el archivo
    // falla, no debe frenar el juego.
    await appendFile(decisionLogPath, JSON.stringify(entry) + '\n').catch(() => {});
  }
  statusServer?.broadcastDecision(entry);
}

async function decide(d: Omit<Decision, 'autoOk'> & { autoOk?: boolean }): Promise<boolean> {
  const full: Decision = { autoOk: true, ...d };
  await logDecision(full);
  let verdict: Verdict;
  try {
    verdict = await decisionHandler(full);
  } catch (e) {
    log(`Handler de decisión falló, rechazo por seguridad: ${(e as Error).message}`);
    return false;
  }
  if (!verdict.allow) log(`Acción rechazada (${full.kind}: ${full.what}): ${verdict.reason ?? 'sin motivo'}`);
  return verdict.allow;
}

// ---------------------------------------------------------------------------
// Módulos autónomos: cada uno mira `world` y decide qué packet mandar.
//    Ritmos humanos, NO flood (ver SpeedHackDetectPlugIn: AttackSpeedBaseDelay
//    450ms + token bucket de 5).
// ---------------------------------------------------------------------------
const WALK_PACE_MS = 380;
const ATTACK_PACE_MS = 500;
const SKILL_PACE_MS = 900;
// El cliente web tiene cooldown de chat; 2.5s entre comandos queda cómodo.
const CHAT_PACE_MS = 2500;
// --explore-dir 0..7 (ver DIR_DELTA; 1 = norte): en mapas sin salida conocida
// (FIRST_EXITS de explore.ts) es la primera dirección que se prueba.
const EXPLORE_PREF = args.has('--explore-dir') ? parseInt(args.get('--explore-dir')!) % 8 : null;

const HEAL_AT_PCT = parseInt(args.get('--heal-at') ?? '60');
const MAX_STAT = parseInt(args.get('--max-stat') ?? '10000');
// --build str:50,ene:33,vit:17 → reparto proporcional de los puntos libres.
// Sin peso, cada stat pesa 1. Default: el reparto que usó el usuario en su
// tercer reset con un Dark Knight que pelea con Twisting Slash (la energía
// sube el daño de los skills del DK).
// Sin --build se usa planStats (farming.ts), el reparto del agente web.
const BUILD_ARG = args.get('--build');
const BUILD_WEIGHTS: Array<[StatName, number]> = (BUILD_ARG ?? 'str:50,ene:33,vit:17')
  .split(',')
  .map((part) => part.trim().split(':'))
  .filter(([name]) => STAT_ORDER.includes(name as StatName))
  .map(([name, w]) => [name as StatName, w ? Number(w) : 1]);
const BUILD = BUILD_ARG ? BUILD_WEIGHTS.map(([name]) => name) : (['ene', 'str', 'vit'] as StatName[]);
// Con menos puntos que esto no vale la pena frenar a repartir (3 comandos de
// chat = ~7.5 s sin pelear). El agente web reparte de a 200.
const STAT_BATCH_MIN = parseInt(args.get('--stat-batch') ?? '200');
const RESET_LEVEL = parseInt(args.get('--reset-level') ?? '400');
const ATTACK_SKILLS = (args.get('--skills') ?? '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !Number.isNaN(n));
const ATTACK_SKILL_POOL = ATTACK_SKILLS.length ? ATTACK_SKILLS : DEFAULT_ATTACK_SKILLS;

// Manda un paso en una dirección y actualiza la posición estimada.
function step(dir: number) {
  sendToGS(buildWalkPacket(world.x, world.y, [dir]).buffer);
  const [dx, dy] = DIR_DELTA[dir];
  world.x += dx;
  world.y += dy;
}

// --- Estadísticas -----------------------------------------------------------
// Sube puntos de atributo siguiendo el orden de --build. El server responde con
// CharacterLevelUpdate (que actualiza levelUpPoints), así que no contamos a ciegas.
// Reparte TODOS los puntos libres con /add <stat> <n> (un comando por stat),
// proporcional a BUILD_WEIGHTS. Es como lo hace el usuario: confirmado que el
// server acepta str/ene/vit así (ver AGENTS.md, "Reset y stats").
const STAT_CMD: Record<StatName, string> = { str: 'str', agi: 'agi', vit: 'vit', ene: 'ene' };
async function investStatPoints(force = false): Promise<number> {
  const points = world.levelUpPoints;
  if (points <= 0 || (!force && points < STAT_BATCH_MIN)) return 0;
  let plan: Array<[StatName, number]>;
  if (!BUILD_ARG) {
    // Energía hasta fuerza − 2000, después mitad/mitad; 5% vitalidad. Fuerza y
    // energía reales vienen de CharacterInformation (al entrar) y se llevan a mano.
    const p = planStats(points, world.stats.str, world.stats.ene);
    plan = [['ene', p.ene], ['str', p.str], ['vit', p.vit]];
  } else {
    const active = BUILD_WEIGHTS.filter(([name]) => world.stats[name] < MAX_STAT);
    const total = active.reduce((acc, [, w]) => acc + w, 0);
    if (!total) return 0;
    plan = active.map(([name, w]) => [name, Math.floor((points * w) / total)] as [StatName, number]);
    plan[0][1] += points - plan.reduce((acc, [, n]) => acc + n, 0);
  }
  const ok = await decide({
    kind: 'stat',
    what: plan.filter(([, n]) => n > 0).map(([name, n]) => `+${n} ${name}`).join(', '),
    detail: { points, plan: Object.fromEntries(plan) },
    autoOk: false,
  });
  if (!ok) return 0;
  let spent = 0;
  for (const [name, n] of plan) {
    if (n <= 0) continue;
    sayChat(CHAR_NAME, `/add ${STAT_CMD[name]} ${n}`);
    world.stats[name] += n;
    world.levelUpPoints -= n;
    spent += n;
    await sleep(CHAT_PACE_MS);
  }
  return spent;
}

// --- Pociones ---------------------------------------------------------------
let lastPotionAt = 0;
const POTION_COOLDOWN_MS = 1500;

// Busca la mejor poción de curación que tengamos en el inventario (primero las
// grandes: menos packets = menos tráfico) y la consume. Las pociones son
// stackeables (X=1 Y=1), así que el slot NO se saca del inventario al beber:
// el server manda ItemAddedToInventory/CharacterInventory cuando cambia.
function useHealingPotion(): boolean {
  if (Date.now() - lastPotionAt < POTION_COOLDOWN_MS) return false;
  let best: ItemSlot | undefined;
  for (const it of world.inventory.values()) {
    if (it.group !== POTION_GROUP || !HEAL_POTION_NUMS.has(it.num)) continue;
    if (!best || it.num > best.num) best = it;
  }
  if (!best) return false;
  const p = ConsumeItemRequest075Packet.createPacket();
  p.ItemSlot = best.slot;
  p.TargetSlot = 0xff; // sin item objetivo (pociones)
  sendToGS(p.buffer);
  lastPotionAt = Date.now();
  log(`Pocion consumida: slot=${best.slot} item=${best.group}/${best.num} (HP ${world.hp}/${world.maxHp})`);
  return true;
}

// Devuelve true SOLO si tomó una poción. Si está bajo pero no tiene, devuelve
// false para que el loop siga con el resto de la prioridades en vez de
// quedarse girando en un busy-loop.
let noPotionWarned = false;
function checkSurvival(): boolean {
  if (world.maxHp <= 0) return false;
  const pct = (world.hp / world.maxHp) * 100;
  if (pct > HEAL_AT_PCT) return false;
  if (useHealingPotion()) {
    noPotionWarned = false;
    return true;
  }
  if (!noPotionWarned) {
    log(`HP ${world.hp}/${world.maxHp} (${pct.toFixed(0)}%) bajo y NO hay pocion de curacion en el inventario.`);
    noPotionWarned = true;
  }
  return false;
}

// --- Skills -----------------------------------------------------------------
// TargetedSkill095 manda el NÚMERO de skill (no el índice de lista), confirmado
// contra TargetedSkillHandlerPlugIn de OpenMU, que resuelve SkillId contra
// player.Skills. Se usan solo las que el server nosdeed清单ó Y tenemos mana.
// Skills de área (AreaSkill 0x1E). El resto se manda como TargetedSkill.
// 41 (Twisting Slash) verificado en una captura del cliente real; 42 (Rageful
// Blow) es área en OpenMU, sin verificar todavía.
const AREA_SKILLS = new Set([41, 42]);
// Con menos maná que esto no se tira el skill "en el camino" (agente web skillMinMp).
const SKILL_MIN_MANA = 0.15;

function pickAttackSkill(): SkillInfo | undefined {
  if (world.mana <= 0) return undefined;
  // El nivel viene en 0 para skills normales (los 5 de Horaz tienen level 0),
  // así que no se filtra por nivel.
  for (const num of ATTACK_SKILL_POOL) {
    const known = world.skills.get(num);
    if (known) return known;
  }
  return undefined;
}

function useSkill(targetId: number): boolean {
  const skill = pickAttackSkill();
  const t = world.npcs.get(targetId);
  if (skill == null || !t) return false;
  if (AREA_SKILLS.has(skill.number)) {
    sendAreaSkill(skill.index, t.x, t.y, directionTowards(world.x, world.y, t.x, t.y), targetId);
  } else {
    sendTargetedSkill(skill.index, targetId);
  }
  return true;
}

// --- Loot -------------------------------------------------------------------
type ScopedDrop = { id: number; x: number; y: number; group: number; num: number; isMoney?: boolean; amount?: number; excellent?: boolean };
const drops = new Map<number, ScopedDrop>();

// Bug real encontrado jugando (cuenta melu): 'ItemsDropped' (C2/0x20) y
// 'MoneyDropped075' (mismo código, confirmado en ClientToServerPackets.xml de
// OpenMU) comparten exactamente el mismo code/header, igual que el caso ya
// documentado de SkillAdded. createSocket resuelve por code sin SubCode, así
// que SIEMPRE llega como 'ItemsDropped' (el único generado para 0x20 sin
// SubCode), aunque el payload real sea un drop de dinero — de 14 bytes fijos,
// no una lista de ítems de 16 bytes c/u. Intentar leer el ItemData de 12
// bytes de un drop de dinero leía fuera de rango y tiraba abajo el proceso
// entero. Se distingue por tamaño: si el buffer no matchea
// 5 + ItemCount*16 (layout de ItemsDropped), se intenta como
// MoneyDropped075 (14 bytes fijos, ver MoneyDropped075Packet).
function parseDropsPacket(raw: any): ScopedDrop[] {
  const bytes = toBytes(raw);
  const itemCount = bytes[4];
  const expectedItemsLen = 5 + itemCount * 16;
  if (itemCount > 0 && bytes.length === expectedItemsLen) {
    const p = new ItemsDroppedPacket(raw);
    return p.getItems(itemCount).map((it) => {
      // El group/num salen del ItemData de 12 bytes (mismo layout que
      // ItemAddedToInventory): num = byte 0, group = nibble alto del byte 5.
      const d = it.ItemData;
      const excellent = isExcellentItemData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      return { id: it.Id & 0x7fff, x: it.PositionX, y: it.PositionY, group: (d.getUint8(5) & 0xf0) >> 4, num: d.getUint8(0), excellent };
    });
  }
  if (bytes.length === 14) {
    const p = new MoneyDropped075Packet(raw);
    return [{ id: p.Id & 0x7fff, x: p.PositionX, y: p.PositionY, group: p.MoneyGroup, num: p.MoneyNumber, isMoney: true, amount: p.Amount }];
  }
  log(`AVISO: packet de drop con layout inesperado (${bytes.length} bytes, ItemCount=${itemCount}), lo ignoro.`);
  return [];
}

// Devuelve el handler para desuscribir, así el loop no lo deja colgado.
function watchDrops(): () => void {
  const onDrop = (raw: any) => {
    try {
      for (const d of parseDropsPacket(raw)) drops.set(d.id, d);
    } catch (e) {
      log(`AVISO: no pude parsear un drop, lo ignoro: ${(e as Error).message}`);
    }
  };
  // Drop que levantó otro o que expiró: sacarlo, si no se iba a buscarlo.
  const onRemoved = (raw: any) => {
    for (const id of parseItemDropRemoved(toBytes(raw))) drops.delete(id);
  };
  EventBus.on('ItemsDropped', onDrop);
  EventBus.on('ItemDropRemoved', onRemoved);
  return () => {
    EventBus.off('ItemsDropped', onDrop);
    EventBus.off('ItemDropRemoved', onRemoved);
  };
}

// Loot valioso (farming.ts, isValuableDrop): cajas, joyas, excelentes y los
// guantes 10/1. El zen y el equipo común NO se levantan (cada viaje es tiempo
// sin pelear). Se camina hasta el drop (a <= 12 tiles) y se levanta a <= 1;
// mientras tanto no se pelea, como el agente web. Un drop al que no se llega
// en LOOT_TIMEOUT_MS se olvida.
const LOOT_RADIUS = 12;
const LOOT_TIMEOUT_MS = 8000;
let looting: { id: number; since: number } | null = null;

// Devuelve true si hizo algo (un paso o el pickup).
async function lootStep(): Promise<boolean> {
  if (!drops.size) {
    looting = null;
    return false;
  }
  const now = Date.now();
  if (looting && (!drops.has(looting.id) || now - looting.since > LOOT_TIMEOUT_MS)) {
    if (drops.has(looting.id)) {
      log(`No llego al drop Id=${looting.id}, lo dejo.`);
      drops.delete(looting.id);
    }
    looting = null;
  }
  const d = looting ? drops.get(looting.id)! : pickLoot({ x: world.x, y: world.y }, drops.values(), LOOT_RADIUS);
  if (!d) return false;
  if (!looting) {
    const ok = await decide({
      kind: 'pickup',
      what: `levantar ${d.group}/${d.num}${d.excellent ? ' exc' : ''} (Id=${d.id}) en (${d.x},${d.y})`,
      detail: { itemId: d.id, group: d.group, num: d.num, excellent: !!d.excellent, x: d.x, y: d.y },
    });
    if (!ok) {
      drops.delete(d.id);
      return false;
    }
    looting = { id: d.id, since: now };
  }
  if (chebyshev(world.x, world.y, d.x, d.y) > 1) {
    step(directionTowards(world.x, world.y, d.x, d.y));
    await sleep(WALK_PACE_MS);
    return true;
  }
  drops.delete(d.id);
  looting = null;
  const p = PickupItemRequest075Packet.createPacket();
  p.ItemId = d.id;
  sendToGS(p.buffer);
  lootCount++;
  log(`Levanto ${d.group}/${d.num}${d.excellent ? ' exc' : ''} (Id=${d.id}) en (${d.x},${d.y})`);
  await sleep(300);
  return true;
}
let lootCount = 0;

// --- Economía: qué es basura y qué vale la pena guardar -------------------
// El bot no tiene ni el precio ni IsSellableToNpc del server, así que usa el
// catálogo del repo (data/items.json) para decidir por grupo.
//   12 = jewels/ribbons (comunes)  14 = pociones  15 = scrolls  0 = weapons
//   13 = misc (bless, bows)  31 = event  41 = event
// Lo que NO se vende: equipamiento de slot principal que el personaje pueda
// usar (1..11 weapons/armor), porque ahí la decisión es tuya, no del bot.
type ItemRow = { Group: number; Index: number; ItemName: string; X: number; Y: number; Width: number; Height: number };
const ITEMS: ItemRow[] = itemsData as unknown as ItemRow[];

// Grupos que el bot vende sin preguntar (basura estándar de farm).
// El grupo 12 (Wings of Fairy / Wings of Angel, ver items.json) es EQUIPAMIENTO,
// no basura — estaba mal clasificado acá y el bot vendía las alas del personaje.
const JUNK_GROUPS = new Set([14, 15, 30, 31, 32, 41, 42, 43]);
// Grupos de equipamiento: nunca se tocan sin que la UI/intervención lo pida.
const EQUIP_GROUPS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

function isJunk(it: ItemSlot): boolean {
  if (EQUIP_GROUPS.has(it.group)) return false; // decisión del humano
  if (!JUNK_GROUPS.has(it.group)) return false; // grupo desconocido: no tocar
  // Las pociones curativas no se venden nunca: son las que nos mantienen vivo.
  if (it.group === POTION_GROUP && HEAL_POTION_NUMS.has(it.num)) return false;
  return true;
}

function junkSlots(): ItemSlot[] {
  return [...world.inventory.values()].filter(isJunk);
}

function inventoryPressure(): number {
  // El server manda CharacterInventory con lo que hay; si no loinskió no podemos saberlo.
  const MAX_SLOTS = 40;
  return world.inventory.size / MAX_SLOTS;
}

// --- Merchant ---------------------------------------------------------------
// Flujo de venta (SellItemToNpcAction de OpenMU): el server exige que
// player.OpenedNpc tenga MerchantStore, o sea que HAY que hablarle al NPC antes.
// Si no, responde ItemSoldToNpc(false) y no pasa nada.
const MERCHANT_IDS = new Set(
  (args.get('--merchant') ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n)),
);

let openedNpcId: number | null = null;
let lastMoney = 0;

function talkToNpc(npcId: number) {
  const p = TalkToNpcRequestPacket.createPacket();
  p.NpcId = npcId;
  sendToGS(p.buffer);
  openedNpcId = npcId;
  log(`Hablo con NPC Id=${npcId}`);
}

function closeNpc() {
  if (openedNpcId == null) return;
  sendToGS(CloseNpcRequestPacket.createPacket().buffer);
  openedNpcId = null;
}

function sellSlot(slot: number) {
  const p = SellItemToNpcRequestPacket.createPacket();
  p.ItemSlot = slot;
  sendToGS(p.buffer);
}

// Compra por índice en la lista del merchant. El server valida el índice; si no
// existe responde NpcItemBuyFailed (0x32/0xFF) y no cobra nada.
function buyShopSlot(shopIndex: number) {
  const p = BuyItemFromNpcRequestPacket.createPacket();
  p.ItemSlot = shopIndex;
  sendToGS(p.buffer);
}

// Vende un item concreto pasando por la capa de decisión.
async function sellItem(it: ItemSlot): Promise<boolean> {
  const ok = await decide({
    kind: 'sell',
    what: `vender item ${it.group}/${it.num} del slot ${it.slot}`,
    detail: { slot: it.slot, group: it.group, num: it.num },
  });
  if (!ok) return false;
  if (openedNpcId == null) {
    log('No hay merchant abierto: no puedo vender.');
    return false;
  }
  sellSlot(it.slot);
  return true;
}

// El ID del slot en el inventario NO coincide con el índice del ItemData, así
// que para saber si el server aceptó la venta comparamos el estado del slot
// antes y después de la respuesta.
async function sellJunkToMerchant(): Promise<boolean> {
  const junk = junkSlots();
  if (!junk.length) return false;

  // Vender es la acción más pesada del bot: siempre pasa por decisión.
  if (!(await decide({
    kind: 'sell',
    what: `vender ${junk.length} item(s) de basura por un merchant`,
    detail: { items: junk.map((i) => ({ slot: i.slot, group: i.group, num: i.num })) },
    autoOk: false,
  }))) return false;

  let merchant = openedNpcId;
  if (merchant == null) {
    if (knownMerchants.size === 0) {
      log('Buscando un merchant en el mapa...');
      merchant = await discoverMerchant();
      if (merchant == null) {
        log('No encontré merchant en esta zona. Pasá --merchant <id> si sabés cuál es.');
        return false;
      }
    } else {
      merchant = knownMerchants.values().next().value!;
      talkToNpc(merchant);
    }
  }

  let sold = 0;
  for (const it of junk) {
    const before = world.inventory.has(it.slot);
    sellSlot(it.slot);
    // Un respiro entre ventas: el server lleva contador por request y un burst
    // de ventas iguales lo puede parsear como speedhack.
    await sleep(SELL_INTERVAL_MS);
    // El server borra el item del inventario al venderlo; si sigue, no se vendió.
    if (before && !world.inventory.has(it.slot)) {
      sold++;
    }
    if (openedNpcId == null) break; // el server cerró la ventana: no insistir
  }
  closeNpc();
  log(`Vendí ${sold}/${junk.length} item(s).`);
  return sold > 0;
}

// Catálogo real del merchant abierto (por StoreItemList). group/num salen del
// mismo parser que el inventario, así que coinciden con items.json.
const shopCatalog = new Map<number, ShopItem>();

function findShopSlotFor(group: number, num: number): number | undefined {
  for (const it of shopCatalog.values()) {
    if (it.group === group && it.num === num) return it.shopSlot;
  }
  return undefined;
}

// Comprar pociones. El ItemSlot que espera BuyItemFromNpcRequest NO es el
// índice de items.json sino la posición dentro de la lista del merchant, que el
// server arma por su cuenta. Antes dependía ciegamente de --buy-slot; ahora,
// si ya llegó StoreItemList del merchant abierto, usamos el catálogo real y
// solo caemos a --buy-slot si todavía no tenemos esa info (compatibilidad).
async function ensurePotions(): Promise<boolean> {
  if (haveHealingPotions()) return false;
  if (openedNpcId == null) {
    const merchant = knownMerchants.values().next().value;
    if (merchant == undefined) return false;
    talkToNpc(merchant);
    await sleep(600); // tiempo para que llegue NpcWindowResponse + StoreItemList
  }

  const fromCatalog = [...HEAL_POTION_NUMS]
    .map((num) => findShopSlotFor(POTION_GROUP, num))
    .filter((slot): slot is number => slot != null);
  const candidates = fromCatalog.length ? fromCatalog : SHOP_POTION_SLOTS;
  if (!candidates.length) return false;

  for (const slot of candidates) {
    const ok = await decide({
      kind: 'buy',
      what: `comprar poción del slot ${slot} del shop`,
      detail: { shopSlot: slot, money: lastMoney, fromCatalog: fromCatalog.length > 0 },
      autoOk: false, // gastar plata es siempre decisión del humano
    });
    if (!ok) continue;
    buyShopSlot(slot);
    await sleep(600);
    if (haveHealingPotions()) return true;
  }
  return false;
}

function haveHealingPotions(): boolean {
  for (const it of world.inventory.values()) {
    if (it.group === POTION_GROUP && HEAL_POTION_NUMS.has(it.num)) return true;
  }
  return false;
}

// Índices de pociones dentro de la lista del merchant, en orden de preferencia.
const SHOP_POTION_SLOTS = (args.get('--buy-slot') ?? '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !Number.isNaN(n));

function watchEconomy() {
  EventBus.on('NpcItemSellResult', (raw: any) => {
    const p = new NpcItemSellResultPacket(raw);
    if (p.Success) {
      lastMoney = p.Money;
      log(`Venta OK. Dinero ahora: ${p.Money}`);
    } else {
      log('Venta rechazada por el server.');
    }
  });
  EventBus.on('InventoryMoneyUpdate', (raw: any) => {
    const p = new InventoryMoneyUpdatePacket(raw);
    lastMoney = p.Money;
    log(`Dinero actualizado: ${p.Money}`);
  });
  EventBus.on('NpcItemBuyFailed', () => log('Compra falló (índice de shop inválido).'));
  EventBus.on('StoreItemList', (raw: any) => {
    shopCatalog.clear();
    for (const it of parseStoreItemList097(raw)) shopCatalog.set(it.shopSlot, it);
    log(`Catálogo del merchant: ${shopCatalog.size} ítem(s) — ${[...shopCatalog.values()].map((i) => `slot${i.shopSlot}:${i.group}/${i.num}`).join(', ')}`);
  });
  EventBus.on('NpcWindowResponse', (raw: any) => {
    const p = new NpcWindowResponsePacket(raw);
    log(`Ventana de NPC: ${NpcWindowResponseNpcWindowEnum[p.Window] ?? p.Window}`);
  });
}
// --- Descubrimiento de merchants -------------------------------------------
// monsters.json NO contiene NPCs (solo monstruos), así que no hay forma de
// saber de antemano qué Id es un merchant. La forma honesta es descubrirlo:
// hablamos con los NPCs que hay en scope y leemos la ventana que conteste.
// Merchant=0 / Merchant1=1 son las ventanas de venta.
const isMerchantWindow = (w: number) => w === 0 || w === 1;

const knownMerchants = new Set<number>(MERCHANT_IDS);

async function discoverMerchant(): Promise<number | null> {
  const candidates = [...world.townNpcs.values()].filter((n) => !isJunkType(n.type));
  for (const c of candidates) {
    const ok = await decide({
      kind: 'travel',
      what: `hablar con NPC Id=${c.id} para ver si es merchant`,
      detail: { npcId: c.id, x: c.x, y: c.y },
    });
    if (!ok) continue;
    const waiter = waitFor('NpcWindowResponse', 3000).catch(() => null);
    talkToNpc(c.id);
    const raw = await waiter;
    if (!raw) {
      closeNpc();
      continue;
    }
    const w = new NpcWindowResponsePacket(raw).Window;
    if (isMerchantWindow(w)) {
      log(`¡Merchant encontrado! Id=${c.id} (ventana ${NpcWindowResponseNpcWindowEnum[w]})`);
      knownMerchants.add(c.id);
      return c.id;
    }
    closeNpc();
  }
  return null;
}

// Los candidatos salen de world.townNpcs (TypeNumber 200-299). Los guardias
// (247 Crossbow, 249 Berdysh) no abren ventana: no vale la pena hablarles.
function isJunkType(type: number): boolean {
  return type === 247 || type === 249;
}

// /move <mapa> por chat público (MoveChatCommandPlugIn de OpenMU): el server
// valida nivel y zen según su WarpList (Version075: Dungeon = nivel 30, 3000 zen)
// y contesta con MapChanged075. Es lo mismo que tipear el comando en el cliente.
// PublicChatMessage: C1, code 0x00, Character[10]@3, Message@13 (null-terminado).
async function moveToMap(mapName: string): Promise<boolean> {
  const ok = await decide({
    kind: 'travel',
    what: `/move ${mapName} (cuesta zen)`,
    detail: { command: '/move', map: mapName, fromMap: world.map },
    autoOk: false,
  });
  if (!ok) return false;
  const waiter = waitFor('MapChanged075', 5000).catch(() => null);
  sayChat(CHAR_NAME, `/move ${mapName}`);
  if (!(await waiter)) {
    log(`/move ${mapName}: el server no cambió de mapa (¿nivel, zen o nombre de mapa?).`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mapas de farmeo: la RUTA del usuario (la que sigue el agente web, que es el
// que sube rápido), con índices del menú de warp del cliente (perfil v097d):
//   Lorencia (2) → Devias 3/4 (6, 7), si no Devias 2 (5) → Arena (1, nivel 50) → Arena 2 (24,
//   nivel 100) → Arena 3 (25, nivel 200) → Arena 4 (26, nivel 300).
// Devias 1 (warp 4) NO va: el usuario confirmó jugando que no sirve. Noria,
// Dungeon, Lost Tower, Atlans, etc. tampoco: no están en su ruta.
// Zen: los de Lorencia/Devias son los de la lista de warp; los de Arena no se
// capturaron todavía (0 = desconocido, el server igual valida y cobra).
// ---------------------------------------------------------------------------
// map = mapa al que deja el warp (Lorencia 0, Devias 2, Arenas 2/3/4 = 83/84/85
// según el agente web). La ruta FIJA por tramo está en learning.ts (FIXED_ROUTE).
const WARP_SPOTS: Spot[] = [
  { index: 2, name: 'Lorencia', reqLevel: 10, zen: 1000, map: 0 },
  // Orden = preferencia entre spots del mismo nivel: Devias 3/4 antes que la 2.
  { index: 6, name: 'Devias 3', reqLevel: 20, zen: 2500, map: 2 },
  { index: 7, name: 'Devias 4', reqLevel: 20, zen: 2500, map: 2 },
  { index: 5, name: 'Devias 2', reqLevel: 20, zen: 2000, map: 2 },
  // Arena 1 (warp 1): monstruos flojos y dispersos, ~0 exp/min medido jugando.
  // Solo como plan B si todas las Devias están llenas de gente (nivel 50-99).
  { index: CROWD_FALLBACK.warp, name: 'Arena', reqLevel: 50, zen: 0 },
  { index: 24, name: 'Arena 2', reqLevel: 100, zen: 0, map: 83 },
  { index: 25, name: 'Arena 3', reqLevel: 200, zen: 0, map: 84 },
  { index: 26, name: 'Arena 4', reqLevel: 300, zen: 0, map: 85 },
];
// Sin el plan B: lo que usan --no-learn y --free-route.
const ROUTE_SPOTS = WARP_SPOTS.filter((sp) => sp.index !== CROWD_FALLBACK.warp);
const FIXED_ROUTE_ON = !args.has('--free-route');
const zenTxt = (sp: Spot | null | undefined) => (sp?.zen ? `cuesta ${sp.zen} zen` : 'zen sin capturar');
const LORENCIA_WARP = 2;
// --spots 2,8,21 limita a qué warps puede ir el bot (default: todos).
const ALLOWED_SPOTS = args.get('--spots') ? new Set(args.get('--spots')!.split(',').map(Number)) : null;
let currentSpot: Spot | null = null;
// Spot → cuándo se lo encontró "seco" (mapa entero sin monstruos DRY_MAP_MS).
// No se vuelve a elegir durante LEARN.DRY_EXCLUDE_MS (ver explore.ts).
const dryAt = new Map<number, number>();
// Desde cuándo está en currentSpot (para la permanencia mínima del bandit).
let spotSince = 0;

// Regla fija (la de antes del aprendizaje): el de mayor reqLevel permitido.
// Se usa con --no-learn.
function pickSpot(level: number, exclude: ReadonlySet<number> = new Set()): Spot | undefined {
  return ROUTE_SPOTS.filter((sp) => sp.reqLevel <= level && (!ALLOWED_SPOTS || ALLOWED_SPOTS.has(sp.index)) && !exclude.has(sp.index)).sort(
    (a, b) => b.reqLevel - a.reqLevel,
  )[0];
}

// ---------------------------------------------------------------------------
// Aprendizaje (ver learning.ts y AGENTS.md, "Aprendizaje"): mide exp/min,
// kills/min y muertes por spot, lo guarda por personaje y elige el spot con
// un bandit UCB1 en vez de "el de mayor nivel".
// ---------------------------------------------------------------------------
const LEARN_ENABLED = !args.has('--no-learn');
const LEARN_FILE = args.get('--learn-file') ?? join(homedir(), '.mubot', 'learning.json');
const LEARN_SUMMARY_MS = 2 * 60_000;
let learning: CharLearning = { resets: 0, samples: [] };
const meter = new SpotMeter();

// Farmeo por exp/segundo (farming.ts): lo aprendido por tipo de monstruo, el
// registro id → tipo para atribuir la exp, y la grilla de spots calientes
// (explore.ts). Viven a nivel módulo: sobreviven a los resets, y se guardan
// en el mismo learning.json para sobrevivir a un reinicio del bot.
const typeStats = new MonsterTypeStats((type) => MONSTER_MAX_HP.get(type) ?? null);
const expTracker = new ExpSplitTracker(typeStats);
const hotGrid = new HotSpotGrid();
// Registro de exp por segundo (farming.ts, ExpLog): TODAS las mediciones de
// exp/min por ventana (informe, campamentos, hambre) salen de acá.
const expLog = new ExpLog(Date.now());
// Campamentos (camp.ts): correa, memoria, vara por mapa. Hambre por tramo.
// Registro de tramos por ciclo. Se recrean al cargar learning.json.
let camps = new CampManager();
let hunger = new Hunger();
let cycleLog = new CycleLog(Date.now());
// Kills por tipo (curiosidad: tipos con < 3 kills medidos van primero).
const typeKills: Record<number, number> = {};
// Último MapChanged / entrada al mundo (el hambre no mira el primer minuto).
let lastArrivalAt = Date.now();
// Se puede adoptar el mapa actual como spot sin warpear (al entrar al mundo);
// tras una muerte no (respawnea en el pueblo: hay que volver a warpear).
let canAdopt = true;
// Spot → cuándo se lo dejó por competencia (ruta fija: no volver enseguida).
const crowdedAt = new Map<number, number>();
// Último spot en el que estuvo (tras morir se vuelve a esa entrada).
let lastSpotIndex: number | null = null;

function onMapArrival() {
  lastArrivalAt = Date.now();
  camps.onArrival(world.map, world.x, world.y, lastArrivalAt, world.level);
  const lz = camps.leashFor(world.map);
  log(`Llegada en (${world.x},${world.y}) map=${world.map}${lz ? `, correa de ${lz.r} tiles` : ''}.`);
  for (const e of camps.events) log(`Campamento: ${e}.`);
}

async function loadLearningState() {
  if (!LEARN_ENABLED) return;
  const r = await loadLearning(LEARN_FILE);
  learning = r.data.chars[CHAR_NAME] ?? { resets: 0, samples: [] };
  if (learning.types) {
    Object.assign(typeStats.expByType, learning.types.expByType);
    Object.assign(typeStats.killSecByType, learning.types.killSecByType);
  }
  if (learning.hot) hotGrid.load(learning.hot);
  camps = new CampManager(CAMP, new CampMemory(CAMP, learning.camps ?? []));
  hunger = new Hunger(CAMP, learning.tierRef);
  cycleLog = new CycleLog(Date.now(), learning.cycles ?? undefined);
  if (r.status === 'corrupt') {
    log(`Aprendizaje: ${LEARN_FILE} ilegible (${r.error}); arranco de cero${r.backup ? `, el original quedó en ${r.backup}` : ''}.`);
  } else {
    log(`Aprendizaje: ${learning.samples.length} muestra(s) de ${CHAR_NAME} en ${LEARN_FILE}${r.status === 'missing' ? ' (archivo nuevo)' : ''}.`);
  }
}

function recordSample(s: SpotSample | null) {
  if (s) learning.samples.push(s);
}

// Los saves se encadenan (muerte y resumen pueden coincidir): uno a la vez.
let learnSaveChain: Promise<void> = Promise.resolve();
function persistLearning(): Promise<void> {
  if (!LEARN_ENABLED) return Promise.resolve();
  // Nunca frena el juego: si el disco falla, se pierde a lo sumo un tramo.
  learning.types = typeStats.snapshot();
  learning.hot = hotGrid.dump().map(({ map, cx, cy, exp }) => ({ map, cx, cy, exp }));
  learning.camps = camps.memory.dump();
  learning.cycles = { cur: cycleLog.cur, done: cycleLog.done.slice(-200) };
  learning.tierRef = { ...hunger.ref };
  learnSaveChain = learnSaveChain.then(() =>
    saveLearningChar(LEARN_FILE, CHAR_NAME, learning).catch((e) =>
      log(`Aprendizaje: no pude guardar ${LEARN_FILE}: ${(e as Error).message}`),
    ),
  );
  return learnSaveChain;
}

// Corta el tramo en curso (lo guarda como muestra) y deja de medir.
function endStint() {
  recordSample(meter.flush(Date.now(), world.level));
  meter.stop();
}

function logLearningSummary() {
  if (!LEARN_ENABLED) return;
  const now = Date.now();
  const live = meter.peek(now);
  const stats = aggregate(live ? [...learning.samples, live] : learning.samples, world.level, learning.resets);
  log(`Aprendizaje (nivel ${world.level}, reset ${learning.resets}, * = spot actual):\n${formatSpotTable(WARP_SPOTS, stats, currentSpot?.index ?? null)}`);
}

// Estadía en el spot actual (para su exp/min) y el mayor tier de mapas ya visto
// en este ciclo de reset (ver chooseRouteSpot en learning.ts).
let stayExp = 0;
let tierSeen = 0;
let lastWarpAt = 0;
// Entre warps: el agente web espera 15 s (que cargue el mapa y aparezcan los
// monstruos) antes de volver a evaluar.
const WARP_COOLDOWN_MS = 15_000;

async function warpAndWait(spot: Spot, measure = true): Promise<boolean> {
  const waiter = waitFor('MapChanged075', 6000).catch(() => null);
  warpTo(spot.index);
  lastWarpAt = Date.now();
  const ok = !!(await waiter);
  if (ok) {
    endStint();
    currentSpot = spot;
    spotSince = Date.now();
    stayExp = 0;
    if (measure && LEARN_ENABLED) meter.start(spot.index, world.level, learning.resets, spotSince);
  } else log(`Warp a ${spot.name} sin respuesta (¿nivel, zen o PK?).`);
  return ok;
}

// Por defecto, la RUTA FIJA por tramo (chooseFixedRoute, learning.ts): cambia
// de mapa solo al cruzar un tramo, con el mapa vacío (90 s) o por competencia
// que bajó la exp (campamentos abandonados por gente, o "hambre"). Si ya está
// en el mapa del tramo al entrar al mundo, lo adopta sin warpear.
// Con --free-route: la regla vieja (chooseRouteSpot) que prueba mapas por exp/min.
type SpotSignals = { mapDead?: boolean; crowded?: boolean };
async function maybeChangeSpot(sig: SpotSignals = {}): Promise<boolean> {
  const now = Date.now();
  if (now - lastWarpAt < WARP_COOLDOWN_MS) return false;
  // Spot fijado por la orden `warp` del panel: ni la ruta ni el bandit lo
  // cambian hasta la orden `farm`. Si murió o lo sacaron, vuelve ahí.
  if (pinnedSpot) {
    if (currentSpot?.index === pinnedSpot.index) return false;
    const pin = pinnedSpot;
    if (!(await decide({ kind: 'travel', what: `volver al spot fijado por el panel: ${pin.name} (${zenTxt(pin)})`, detail: { warp: pin.index, reason: 'panel' } }))) return false;
    return warpAndWait(pin);
  }
  let best: Spot | undefined | null;
  let what: string;
  let detail: Record<string, unknown> = { from: currentSpot?.name ?? null, level: world.level };
  const exclude = activeDryExclusions(dryAt, now);
  if (exclude.size) detail.dry = [...exclude];
  if (FIXED_ROUTE_ON) {
    const choice = chooseFixedRoute({
      spots: WARP_SPOTS,
      level: world.level,
      allowed: ALLOWED_SPOTS,
      current: currentSpot,
      currentMap: canAdopt ? world.map : -1,
      mapDead: !!sig.mapDead,
      crowded: !!sig.crowded,
      crowdedAt,
      now,
      prefer: lastSpotIndex,
    });
    if (choice.reason === 'crowd' && currentSpot) crowdedAt.set(currentSpot.index, now);
    if (sig.crowded) camps.crowdLeaves = [];
    if (choice.reason === 'adopt' && choice.spot) {
      // Ya está en el mapa del tramo: seguir acá sin warpear.
      log(`Spot: ${choice.what}.`);
      currentSpot = choice.spot;
      spotSince = now;
      stayExp = 0;
      if (LEARN_ENABLED) meter.start(choice.spot.index, world.level, learning.resets, now);
      return false;
    }
    if (!choice.warp || !choice.spot || choice.spot.index === currentSpot?.index) return false;
    best = choice.spot;
    what = `${choice.what} (${zenTxt(best)})`;
    detail = { ...detail, reason: choice.reason, tier: choice.tier };
  } else if (!LEARN_ENABLED) {
    best = pickSpot(world.level, exclude);
    what = `warp a ${best?.name} (nivel ${world.level}, ${zenTxt(best)})`;
  } else {
    const live = meter.peek(now);
    const scores = routeScores(live ? [...learning.samples, live] : learning.samples, world.level, learning.resets);
    const choice = chooseRouteSpot({
      spots: ROUTE_SPOTS,
      level: world.level,
      allowed: ALLOWED_SPOTS,
      current: currentSpot,
      stayMs: currentSpot ? now - spotSince : 0,
      stayExp,
      scores,
      tierSeen,
      exclude,
    });
    tierSeen = Math.max(tierSeen, choice.tier);
    if (choice.restartEval) {
      // Rinde poco pero no hay alternativa: medir de nuevo desde ahora.
      log(`Spot: ${choice.what}; vuelvo a medir.`);
      spotSince = now;
      stayExp = 0;
    }
    best = choice.spot;
    what = `${choice.what} → warp a ${best?.name} (${zenTxt(best)})`;
    detail = {
      ...detail,
      reason: choice.reason,
      curRate: Math.round(choice.curRate),
      bestKnown: Math.round(choice.bestKnown),
      scores: Object.fromEntries(scores),
    };
  }
  if (!best || best.index === currentSpot?.index) return false;
  const ok = await decide({ kind: 'travel', what, detail: { ...detail, warp: best.index }, autoOk: true });
  if (!ok) return false;
  log(`Cambio de spot: ${currentSpot?.name ?? '?'} → ${best.name} — ${what}`);
  const moved = await warpAndWait(best);
  if (moved) await persistLearning();
  return moved;
}

// ---------------------------------------------------------------------------
// Reset (capturado del usuario): reparte lo que quede, va a Lorencia, manda
// /reset por chat y el server lo devuelve a la selección de personaje. Hay que
// volver a elegir el personaje, repartir los puntos nuevos y salir a farmear.
// ---------------------------------------------------------------------------
async function doReset(): Promise<boolean> {
  const ok = await decide({
    kind: 'reset',
    what: `/reset en nivel ${world.level}`,
    detail: { level: world.level, stats: { ...world.stats } },
    autoOk: false,
  });
  if (!ok) return false;
  resetting = true;
  try {
    return await doResetSteps();
  } finally {
    resetting = false;
  }
}

async function doResetSteps(): Promise<boolean> {
  doing = `reseteando en nivel ${world.level}`;
  await investStatPoints(true);
  // Lo medido hasta acá es del reset viejo: cortarlo antes de ir a Lorencia
  // (el viaje a resetear no es farmeo y no se mide).
  endStint();
  if (world.map !== 0) await warpAndWait(WARP_SPOTS.find((sp) => sp.index === LORENCIA_WARP)!, false);
  await sleep(2000);
  let listWaiter = waitFor('CharacterList', 8000).catch(() => null);
  sayChat(CHAR_NAME, '/reset');
  let list = await listWaiter;
  if (!list) {
    // Por si el server nos dejó en la selección sin mandar la lista.
    listWaiter = waitFor('CharacterList', 5000).catch(() => null);
    requestCharacterList();
    list = await listWaiter;
  }
  if (!list) {
    log('Reset: el server no nos mandó a la selección de personaje. ¿Requisitos (nivel, zen)?');
    return false;
  }
  log('Reset hecho. Vuelvo a entrar con el personaje.');
  inGameAt = 0;
  world.npcs.clear();
  world.townNpcs.clear();
  currentSpot = null;
  meter.stop();
  // Ciclo nuevo: el rendimiento por mapa se vuelve a medir (routeScores solo
  // mira muestras de este reset) y los tiers se vuelven a habilitar desde
  // Lorencia. Los spots calientes (hotGrid) y lo aprendido por tipo de
  // monstruo se conservan: dependen del mapa, no del nivel.
  tierSeen = 0;
  stayExp = 0;
  // La vara de cada mapa depende del nivel: se vuelve a medir. La memoria de
  // campamentos se conserva (guarda el nivel al que se midió).
  camps.onReset();
  crowdedAt.clear();
  // Cierra el ciclo en el registro de tramos (solo cuenta si llegó al 400).
  const closed = cycleLog.reset(Date.now());
  if (closed) log(`Ciclo cerrado: ${closed.min} min (${Math.round(1440 / (closed.min || 1))} resets/día a este ritmo).`);
  // Contador local de resets: el server no manda uno que sepamos parsear.
  learning.resets++;
  await persistLearning();
  await selectCharacter(list);
  await sleep(2500);
  await investStatPoints(true);
  return true;
}

// ---------------------------------------------------------------------------
// Panel (panel-protocol.ts, ws-server.ts): modo, órdenes de lista cerrada y el
// estado que se manda cada 1 s. Todo sale de lo que el bot ya trackea de los
// packets: funciona igual sin navegador.
// ---------------------------------------------------------------------------
// Pausa: el loop no camina, no pelea, no warpea ni resetea; las pociones siguen.
let paused = false;
// Cacería de dorados (orden `hunt`). null = farmeo normal.
type HuntState = { hunt: HuntMap; since: number; warpTries: number; nextWarpAt: number; explorer: HuntExplorer; seen: Set<number> };
let hunting: HuntState | null = null;
// Cazando, a un monstruo común solo se le pega si está a esto (no frena la búsqueda).
const HUNT_NORMAL_RANGE = 3;
// Orden `warp`: el loop la ejecuta en su próximo tick; el spot queda fijo hasta `farm`.
let pendingWarp: Spot | null = null;
let pinnedSpot: Spot | null = null;
let resetting = false;
// 0 = fuera del mundo (conectando, en la selección de personaje).
let inGameAt = 0;
let charName = CHAR_NAME;
// El loop descarta su objetivo en el próximo tick (cambio de modo).
let retarget = false;
// Frase corta de lo que hace ahora (la pone el loop).
let doing = 'conectando';
// Punto al que va ahora (campamento, salida, celda de la cacería).
let goalPoint: [number, number] | null = null;
// Última invasión (0xFD) y aperturas de eventos (0x91).
let invasion: Invasion | null = null;
const eventTimers = new Map<EventKey, EventTimer>();
const nextEventPollAt = new Map<EventKey, number>();
// Rastro para el minimapa: una posición cada 2 s, solo del mapa actual.
const TRAIL_MAX = 60;
const trail: [number, number][] = [];
let trailMap = -1;
let lastTrailAt = 0;

const isGolden = (n: ScopedNpc) => GOLDEN_TYPES.has(n.type);
const monsterName = (type: number) => MONSTER_NAMES.get(type) ?? `tipo ${type}`;

// Log a consola y al panel.
function panelLog(text: string) {
  log(text);
  statusServer?.broadcastLog(text);
}

function currentMode(): BotMode {
  if (!inGameAt || kicked) return 'connecting';
  if (resetting) return 'resetting';
  if (world.maxHp > 0 && world.hp <= 0) return 'dead';
  if (paused) return 'paused';
  return hunting ? 'hunt' : 'farm';
}

function stopHunt(reason: string) {
  if (!hunting) return;
  const h = hunting;
  hunting = null;
  retarget = true;
  goalPoint = null;
  // El spot de la cacería no es de la ruta: que la ruta fija decida (adopta el
  // mapa si es el del tramo, si no warpea).
  endStint();
  currentSpot = null;
  canAdopt = true;
  panelLog(`Cacería en ${h.hunt.name} terminada (${reason}): vuelvo a farmear.`);
}

function runPanelCommand(c: PanelCommand): CommandResult {
  switch (c.cmd) {
    case 'pause':
      if (paused) return { ok: true, msg: 'ya estaba en pausa' };
      paused = true;
      retarget = true;
      return { ok: true, msg: 'en pausa: no camino, no peleo ni warpeo (las pociones siguen)' };
    case 'resume':
      if (!paused) return { ok: true, msg: 'no estaba en pausa' };
      paused = false;
      return { ok: true, msg: `sigo: ${hunting ? `cazando en ${hunting.hunt.name}` : 'farmeo normal'}` };
    case 'farm': {
      const was = [hunting && 'cacería cancelada', pinnedSpot && `spot fijo (${pinnedSpot.name}) liberado`, paused && 'pausa levantada'].filter(Boolean);
      if (hunting) stopHunt('orden del panel');
      pinnedSpot = null;
      pendingWarp = null;
      paused = false;
      return { ok: true, msg: `farmeo normal por la ruta${was.length ? ` (${was.join(', ')})` : ''}` };
    }
    case 'warp': {
      if (!inGameAt) return { ok: false, msg: 'todavía no estoy en el mundo' };
      if (resetting) return { ok: false, msg: 'estoy reseteando, probá en un rato' };
      const spots = WARP_SPOTS.filter((sp) => !ALLOWED_SPOTS || ALLOWED_SPOTS.has(sp.index));
      const v = validateWarp(c.warp, world.level, spots);
      if (!v.ok) return { ok: false, msg: v.msg };
      if (hunting) stopHunt('orden warp del panel');
      paused = false;
      pendingWarp = v.spot;
      pinnedSpot = v.spot;
      return { ok: true, msg: `voy a ${v.spot.name} (warp ${v.spot.index}); queda fijo hasta la orden farm` };
    }
    case 'hunt': {
      if (!inGameAt) return { ok: false, msg: 'todavía no estoy en el mundo' };
      if (resetting) return { ok: false, msg: 'estoy reseteando, probá en un rato' };
      const ch = chooseHuntMap({ invasion, level: world.level, map: c.map });
      if (!ch.ok) return { ok: false, msg: ch.msg };
      if (invasion?.status === 'active' && ch.alive === 0) return { ok: false, msg: `el último 0xFD dice 0 dorados vivos en ${ch.hunt.name}` };
      hunting = { hunt: ch.hunt, since: Date.now(), warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set() };
      pinnedSpot = null;
      pendingWarp = null;
      paused = false;
      retarget = true;
      return { ok: true, msg: `cazo dorados en ${ch.hunt.name}${ch.alive != null ? ` (${ch.alive} vivos según el 0xFD)` : ''}; corto a los 15 min o cuando no queden` };
    }
  }
}

async function handlePanelCommand(c: PanelCommand): Promise<CommandResult> {
  const r = runPanelCommand(c);
  panelLog(`Orden del panel ${JSON.stringify(c)}: ${r.ok ? '' : 'rechazada, '}${r.msg}.`);
  await logDecision({ kind: 'command', what: `${c.cmd}: ${r.msg}`, detail: { command: c, ok: r.ok }, autoOk: true });
  return r;
}

// Cambios de modo: se detectan en el tick de 1 s del panel (cubre todo: órdenes,
// muerte, reset, reconexión) y van al log del panel y al de decisiones.
let lastMode: BotMode | null = null;
function noteModeChange() {
  const m = currentMode();
  if (m === lastMode) return;
  const from = lastMode;
  lastMode = m;
  if (from == null) return;
  panelLog(`Modo: ${from} → ${m}.`);
  void logDecision({ kind: 'mode', what: `${from} → ${m}`, detail: { from, to: m }, autoOk: true });
}

function updateTrail(now: number) {
  if (world.map !== trailMap) {
    trail.length = 0;
    trailMap = world.map;
  }
  if (now - lastTrailAt < 2000) return;
  lastTrailAt = now;
  trail.push([world.x, world.y]);
  if (trail.length > TRAIL_MAX) trail.shift();
}

function buildPanelState(now: number): PanelState {
  const cycles = cycleLog.done.slice(-20).map((c) => toPanelCycle(c));
  const equipment = [...world.inventory.values()]
    .filter((it) => it.slot >= 0 && it.slot <= 11)
    .sort((a, b) => a.slot - b.slot)
    .map((it) => ({ slot: it.slot, group: it.group, num: it.num, level: it.level ?? 0, excellent: !!it.excellent }));
  return {
    at: now,
    mode: currentMode(),
    doing: paused ? 'en pausa' : doing,
    char: {
      name: charName,
      level: world.level,
      resets: LEARN_ENABLED ? learning.resets : null,
      ...(world.classId != null ? { classId: world.classId } : {}),
      hp: [world.hp, world.maxHp],
      mp: [world.mana, world.maxMana],
      stats: { ...world.stats },
      points: world.levelUpPoints,
      zen: inGameAt ? lastMoney : null,
    },
    where: { map: world.map, mapName: mapName(world.map), x: world.x, y: world.y, spot: hunting ? `cacería ${hunting.hunt.name}` : (currentSpot?.name ?? null) },
    exp: { perMin1: Math.round(expLog.perMin(now, 60_000)), perMin5: Math.round(expLog.perMin(now, 5 * 60_000)) },
    cycle: toPanelCycle(cycleLog.cur, true),
    cycles,
    resetsPerDay: resetsPerDay(cycles),
    events: EVENT_KEYS.map((k) => eventTimers.get(k)).filter((t): t is EventTimer => !!t),
    invasion,
    tickets: countTickets(world.inventory.values()),
    nearby: {
      monsters: [...world.npcs.values()].filter((n) => chebyshev(n.x, n.y, world.x, world.y) <= 10).length,
      players: world.players.size,
    },
    equipment,
    trail: trail.map(([x, y]) => [x, y] as [number, number]),
    camp: goalPoint,
  };
}

// Aperturas de eventos (0x91): una pregunta por evento cada ~60 s, nunca más
// de una cada EVENT_POLL_TICK_MS (ritmo humano; el cliente pregunta cada 30 s
// a 5 min). Al entrar al mundo se preguntan las tres, espaciadas.
const EVENT_POLL_EVERY_MS = 60_000;
const EVENT_POLL_TICK_MS = 5_000;
function scheduleEventPolls(now: number) {
  for (const k of EVENT_KEYS) nextEventPollAt.set(k, now + 3000);
}
function pollEvents() {
  if (!statusServer || kicked || !inGameAt || resetting) return;
  const now = Date.now();
  let due: EventKey | null = null;
  for (const k of EVENT_KEYS) {
    const at = nextEventPollAt.get(k) ?? 0;
    if (at <= now && (due == null || at < (nextEventPollAt.get(due) ?? 0))) due = k;
  }
  if (!due) return;
  nextEventPollAt.set(due, now + EVENT_POLL_EVERY_MS);
  sendToGS(new DataView(buildOpeningStateRequest(due).buffer));
}

// Listeners de los packets que solo usa el panel (una vez, con trackWorld).
function trackPanelPackets() {
  EventBus.on('MiniGameOpeningState', (raw: any) => {
    const t = parseOpeningState(toBytes(raw), Date.now());
    if (t) eventTimers.set(t.key, t);
  });
  // 0xFD (invasión dorada) es propio del server: no está en packets/routes.ts y
  // net/socket.ts lo emite crudo como 'UnroutedPacket'.
  EventBus.on('UnroutedPacket', (raw: any) => {
    const b = toBytes(raw);
    if (b[0] !== 0xc1 || b[2] !== 0xfd) return;
    const inv = parseInvasion(b, Date.now());
    if (!inv) return;
    const prev = invasion;
    invasion = inv;
    if (!prev || prev.status !== inv.status || prev.total !== inv.total) {
      log(`Invasión dorada: ${inv.status}, ${inv.total} vivo(s)${inv.maps.length ? ` (${inv.maps.map((m) => `${m.name}: ${m.alive}`).join(' · ')})` : ''}.`);
    }
  });
}

// ---------------------------------------------------------------------------
// 7. Loop autónomo: prioriza sobrevivir > subir stats > pelear > loot > explorar
// ---------------------------------------------------------------------------
// Autoevaluación en consola cada esto (ver SelfReport en farming.ts).
const REPORT_EVERY_MS = 5 * 60_000;

// Totales de todas las sesiones (el loop corre una vez por conexión).
type LoopResult = { kills: number; totalExpGained: number; potionsDrunk: number; statPointsSpent: number; skillsUsed: number; resets: number; deaths: number };

// Autoevaluación acumulada entre sesiones (reconexiones), sobre el ExpLog.
const report = new SelfReport(Date.now(), expLog);

// Hasta `deadline` (0 = sin límite) o hasta que se corte la conexión.
async function autonomousLoop(deadline: number): Promise<LoopResult> {
  log(`\n--- Modo autónomo: ${deadline ? `hasta ${new Date(deadline).toLocaleTimeString()}` : 'sin límite'} ---`);
  log(`Build=${BUILD.join('>')}${BUILD_ARG ? '' : ' (planStats)'} heal<=${HEAL_AT_PCT}% skills=[${ATTACK_SKILL_POOL.join(',')}] ruta=${FIXED_ROUTE_ON ? 'fija por tramo' : 'libre'}`);

  const npcs = world.npcs;
  let totalExpGained = 0;
  let kills = 0;
  let potionsDrunk = 0;
  let statPointsSpent = 0;
  let skillsUsed = 0;
  let resets = 0;
  let deaths = 0;
  let nextResetTry = 0;
  let lastSummary = Date.now();
  let lastReport = Date.now();
  let lastCycleCheck = 0;
  let lastCastAt = 0;
  // Fase de la iteración anterior: el tiempo hasta la próxima se le atribuye.
  let phase: TimeKind = 'other';
  let phaseAt = Date.now();
  // Desde cuándo perseguimos al objetivo actual (segundos hasta matarlo).
  let targetSince = 0;
  let targetType = -1;
  let starvingLogged = 0;

  // Muerte propia: llega por dos lados (HP a 0 y ObjectGotKilled con nuestro
  // id); el meter descarta el duplicado. Se corta el tramo y se olvida el spot
  // actual: el respawn es en el pueblo, así que el próximo maybeChangeSpot
  // vuelve a warpear (canAdopt = false: no adoptar el pueblo como spot).
  const onDeath = (source: string) => {
    if (!meter.addDeath(Date.now())) return;
    deaths++;
    log(`Muerte #${deaths} (${source}) en ${currentSpot?.name ?? 'spot desconocido'}.`);
    endStint();
    lastSpotIndex = currentSpot?.index ?? lastSpotIndex;
    currentSpot = null;
    canAdopt = false;
    camps.camp = null;
    if (LEARN_ENABLED) void persistLearning();
  };
  let lastHp = world.hp;
  const onHp = (raw: any) => {
    const hp = new CurrentHealthAndShieldPacket(raw).Health;
    if (hp === 0 && lastHp > 0) onDeath('HP 0');
    lastHp = hp;
  };

  const onKilled = (raw: any) => {
    const p = new ObjectGotKilledPacket(raw);
    const wasOurTarget = (p.KilledId & 0x7fff) === target;
    npcs.delete(p.KilledId & 0x7fff);
    if ((p.KilledId & 0x7fff) === playerId) {
      onDeath('ObjectGotKilled');
      return;
    }
    if ((p.KillerId & 0x7fff) === playerId) {
      kills++;
      meter.addKill();
      // Segundos de kill por tipo: desde que se eligió el objetivo hasta acá.
      if (wasOurTarget) typeStats.recordKillSec(targetType, (Date.now() - targetSince) / 1000);
      if (process.env.MUBOT_DEBUG_COMBAT) log(`Kill #${kills} (Id=${p.KilledId & 0x7fff})`);
    } else if (wasOurTarget && process.env.MUBOT_DEBUG_COMBAT) {
      // Zona concurrida: puede que otro jugador/NPC mate a nuestro objetivo
      // antes que nosotros — no es un bug, pero conviene verlo.
      log(`DEBUG combate: nuestro objetivo Id=${p.KilledId} lo mató otro (KillerId=${p.KillerId})`);
    }
  };
  // ExperienceGained (C3 16): KilledObjectId u16 BE @3, AddedExperience u16
  // BE @5. Un kill de más de 65535 llega partido en ~60 packets con el mismo
  // id: ExpSplitTracker los suma para la exp por tipo (farming.ts) y ExpLog
  // los agrega por segundo (no un registro por tramo: ver ExpLog).
  const onExp = (raw: any) => {
    const p = new ExperienceGainedPacket(raw);
    const added = p.AddedExperience;
    const now = Date.now();
    totalExpGained += added;
    meter.addExp(added);
    stayExp += added;
    report.addExp(added, now);
    const ev = expTracker.onExp(p.KilledObjectId & 0x7fff, added, now);
    if (ev.info && !ev.continuation) typeKills[ev.info.type] = (typeKills[ev.info.type] ?? 0) + 1;
    // El spot caliente se pondera por exp: se suma donde estaba el monstruo.
    if (ev.info && ev.info.map === world.map) explorer.onExp(world.map, ev.info.x, ev.info.y, added, now);
    if (process.env.MUBOT_DEBUG_EXP) {
      const what = ev.info ? ` tipo ${ev.info.type}${ev.continuation ? `, kill partido: ${ev.sum}` : ''}` : '';
      log(`+${added} exp${what} (total ${totalExpGained})`);
    }
  };
  EventBus.on('ObjectGotKilled', onKilled);
  EventBus.on('ExperienceGained', onExp);
  EventBus.on('CurrentHealthAndShield', onHp);
  const stopWatchingDrops = watchDrops();
  if (!economyWatched) {
    watchEconomy();
    economyWatched = true;
  }

  const unreachable = new Set<number>();
  let target: number | null = null;
  let stuckCount = 0;
  let lastX = world.x;
  let lastY = world.y;
  // Explorador (explore.ts): spots calientes, salidas del pueblo y mapa seco.
  // Se usa solo cuando no hay campamento (camp.ts) al que ir.
  const explorer = new Explorer(EXPLORE_PREF, EXPLORE, hotGrid);
  let explorerMap: number | null = null;
  let walkStuck = 0;
  let lastGoalTxt = '';
  let ticks = 0;
  const logCampEvents = () => {
    for (const e of camps.events) log(`Campamento: ${e}.`);
    camps.events = [];
  };

  // Un paso hacia (x, y); si no avanza, rodea el obstáculo abriendo de a 45°
  // (alternando lados) y vuelve a la recta.
  const walkTowards = async (x: number, y: number) => {
    const straight = directionTowards(world.x, world.y, x, y);
    const k = Math.ceil(walkStuck / 2);
    const dir = walkStuck === 0 ? straight : (straight + (walkStuck % 2 ? k : 8 - k) + 8) % 8;
    const bx = world.x;
    const by = world.y;
    step(dir);
    await sleep(WALK_PACE_MS);
    walkStuck = world.x === bx && world.y === by ? (walkStuck % 6) + 1 : 0;
    lastX = world.x;
    lastY = world.y;
  };

  // Skill de área con CUALQUIER monstruo a <= CAST_RANGE, aunque esté
  // caminando (Twisting Slash gira alrededor del DK). Respeta SKILL_PACE_MS
  // entre casts y no espera: el paso de caminata sigue en la misma iteración.
  const castOnTheWay = (): boolean => {
    const now = Date.now();
    if (now - lastCastAt < SKILL_PACE_MS) return false;
    const skill = pickAttackSkill();
    if (!skill || !AREA_SKILLS.has(skill.number)) return false;
    if (world.maxMana > 0 && world.mana / world.maxMana < SKILL_MIN_MANA) return false;
    const t = target != null ? npcs.get(target) ?? null : null;
    const c = castCandidate({ x: world.x, y: world.y }, npcs.values(), t, CAMP.CAST_RANGE);
    if (!c) return false;
    sendAreaSkill(skill.index, c.x, c.y, directionTowards(world.x, world.y, c.x, c.y), c.id);
    lastCastAt = now;
    skillsUsed++;
    return true;
  };

  while ((deadline <= 0 || Date.now() < deadline) && !kicked) {
    ticks++;
    {
      const t = Date.now();
      report.addTime(phase, t - phaseAt);
      phaseAt = t;
      phase = 'other';
    }
    // Registro de tramos por ciclo: minuto al llegar a 20/50/100/.../400.
    if (Date.now() - lastCycleCheck >= 2000) {
      lastCycleCheck = Date.now();
      const marks = cycleLog.observe(world.level, lastCycleCheck);
      for (const m of marks) if (m >= 100) log(`Tramo: nivel ${m} al minuto ${cycleLog.cur.marks[m]} del ciclo.`);
      if (marks.length) void persistLearning();
    }
    // Autoevaluación cada ~5 min (con la proyección de resets/día).
    if (Date.now() - lastReport >= REPORT_EVERY_MS) {
      lastReport = Date.now();
      const spotTxt = currentSpot ? `spot ${currentSpot.name} (${Math.round(stayExp / Math.max((lastReport - spotSince) / 60_000, 1e-6))} exp/min)` : 'sin spot';
      const campTxt = camps.camp ? `, campamento (${camps.camp.x},${camps.camp.y}) vara ${Math.round(camps.best[world.map] ?? 0)} exp/min` : '';
      log(report.format(lastReport, world.level, learning.resets, `${kills} kills, ${lootCount} loot, ${spotTxt}${campTxt}`));
      log(`Tramos por ciclo:\n${cycleLog.format()}`);
    }
    // Aprendizaje: cada ~2 min cierra un tramo, lo guarda y muestra la tabla.
    if (LEARN_ENABLED && Date.now() - lastSummary >= LEARN_SUMMARY_MS) {
      lastSummary = Date.now();
      recordSample(meter.flush(lastSummary, world.level));
      await persistLearning();
      logLearningSummary();
    }
    // 0) Reponer pociones cada tanto aunque haya otra acción posible: las
    //    compras son caras de confirmar y no queremos spamearlas.
    if (ticks % 25 === 0 && !haveHealingPotions()) {
      await ensurePotions();
    }
    // 1) Sobrevivir tiene prioridad absoluta.
    if (checkSurvival()) {
      potionsDrunk++;
      await sleep(200);
      continue;
    }

    // 1b) Órdenes del panel. Cambio de modo: soltar el objetivo.
    if (retarget) {
      retarget = false;
      target = null;
      looting = null;
    }
    // En pausa no se hace nada más (las pociones de arriba siguen).
    if (paused) {
      phase = 'wait';
      await sleep(500);
      continue;
    }
    // Orden `warp` pendiente.
    if (pendingWarp) {
      const sp = pendingWarp;
      pendingWarp = null;
      doing = `viajando a ${sp.name}`;
      if (await decide({ kind: 'travel', what: `warp a ${sp.name} por orden del panel (${zenTxt(sp)})`, detail: { warp: sp.index, reason: 'panel' } })) {
        if (!(await warpAndWait(sp))) panelLog(`El warp a ${sp.name} no respondió; sigue fijado y lo reintento.`);
      }
      target = null;
      continue;
    }
    // Cacería: cortar a tiempo (0xFD dice 0 vivos, derrotada, 15 min) y llegar al mapa.
    if (hunting) {
      const h = hunting;
      const nowH = Date.now();
      const stop = shouldStopHunt({ invasion, map: h.hunt.map, since: h.since, now: nowH });
      if (stop) {
        stopHunt(stop);
        target = null;
        continue;
      }
      if (world.map !== h.hunt.map) {
        target = null;
        if (nowH < h.nextWarpAt) {
          await sleep(500);
          continue;
        }
        if (h.warpTries >= 3) {
          stopHunt(`no pude llegar a ${h.hunt.name}`);
          continue;
        }
        h.warpTries++;
        h.nextWarpAt = nowH + WARP_COOLDOWN_MS;
        doing = `viajando a ${h.hunt.name} a cazar dorados`;
        const spot: Spot = { index: h.hunt.warp, name: `cacería ${h.hunt.name}`, reqLevel: h.hunt.reqLevel, zen: 0, map: h.hunt.map };
        if (await decide({ kind: 'travel', what: `warp a ${h.hunt.name} para cazar dorados`, detail: { warp: h.hunt.warp, map: h.hunt.map, reason: 'hunt' } })) {
          // Sin medir: la cacería no es farmeo y ensuciaría el aprendizaje del spot.
          await warpAndWait(spot, false);
        }
        continue;
      }
    }

    // 2) Reset al llegar al nivel: lo más importante para progresar (no a mitad de una cacería).
    if (!hunting && world.level >= RESET_LEVEL && Date.now() >= nextResetTry) {
      if (await doReset()) {
        resets++;
        target = null;
        report.cycleDone(Date.now());
        log(report.format(Date.now(), world.level, learning.resets, 'reset hecho'));
        log(`Tramos por ciclo:\n${cycleLog.format()}`);
      } else {
        nextResetTry = Date.now() + 10 * 60_000;
      }
      continue;
    }

    // 3) Invertir puntos de atributo cuando junte un lote.
    const spent = await investStatPoints();
    if (spent) {
      statPointsSpent += spent;
      continue;
    }

    // 4) Hambre: casi nada de exp en 45 s con jugadores cerca → cambiar YA de
    //    entrada o de mapa (o, si no hay a dónde, de campamento).
    const now0 = Date.now();
    const rivalsNear = [...world.players.values()].filter((q) => chebyshev(q.x, q.y, world.x, world.y) <= CAMP.HUNGER_RIVAL_DIST).length;
    const recentRate = expLog.perMin(now0, CAMP.HUNGER_WINDOW_MS);
    const hungry = hunger.check({ now: now0, tier: routeTier(world.level).minLevel, recentRate, lastWarpAt: lastArrivalAt, rivalsNear });
    if (hungry.starving && now0 - starvingLogged > 15_000) {
      starvingLogged = now0;
      log(`Casi sin exp (${Math.round(recentRate)} exp/min en 45 s, referencia ${Math.round(hungry.ref ?? 0)}) con ${rivalsNear} jugador(es) cerca: cambio de lugar.`);
    }

    // 5) ¿Cambiar de spot? (ruta fija: tramo nuevo, competencia, hambre). Cada
    //    10 ticks, o ya si hay hambre/competencia; respeta WARP_COOLDOWN_MS.
    const crowded = hungry.starving || camps.crowdedSpot(now0);
    // Cazando no se cambia de spot: manda la cacería.
    if (!hunting && (ticks % 10 === 0 || crowded || !currentSpot)) {
      const moved = await maybeChangeSpot({ crowded });
      if (moved) {
        target = null;
        continue;
      }
      if (hungry.starving && camps.camp && now0 - camps.camp.since > CAMP.HUNGER_WINDOW_MS) {
        // No hay otra entrada/mapa: al menos cambiar de campamento.
        camps.leave(now0, world.level, 'hambre con jugadores cerca', true, expLog);
        logCampEvents();
        target = null;
      }
    }

    // 6) Desviar inventario antes de llenarse.
    if (inventoryPressure() > SELL_AT_PRESSURE) {
      doing = 'vendiendo basura';
      await sellJunkToMerchant();
      continue;
    }

    // 7) Loot valioso (cajas, joyas, excelentes, guantes 10/1), PERO no si ya
    //    hay un objetivo a distancia de golpe (bug real: en una zona con mucho
    //    drop acumulado el bot se quedaba recogiendo y nunca peleaba).
    const targetInMeleeRange =
      target != null && npcs.has(target) && chebyshev(world.x, world.y, npcs.get(target)!.x, npcs.get(target)!.y) <= 1;
    if (!targetInMeleeRange && (await lootStep())) {
      phase = 'walk';
      doing = `levantando loot en ${mapName(world.map)}`;
      continue;
    }

    // 8) Elegir / mantener objetivo: campamento (camp.ts) + exp/s (farming.ts).
    if (target != null && !npcs.has(target)) target = null;
    if (hunting) {
      // Cacería: el dorado más cercano siempre manda (aunque estemos pegándole a
      // otro); a los comunes solo si están a HUNT_NORMAL_RANGE (no frenan la búsqueda).
      const now = Date.now();
      let gold: ScopedNpc | null = null;
      let gd = Infinity;
      for (const n of npcs.values()) {
        if (!isGolden(n) || unreachable.has(n.id)) continue;
        const d = chebyshev(world.x, world.y, n.x, n.y);
        if (d < gd) {
          gd = d;
          gold = n;
        }
      }
      if (gold && target !== gold.id) {
        if (!hunting.seen.has(gold.id)) {
          hunting.seen.add(gold.id);
          panelLog(`Cacería: ${monsterName(gold.type)} a ${gd} tiles en (${gold.x},${gold.y}).`);
        }
        target = gold.id;
        targetType = gold.type;
        targetSince = now;
        stuckCount = 0;
      } else if (target != null) {
        const t = npcs.get(target)!;
        if (!isGolden(t) && chebyshev(world.x, world.y, t.x, t.y) > HUNT_NORMAL_RANGE) target = null;
      }
      if (target == null) {
        let near: ScopedNpc | null = null;
        let nd = Infinity;
        for (const n of npcs.values()) {
          if (unreachable.has(n.id)) continue;
          const d = chebyshev(world.x, world.y, n.x, n.y);
          if (d <= HUNT_NORMAL_RANGE && d < nd) {
            nd = d;
            near = n;
          }
        }
        if (near) {
          target = near.id;
          targetType = near.type;
          targetSince = now;
          stuckCount = 0;
        }
      }
    } else if (target == null) {
      const now = Date.now();
      const pick = camps.pick({
        now,
        map: world.map,
        me: { x: world.x, y: world.y },
        level: world.level,
        monsters: [...npcs.values()].filter((n) => !unreachable.has(n.id)),
        players: [...world.players.values()],
        stats: typeStats,
        exp: expLog,
        typeKills,
      });
      logCampEvents();
      if (pick) {
        target = pick.id;
        targetType = pick.type;
        targetSince = now;
        stuckCount = 0;
        if (process.env.MUBOT_DEBUG_COMBAT) log(`DEBUG objetivo: Id=${target} tipo=${targetType} en (${pick.x},${pick.y})`);
      }
    }
    // El reloj de mapa vacío corre desde la llegada, aunque el explorador
    // todavía no haya tenido que elegir a dónde caminar (había campamento).
    if (explorerMap !== world.map) {
      explorerMap = world.map;
      explorer.enterMap(world.map, world.x, world.y, Date.now());
    }
    if (npcs.size) explorer.sawMonster(Date.now());

    if (target != null) {
      const t = npcs.get(target)!;
      const dist = chebyshev(world.x, world.y, t.x, t.y);
      if (process.env.MUBOT_DEBUG_COMBAT && ticks % 5 === 0) {
        log(`DEBUG combate: target=${target} yo=(${world.x},${world.y}) target_pos=(${t.x},${t.y}) dist=${dist} stuck=${stuckCount}`);
      }
      phase = 'fight';
      doing = `${hunting ? 'cazando: ' : ''}peleando con ${monsterName(t.type)} en ${mapName(world.map)} (${world.x},${world.y})`;
      if (dist <= 1) {
        // A distancia de golpe: skill si hay (respetando SKILL_PACE_MS desde el
        // último cast, también los del camino), si no el hit normal.
        const sinceCast = Date.now() - lastCastAt;
        if (sinceCast < SKILL_PACE_MS && pickAttackSkill()) {
          await sleep(SKILL_PACE_MS - sinceCast);
          continue;
        }
        if (useSkill(target)) {
          lastCastAt = Date.now();
          skillsUsed++;
          await sleep(SKILL_PACE_MS);
        } else {
          sendHit(target, directionTowards(world.x, world.y, t.x, t.y));
          await sleep(ATTACK_PACE_MS);
        }
        continue;
      }
      if (stuckCount >= 8) {
        log(`Objetivo ${target} inalcanzable, lo abandono.`);
        unreachable.add(target);
        target = null;
        stuckCount = 0;
        continue;
      }
      // Girar con lo que esté a <= 3 mientras se acerca (no frena la caminata).
      castOnTheWay();
      const straight = directionTowards(world.x, world.y, t.x, t.y);
      const dir = stuckCount >= 3 ? (straight + 2 + (stuckCount % 4)) % 8 : straight;
      step(dir);
      await sleep(WALK_PACE_MS);
      if (world.x === lastX && world.y === lastY) stuckCount++;
      else stuckCount = 0;
      lastX = world.x;
      lastY = world.y;
      continue;
    }

    // 9) Sin objetivo.
    //  a) Mapa vacío DRY_MAP_MS (90 s): la ruta fija pasa a otra entrada del
    //     tramo (o se queda si no hay); el spot queda excluido un rato.
    const now = Date.now();
    //  0) Cacería: recorrer el mapa en celdas de 25 tiles (panel-logic.ts).
    if (hunting) {
      const g = hunting.explorer.next(world.x, world.y, now);
      goalPoint = [g.x, g.y];
      doing = `cazando dorados en ${hunting.hunt.name}: recorro la celda (${g.x},${g.y})`;
      phase = 'walk';
      castOnTheWay();
      await walkTowards(g.x, g.y);
      continue;
    }
    if (explorer.isDry(now)) {
      const where = currentSpot?.name ?? `map ${world.map}`;
      log(`Mapa sin monstruos hace ${EXPLORE.DRY_MAP_MS / 1000} s en ${where}: busco otro spot.`);
      if (currentSpot) {
        dryAt.set(currentSpot.index, now);
        // Corta el tramo ya: queda como muestra (0 exp) aunque después no se warpee.
        recordSample(meter.flush(now, world.level));
      }
      const moved = await maybeChangeSpot({ mapDead: true });
      if (!moved) {
        log('No hay otro spot elegible (o se rechazó el warp): sigo explorando acá.');
        explorer.resetDry(Date.now());
      }
      continue;
    }
    //  b) Campamento (actual, memoria, arranque) o volver a la correa.
    const cg = camps.goal(now, world.map, { x: world.x, y: world.y }, world.level, expLog);
    logCampEvents();
    if (cg) {
      const txt = `${cg.kind} (${cg.x},${cg.y})`;
      if (txt !== lastGoalTxt) {
        lastGoalTxt = txt;
        log(`Voy a ${txt} desde (${world.x},${world.y}) map=${world.map}.`);
      }
      goalPoint = [cg.x, cg.y];
      if (chebyshev(world.x, world.y, cg.x, cg.y) <= 2) {
        // En el campamento esperando el respawn: sin packets.
        doing = `acampando en ${mapName(world.map)} (${cg.x},${cg.y})`;
        phase = 'wait';
        await sleep(500);
        continue;
      }
      phase = 'walk';
      doing = `yendo al ${cg.kind === 'camp' ? 'campamento' : 'punto de llegada'} (${cg.x},${cg.y}) en ${mapName(world.map)}`;
      castOnTheWay();
      await walkTowards(cg.x, cg.y);
      continue;
    }
    //  c) Explorador: spots calientes (<= 30 tiles, dentro de la correa) y,
    //     sin ellos, salidas del pueblo (o alrededor de la llegada si hay correa).
    explorer.setLeash(camps.leashFor(world.map));
    const act = explorer.tick(world.map, world.x, world.y, now);
    for (const e of explorer.events) {
      const g = e.goal;
      const txt = {
        'hot-empty': `spot caliente (${g.x},${g.y}) vacío, lo marco y sigo`,
        'hot-timeout': `no llego al spot caliente (${g.x},${g.y}), lo marco vacío`,
        'exit-abandoned': `salida (${g.x},${g.y}) sin monstruos tras esperar, pruebo la siguiente`,
        'exit-timeout': `no llego a la salida (${g.x},${g.y}), pruebo la siguiente`,
      }[e.kind];
      log(`Explorar: ${txt}.`);
    }
    {
      const g = act.goal;
      const txt = g.kind === 'hot' ? `spot caliente (${g.x},${g.y})` : `salida #${g.index + 1}/${explorer.exitList.length} (${g.x},${g.y})`;
      if (txt !== lastGoalTxt) {
        lastGoalTxt = txt;
        log(`Explorar: voy a ${txt}${g.kind === 'hot' ? `, ${Math.round(explorer.hot.get(world.map, g.cx, g.cy)?.exp ?? 0)} exp acumulada ahí` : ''} desde (${world.x},${world.y}) map=${world.map}.`);
      }
    }
    phase = act.action === 'wait' ? 'wait' : 'walk';
    goalPoint = [act.goal.x, act.goal.y];
    doing = `explorando ${mapName(world.map)}: ${act.goal.kind === 'hot' ? 'spot caliente' : 'salida'} (${act.goal.x},${act.goal.y})`;
    if (act.action === 'wait') {
      // Parado mirando: sin packets, solo deja correr el tick (si aparece un
      // monstruo, el paso 8 lo toma).
      await sleep(500);
      continue;
    }
    castOnTheWay();
    await walkTowards(act.x, act.y);
  }

  EventBus.off('ObjectGotKilled', onKilled);
  EventBus.off('ExperienceGained', onExp);
  EventBus.off('CurrentHealthAndShield', onHp);
  stopWatchingDrops();
  if (LEARN_ENABLED) {
    // Cierra el tramo y guarda.
    endStint();
    await persistLearning();
    logLearningSummary();
  }
  drops.clear();
  looting = null;

  log(report.format(Date.now(), world.level, learning.resets, kicked ? 'conexión cortada' : 'fin'));
  log(`Tramos por ciclo:\n${cycleLog.format()}`);
  log(`\nFin del loop: ${kills} kill(s), +${totalExpGained} exp, ${potionsDrunk} pocion(es), ${statPointsSpent} stat(s), ${skillsUsed} skill(s), ${resets} reset(s), ${deaths} muerte(s).`);
  log(`Posición final (${world.x},${world.y}) map=${world.map}. Desconectado: ${kicked}`);
  return { kills, totalExpGained, potionsDrunk, statPointsSpent, skillsUsed, resets, deaths };
}

// ---------------------------------------------------------------------------
// Main: una sesión por conexión. Si se corta (kick, red, timeout), reconecta
// con backoff y retoma el ciclo desde el estado REAL: login → elegir personaje
// → leer nivel/mapa/puntos (CharacterInformation) → la ruta fija adopta el
// mapa si ya está en el del tramo, o warpea; a nivel 400 resetea. Nunca hay
// dos sesiones a la vez: se reconecta solo con la anterior ya cerrada.
// ---------------------------------------------------------------------------
class LoginError extends Error {
  constructor(readonly result: number) {
    super(`Login falló: ${LoginResponseLoginResultEnum[result] ?? result}`);
  }
}
// Errores de login que no se arreglan reintentando.
const FATAL_LOGIN = new Set<number>([
  LoginResponseLoginResultEnum.InvalidPassword,
  LoginResponseLoginResultEnum.AccountInvalid,
  LoginResponseLoginResultEnum.AccountBlocked,
  LoginResponseLoginResultEnum.WrongVersion,
]);

let worldTracked = false;
let economyWatched = false;

function closeSockets() {
  try { csSocket?.close(); } catch {}
  try { gsSocket?.close(); } catch {}
}

function clearScope() {
  world.npcs.clear();
  world.townNpcs.clear();
  world.players.clear();
  drops.clear();
  looting = null;
  openedNpcId = null;
  currentSpot = null;
  meter.stop();
  inGameAt = 0;
  doing = 'conectando';
  goalPoint = null;
}

async function session(first: boolean, deadline: number): Promise<LoopResult> {
  kicked = false;
  clearScope();
  await connectToConnectServer();
  const { ip, port } = await getGameServerAddress();
  await connectToGameServer(ip, port);
  // A partir de acá el server empieza a mandar el estado del mundo, así que
  // enganchamos el tracker ANTES de seleccionar personaje para no perder
  // SkillListUpdate / CharacterInventory, que llegan justo después del login.
  // Una sola vez: los handlers del EventBus sobreviven a la reconexión.
  if (!worldTracked) {
    trackWorld();
    trackPanelPackets();
    worldTracked = true;
  }
  const { startX, startY } = await loginAndSelectCharacter();

  if (first && args.has('--probe-dir')) {
    const dir = parseInt(args.get('--probe-dir')!);
    log(`\n--- Modo prueba: UN solo WalkRequest, dirección ${dir}, desde (${startX},${startY}) ---`);
    sendToGS(buildWalkPacket(startX, startY, [dir]).buffer);
    await sleep(800);
    console.log(`\n=== Resumen (modo prueba) ===`);
    console.log(`Se mandó 1 paquete válido, dirección ${dir}. Revisá la DB para ver si la posición cambió.`);
    gsSocket?.close();
    process.exit(0);
  }

  if (first) {
    const warp = args.get('--warp') ? parseInt(args.get('--warp')!) : null;
    if (warp != null) {
      const spot = WARP_SPOTS.find((sp) => sp.index === warp) ?? { index: warp, name: `warp ${warp}`, reqLevel: 0, zen: 0 };
      await warpAndWait(spot);
    }
    const moveTo = args.get('--move');
    if (moveTo) await moveToMap(moveTo);
  }
  // Damos un par de segundos a que lleguen skill list, inventario y NPCs
  // en scope antes de que el loop empiece a decidir.
  await sleep(2000);
  return autonomousLoop(deadline);
}

async function main() {
  console.log(`\nBot headless contra proxy=${PROXY} connectServer=${CS_HOST}:${CS_PORT}`);
  console.log(`Cuenta=${USERNAME} Personaje=${CHAR_NAME}\n`);

  const wsPortArg = args.get('--ws-port');
  if (wsPortArg) {
    const wsPort = parseInt(wsPortArg);
    statusServer = startStatusServer({ port: wsPort });
    statusServer.onCommand(handlePanelCommand);
    log(`Panel en http://127.0.0.1:${wsPort}/panel (WebSocket ws://127.0.0.1:${wsPort}, solo esta máquina)`);
    setInterval(() => {
      const now = Date.now();
      updateTrail(now);
      noteModeChange();
      statusServer?.broadcastState(snapshotWorld());
      statusServer?.broadcastPanelState(buildPanelState(now));
    }, 1000);
    setInterval(pollEvents, EVENT_POLL_TICK_MS);
  }

  // Lo aprendido (memoria de campamentos, ciclos, tipos) antes de entrar: la
  // llegada al mundo ya usa la memoria de campamentos.
  await loadLearningState();

  // Keepalives como el cliente web (ver sendPing/sendEcho). sendToGS no
  // manda nada si el socket está cerrado.
  setInterval(() => !kicked && sendPing(), 5000);
  setInterval(() => !kicked && sendEcho(), 2000);

  const autoSeconds = parseInt(args.get('--auto-seconds') ?? '600');
  const deadline = autoSeconds > 0 ? Date.now() + autoSeconds * 1000 : 0;
  const total: LoopResult = { kills: 0, totalExpGained: 0, potionsDrunk: 0, statPointsSpent: 0, skillsUsed: 0, resets: 0, deaths: 0 };
  const backoff = new Backoff();
  let first = true;
  let sessions = 0;
  while (true) {
    const t0 = Date.now();
    let alreadyConnected = false;
    try {
      sessions++;
      const r = await session(first, deadline);
      for (const k of Object.keys(total) as Array<keyof LoopResult>) total[k] += r[k];
    } catch (e) {
      if (e instanceof LoginError && FATAL_LOGIN.has(e.result)) {
        console.error(`${e.message}: no reintento.`);
        closeSockets();
        process.exit(1);
      }
      alreadyConnected = e instanceof LoginError && e.result === LoginResponseLoginResultEnum.AccountAlreadyConnected;
      log(`Sesión #${sessions} terminó con error: ${(e as Error).message}`);
    }
    first = false;
    closeSockets();
    if (deadline && Date.now() >= deadline) break;
    const wait = backoff.next(Date.now() - t0, alreadyConnected);
    if (deadline && Date.now() + wait >= deadline) break;
    log(`Reconecto en ${Math.round(wait / 1000)} s (sesión #${sessions} duró ${Math.round((Date.now() - t0) / 1000)} s).`);
    await sleep(wait);
  }

  console.log(`\n=== Resumen ===`);
  console.log(`Duración: ${autoSeconds}s, ${sessions} sesión(es), sin GUI, ritmo humano.`);
  console.log(`Kills: ${total.kills}  Exp: ${total.totalExpGained}  Pociones: ${total.potionsDrunk}`);
  console.log(`Puntos repartidos: ${total.statPointsSpent}  Skills usadas: ${total.skillsUsed}  Resets: ${total.resets}  Muertes: ${total.deaths}`);
  console.log(`Stats finales: ${STAT_ORDER.map((s) => `${s}=${world.stats[s]}`).join(' ')}`);
  console.log(`Skills conocidos: ${[...world.skills.values()].map((s) => `${s.number}(lv${s.level})`).join(', ') || 'ninguno'}`);
  closeSockets();
  process.exit(0);
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
