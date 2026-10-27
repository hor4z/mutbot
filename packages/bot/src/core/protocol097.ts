/**
 * Helpers de protocolo 0.97d sin estado (parsers y builders a mano) y la
 * política de reconexión. Están fuera de `headless-bot.ts` para poder
 * testearlos offline (`packet-tests.ts`): importar el bot lo arranca.
 */

const u8 = (raw: Uint8Array | DataView | ArrayBuffer): Uint8Array =>
  raw instanceof Uint8Array ? raw : raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);

// ---------------------------------------------------------------------------
// Party: se acepta toda invitación y el bot pide party a los jugadores que tiene cerca (brain/party.ts).
// PartyRequest (C1 05 40) trae el id del que invita en el byte 3 (BE). La respuesta es
// PartyInviteResponse C1 06 41 <aceptado 0/1> <id BE>, como la manda el agente web (con un respiro
// humano de 0.6-1.5 s antes de contestar, que pone el bot). Invitar: PartyInviteRequest C1 05 40 <id BE>.
// ---------------------------------------------------------------------------
export function parsePartyRequest(raw: Uint8Array | DataView | ArrayBuffer): number | null {
  const b = u8(raw);
  if (b.length < 5) return null;
  return ((b[3] << 8) | b[4]) & 0x7fff;
}

export function buildPartyDecline(requesterId: number): Uint8Array {
  return Uint8Array.from([0xc1, 0x06, 0x41, 0x00, (requesterId >> 8) & 0xff, requesterId & 0xff]);
}

export function buildPartyAccept(requesterId: number): Uint8Array {
  return Uint8Array.from([0xc1, 0x06, 0x41, 0x01, (requesterId >> 8) & 0xff, requesterId & 0xff]);
}

/** Pedir party a un jugador: C1 05 40 <id BE>. */
export function buildPartyInvite(targetId: number): Uint8Array {
  return Uint8Array.from([0xc1, 0x05, 0x40, (targetId >> 8) & 0xff, targetId & 0xff]);
}

/** Respiro humano antes de contestar una invitación (ms). */
export const PARTY_DECLINE_DELAY_MS: readonly [number, number] = [600, 1500];

// ---------------------------------------------------------------------------
// ItemDropRemoved (C2 21): count en [4], ids u16 BE desde [5] (2 bytes c/u).
// Un drop que levantó otro o que expiró: sin esto el bot iba a buscarlo.
// ---------------------------------------------------------------------------
export function parseItemDropRemoved(raw: Uint8Array | DataView | ArrayBuffer): number[] {
  const b = u8(raw);
  const count = b[4] ?? 0;
  const out: number[] = [];
  for (let i = 0; i < count && 5 + i * 2 + 1 < b.length; i++) out.push(((b[5 + i * 2] << 8) | b[6 + i * 2]) & 0x7fff);
  return out;
}

// ItemData de 12 bytes: opciones excelentes en los 6 bits bajos del byte 3
// (ReadExcellentOption del itemSerializer del cliente).
export function isExcellentItemData(itemData: Uint8Array): boolean {
  return itemData.length > 3 && (itemData[3] & 0x3f) !== 0;
}

// ---------------------------------------------------------------------------
// Reconexión: backoff exponencial con tope. Una sesión que duró más de
// HEALTHY_MS vuelve a empezar desde el primer escalón. Nunca hay dos sesiones
// a la vez: se reconecta solo cuando la anterior ya se cerró.
// ---------------------------------------------------------------------------
export const RECONNECT = {
  BASE_MS: 5_000,
  MAX_MS: 5 * 60_000,
  HEALTHY_MS: 5 * 60_000,
  // La cuenta figura conectada (sesión vieja todavía abierta del lado server):
  // esperar más antes de reintentar.
  ALREADY_CONNECTED_MS: 60_000,
} as const;

export class Backoff {
  private attempt = 0;

  constructor(private readonly p = RECONNECT) {}

  // Terminó una sesión que duró `sessionMs`: cuánto esperar antes de la próxima.
  next(sessionMs: number, alreadyConnected = false): number {
    if (sessionMs >= this.p.HEALTHY_MS) this.attempt = 0;
    const ms = Math.min(this.p.MAX_MS, this.p.BASE_MS * 2 ** this.attempt);
    this.attempt++;
    return alreadyConnected ? Math.max(ms, this.p.ALREADY_CONNECTED_MS) : ms;
  }
}

// 0x15 S2C: en el XML (season 6) es ObjectMoved, C1 de 8 bytes (id, x, y). Este server 0.97d manda con
// el MISMO código el daño de un golpe (ObjectHit, C1 de 10 bytes: id, daño u16 BE, tipo). Leerlo como
// movimiento ponía al monstruo golpeado en (daño >> 8, daño & 255): Horaz quedaba tirando skills a un
// lugar vacío sin matar nada (2026-10-11). Solo es movimiento si mide 8.
export function isObjectMovedPacket(raw: Uint8Array | DataView | ArrayBuffer): boolean {
  const b = u8(raw);
  return b.length === 8 && b[0] === 0xc1 && b[2] === 0x15;
}

