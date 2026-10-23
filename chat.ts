/**
 * Chat del personaje: lo que llega (público, party, guild, susurros y avisos del server) va al panel
 * como mensajes `chat`, y la orden `say` del panel lo manda. Parsers y builders en protocol097.ts.
 * Ritmo humano: como mucho un mensaje cada CHAT_SEND_GAP_MS.
 */
import { sendToGS } from './connection';
import { EventBus } from './net/eventBus';
import type { PanelCommand } from './panel-protocol';
import { CHAT_MAX, buildPublicChat, buildWhisper, parseChatMessage, parseServerMessage, type ChatLine } from './protocol097';
import { dragonMapFromServerMessage, redDragonMapFromServerMessage } from './panel-logic';
import { bot } from './state';
import { trackEvent } from './telemetry';
import { log, toBytes } from './util';

const CHAT_SEND_GAP_MS = 2000;
let lastSentAt = 0;

function emit(line: ChatLine, mine = false) {
  bot.statusServer?.broadcastChat({ at: Date.now(), ...line, ...(mine ? { mine: true } : {}) });
}

/** Escucha el chat (una vez por proceso: los handlers del EventBus sobreviven a la reconexión). */
export function watchChat() {
  // El susurro llega con code 0x02, que la tabla de rutas nombra PatchVersionOkay.
  for (const ev of ['ChatMessage', 'PatchVersionOkay']) {
    EventBus.on(ev, (raw: any) => {
      const line = parseChatMessage(toBytes(raw));
      if (line) emit(line);
    });
  }
  EventBus.on('ServerMessage', (raw: any) => {
    const line = parseServerMessage(toBytes(raw));
    if (!line || !line.text) return;
    emit(line);
    // Avisos del server (invasiones, dorados derrotados, Big Boss...): al log y a la base, para aprender
    // a leerlos (el mapa del Golden Dragon llega así a las :50).
    log(`Server: ${line.text}`);
    if (!/ entered the game\.$/.test(line.text)) trackEvent('server_msg', line.text);
    const dm = dragonMapFromServerMessage(line.text);
    if (dm != null) bot.dragonMap = { map: dm, at: Date.now() };
    const rm = redDragonMapFromServerMessage(line.text);
    if (rm != null) bot.redDragon = { map: rm, at: Date.now() };
  });
}

/** Orden `say` del panel (ya validada por isPanelCommand). */
export function sayFromPanel(c: Extract<PanelCommand, { cmd: 'say' }>): { ok: boolean; msg: string } {
  if (!bot.inGameAt) return { ok: false, msg: 'todavía no estoy en el mundo' };
  const now = Date.now();
  if (now - lastSentAt < CHAT_SEND_GAP_MS) return { ok: false, msg: 'despacio: un mensaje cada 2 s' };
  const prefix = c.channel === 'party' ? '~' : c.channel === 'guild' ? '@' : '';
  if (Buffer.byteLength(prefix + c.text, 'utf8') > CHAT_MAX) return { ok: false, msg: `muy largo: máximo ${CHAT_MAX} bytes (con acentos y el prefijo de party/guild cuentan más)` };
  lastSentAt = now;
  const bytes = c.to ? buildWhisper(c.to, c.text) : buildPublicChat(bot.charName, prefix + c.text);
  sendToGS(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  log(`Chat (panel)${c.to ? ` a ${c.to}` : c.channel && c.channel !== 'normal' ? ` [${c.channel}]` : ''}: ${c.text}`);
  emit({ kind: c.to ? 'whisper' : (c.channel ?? 'normal'), from: c.to ? `→ ${c.to}` : bot.charName, text: c.text }, true);
  return { ok: true, msg: c.to ? `susurro a ${c.to}` : 'mensaje enviado' };
}
