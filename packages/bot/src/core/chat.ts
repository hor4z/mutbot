/**
 * Chat del personaje: lo que llega (público, party, guild, susurros y avisos del server) queda en un buffer que el panel lee
 * dentro del estado, y la orden `say` del panel lo manda. Parsers y builders en protocol097.ts.
 * Ritmo humano: como mucho un mensaje cada CHAT_SEND_GAP_MS.
 */
import type { ChatEntry, PanelCommand } from '@mubot/protocol';
import { sendToGS } from './connection';
import { EventBus } from '../net/eventBus';
import { CHAT_MAX, buildPublicChat, buildWhisper, parseChatMessage, parseServerMessage, type ChatLine } from './protocol097';
import { bot } from './state';
import { trackEvent } from './telemetry';
import { log, toBytes } from './util';

const CHAT_SEND_GAP_MS = 2500;
const KEEP = 150;
let lastSentAt = 0;
const lines: ChatEntry[] = [];

/** Las últimas líneas del chat, para el panel. */
export const recentChat = (): ChatEntry[] => lines.slice();

function push(line: ChatLine, mine = false) {
  lines.push({ at: Date.now(), ...line, ...(mine ? { mine: true } : {}) });
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
}

/** Escucha el chat (una vez por proceso: los handlers del EventBus sobreviven a la reconexión). */
export function watchChat() {
  // El susurro llega con code 0x02, que la tabla de rutas nombra PatchVersionOkay.
  for (const ev of ['ChatMessage', 'PatchVersionOkay']) {
    EventBus.on(ev, (raw: any) => {
      const line = parseChatMessage(toBytes(raw));
      if (line) push(line);
    });
  }
  EventBus.on('ServerMessage', (raw: any) => {
    const line = parseServerMessage(toBytes(raw));
    if (!line || !line.text) return;
    push(line);
    log(`Server: ${line.text}`);
    if (!/ entered the game\.$/.test(line.text)) trackEvent('server_msg', line.text);
  });
}

/** Orden `say` del panel (ya validada por isPanelCommand). */
export function sayFromPanel(c: Extract<PanelCommand, { cmd: 'say' }>): { ok: boolean; msg: string } {
  if (!bot.inGameAt) return { ok: false, msg: 'todavía no estoy en el mundo' };
  const now = Date.now();
  if (now - lastSentAt < CHAT_SEND_GAP_MS) return { ok: false, msg: 'despacio: un mensaje cada 2,5 s' };
  const text = c.text.trim();
  const prefix = c.channel === 'party' ? '~' : c.channel === 'guild' ? '@' : '';
  if (Buffer.byteLength(prefix + text, 'utf8') > CHAT_MAX) return { ok: false, msg: `muy largo: máximo ${CHAT_MAX} bytes (con acentos y el prefijo de party o guild cuentan más)` };
  lastSentAt = now;
  const bytes = c.to ? buildWhisper(c.to, text) : buildPublicChat(bot.charName, prefix + text);
  sendToGS(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  log(`Chat (panel)${c.to ? ` a ${c.to}` : c.channel && c.channel !== 'normal' ? ` [${c.channel}]` : ''}: ${text}`);
  push({ kind: c.to ? 'whisper' : (c.channel ?? 'normal'), from: c.to ? `a ${c.to}` : bot.charName, text }, true);
  return { ok: true, msg: c.to ? `susurro a ${c.to}` : 'mensaje enviado' };
}