/**
 * El 0x15 de 10 bytes (ObjectHit 0.97d): daño de un golpe sobre un objeto, id u16 BE @3 y daño u16 BE @5.
 * Solo para estadísticas (`dragon_fight`); null si no mide 10. Layout sin verificar contra bytes reales.
 */
export function parseHitDamage(raw: Uint8Array | DataView | ArrayBuffer): { id: number; damage: number } | null {
  const b = u8(raw);
  if (b.length !== 10 || b[0] !== 0xc1 || b[2] !== 0x15) return null;
  return { id: ((b[3] << 8) | b[4]) & 0x7fff, damage: (b[5] << 8) | b[6] };
}

/**
 * ObjectHitExtended (C1 16 11, docs/Packets/C1-11-ObjectHitExtended de OpenMU): el server lo manda cuando YO pego
 * (o me pegan) e incluye la vida que le queda al blanco: es la barra roja del cliente. Byte 3 = tipo de daño (bits
 * bajos), id u16 LITTLE endian @4, vida restante @6 en fracciones de 1/250, escudo @7, daño u32 LE @8 y daño al
 * escudo u32 LE @12. null si no es ese paquete. Sin verificar contra bytes reales (ver las líneas RAW del log).
 */
export function parseHitExtended(raw: Uint8Array | DataView | ArrayBuffer): { kind: number; id: number; healthStatus: number; shieldStatus: number; damage: number } | null {
  const b = u8(raw);
  if (b.length !== 16 || b[0] !== 0xc1 || b[2] !== 0x11) return null;
  return { kind: b[3] & 0x0f, id: (b[4] | (b[5] << 8)) & 0x7fff, healthStatus: b[6], shieldStatus: b[7], damage: (b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)) >>> 0 };
}

// ---------------------------------------------------------------------------
// Ítems. Este server manda casi todos los ítems en 5 bytes (formato clásico 0.97); el cliente web los
// convierte a 12 antes de leerlos. Confirmado con bytes reales de Horaz (2026-10-11): inventario y
// drops de ítems en 5 bytes; los drops de zen (14/15) en el formato de 12.
//   5 bytes: r = e[0] | (e[3] & 0x80) << 1 → grupo r >> 5, número r & 31; nivel (+N) en los bits 3-6
//            de e[1]; opciones excelentes en los 6 bits bajos de e[3]; e[2] = durabilidad.
//   6 bytes (desde la armonía, 2026-10-23): los 5 de antes más e[5] = armonía; e[4] & 0x10 es el bit 5
//            del número y e[4] & 0x20 la opción 380 (función `x` del adaptador 0.97d del cliente).
//   12 bytes (itemSerializer del cliente): número e[0], grupo nibble alto de e[5], nivel igual.
// ---------------------------------------------------------------------------
export type ItemInfo = { group: number; num: number; level: number; excellent: boolean };
export type ItemSlot = ItemInfo & { slot: number; raw?: Uint8Array };
export type ItemDrop = ItemInfo & { id: number; x: number; y: number };

export function decodeItem5(e: Uint8Array): ItemInfo {
  const r = e[0] | ((e[3] & 0x80) << 1);
  return { group: r >> 5, num: (r & 31) | ((e[4] & 0x10) << 1), level: (e[1] >> 3) & 0x0f, excellent: (e[3] & 0x3f) !== 0 };
}

/**
 * Todo lo que trae un ítem de 5/6 bytes (para decidir el set): misma lectura que el adaptador 0.97d del
 * cliente (`x`) + su deserializador de 12 bytes. e[1]: nivel bits 3-6, skill bit 7, luck bit 2, opción
 * bits 0-1 (+4 con e[3] & 0x40); e[3] & 0x3f excelentes; e[4] & 0x0f ancient, & 0x20 opción 380;
 * e[5] armonía (opción en el nibble alto, nivel en el bajo).
 */
export type ItemDetail = ItemInfo & { durability: number; skill: boolean; luck: boolean; option: number; excFlags: number; excCount: number; ancient: number; opt380: boolean; harmony: { option: number; level: number } | null };
export function decodeItemDetail(e: Uint8Array): ItemDetail {
  const base = e.length >= 12 ? decodeItem12(e) : decodeItem5(e);
  const excFlags = e.length >= 12 ? e[3] & 0x3f : e[3] & 0x3f;
  const h = e.length === 6 ? e[5] : 0;
  return {
    ...base,
    durability: e[2],
    skill: (e[1] & 0x80) !== 0,
    luck: (e[1] & 0x04) !== 0,
    option: (e[1] & 0x03) + ((e[3] & 0x40) ? 4 : 0),
    excFlags,
    excCount: [0, 1, 2, 3, 4, 5].filter((i) => excFlags & (1 << i)).length,
    ancient: e.length >= 5 ? e[4] & 0x0f : 0,
    opt380: e.length >= 5 && (e[4] & 0x20) !== 0,
    harmony: h >> 4 ? { option: h >> 4, level: h & 0x0f } : null,
  };
}

