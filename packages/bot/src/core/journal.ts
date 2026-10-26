/**
 * Diario de decisiones: cada decisión del bot (spot, viaje, huida, reparto de puntos, orden del panel, traba) va al log, al panel
 * (con su motivo y su tipo, para filtrar) y a la base. Lo que el panel muestra como "qué está decidiendo y por qué" sale de acá.
 */
import type { NoteKind } from '@mubot/protocol';
import { trackEvent } from './telemetry';
import { log } from './util';

export type Note = { at: number; kind: NoteKind; text: string };
const NOTES_MAX = 80;
const notes: Note[] = [];
export const recentNotes = (): Note[] => notes;

/** Un evento suelto del diario (viajes, mensajes del panel…): solo a la base. */
export function journal(kind: 'pickup' | 'travel' | 'command' | 'mode', what: string, detail: Record<string, unknown> = {}) {
  if (kind === 'travel' || kind === 'pickup') trackEvent(kind, what, 0, 0, detail);
}

/** Una decisión con su motivo: al log, al panel y a la base. `detail.kind` dice de qué tipo es (por defecto 'system'). */
export function decide(what: string, detail: Record<string, unknown> & { kind?: NoteKind } = {}) {
  log(what);
  notes.push({ at: Date.now(), kind: detail.kind ?? 'system', text: what.slice(0, 220) });
  if (notes.length > NOTES_MAX) notes.shift();
  trackEvent('decide', what, 0, 0, detail);
}

