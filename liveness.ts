/**
 * ¿El server sigue mandando cosas? Anota cuándo llegó el último packet de cualquier tipo, para el
 * vigía de trabas (watchdog.ts: "no_response"). Engancha `EventBus.emit` sin tocar net/ (que es copia
 * del cliente): cada packet que llega se emite por ahí con su nombre.
 */
import { EventBus } from './net/eventBus';

let lastAt = 0;
let hooked = false;

/** Una sola vez por proceso (el EventBus sobrevive a la reconexión). */
export function watchLiveness() {
  if (hooked) return;
  hooked = true;
  const emit = EventBus.emit.bind(EventBus);
  EventBus.emit = (event: string, payload?: unknown) => {
    // Los eventos del socket (ws*) no son del server.
    if (!event.startsWith('ws')) lastAt = Date.now();
    emit(event, payload);
  };
}

