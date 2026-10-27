/**
 * Pedir party: con party la exp rinde más y el usuario la quiere siempre. Si no estamos en party, se le pide a un jugador cercano; si acepta llega
 * PartyList (world.ts). Ritmo humano: una invitación cada INVITE_GAP_MS como mucho y al mismo jugador no se le insiste hasta pasados REASK_MS.
 */
import { inviteToParty } from '../core/actions';
import { decide } from '../core/journal';
import { trackEvent } from '../core/telemetry';
import { bot, world } from '../core/state';
import { isSafeZone } from '../core/terrain';
import { chebyshev } from '../core/util';

const INVITE_GAP_MS = 20_000;
const REASK_MS = 20 * 60_000;
const RANGE = 10;

const g = globalThis as { __partyAsked?: Map<string, number>; __partyLastAt?: number };
const asked = (g.__partyAsked ??= new Map<string, number>());

/** Un paso sin esperas: si corresponde, manda una invitación de party. */
export function partyStep(): void {
  if (!bot.inGameAt || bot.paused || bot.inParty || world.hp <= 0) return;
  const now = Date.now();
  if (now - (g.__partyLastAt ?? 0) < INVITE_GAP_MS) return;
  if (isSafeZone(world.map, world.x, world.y)) return;
  let best: { id: number; name: string; d: number } | null = null;
  for (const [id, p] of world.players) {
    if (!p.name || now - (asked.get(p.name) ?? 0) < REASK_MS) continue;
    const d = chebyshev(p.x, p.y, world.x, world.y);
    if (d <= RANGE && (!best || d < best.d)) best = { id, name: p.name, d };
  }
  if (!best) return;
  g.__partyLastAt = now;
  asked.set(best.name, now);
  inviteToParty(best.id);
  trackEvent('party', 'invite', 0, 0, { to: best.name });
  decide(`Le pedí party a ${best.name} (a ${best.d} casillas).`, { kind: 'system' });
}
