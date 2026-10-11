/**
 * Equipo: los personajes propios (MUBOT_MATES) se coordinan a través de la estación (MUBOT_TEAM_URL):
 * cada bot consulta cada TEAM_POLL_MS dónde están los demás y qué pidieron, y puede pedir ayuda
 * (sostener la esquina, un dragón a la vista). Las respuestas son decisiones del loop (farm-loop.ts)
 * y van a la tarjeta "Decisiones" del panel. Si la estación no está, el bot sigue solo.
 */
import { bot } from './state';

export type TeamMember = { char: string; level: number; map: number; x: number; y: number; mode: string };
export type HelpKind = 'corner' | 'golden';
export type TeamRequest = { from: string; kind: HelpKind; map: number; x: number; y: number; note: string; at: number };

const TEAM_URL = process.env.MUBOT_TEAM_URL ?? 'http://127.0.0.1:8787/api/team';
const TEAM_POLL_MS = 5000;
// Un mismo pedido (de qué tipo) como mucho cada esto.
const ASK_EVERY_MS = 3 * 60_000;

let members: TeamMember[] = [];
let requests: TeamRequest[] = [];
const askedAt = new Map<HelpKind, number>();
const answered = new Set<string>();
let polling = false;

/** Arranca la consulta periódica a la estación (una vez por proceso). */
export function startTeamPolling() {
  if (polling) return;
  polling = true;
  const poll = async () => {
    try {
      const r = await fetch(TEAM_URL, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const d = (await r.json()) as { members?: TeamMember[]; requests?: TeamRequest[] };
        members = d.members ?? [];
        requests = d.requests ?? [];
      }
    } catch {
      // sin estación: el bot sigue solo
    }
  };
  void poll();
  setInterval(poll, TEAM_POLL_MS);
}

/** Los compañeros (sin mí) que la estación ve conectados. */
export const teammates = () => members.filter((m) => m.char.toLowerCase() !== bot.charName.toLowerCase());

/** Pedir ayuda (como mucho uno por tipo cada `everyMs`, por defecto ASK_EVERY_MS). Devuelve true si salió el pedido. */
export function askHelp(kind: HelpKind, map: number, x: number, y: number, note: string, everyMs = ASK_EVERY_MS): boolean {
  const now = Date.now();
  if (now - (askedAt.get(kind) ?? 0) < everyMs) return false;
  askedAt.set(kind, now);
  const body: TeamRequest = { from: bot.charName, kind, map, x, y, note, at: now };
  void fetch(TEAM_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }).catch(() => {});
  return true;
}

/** Pedidos de compañeros que todavía no contesté (cada uno se contesta una vez). */
export function newRequests(): TeamRequest[] {
  const out = requests.filter((r) => r.from.toLowerCase() !== bot.charName.toLowerCase() && !answered.has(`${r.from}:${r.kind}:${r.at}`));
  for (const r of out) answered.add(`${r.from}:${r.kind}:${r.at}`);
  if (answered.size > 500) answered.clear();
  return out;
}
