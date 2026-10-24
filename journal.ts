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

/** Las últimas decisiones: van en el estado del panel y la estación las muestra como mensajes. */
export type Note = { at: number; text: string };
const NOTES_MAX = 20;
const notes: Note[] = [];
export const recentNotes = (): Note[] => notes;

/** Una decisión con su motivo: al log, a los mensajes de la estación y al diario. */
export function decide(what: string, detail: Record<string, unknown> = {}) {
  log(what);
  notes.push({ at: Date.now(), text: what.slice(0, 160) });
  if (notes.length > NOTES_MAX) notes.shift();
  journal('decide', what, detail);
}

/** Una línea al log. */
export function panelLog(text: string) {
  log(text);
}
