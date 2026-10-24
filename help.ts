/**
 * Party entre compañeros: cada uno farmea por su cuenta; si un compañero está cerca en el mismo mapa, el más fuerte
 * (resets × 1000 + nivel) lo invita a party, así comparten exp sin moverse de su spot. Ayudar yendo al mapa del otro se
 * quitó: Hume solo en la esquina rinde ~35 veces más que acompañando a otro personaje en Devias. Los dorados se avisan
 * por `team.ts` (cazador, hunt.ts).
 */
import { sendToGS } from './connection';
import { decide } from './journal';
import { buildPartyInvite } from './protocol097';
import { bot, world } from './state';
import { teammates } from './bus';
import { dist } from './util';

const NEAR = 20;
const EVERY_MS = 20_000;
const INVITE_EVERY_MS = 3 * 60_000;

export const power = (level: number, resets?: number | null) => (resets ?? 0) * 1000 + level;

let lastCheck = 0;
const invitedAt = new Map<string, number>();

/** Invitar a party al compañero cercano más débil (uno por vez, cada tanto). */
export function partyUp() {
  const now = Date.now();
  if (now - lastCheck < EVERY_MS || bot.resetting || bot.paused || !bot.inGameAt) return;
  lastCheck = now;
  const mine = power(world.level, world.resets);
  for (const m of teammates()) {
    if (m.map !== world.map || dist({ x: world.x, y: world.y }, m) > NEAR || power(m.level, m.resets) > mine) continue;
    if (now - (invitedAt.get(m.char) ?? 0) < INVITE_EVERY_MS) continue;
    const id = [...world.players].find(([, p]) => p.name?.toLowerCase() === m.char.toLowerCase())?.[0];
    if (id == null) continue;
    invitedAt.set(m.char, now);
    sendToGS(new DataView(buildPartyInvite(id).buffer));
    decide(`Invito a ${m.char} a party (está cerca).`);
    return;
  }
}
