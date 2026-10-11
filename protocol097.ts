/**
 * Helpers de protocolo 0.97d sin estado (parsers y builders a mano) y la
 * política de reconexión. Están fuera de `headless-bot.ts` para poder
 * testearlos offline (`packet-tests.ts`): importar el bot lo arranca.
 */

const u8 = (raw: Uint8Array | DataView | ArrayBuffer): Uint8Array =>
  raw instanceof Uint8Array ? raw : raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);

// ---------------------------------------------------------------------------
// Party: rechazar siempre (pedido del usuario). PartyRequest (C1 05 40) trae el
// id del que invita en el byte 3 (BE). La respuesta es PartyInviteResponse
// C1 06 41 <aceptado=0> <id BE>, como la manda el agente web (con un respiro
// humano de 0.6-1.5 s antes de contestar, que pone el bot).
// ---------------------------------------------------------------------------
export function parsePartyRequest(raw: Uint8Array | DataView | ArrayBuffer): number | null {
  const b = u8(raw);
  if (b.length < 5) return null;
  return ((b[3] << 8) | b[4]) & 0x7fff;
}

export function buildPartyDecline(requesterId: number): Uint8Array {
  return Uint8Array.from([0xc1, 0x06, 0x41, 0x00, (requesterId >> 8) & 0xff, requesterId & 0xff]);
}

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

// ---------------------------------------------------------------------------
// Ítems. Este server manda casi todos los ítems en 5 bytes (formato clásico 0.97); el cliente web los
// convierte a 12 antes de leerlos. Confirmado con bytes reales de Horaz (2026-10-11): inventario y
// drops de ítems en 5 bytes; los drops de zen (14/15) en el formato de 12.
//   5 bytes: r = e[0] | (e[3] & 0x80) << 1 → grupo r >> 5, número r & 31; nivel (+N) en los bits 3-6
//            de e[1]; opciones excelentes en los 6 bits bajos de e[3]; e[2] = durabilidad.
//   12 bytes (itemSerializer del cliente): número e[0], grupo nibble alto de e[5], nivel igual.
// ---------------------------------------------------------------------------
export type ItemInfo = { group: number; num: number; level: number; excellent: boolean };
export type ItemSlot = ItemInfo & { slot: number };
export type ItemDrop = ItemInfo & { id: number; x: number; y: number };

export function decodeItem5(e: Uint8Array): ItemInfo {
  const r = e[0] | ((e[3] & 0x80) << 1);
  return { group: r >> 5, num: r & 31, level: (e[1] >> 3) & 0x0f, excellent: (e[3] & 0x3f) !== 0 };
}

export function decodeItem12(e: Uint8Array): ItemInfo {
  return { group: e[5] >> 4, num: e[0], level: (e[1] >> 3) & 0x0f, excellent: isExcellentItemData(e) };
}

/** Largo de cada ítem según el largo del paquete: `header + count * (prefix + item)`; 0 = no cuadra. */
function itemSize(total: number, header: number, count: number, prefix: number): 5 | 12 | 0 {
  if (total === header + count * (prefix + 5)) return 5;
  if (total === header + count * (prefix + 12)) return 12;
  return 0;
}
const decode = (size: 5 | 12, e: Uint8Array) => (size === 5 ? decodeItem5(e) : decodeItem12(e));

/** CharacterInventory (C4 F3 10): count en el byte 5, después [slot][ítem]. null = largo inesperado. */
export function parseInventory(raw: Uint8Array | DataView | ArrayBuffer): ItemSlot[] | null {
  const b = u8(raw);
  const count = b[5] ?? 0;
  const size = itemSize(b.length, 6, count, 1);
  if (!size) return null;
  const out: ItemSlot[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * (1 + size);
    out.push({ slot: b[o], ...decode(size, b.subarray(o + 1, o + 1 + size)) });
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

/** ItemAddedToInventory (C3 22): slot en el byte 3, ítem desde el 4 (5 o 12 bytes). */
export function parseItemAdded(raw: Uint8Array | DataView | ArrayBuffer): ItemSlot | null {
  const b = u8(raw);
  if (b.length >= 4 + 12) return { slot: b[3], ...decodeItem12(b.subarray(4, 16)) };
  if (b.length >= 4 + 5) return { slot: b[3], ...decodeItem5(b.subarray(4, 9)) };
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

/** Texto latin1 hasta el primer 0 (o el final). */
function latin1(b: Uint8Array): string {
  const end = b.indexOf(0);
  return Buffer.from(end >= 0 ? b.subarray(0, end) : b).toString('latin1');
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

/** Chat público (también party "~", guild "@" y comandos "/"): C1 len 00 <nombre propio[10]> <texto>. */
export function buildPublicChat(myName: string, text: string): Uint8Array {
  const t = [...Buffer.from(text.slice(0, CHAT_MAX), 'latin1')];
  return Uint8Array.from([0xc1, 13 + t.length, 0x00, ...nameField(myName), ...t]);
}

/** Susurro: C1 len 02 <destino[10]> <texto>. */
export function buildWhisper(to: string, text: string): Uint8Array {
  const t = [...Buffer.from(text.slice(0, CHAT_MAX), 'latin1')];
  return Uint8Array.from([0xc1, 13 + t.length, 0x02, ...nameField(to), ...t]);
}

// ---------------------------------------------------------------------------
// Quién me pega (aggro). ObjectAnimation C1 09 18 <atacante u16> <dir> <anim> <objetivo u16> (golpe)
// y SkillAnimation C3 09 19 <skill u16> <atacante u16> <objetivo u16> (skill dirigido). El área (0x1E)
// no trae objetivo: daba falsos positivos en el navegador. Devuelve el id del atacante si el objetivo
// soy yo (`me` sin el bit 0x8000), o null.
// ---------------------------------------------------------------------------
export function attackerOf(raw: Uint8Array | DataView | ArrayBuffer, me: number): number | null {
  const b = u8(raw);
  if (b.length < 9) return null;
  const u16 = (i: number) => ((b[i] << 8) | b[i + 1]) & 0x7fff;
  if (b[2] === 0x18 && u16(7) === me) return u16(3);
  if (b[2] === 0x19 && u16(7) === me) return u16(5);
  return null;
}
