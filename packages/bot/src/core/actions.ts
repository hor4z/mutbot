/**
 * Packets de salida armados a mano con los códigos REALES de este server (ver AGENTS.md, "Protocolo
 * real, capturado del cliente web"): paso, golpe, skills, keepalives, warp y chat. Sin decisiones:
 * quien llama elige qué y cuándo (a ritmo humano, ver config.ts).
 */
import { sendToGS } from './connection';
import { buildPartyInvite } from './protocol097';
import { isWalkable } from './terrain';
import { world } from './state';
import { DIR_DELTA, log } from './util';

// ---------------------------------------------------------------------------
// Movimiento (mismo encoding que Store.sendWalkPath)
// ---------------------------------------------------------------------------
// Un server 0.95/0.97 no entiende el WalkRequest moderno (code 0xD4): espera el
// WalkRequest075 (code 0x10), que además empuja TargetRotation en el nibble alto
// del mismo byte que StepCount. Con 0xD4 el server ignora el paso en silencio.
// Un packet armado byte a byte, listo para sendToGS.
export function rawPacket(bytes: number[]): DataView {
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

// Manda un paso en una dirección y actualiza la posición estimada.
export function step(dir: number) {
  sendToGS(buildWalkPacket(world.x, world.y, [dir]).buffer);
  const [dx, dy] = DIR_DELTA[dir];
  world.x += dx;
  world.y += dy;
}

// ---------------------------------------------------------------------------
// Packets con los códigos REALES de este server. El cliente web arma packets
// season6 y su adaptador de salida los reescribe antes de mandarlos; los
// parsers de packets/ tienen el código season6, que acá no sirve:
//   HitRequest 0x11 → 0x15          (por eso el bot nunca mataba nada)
//   TargetedSkill/AreaSkill: el skill va como ÍNDICE de la lista, no número.
// ---------------------------------------------------------------------------
let hitAnimToggle = false;
export function sendHit(targetId: number, dir: number) {
  // El cliente alterna Attack1/Attack2 (0x78/0x79) en cada golpe.
  hitAnimToggle = !hitAnimToggle;
  sendToGS(rawPacket([0xc1, 0x07, 0x15, targetId >> 8, targetId, hitAnimToggle ? 0x78 : 0x79, dir]));
}

export function sendTargetedSkill(skillIndex: number, targetId: number) {
  sendToGS(rawPacket([0xc3, 0x06, 0x19, skillIndex, targetId >> 8, targetId]));
}

export function sendAreaSkill(skillIndex: number, x: number, y: number, dir: number, targetId: number) {
  // Rotación en 0..255 (el cliente la saca del ángulo del modelo).
  sendToGS(rawPacket([0xc3, 0x09, 0x1e, skillIndex, x, y, dir * 32, targetId >> 8, targetId]));
}

// Ping (C3 0E/00) cada 5s con el TickCount, como el cliente: el server lo usa
// para su detector de speed hack. AttackSpeed en 0, igual que en la captura.
const botStart = performance.now();
/**
 * Levantar un drop: `C3 05 22 <id BE>` (PickupItemRequest, cifrado), como el cliente web. El bot
 * mandaba PickupItemRequest075 (C1 22) y este server lo ignora en silencio: nunca levantó nada, ni el
 * zen (Hume, 2026-10-12: 15 "Levanto" y el zen en 0).
 */
export function sendPickup(itemId: number) {
  sendToGS(rawPacket([0xc3, 0x05, 0x22, itemId >> 8, itemId]));
}

export function sendPing() {
  const tick = Math.floor(performance.now() - botStart) >>> 0;
  sendToGS(rawPacket([0xc3, 0x0c, 0x0e, 0x00, tick, tick >> 8, tick >> 16, tick >>> 24, 0, 0, 0, 0]));
}

// Eco propio de este server (C1 FB/02) cada 2s; el server contesta PingRelay.
export function sendEcho() {
  sendToGS(rawPacket([0xc1, 0x04, 0xfb, 0x02]));
}

// Menú de warp (C1 8E/02): índice de la lista de movimiento del cliente
// (Lorencia = 2). El server valida nivel y zen.
/** Tirar al suelo el ítem de una casilla de la bolsa, en la posición actual: C1 07 23 x y casilla. */
export function dropItem(slot: number) {
  // El cliente real tira en la casilla de al lado, no encima: se busca una vecina por donde se pueda caminar.
  const near = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => [world.x + dx!, world.y + dy!] as const).find(([x, y]) => isWalkable(world.map, x, y));
  const [x, y] = near ?? [world.x, world.y];
  sendToGS(rawPacket([0xc1, 0x07, 0x23, x, y, slot]));
}

/** Pide party al jugador con ese id (no espera la respuesta: si acepta llega PartyList). */
export function inviteToParty(id: number) {
  sendToGS(new DataView(buildPartyInvite(id).buffer));
}

export function warpTo(warpIndex: number) {
  sendToGS(rawPacket([0xc1, 0x0a, 0x8e, 0x02, 0, 0, 0, 0, warpIndex, warpIndex >> 8]));
  log(`Warp al índice ${warpIndex}`);
}

// Chat público: C1 len 00 <nombre 10 bytes> <texto>. Los comandos del server
// (/add, /reset) viajan por acá.
export function sayChat(name: string, text: string) {
  const nameBytes = new Array<number>(10).fill(0);
  [...Buffer.from(name, 'latin1').subarray(0, 10)].forEach((b, i) => (nameBytes[i] = b));
  const textBytes = [...Buffer.from(text, 'latin1')];
  sendToGS(rawPacket([0xc1, 3 + 10 + textBytes.length, 0x00, ...nameBytes, ...textBytes]));
  log(`Chat: ${text}`);
}
