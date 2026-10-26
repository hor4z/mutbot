/**
 * Packets propios del server: 0xFE (contador de resets, el Slow no resetea) se ignora; los demás códigos desconocidos se anotan una vez
 * para identificarlos. net/socket.ts los emite crudos como 'UnroutedPacket'.
 */
import { EventBus } from '../net/eventBus';
import { log, toBytes } from './util';

const seenUnrouted = new Set<number>();
const RESETS_CODE = 0xfe;

export function trackPanelPackets() {
  EventBus.on('UnroutedPacket', (raw: any) => {
    const b = toBytes(raw);
    if (b[0] !== 0xc1) return;
    if (b[2] === RESETS_CODE) return;
    if (!seenUnrouted.has(b[2])) {
      seenUnrouted.add(b[2]);
      log(`Packet propio 0x${b[2].toString(16)}: ${[...b.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    }
  });
}