export function decodeItem12(e: Uint8Array): ItemInfo {
  return { group: e[5] >> 4, num: e[0], level: (e[1] >> 3) & 0x0f, excellent: isExcellentItemData(e) };
}

/** Largo de cada ítem según el largo del paquete: `header + count * (prefix + item)`; 0 = no cuadra. */
function itemSize(total: number, header: number, count: number, prefix: number): 5 | 6 | 12 | 0 {
  if (total === header + count * (prefix + 6)) return 6;
  if (total === header + count * (prefix + 5)) return 5;
  if (total === header + count * (prefix + 12)) return 12;
  return 0;
}
const decode = (size: 5 | 6 | 12, e: Uint8Array) => (size === 12 ? decodeItem12(e) : decodeItem5(e));

/** CharacterInventory (C4 F3 10): count en el byte 5, después [slot][ítem]. null = largo inesperado. */
export function parseInventory(raw: Uint8Array | DataView | ArrayBuffer): ItemSlot[] | null {
  const b = u8(raw);
  const count = b[5] ?? 0;
  const size = itemSize(b.length, 6, count, 1);
  if (!size) return null;
  const out: ItemSlot[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * (1 + size);
    const e = b.subarray(o + 1, o + 1 + size);
    out.push({ slot: b[o], ...decode(size, e), ...(size !== 12 ? { raw: e.slice() } : {}) });
  }
  return out;
}

/** ItemsDropped (C2 20): count en el byte 4, después [id u16 BE][x][y][ítem]. null = largo inesperado. */
export function parseItemsDropped(raw: Uint8Array | DataView | ArrayBuffer): ItemDrop[] | null {
  const b = u8(raw);
  const count = b[4] ?? 0;
  const size = count > 0 ? itemSize(b.length, 5, count, 4) : 0;
  if (!size) return null;
  const out: ItemDrop[] = [];
  for (let i = 0; i < count; i++) {
    const o = 5 + i * (4 + size);
    out.push({ id: ((b[o] << 8) | b[o + 1]) & 0x7fff, x: b[o + 2], y: b[o + 3], ...decode(size, b.subarray(o + 4, o + 4 + size)) });
  }
  return out;
}

/** ItemAddedToInventory (C3 22): slot en el byte 3, ítem desde el 4 (5, 6 o 12 bytes). */
export function parseItemAdded(raw: Uint8Array | DataView | ArrayBuffer): ItemSlot | null {
  const b = u8(raw);
  if (b.length >= 4 + 12) return { slot: b[3], ...decodeItem12(b.subarray(4, 16)) };
  if (b.length >= 4 + 6) return { slot: b[3], ...decodeItem5(b.subarray(4, 10)), raw: b.slice(4, 10) };
  if (b.length >= 4 + 5) return { slot: b[3], ...decodeItem5(b.subarray(4, 9)), raw: b.slice(4, 9) };
  return null;
}

// ---------------------------------------------------------------------------
// Chat. S2C ChatMessage: C1 len <tipo> <remitente[10]> <mensaje>; el tipo es el mismo byte del code:
// 0x00 normal (público, party, guild) y 0x02 susurro (por eso el susurro llega por la ruta de 0x02).
// ServerMessage: C1 len 0D <tipo> <mensaje> (0 dorado al centro, 1 azul, 2 aviso de guild).
// C2S: PublicChatMessage C1 len 00 <nombre[10]> <mensaje> (party con "~", guild con "@", comandos con
// "/"); WhisperMessage C1 len 02 <destino[10]> <mensaje>. Texto en latin1, sin terminador.
// Party/guild se reconocen por el prefijo del mensaje: sin verificar contra el server.
// ---------------------------------------------------------------------------
export type ChatKind = 'normal' | 'party' | 'guild' | 'whisper' | 'server';
export type ChatLine = { kind: ChatKind; from: string; text: string };

/** Texto hasta el primer 0: UTF-8 si es válido (OpenMU usa UTF-8), si no latin1 (cliente clásico). */
const utf8 = new TextDecoder('utf-8', { fatal: true });
function latin1(b: Uint8Array): string {
  const end = b.indexOf(0);
  const t = end >= 0 ? b.subarray(0, end) : b;
  try {
    return utf8.decode(t);
  } catch {
    return Buffer.from(t).toString('latin1');
  }
}

