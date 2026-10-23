/**
 * Escuadra, lado del bot: consulta por loopback a la estación qué le toca (squad.ts `Assignment`
 * firmada con MUBOT_SQUAD_KEY), la verifica y la ejecuta con lo que el bot ya sabe hacer: viajar con el
 * warp de siempre, caminar con terreno real (`walkTowards`), seguir al líder con correa (formation.ts),
 * invitar/aceptar party solo entre miembros (party.ts) y tirar buffs de apoyo.
 *
 * Seguridad: sin MUBOT_SQUAD_KEY (bots lanzados antes de las escuadras, o a mano) no consulta ni obedece
 * nada. La URL tiene que ser loopback. Una orden sin firma válida, vencida (20 s) o para otro personaje
 * se ignora; si la estación deja de mandar, a los 20 s el bot vuelve solo a su rutina. Nadie puede
 * mandarle órdenes por chat ni por party: la única fuente es la estación local.
 *
 * Ritmos humanos: no baja ningún pace (todo el movimiento va por walkTowards/humanPace); espera
 * antes de viajar lo que dice la orden (`delayMs`), reacciona al líder con retraso y varía dónde se
 * para (formation.ts). Sin verificar en vivo (docs/escuadras.md).
 */
import { SKILL_PACE_MS } from './config';
import { sendToGS } from './connection';
import { sendTargetedSkill } from './actions';
import { walkTowards, type LoopCtx } from './loop-ctx';
import { WARP_SPOTS } from './route';
import { bot, world } from './state';
import { walkableFor } from './terrain';
import { dist } from './corner';
import { Follower, wardTile } from './formation';
import { InviteScheduler, decideInvite, parsePartyList } from './party';
import { buildPartyInvite, buildPartyKick } from './protocol097';
import { FOLLOW_MISSION, verifyAssignment, type Assignment } from './squad';
import { humanPace, log, sleep } from './util';

const KEY = process.env.MUBOT_SQUAD_KEY ?? '';
const URL_ = process.env.MUBOT_SQUAD_URL ?? 'http://127.0.0.1:8787/api/squad';
const POLL_MS = 3000;

let current: Assignment | null = null;
let lastSeq = -1;
let polling = false;
let partyNames: string[] = [];
let partyIndex = -1;
/** Lo que había antes de la escuadra, para devolverlo al soltar. */
let savedPin: typeof bot.pinnedSpot | undefined;
let released = '';
const invites = new InviteScheduler();
const follower = new Follower();
/** Campaña de crianza: correa corta (2-6 tiles) detrás del padrino. */
const tightFollower = new Follower(Math.random, FOLLOW_MISSION.LEASH_FAR);
let warpSeenAt = 0;
let warpKey = '';
const buffAt = new Map<number, number>();

const loopback = (u: string) => {
  try { return ['127.0.0.1', 'localhost'].includes(new URL(u).hostname); } catch { return false; }
};

/** Arranca la consulta (una vez por proceso). Sin clave o con URL no local, no hace nada. */
export function startSquadPolling() {
  if (polling || !KEY || !loopback(URL_)) return;
  polling = true;
  const poll = async () => {
    try {
      const r = await fetch(`${URL_}?char=${encodeURIComponent(bot.charName)}`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const body = (await r.json()) as unknown;
        if ((body as { none?: boolean })?.none) { current = null; return; }
        const v = verifyAssignment(KEY, body, bot.charName, Date.now(), lastSeq);
        if ('a' in v) { current = v.a; lastSeq = v.a.seq; } else log(`Escuadra: orden descartada (${v.err}).`);
      }
    } catch {
      // sin estación: el bot sigue solo
    }
  };
  void poll();
  setInterval(poll, POLL_MS + Math.floor(Math.random() * 1500));
}

/** Escuadra con orden vigente (no `release`). */
export function squadActive(): boolean {
  return !!current && Date.now() <= current.expiresAt && current.order.kind !== 'release';
}

/** Miembros firmados de la escuadra vigente, o null si no hay: define a quién se le acepta party. */
export function squadMembers(): string[] | null {
  return squadActive() ? current!.members : null;
}

