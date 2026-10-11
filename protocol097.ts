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
