/**
 * Conexión: sockets al connect server y al game server, cifrado de salida (xor32 del 0.97d +
 * SimpleModulus), espera de packets por nombre de evento y el login. Elegir personaje y entrar al
 * mundo está en world.ts (necesita el tracker del mundo).
 */
import { CS_HOST, CS_PORT, PROXY } from './config';
import { EventBus } from '../net/eventBus';
import { SimpleModulusEncryptor, Xor32Encryptor, Xor3Byte } from '../net/encryption';
import { createSocket } from '../net/socket';
import { stringToBytes } from '../net/utils';
import {
  ConnectionInfoPacket,
  ConnectionInfoRequestPacket,
  GameServerEnteredPacket,
  LoginResponseLoginResultEnum,
  LoginShortPasswordPacket,
  RequestCharacterListPacket,
  ServerListRequestOldPacket,
  ServerListResponseOldPacket,
  ServerListResponsePacket,
} from '../packets';
import { bot } from './state';
import { log } from './util';

// El mundo de mu.mormon.garden está configurado con el perfil de cliente 0.97d
// (V097D), NO season6. Estos son sus bytes de versión y serial: el server valida
// ambos y descarta el login en silencio si no coinciden.
const CLIENT_VERSION = [49, 59, 58, 52, 57]; // "1;:49"
const CLIENT_SERIAL = 'St0n3agemu97d99i';
const MAX_USERNAME_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 10;

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
export const XOR32_KEY_097D = new Uint8Array([
  231, 109, 58, 137, 188, 178, 159, 115, 35, 168, 254, 182, 73, 93, 57, 93,
  138, 203, 99, 141, 234, 125, 43, 95, 195, 177, 233, 131, 41, 81, 232, 86,
]);

export function sendToGS(buffer: DataView) {
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

EventBus.on('wsClosed', (e: any) => {
  // Solo cuenta si es el socket del game server el que se cerró; cerrar
  // nosotros mismos el del connect server al pasar al game server no es un "kick".
  if (gsSocket && e?.socket === gsSocket) {
    bot.kicked = true;
  }
});

/**
 * Modo asistente (attach.ts): el socket del juego es el de la pestaña del navegador del usuario. Lo que se manda con sendToGS sale con el mismo
 * xor32 y el mismo cifrado que usa el bot y se le entrega a `deliver` (la extensión lo escribe en el socket de la página).
 */
export function attachFakeGameSocket(deliver: (bytes: Uint8Array) => void) {
  gsSocket = { readyState: WebSocket.OPEN, send: (d: Uint8Array) => deliver(d) } as unknown as WebSocket;
  gsEncryptor = new SimpleModulusEncryptor();
  gsEncryptor.encryptionKeys = SimpleModulusEncryptor.DefaultClientKey;
}

/** El contador de cifrado (SimpleModulus) sigue al de la página: lo que ella mande a mano ya consumió estos números. */
export function syncGameCounter(next: number) {
  if (gsEncryptor) gsEncryptor.Counter.Count = next & 0xff;
}

/** Un C3 de la página (ya con xor32, descifrado) vuelve a salir con el contador compartido, así lo suyo y lo nuestro hacen una sola secuencia. */
export function resendPageFrame(plain: Uint8Array) {
  if (gsEncryptor) gsSocket?.send(gsEncryptor.Encrypt(plain));
}

export function detachFakeGameSocket() {
  gsSocket = undefined;
}

export function closeSockets() {
  try { csSocket?.close(); } catch {}
  try { gsSocket?.close(); } catch {}
}

export function waitFor<T extends string>(event: T | T[], timeoutMs = 8000): Promise<any> {
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
export async function connectToConnectServer() {
  const { socket } = createSocket({ wsAddress: PROXY, tcpIP: CS_HOST, tcpPort: CS_PORT });
  csSocket = socket;
  await waitFor('Hello');
  log('Connect server: Hello recibido');
}

export async function getGameServerAddress(): Promise<{ ip: string; port: number }> {
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
// 2. Game server: hello -> login -> character list (-> select, en world.ts)
// ---------------------------------------------------------------------------
export async function connectToGameServer(ip: string, port: number) {
  csSocket?.close();
  const { socket } = createSocket({ wsAddress: PROXY, tcpIP: ip, tcpPort: port });
  gsSocket = socket;
  gsEncryptor = new SimpleModulusEncryptor();
  gsEncryptor.encryptionKeys = SimpleModulusEncryptor.DefaultClientKey;

  const bytes = await waitFor('GameServerEntered');
  const p = new GameServerEnteredPacket(bytes);
  bot.playerId = p.PlayerId & 0x7fff;
  log(`Game server: GameServerEntered recibido (playerId=${bot.playerId})`);
}

export function login(username: string, password: string) {
  const usernameBytes = stringToBytes(username, MAX_USERNAME_LENGTH);
  const passwordBytes = stringToBytes(password, MAX_PASSWORD_LENGTH);
  Xor3Byte(usernameBytes);
  Xor3Byte(passwordBytes);

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

export function requestCharacterList() {
  const p = RequestCharacterListPacket.createPacket();
  p.Language = 0;
  sendToGS(p.buffer);
}

export class LoginError extends Error {
  constructor(readonly result: number) {
    super(`Login falló: ${LoginResponseLoginResultEnum[result] ?? result}`);
  }
}
// Errores de login que no se arreglan reintentando.
export const FATAL_LOGIN = new Set<number>([
  LoginResponseLoginResultEnum.InvalidPassword,
  LoginResponseLoginResultEnum.AccountInvalid,
  LoginResponseLoginResultEnum.AccountBlocked,
  LoginResponseLoginResultEnum.WrongVersion,
]);