export function parseChatMessage(raw: Uint8Array | DataView | ArrayBuffer): ChatLine | null {
  const b = u8(raw);
  if (b[0] !== 0xc1 || b.length < 13 || (b[2] !== 0x00 && b[2] !== 0x02)) return null;
  const from = latin1(b.subarray(3, 13));
  const text = latin1(b.subarray(13));
  if (b[2] === 0x02) return { kind: 'whisper', from, text };
  if (text.startsWith('~')) return { kind: 'party', from, text: text.slice(1) };
  if (text.startsWith('@')) return { kind: 'guild', from, text: text.replace(/^@+/, '') };
  return { kind: 'normal', from, text };
}

export function parseServerMessage(raw: Uint8Array | DataView | ArrayBuffer): ChatLine | null {
  const b = u8(raw);
  if (b[0] !== 0xc1 || b[2] !== 0x0d || b.length < 5) return null;
  return { kind: 'server', from: '', text: latin1(b.subarray(4)) };
}

/** Máximo de un mensaje de chat (el cliente corta en 60; el largo del C1 tampoco pasa de 255). */
export const CHAT_MAX = 60;

function nameField(name: string): number[] {
  const out = new Array<number>(10).fill(0);
  [...Buffer.from(name, 'latin1').subarray(0, 10)].forEach((c, i) => (out[i] = c));
  return out;
}

// Texto saliente en UTF-8 (lo mismo que se decodifica primero al leer), cortado en CHAT_MAX bytes sin
// partir un carácter.
function chatBytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const b = [...Buffer.from(ch, 'utf8')];
    if (out.length + b.length > CHAT_MAX) break;
    out.push(...b);
  }
  return out;
}

/** Chat público (también party "~", guild "@" y comandos "/"): C1 len 00 <nombre propio[10]> <texto>. */
export function buildPublicChat(myName: string, text: string): Uint8Array {
  const t = chatBytes(text);
  return Uint8Array.from([0xc1, 13 + t.length, 0x00, ...nameField(myName), ...t]);
}

/** Susurro: C1 len 02 <destino[10]> <texto>. */
export function buildWhisper(to: string, text: string): Uint8Array {
  const t = chatBytes(text);
  return Uint8Array.from([0xc1, 13 + t.length, 0x02, ...nameField(to), ...t]);
}

// ---------------------------------------------------------------------------
// Quién me pega (aggro). ObjectAnimation C1 09 18 <atacante u16> <dir> <anim> <objetivo u16> (golpe)
// y SkillAnimation: en 0.97d C3 08 19 <skill u8> <atacante u16> <objetivo u16> (SkillAnimation075/095
// del XML); el de 9 bytes (skill u16, season 6) se acepta por las dudas. El área (0x1E)
// no trae objetivo: daba falsos positivos en el navegador. Devuelve el id del atacante si el objetivo
// soy yo (`me` sin el bit 0x8000), o null.
// ---------------------------------------------------------------------------
// Skills dirigidos que NO son ataques (curar, buffs, teleport): un Elf que cura a Horaz no es un PK.
export const FRIENDLY_SKILLS: ReadonlySet<number> = new Set([6, 16, 26, 27, 28, 48]);

// ---------------------------------------------------------------------------
// 0x11 S2C de 8 bytes en este server: C1 08 11 <id u16 BE> <x> <y> <?> = "estás en (x, y)". Llega
// repetido cuando el server rechaza los pasos (el bot caminó desde una posición equivocada) y lo
// devuelve a su lugar real. Ignorarlo dejaba al bot creyendo que caminaba, con cada paso rechazado,
// clavado en el pueblo sin monstruos cerca ni exp (Horaz y Melu en Lorencia, 2026-10-11). En el XML
// (season 6) el 0x11 es ObjectHit de 10 bytes: por eso se distingue por el largo.
// ---------------------------------------------------------------------------
export function parsePositionFix(raw: Uint8Array | DataView | ArrayBuffer): { id: number; x: number; y: number } | null {
  const b = u8(raw);
  if (b.length !== 8 || b[0] !== 0xc1 || b[2] !== 0x11) return null;
  return { id: ((b[3] << 8) | b[4]) & 0x7fff, x: b[5], y: b[6] };
}

/** TalkToNpcRequest (C3 05 30 <id BE>): abre la ventana del NPC (Baz = baúl; el Chaos Goblin es el NPC 238). */
export function buildTalkNpc(npcId: number): Uint8Array {
  return Uint8Array.from([0xc3, 0x05, 0x30, (npcId >> 8) & 0xff, npcId & 0xff]);
}

/** CloseNpcRequest (C1 03 31): cierra la ventana del NPC (baúl incluido). */
export function buildCloseNpc(): Uint8Array {
  return Uint8Array.from([0xc1, 0x03, 0x31]);
}

