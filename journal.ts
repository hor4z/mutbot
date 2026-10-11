/**
 * Diario: cada acción de alto nivel (viaje, reset, reparto, loot, órdenes del panel, cambios de
 * modo) se anota al panel (`decision`/`history`) y, con --decision-log, a un JSONL. También el log
 * que va a consola y al panel a la vez.
 */
import { appendFile } from 'node:fs/promises';
import { DECISION_LOG_PATH } from './config';
import { bot } from './state';
import { log } from './util';

type JournalKind = 'pickup' | 'reset' | 'stat' | 'travel' | 'command' | 'mode';

let journalSeq = 0;

export function journal(kind: JournalKind, what: string, detail: Record<string, unknown> = {}) {
  const entry = { seq: ++journalSeq, at: new Date().toISOString(), kind, what, detail, autoOk: true };
  // appendFile (no Bun.write, que sobrescribe); si el archivo falla no frena el juego.
  if (DECISION_LOG_PATH) void appendFile(DECISION_LOG_PATH, JSON.stringify(entry) + '\n').catch(() => {});
  bot.statusServer?.broadcastDecision(entry);
}

// Log a consola y al panel.
export function panelLog(text: string) {
  log(text);
  bot.statusServer?.broadcastLog(text);
}
