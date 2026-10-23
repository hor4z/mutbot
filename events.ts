/**
 * Packets que solo usa el panel: aperturas de eventos (0x91, preguntadas a ritmo humano), invasión
 * dorada (0xFD) y CharacterResets (packet propio del server). La lógica pura está en panel-logic.ts.
 */
import { sendToGS } from './connection';
import { EventBus } from './net/eventBus';
import { EVENT_KEYS, aliveHistory, buildOpeningStateRequest, parseInvasion, parseOpeningState } from './panel-logic';
import type { EventKey, EventTimer } from './panel-protocol';
import { bot, world } from './state';
import { log, toBytes } from './util';

// Aperturas de eventos (0x91).
export const eventTimers = new Map<EventKey, EventTimer>();
const nextEventPollAt = new Map<EventKey, number>();

// Aperturas de eventos (0x91): una pregunta por evento cada ~60 s, nunca más
// de una cada EVENT_POLL_TICK_MS (ritmo humano; el cliente pregunta cada 30 s
// a 5 min). Al entrar al mundo se preguntan las tres, espaciadas.
const EVENT_POLL_EVERY_MS = 60_000;
export const EVENT_POLL_TICK_MS = 5_000;
export function scheduleEventPolls(now: number) {
  for (const k of EVENT_KEYS) nextEventPollAt.set(k, now + 3000);
}
export function pollEvents() {
  if (!bot.statusServer || bot.kicked || !bot.inGameAt || bot.resetting) return;
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
const seenUnrouted = new Set<number>();
// Código del packet CharacterResets del cliente web (layout: resets u16 BE, grand u8). Ver el log "Packet propio".
const RESETS_CODE = 0xfe; // visto: c1 06 fe 00 13 00 = 19 resets (Melu)
export function trackPanelPackets() {
  EventBus.on('MiniGameOpeningState', (raw: any) => {
    const t = parseOpeningState(toBytes(raw), Date.now());
    if (t) eventTimers.set(t.key, t);
  });
  // 0xFD (invasión dorada) es propio del server: no está en packets/routes.ts y
  // net/socket.ts lo emite crudo como 'UnroutedPacket'.
  EventBus.on('UnroutedPacket', (raw: any) => {
    const b = toBytes(raw);
    // Packets propios del server que el cliente web sí lee y el bot no conocía: se anotan una vez
    // (código y bytes) para identificarlos; CharacterResets = resets u16 BE en [3..4], grand en [5].
    if (b[0] === 0xc1 && b[2] !== 0xfd && b[2] !== RESETS_CODE && !seenUnrouted.has(b[2])) { seenUnrouted.add(b[2]); log(`Packet propio 0x${b[2].toString(16)}: ${[...b.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`); }
    if (b[0] === 0xc1 && b[2] === RESETS_CODE && b.length >= 6) { world.resets = (b[3] << 8) | b[4]; world.grandResets = b[5]; return; }
    if (b[0] !== 0xc1 || b[2] !== 0xfd) return;
    const inv = parseInvasion(b, Date.now());
    if (!inv) return;
    const prev = bot.invasion;
    bot.invasion = inv;
    aliveHistory.record(inv, Date.now());
    if (!prev || prev.status !== inv.status || prev.total !== inv.total) {
      log(`Invasión dorada: ${inv.status}, ${inv.total} vivo(s)${inv.maps.length ? ` (${inv.maps.map((m) => `${m.name}: ${m.alive}`).join(' · ')})` : ''}.`);
    }
  });
}
