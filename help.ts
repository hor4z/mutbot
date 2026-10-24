/**
 * Ayuda entre personajes propios, sin escuadras ni misiones. Cada uno farmea por su cuenta; si hay un compañero
 * claramente más fuerte (resets y nivel), el más débil lo avisa por la estación (`askHelp('help')`, team.ts). El
 * fuerte que esté libre va a su mapa, se acerca, lo invita a party y pelea a su lado; el débil acepta la party de un
 * compañero (world.ts). Cuando el débil deja de pedir (ya no está tan atrás) o el fuerte tiene que resetear, vuelve
 * a su ruta. El spot lo fija `intent.ts` con el dueño `help` mientras ayuda.
 */
import { sendToGS } from './connection';
import { RESET_LEVEL } from './config';
import { dist } from './early';
import { pin, requestWarp } from './intent';
import { decide } from './journal';
import { walkTowards, type LoopCtx } from './loop-ctx';
import { buildPartyInvite } from './protocol097';
import { WARP_SPOTS } from './route';
import { bot, world } from './state';
import { askHelp, teammates, type TeamRequest } from './team';

/** Diferencia mínima de poder (resets × 1000 + nivel) para que uno ayude al otro. */
export const HELP_MARGIN = 60;
const ASK_EVERY_MS = 90_000;
/** Sin pedidos nuevos del compañero durante esto, se deja de ayudar. */
const GIVE_UP_MS = 4 * 60_000;
const NEAR = 8;
const FAR = 18;
const WARP_RETRY_MS = 30_000;
const INVITE_EVERY_MS = 3 * 60_000;

export const power = (level: number, resets?: number | null) => (resets ?? 0) * 1000 + level;
const myPower = () => power(world.level, world.resets);

type Helping = { name: string; lastAt: number; warpTriedAt: number; joined: boolean; invitedAt: number };
let helping: Helping | null = null;
export const helpingWho = () => helping?.name ?? null;

const busy = () => bot.hunting || bot.resetting || bot.paused || !bot.inGameAt;

/** El débil pide ayuda mientras haya un compañero conectado bastante más fuerte. */
export function askForHelp() {
  if (busy() || helping) return;
  const mine = myPower();
  const stronger = teammates().filter((m) => power(m.level, m.resets) - mine >= HELP_MARGIN);
  if (!stronger.length) return;
  const best = stronger.sort((a, b) => power(b.level, b.resets) - power(a.level, a.resets))[0];
  if (askHelp('help', world.map, world.x, world.y, `nivel ${world.level}, ${best.char} es más fuerte`, ASK_EVERY_MS))
    decide(`Pido ayuda: ${best.char} (nivel ${best.level}, ${best.resets ?? 0} resets) está mucho más arriba que yo.`);
}

/** El fuerte contesta un pedido de ayuda. */
export function onHelpRequest(r: TeamRequest) {
  const them = teammates().find((m) => m.char.toLowerCase() === r.from.toLowerCase());
  if (!them) return;
  if (helping) { if (helping.name.toLowerCase() === r.from.toLowerCase()) helping.lastAt = Date.now(); return; }
  if (busy() || world.level >= RESET_LEVEL || pin.owner() === 'panel') return;
  if (myPower() - power(them.level, them.resets) < HELP_MARGIN) return;
  helping = { name: them.char, lastAt: Date.now(), warpTriedAt: 0, joined: false, invitedAt: 0 };
  decide(`${them.char} pide ayuda y estoy más fuerte (nivel ${world.level}, ${world.resets ?? 0} resets): voy con él.`);
}

function stop(why: string) {
  if (!helping) return;
  decide(`Dejo de ayudar a ${helping.name}: ${why}.`);
  helping = null;
  pin.clear('help', why);
}

/** Un paso de ayuda. true = consumió el tick (caminó hacia el compañero); false = que siga el loop normal (pelear a su lado). */
export async function helpStep(ctx: LoopCtx): Promise<boolean> {
  const h = helping;
  if (!h) return false;
  const now = Date.now();
  const them = teammates().find((m) => m.char.toLowerCase() === h.name.toLowerCase());
  if (!them) { stop('se desconectó'); return false; }
  if (now - h.lastAt > GIVE_UP_MS) { stop('ya no pide'); return false; }
  if (busy() || world.level >= RESET_LEVEL || pin.owner() === 'panel') { stop('tengo otra cosa que hacer'); return false; }

  if (world.map !== them.map) {
    if (now - h.warpTriedAt < WARP_RETRY_MS || bot.pendingWarp) return false;
    h.warpTriedAt = now;
    const target = { x: them.x, y: them.y };
    const spot = WARP_SPOTS.filter((s) => s.map === them.map && s.reqLevel <= world.level)
      .sort((a, b) => (a.arrival ? dist(a.arrival, target) : 999) - (b.arrival ? dist(b.arrival, target) : 999))[0];
    if (!spot) { stop(`no tengo cómo llegar al mapa ${them.map}`); return false; }
    if (requestWarp(spot, 'help', `ayudo a ${h.name}`)) pin.set('help', spot, `ayudo a ${h.name}`);
    return false;
  }

  const d = dist({ x: world.x, y: world.y }, them);
  if (d > FAR) h.joined = false;
  if (!h.joined) {
    if (d > NEAR) {
      bot.doing = `voy con ${h.name} a ayudarlo`;
      await walkTowards(ctx, them.x, them.y);
      return true;
    }
    h.joined = true;
  }
  if (now - h.invitedAt > INVITE_EVERY_MS) {
    const id = [...world.players].find(([, p]) => p.name?.toLowerCase() === h.name.toLowerCase())?.[0];
    if (id != null) {
      h.invitedAt = now;
      sendToGS(new DataView(buildPartyInvite(id).buffer));
      decide(`Invito a ${h.name} a party.`);
    }
  }
  return false;
}
