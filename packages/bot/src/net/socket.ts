/**
 * Socket WS (vía proxy WS -> TCP) que corta el stream en packets MU y los emite
 * por nombre en el EventBus.
 *
 * Copia del createSocket del cliente MU JS (src/libs/sockets/createSocket.ts) con
 * la misma resolución: por code, `find(p => p.SubCode == null || p.SubCode === sub)`
 * sobre la tabla completa de packets S2C del repo (packets/routes.ts). El nombre
 * del evento que emite tiene que ser idéntico al del cliente: varias trampas de
 * AGENTS.md dependen de eso (codes compartidos, eventos "con otro nombre").
 *
 * Diferencia: un code que no está en la tabla se emite crudo como
 * 'UnroutedPacket' y se descarta con un log (salvo 0xFD, que es esperado), en
 * vez de tirar una excepción dentro del handler de mensajes.
 */
import { EventBus } from './eventBus';
import { SimpleModulusDecryptor } from './encryption';
import { byteToString, getPacketSize, getSizeOfPacketType } from './utils';
import { S2C_ROUTES, type PacketRoute } from '../packets/routes';

type Options = {
  wsAddress: string;
  tcpIP: string;
  tcpPort: number;
};

const routesByCode: PacketRoute[][] = [];
for (const r of S2C_ROUTES) (routesByCode[r.Code] ??= []).push(r);

const HEADERS = new Set<number>([0xc1, 0xc2, 0xc3, 0xc4]);

const DEBUG_LOG = false;
const INFO_LOG = process.env.MUBOT_PACKET_LOG === '1'; // una línea por paquete: apagado (llenaba el disco); 1 para depurar

const DUMP_CODES = new Set((process.env.DUMP_CODES ?? '').split(',').filter(Boolean).map((h) => parseInt(h, 16)));
const dumped = new Map<number, number>();

/**
 * Corta un stream de bytes del server en packets MU, descifra los C3/C4 y los emite por nombre en el EventBus. `push` recibe los bytes tal cual
 * llegan (un frame puede traer varios packets o la mitad de uno). Lo usan el socket del bot y el modo asistente (extensión).
 */
export function createPacketReader(LOG_PREFIX: string) {
  const decryptor = new SimpleModulusDecryptor();
  decryptor.decryptionKeys = SimpleModulusDecryptor.DefaultClientKey;

  let bytes = new Uint8Array(0);
  function removePacketAndGoNext(length: number) {
    bytes = bytes.slice(length);
    if (bytes.byteLength > 0) handlePacketsQueue();
  }

  function handlePacketsQueue() {
    if (bytes.length < 1) return;

    const packetType = bytes[0];

    if (!HEADERS.has(packetType)) {
      console.error(`${LOG_PREFIX}NOT_MU_PACKET: 0x${byteToString(packetType)}`);
      // Frames de control WS (ping/pong) colados: igual que el cliente, se ignoran.
      if (packetType === 0x89 || packetType === 0x6b) return;
    }

    const packetHeaderSize = getSizeOfPacketType(packetType);
    const length = getPacketSize(bytes);
    let packet: DataView = new DataView(bytes.buffer, 0, length);

    if (packetType >= 0xc3) {
      const [s, decryptedPacket] = decryptor.Decrypt(new Uint8Array(packet.buffer, 0, length));
      if (!s) {
        console.error(`${LOG_PREFIX} can't decrypt packet`);
        removePacketAndGoNext(length);
        return;
      }
      packet = new DataView(decryptedPacket.buffer);
    }

    const codeIndex = packetHeaderSize === 3 ? 3 : 2;
    const packetCode = packet.getUint8(codeIndex);
    // Un paquete de 3 bytes (code sin subcode) tiraba RangeError y mataba al bot (Trainer, 2026-10-25): sin subcode se busca la ruta sin él.
    const subCode = codeIndex + 1 < packet.byteLength ? packet.getUint8(codeIndex + 1) : -1;

    const pDef = routesByCode[packetCode]?.find(p => p.SubCode == null || p.SubCode === subCode);

    // Diagnóstico: DUMP_CODES=11,f6 vuelca en hex los primeros 40 paquetes de esos codes (por code).
    if (DUMP_CODES.has(packetCode) && (dumped.get(packetCode) ?? 0) < 40) {
      dumped.set(packetCode, (dumped.get(packetCode) ?? 0) + 1);
      const u = new Uint8Array(packet.buffer, packet.byteOffset, Math.min(packet.byteLength, length));
      console.log(`${LOG_PREFIX}DUMP 0x${byteToString(packetCode)}: ${[...u].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    if (!pDef) {
      // Packets propios del server que la tabla no conoce (ej. 0xFD, invasión
      // dorada): se emiten crudos como 'UnroutedPacket' para quien los quiera.
      EventBus.emit('UnroutedPacket', packet);
      if (packetCode === 0xfd) {
        removePacketAndGoNext(length);
        return;
      }
      console.error(`${LOG_PREFIX}no packet: 0x` + byteToString(packetCode));
      removePacketAndGoNext(length);
      return;
    }

    INFO_LOG && console.log(
      `${LOG_PREFIX}[${pDef.name}][${pDef.HeaderType}]0x${byteToString(pDef.Code)}${
        pDef.SubCode != null ? `(0x${byteToString(pDef.SubCode)})` : ''
      } lng:${length}`,
    );

    EventBus.emit(pDef.Name, packet);
    removePacketAndGoNext(length);
  }

  return {
    push(newBytes: Uint8Array) {
      bytes = new Uint8Array([...bytes, ...newBytes]);
      handlePacketsQueue();
    },
  };
}

export function createSocket({ wsAddress, tcpIP, tcpPort }: Options) {
  const LOG_PREFIX = `[${tcpIP}:${tcpPort}]`;
  const reader = createPacketReader(LOG_PREFIX);

  const socket = new WebSocket(`${wsAddress}?host=${tcpIP}&port=${tcpPort}`);
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('message', event => {
    const newBytes = new Uint8Array(event.data as ArrayBuffer);
    DEBUG_LOG && console.log(`${LOG_PREFIX}received ${newBytes.length} bytes:`, newBytes);
    reader.push(newBytes);
  });

  socket.addEventListener('open', event => {
    console.log(`${LOG_PREFIX}opened:`, event);
    EventBus.emit('wsOpened', { socket });
  });

  socket.addEventListener('close', event => {
    console.log(`${LOG_PREFIX}closed:`, event);
    EventBus.emit('wsClosed', { socket });
  });

  socket.addEventListener('error', event => {
    console.log(`${LOG_PREFIX}error:`, event);
    EventBus.emit('wsError', { socket, error: (event as ErrorEvent).error });
  });

  return { socket } as const;
}
