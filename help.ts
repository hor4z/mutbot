/**
 * Party entre compañeros: cada uno farmea por su cuenta; si un compañero está cerca en el mismo mapa, el más fuerte
 * (por stats; el más débil, si pasan 40 s sin party) lo invita a party, así comparten exp sin moverse de su spot. Ayudar yendo al mapa del otro se
 * quitó: Hume solo en la esquina rinde ~35 veces más que acompañando a otro personaje en Devias. Los dorados se avisan
 * por `team.ts` (cazador, hunt.ts).
 */
import { sendToGS } from './connection';
import { decide } from './journal';
import { buildPartyInvite } from './protocol097';
import { bot, world } from './state';
import { teammates } from './bus';
import { dist, statPower } from './util';

const NEAR = 20;
const EVERY_MS = 10_000;
/** Reintentos rápidos (el compañero puede no tenerme todavía en su lista de jugadores) y luego espaciados. */
const RETRY_MS = 15_000;
const SLOW_RETRY_MS = 3 * 60_000;
const FAST_TRIES = 4;
/** El más débil espera esto antes de invitar él (si el fuerte no lo hizo, no se queda sin party por un rol invertido). */
const WEAKER_WAITS_MS = 40_000;

let lastCheck = 0;
let unpartiedSince = 0;
const invited = new Map<string, { at: number; tries: number }>();

/** Invitar a party al compañero cercano (sin rol fijo: invita el más fuerte; el más débil, si pasaron WEAKER_WAITS_MS). */
export function partyUp() {
  const now = Date.now();
  if (now - lastCheck < EVERY_MS || bot.resetting || bot.paused || !bot.inGameAt) return;
  lastCheck = now;
  if (bot.inParty) { invited.clear(); unpartiedSince = 0; return; }
  const mine = statPower(world.stats);
  let anyNear = false;
  for (const m of teammates()) {
    if (m.map !== world.map || dist({ x: world.x, y: world.y }, m) > NEAR) continue;
    anyNear = true;
    if (!unpartiedSince) unpartiedSince = now;
    if (m.power > mine && now - unpartiedSince < WEAKER_WAITS_MS) continue;
    const prev = invited.get(m.char);
    if (prev && now - prev.at < (prev.tries < FAST_TRIES ? RETRY_MS : SLOW_RETRY_MS)) continue;
    const id = [...world.players].find(([, p]) => p.name?.toLowerCase() === m.char.toLowerCase())?.[0];
    if (id == null) continue;
    invited.set(m.char, { at: now, tries: (prev?.tries ?? 0) + 1 });
    sendToGS(new DataView(buildPartyInvite(id).buffer));
    decide(`Invito a ${m.char} a party (está cerca).`);
    return;
  }
  if (!anyNear) unpartiedSince = 0;
}
