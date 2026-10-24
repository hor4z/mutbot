/**
 * Packets propios del server que el bot necesita: la invasión dorada (0xFD, la manda el server sola) y los
 * resets del personaje (0xFE). La lógica pura de la invasión está en panel-logic.ts.
 */
import { EventBus } from './net/eventBus';
import { parseInvasion } from './panel-logic';
import { bot, world } from './state';
import { log, toBytes } from './util';

const seenUnrouted = new Set<number>();
// Código del packet CharacterResets del cliente web (layout: resets u16 BE, grand u8). Visto: c1 06 fe 00 13 00 = 19 resets.
const RESETS_CODE = 0xfe;
const INVASION_CODE = 0xfd;

export function trackPanelPackets() {
  // 0xFD y 0xFE son propios del server: no están en packets/routes.ts y net/socket.ts los emite crudos como 'UnroutedPacket'.
  EventBus.on('UnroutedPacket', (raw: any) => {
    const b = toBytes(raw);
    if (b[0] !== 0xc1) return;
    // Los demás packets propios se anotan una vez (código y bytes) para identificarlos.
    if (b[2] !== INVASION_CODE && b[2] !== RESETS_CODE && !seenUnrouted.has(b[2])) {
      seenUnrouted.add(b[2]);
      log(`Packet propio 0x${b[2].toString(16)}: ${[...b.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    }
    if (b[2] === RESETS_CODE && b.length >= 6) { world.resets = (b[3] << 8) | b[4]; world.grandResets = b[5]; return; }
    if (b[2] !== INVASION_CODE) return;
    const inv = parseInvasion(b, Date.now());
    if (!inv) return;
    const prev = bot.invasion;
    bot.invasion = inv;
    if (!prev || prev.status !== inv.status || prev.total !== inv.total) {
      log(`Invasión dorada: ${inv.status}, ${inv.total} vivo(s)${inv.maps.length ? ` (${inv.maps.map((m) => `${m.name}: ${m.alive}`).join(' · ')})` : ''}.`);
    }
  });
}
