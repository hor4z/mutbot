/**
 * Diario: cada decisión de alto nivel (viaje, reset, reparto de puntos, cambio de modo) va al log y, las que sirven para
 * aprender (decisiones, viajes, resets), a la base.
 */
import { trackEvent } from './telemetry';
import { log } from './util';

type JournalKind = 'pickup' | 'reset' | 'stat' | 'travel' | 'command' | 'mode' | 'decide';

export function journal(kind: JournalKind, what: string, detail: Record<string, unknown> = {}) {
  if (kind === 'decide' || kind === 'travel' || kind === 'reset' || kind === 'pickup') trackEvent(kind, what, 0, 0, detail);
}

/** Una decisión con su motivo: al log y al diario. */
export function decide(what: string, detail: Record<string, unknown> = {}) {
  log(what);
  journal('decide', what, detail);
}

/** Una línea al log. */
export function panelLog(text: string) {
  log(text);
}
