/**
 * Avisos del server (ServerMessage): van al log y a la base, y de ellos sale el mapa del Golden Dragon y del Dragón Rojo
 * ("[Devias] Golden invasion!" a las :50). No se escribe nada en el chat.
 */
import { EventBus } from './net/eventBus';
import { parseServerMessage } from './protocol097';
import { dragonMapFromServerMessage, redDragonMapFromServerMessage } from './panel-logic';
import { bot } from './state';
import { trackEvent } from './telemetry';
import { log, toBytes } from './util';

/** Escucha los avisos (una vez por proceso: los handlers del EventBus sobreviven a la reconexión). */
export function watchChat() {
  EventBus.on('ServerMessage', (raw: any) => {
    const line = parseServerMessage(toBytes(raw));
    if (!line || !line.text) return;
    log(`Server: ${line.text}`);
    if (!/ entered the game\.$/.test(line.text)) trackEvent('server_msg', line.text);
    const dm = dragonMapFromServerMessage(line.text);
    if (dm != null) bot.dragonMap = { map: dm, at: Date.now() };
    const rm = redDragonMapFromServerMessage(line.text);
    if (rm != null) bot.redDragon = { map: rm, at: Date.now() };
  });
}
