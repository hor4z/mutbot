/**
 * Helpers de packet y de bytes. Copia LITERAL de src/common/utils.ts del cliente
 * MU JS (de stringifyPacket a ArrayCopy); lo que quedó afuera es lo de Babylon y
 * descarga de assets, que el bot no usa.
 *
 * No reescribir "más limpio": el cifrado (net/encryption) depende de estas firmas
 * exactas — una versión anterior las tenía distintas y rompía el SimpleModulus.
 */

// like 'C1 04 00 01'
export function stringifyPacket(buffer: Buffer) {
  return Array.from(new Uint8Array(buffer)).map(byteToString).join(' ');
}

export function byteToString(i: number) {
  return i.toString(16).padStart(2, '0').toUpperCase();
}

export function getSizeOfPacketType(packetType: number) {
  switch (packetType) {
    case 0xc1:
    case 0xc3:
      return 2;
    case 0xc2:
    case 0xc4:
      return 3;
    default:
      return 0;
  }
}

export function getPacketHeaderSize(packet: Uint8Array) {
  const t = packet[0];

  return getSizeOfPacketType(t);
}

export function getPacketSize(packet: Uint8Array) {
  switch (packet[0]) {
    case 0xc1:
    case 0xc3:
      return packet[1];
    case 0xc2:
    case 0xc4:
      return (packet[1] << 8) | packet[2];
    default:
      return 0;
  }
}

export function setPacketSize(packet: Uint8Array) {
  const size = packet.byteLength;
  switch (packet[0]) {
    case 0xc1:
    case 0xc3:
      packet[1] = castToByte(size);
      break;
    case 0xc2:
    case 0xc4:
      packet[1] = castToByte((size & 0xff00) >> 8);
      packet[2] = castToByte(size & 0x00ff);
      break;
    default:
      throw new Error(`Unknown packet type 0x${byteToString(packet[0])}`);
  }
}

export function stringToBytes(str: string, count = str.length) {
  const bytes = new Uint8Array(count);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}

export function castToByte(n: number): Byte {
  return n & 0xff;
}

export function castToUInt(n: number): UInt {
  return n; //TODO
}

export function castToUShort(n: number): UShort {
  return n; //TODO
}

export function integerDevision(n: number) {
  return Math.floor(n);
}

export function GetByteValue(byte: Byte, bits: Int, leftShifted: Int): Byte {
  const andMask = castToByte(Math.pow(2, bits) - 1);
  const numericalValue = castToByte((byte >> leftShifted) & andMask);

  return numericalValue;
}

export function SetByteValue(
  oldValue: Byte,
  value: Byte,
  bits: Int,
  leftShifted: Int
): Byte {
  const bitMask = castToByte(Math.pow(2, bits) - 1) << leftShifted;
  const clearMask = castToByte(0xff - bitMask);

  oldValue &= clearMask;

  const numericalValue = castToByte(value); //Convert.ToByte check?
  oldValue |= castToByte((numericalValue << leftShifted) & bitMask);

  return oldValue;
}

export function GetBoolean(byte: Byte, leftShifted: Int): boolean {
  return ((byte >> leftShifted) & 1) === 1;
}

export function SetBoolean(
  oldValue: Byte,
  value: Boolean,
  leftShifted: Int
): Byte {
  const mask = castToByte(1 << leftShifted);
  const clearMask = castToByte(0xff - (1 << leftShifted));
  oldValue &= clearMask;
  if (value) {
    oldValue |= mask;
  }

  return oldValue;
}

// More permormance
// export function SetBoolean(oldValue: Byte, value: Boolean): Byte {
//   const clearMask = 0b1111_1110;
//   oldValue &= clearMask;
//   if (value) {
//     oldValue |= 1;
//   }
//   return oldValue;
// }

export function ArrayCopy<TArray extends Uint8Array | Uint16Array>(
  buffer: TArray,
  srcOffset: Int,
  dst: TArray,
  dstOffset: Int,
  count: Int
): void {
  for (let i = 0; i < count; i++) {
    dst[dstOffset + i] = buffer[srcOffset + i];
  }
}