/** Decisión de party con escuadra (null = sin escuadra, queda la regla de world.ts). */
export function squadPartyDecision(from: string | null | undefined) {
  const m = squadMembers();
  return m ? decideInvite(from, m, false) : null;
}

export function onPartyList(raw: Uint8Array) {
  const names = parsePartyList(raw);
  if (!names) return;
  partyNames = names;
  partyIndex = names.findIndex((n) => n.toLowerCase() === bot.charName.toLowerCase());
}
export function onPartyGone() { partyNames = []; partyIndex = -1; invites.reset(); }

const byName = (n: string) => [...world.players].find(([, p]) => p.name?.toLowerCase() === n.toLowerCase());
const recentlyHit = (ctx: LoopCtx) => [...ctx.aggro.values()].some((t) => Date.now() - t < 3000);

/**
 * Un tick de escuadra dentro del loop. Devuelve true si consumió el tick (se movió o esperó) y false si
 * el loop normal puede seguir (pelear lo que tiene cerca, farmear, cazar).
 */
export async function squadStep(ctx: LoopCtx): Promise<boolean> {
  const a = current;
  if (!a || Date.now() > a.expiresAt) { restore(); return false; }
  const o = a.order;
  if (o.kind === 'release') {
    const tag = `${a.squadId}:${a.missionId}`;
    if (released !== tag) {
      released = tag;
      restore();
      if (o.leaveParty && partyIndex >= 0) {
        // Salir de la party: PartyPlayerKickRequest con el propio índice (SIN VERIFICAR en vivo), con espera humana.
        const idx = partyIndex;
        setTimeout(() => { sendToGS(new DataView(buildPartyKick(idx).buffer)); log('Escuadra: salgo de la party.'); onPartyGone(); }, 1500 + Math.random() * 4000);
      }
      log('Escuadra: misión terminada, vuelvo a mi rutina.');
    }
    return false;
  }
  released = '';
  if (world.hp <= 0 || bot.paused || bot.resetting || !bot.inGameAt) return false;

  // Party: el líder invita a los que faltan (uno por vez, con espera larga).
  const vis = new Map<string, number>();
  for (const [id, p] of world.players) if (p.name) vis.set(p.name.toLowerCase(), id);
  const inv = invites.next(Date.now(), bot.charName, a.leader, a.invite.length ? [a.leader, ...a.invite] : [], partyNames.length ? partyNames : bot.inParty ? [bot.charName] : [], vis);
  if (inv) {
    sendToGS(new DataView(buildPartyInvite(inv.id).buffer));
    log(`Escuadra: invito a ${inv.name} a la party.`);
  }
  await buffTick(a);

  const walkOn = world.map === (o as { map?: number }).map;
  switch (o.kind) {
    case 'idle':
      if (recentlyHit(ctx)) return false;
      bot.doing = `escuadra: ${o.why || 'espero'}`;
      await sleep(humanPace(600));
      return true;
    case 'warp': {
      if (world.map === o.map) return false;
      const k = `${a.missionId}:${o.warp}:${o.delayMs}`; // cada viaje con su espera nueva
      if (warpKey !== k) { warpKey = k; warpSeenAt = Date.now(); }
      if (Date.now() - warpSeenAt < o.delayMs) { bot.doing = 'escuadra: espero para viajar'; await sleep(humanPace(500)); return true; }
      const sp = WARP_SPOTS.find((s) => s.index === o.warp);
      if (!sp || sp.reqLevel > world.level) { log(`Escuadra: no puedo viajar al warp ${o.warp}.`); return false; }
      if (!bot.pendingWarp) {
        if (savedPin === undefined) savedPin = bot.pinnedSpot;
        bot.pendingWarp = sp;
        bot.pinnedSpot = sp;
        bot.hunting = null;
        bot.doing = `escuadra: viajo a ${sp.name}`;
      }
      return false; // el loop ejecuta pendingWarp en el mismo tick
    }
    case 'goto':
    case 'retreat': {
      if (!walkOn) return false;
      const r = o.kind === 'goto' ? o.radius : 3;
      if (dist(world, o) > r) {
        bot.doing = o.kind === 'goto' ? 'escuadra: voy a mi zona' : 'escuadra: me retiro';
        await walkTowards(ctx, o.x, o.y);
        return true;
      }
      if (o.kind === 'goto') return false; // llegó: pelea lo que tenga cerca
      if (recentlyHit(ctx)) return false;
      await sleep(humanPace(700));
      return true;
    }
    case 'hunt': {
      if (!walkOn) return false;
      if (dist(world, o) > o.radius + 8) { bot.doing = 'escuadra: voy al objetivo común'; await walkTowards(ctx, o.x, o.y); return true; }
      return false; // el loop ataca (dorados primero, GoldenRule)
    }
    case 'farm':
      return false;
    case 'follow':
    case 'hold': {
      const L = byName(o.leader);
      if (!L) {
        if (o.kind === 'follow' && o.tight) {
          // Campaña de crianza: no lo veo, voy hacia donde la estación dice que está (sin pelear salvo defensa propia).
          if (recentlyHit(ctx)) return false;
          if (o.at && dist(world, o.at) > 4) { bot.doing = 'escuadra: voy con el padrino'; await walkTowards(ctx, o.at.x, o.at.y); return true; }
          bot.doing = 'escuadra: espero al padrino';
          await sleep(humanPace(900));
          return true;
        }
        return false; // no lo veo: sigo con lo mío hasta que aparezca
      }
      const lp = { x: L[1].x, y: L[1].y };
      const others = [...vis].filter(([n]) => a.members.some((m) => m.toLowerCase() === n)).map(([, id]) => world.players.get(id)!).filter((p) => p !== L[1]).map((p) => ({ x: p.x, y: p.y }));
      const me = { x: world.x, y: world.y };
      const slots = Math.max(1, a.members.length - 1);
      const slot = Math.max(0, a.members.findIndex((m) => m.toLowerCase() === bot.charName.toLowerCase()) - 1);
      const walkable = walkableFor(world.map);
      let t = (o.kind === 'follow' && o.tight ? tightFollower : follower).next(Date.now(), me, lp, walkable, others, slot, slots);
      if (t && o.kind === 'hold') t = wardTile(lp, [...world.npcs.values()].map((n) => ({ x: n.x, y: n.y })), walkable, others) ?? t;
      if (t) { bot.doing = o.kind === 'hold' ? 'escuadra: cobro cerca del padrino' : 'escuadra: sigo al líder'; await walkTowards(ctx, t.x, t.y); return true; }
      if (o.kind === 'hold' || (o.kind === 'follow' && o.tight)) {
        // Protegido en su lugar: no pelea (cobra el reparto de exp de la party) salvo que le peguen.
        if (recentlyHit(ctx)) return false;
        bot.doing = o.kind === 'hold' ? 'escuadra: cobro exp' : 'escuadra: acompaño al padrino';
        await sleep(humanPace(900));
        return true;
      }
      return false;
    }
  }
}

