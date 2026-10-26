/**
 * Avisos del server (ServerMessage): van al log y a la base. No se escribe nada en el chat.
 */
import { EventBus } from '../net/eventBus';
import { parseServerMessage } from './protocol097';
import { trackEvent } from './telemetry';
import { log, toBytes } from './util';

/** Escucha los avisos (una vez por proceso: los handlers del EventBus sobreviven a la reconexión). */
export function watchChat() {
  EventBus.on('ServerMessage', (raw: any) => {
    const line = parseServerMessage(toBytes(raw));
    if (!line || !line.text) return;
    log(`Server: ${line.text}`);
    if (!/ entered the game\.$/.test(line.text)) trackEvent('server_msg', line.text);
  });
}
