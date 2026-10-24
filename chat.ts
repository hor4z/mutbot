/**
 * Chat del personaje: lo que llega (público, party, guild, susurros y avisos del server) va al panel
 * como mensajes `chat`, y la orden `say` del panel lo manda. Parsers y builders en protocol097.ts.
 * Ritmo humano: como mucho un mensaje cada CHAT_SEND_GAP_MS.
 */
import { sendToGS } from './connection';
import { EventBus } from './net/eventBus';
import { CHAT_MAX, buildPublicChat, buildWhisper, parseChatMessage, parseServerMessage, type ChatLine } from './protocol097';
import { decide } from './journal';
import { dragonMapFromServerMessage, redDragonMapFromServerMessage } from './panel-logic';
/** Comandos del server que el bot manda solo (hoy `/pkclear`, ver recovery.ts). */
const SAY_COMMANDS: readonly string[] = ['/pkclear'];
import { bot, pkGuard } from './state';
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
    // PK: el aviso abre el episodio de auto-recuperación (recovery.ts); el "cleaned" lo cierra.
    const pk = pkGuard.onServerMessage(line.text, Date.now());
    if (pk?.kind === 'pk-cleared') decide('PK limpio: el server confirmó /pkclear.');
    const dm = dragonMapFromServerMessage(line.text);
    if (dm != null) bot.dragonMap = { map: dm, at: Date.now() };
    const rm = redDragonMapFromServerMessage(line.text);
    if (rm != null) bot.redDragon = { map: rm, at: Date.now() };
  });
}

/**
 * Comando del server que el bot manda SOLO (hoy `/pkclear`, ver recovery.ts): solo los de SAY_COMMANDS y
 * respetando el gap de CHAT_SEND_GAP_MS con el chat del panel. false si todavía no toca (se reintenta).
 */
export function sendServerCommand(text: string, now = Date.now()): boolean {
  if (!SAY_COMMANDS.includes(text) || !bot.inGameAt || now - lastSentAt < CHAT_SEND_GAP_MS) return false;
  lastSentAt = now;
  const bytes = buildPublicChat(bot.charName, text);
  sendToGS(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  log(`Chat (automático): ${text}`);
  return true;
}