function restore() {
  if (savedPin !== undefined) { bot.pinnedSpot = savedPin; savedPin = undefined; }
  current = null;
}

/** Buffs de apoyo sobre aliados a la vista (Elf 26-28, DL 64). Los de DK y DW ya los pone el loop. SIN VERIFICAR. */
async function buffTick(a: Assignment) {
  for (const b of a.buffs) {
    if (b.skill === 48 || b.skill === 16) continue;
    const sk = world.skills.get(b.skill);
    if (!sk || world.maxMana <= 0 || world.mana / world.maxMana < 0.25) continue;
    const gap = b.everyMs * (0.85 + Math.random() * 0.3);
    if (Date.now() - (buffAt.get(b.skill) ?? 0) < gap) continue;
    const targets = [bot.playerId, ...[...world.players].filter(([, p]) => p.name && a.members.some((m) => m.toLowerCase() === p.name!.toLowerCase()) && dist(world, p) <= 5).map(([id]) => id)];
    if (b.to === 'self') targets.splice(1);
    if (b.to === 'low-hp-ally') { if (world.maxHp > 0 && world.hp / world.maxHp < 0.6) targets.splice(1); else continue; }
    buffAt.set(b.skill, Date.now());
    for (const id of targets) {
      sendTargetedSkill(sk.index, id);
      await sleep(humanPace(SKILL_PACE_MS));
    }
  }
}
