/**
 * Un tick del loop en la esquina de Arena 2 (la lógica pura está en corner.ts): viajar hasta ahí,
 * girar con el skill de área donde deja más monstruos, buff propio, irse un rato si está llena.
 * Lo llama farm-loop.ts desde el nivel 100 hasta el reset (ver cornerActive).
 */
import { ATTACK_PACE_MS, PARTY_MATES, SKILL_PACE_MS } from './config';
import { sendToGS } from './connection';
import { buildPartyInvite, buildPartyKick } from './protocol097';
import { isPriorityChar, partyWanted } from './knowledge';
import { sendHit, sendTargetedSkill } from './actions';
import { castReach, isMage, mageNeedsPower, pickAttackSkill, useSkill } from './combat';
import { CORNER, CornerSides, SIDE, SIDES, mageCenter, altWarp, cornerFull, cornerTarget, inCorner, nextRoutePoint, spinRange, spinTarget } from './corner';
import { decide, journal } from './journal';
import { lootStep } from './loot';
import { walkTowards, type LoopCtx } from './loop-ctx';
import { WARP_COOLDOWN_MS, WARP_SPOTS, warpAndWait } from './route';
import { bot, expLog, isMate, monsterName, world } from './state';
import { chebyshev, directionTowards, log, sleep } from './util';

// Esquina de Arena 2: afuera hasta (llena), desde cuándo está adentro, punto del camino, último buff,
// el lado elegido (esquina/medio/este) y la exp ya anotada a ese lado.
export type CornerState = { awayUntil: number; since: number | null; routeIdx: number | null; routeAt: number; buffAt: number; mateBuffAt: number; inviteAt: number; partyUse: boolean | null; sides: CornerSides; expSeen: number;
  // compañeros que ya estaban en la esquina (para anunciar cuando llega uno)
  matesHere: Set<string>;
  // exp/min medida en cada Arena de afuera (warp → promedio móvil), para decidir si la esquina rinde menos.
  altRates: Map<number, number> };

// Jugadores que cuentan como rivales: todos menos los compañeros (MUBOT_MATES).
const rivalPlayers = () => [...world.players.values()].filter((q) => q.name == null || !isMate(q.name));

export function newCornerState(): CornerState {
  return { awayUntil: 0, since: null, routeIdx: null, routeAt: 0, buffAt: 0, mateBuffAt: 0, inviteAt: 0, partyUse: null, sides: new CornerSides(), expSeen: 0, altRates: new Map(), matesHere: new Set() };
}

export async function cornerStep(ctx: LoopCtx, corner: CornerState) {
  const now = Date.now();
  const arena2 = WARP_SPOTS.find((sp) => sp.index === CORNER.warp)!;
  if (world.map !== CORNER.map) {
    corner.since = null;
    corner.routeIdx = null;
    ctx.target = null;
    if (now - bot.lastWarpAt < WARP_COOLDOWN_MS) {
      bot.doing = 'esperando para ir a la esquina de Arena 2';
      await sleep(500);
      return;
    }
    bot.doing = `viajando a la esquina de Arena 2 (nivel ${world.level})`;
    journal('travel', `warp a Arena 2 para la esquina (nivel ${world.level})`, { warp: CORNER.warp, reason: 'corner' });
    if (await warpAndWait(arena2)) log(`Esquina: en Arena 2 en nivel ${world.level}.`);
    return;
  }
  bot.currentSpot = arena2;
  const me = { x: world.x, y: world.y };
  // Mago: Decay con rivales o con el compañero cerca, Evil Spirit sola (pickAttackSkill, combat.ts).
  const skill = pickAttackSkill();
  const r = spinRange(skill?.number);
  const mons = [...ctx.npcs.values()];
  const here = inCorner(me);
  if (here) {
    if (corner.since == null) {
      // Recién entrado: la exp y el tiempo de afuera no se le anotan a ningún lado.
      corner.since = now;
      corner.sides.restartClock();
      corner.expSeen = ctx.expTotal;
    }
    // Exp de este tick al lado elegido (si está cerca de él).
    corner.sides.record(now, me, ctx.expTotal - corner.expSeen);
    corner.expSeen = ctx.expTotal;
    // Llena (3+ jugadores, 60 s) o sin rendir (90 s) y rindiendo menos que la Arena de afuera medida →
    // 5 min a la Arena de su nivel. Si rinde, compite aunque haya gente.
    const rivals = rivalPlayers().filter((q) => Math.hypot(q.x - CORNER.home.x, q.y - CORNER.home.y) <= CORNER.fullRivalDist).length;
    const rate = expLog.perMin(now, 60_000);
    const altRate = corner.altRates.get(altWarp(world.level));
    const matesIn = [...world.players.values()].filter((q) => q.name != null && isMate(q.name) && inCorner(q));
    const mateHere = matesIn.length > 0;
    // Llegó un compañero: anunciar el reparto (él toma otro lado; ver CornerSides.pick).
    for (const q of matesIn)
      if (!corner.matesHere.has(q.name!)) decide(`Llegó ${q.name} a la esquina: cooperamos, yo en el lado ${corner.sides.side.name} y ${q.name} en el otro.`);
    corner.matesHere = new Set(matesIn.map((q) => q.name!));
    // Party en el dúo según los datos (knowledge.ts: party sí/no, con experimentos). El DK invita al
    // compañero que está en la esquina (cada 60 s), o disuelve la party si los datos dicen que no.
    const party = partyWanted(now);
    if (!isMage() && PARTY_MATES && party.use !== corner.partyUse) {
      corner.partyUse = party.use;
      decide(`Party en el dúo: ${party.use ? 'sí' : 'no'} (${party.why}).`);
    }
    if (!isMage() && bot.inParty && !party.use && now - corner.inviteAt > 60_000) {
      corner.inviteAt = now;
      sendToGS(new DataView(buildPartyKick(0).buffer));
    }
    const invitee = !isMage() && !bot.inParty && party.use && PARTY_MATES && now - corner.inviteAt > 60_000
      ? [...world.players].find(([, q]) => q.name != null && isMate(q.name) && inCorner(q)) : undefined;
    if (invitee) {
      corner.inviteAt = now;
      sendToGS(new DataView(buildPartyInvite(invitee[0]).buffer));
      decide(`Invito a ${invitee[1].name} a party (dúo en la esquina).`);
    }
    if (cornerFull({ rivals, inCornerSince: corner.since, now, rate1m: rate, altRate, level: world.level,
      // Mesa de agentes (2026-10-11): afuera (Arena 4 ~50-177M/min) rinde 5-8x menos que la esquina disputada.
      // El prioritario y el mago del dúo no se van nunca.
      mateHere: mateHere || isPriorityChar(bot.charName) || isMage() })) {
      corner.awayUntil = now + CORNER.awayMs;
      corner.since = null;
      ctx.target = null;
      const alt = WARP_SPOTS.find((sp) => sp.index === altWarp(world.level))!;
      const vs = `${Math.round(rate / 1e6)}M/min el último minuto contra ${Math.round(Math.max(altRate ?? 0, CORNER.altMinRate) / 1e6)}M de ${alt.name}`;
      decide(`Esquina ${rivals >= CORNER.fullRivals ? `llena (${rivals} jugadores)` : 'sin rendir'}, ${vs}: voy a ${alt.name} por ${CORNER.awayMs / 60_000} min.`);
      journal('travel', `esquina llena: warp a ${alt.name}`, { warp: alt.index, reason: 'corner-full', rivals });
      await warpAndWait(alt);
      return;
    }
  } else corner.since = null;
  // Monstruos que me pegaron en los últimos 5 s y están a <= 15 (los que pegan de lejos en las Arenas).
  for (const [id, t] of ctx.aggro) if (now - t > 5000 || !ctx.npcs.has(id)) ctx.aggro.delete(id);
  const aggro = [...ctx.aggro.keys()].map((id) => ctx.npcs.get(id)!).filter((m) => Math.hypot(m.x - me.x, m.y - me.y) <= 15)
    .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0] ?? null;
  // Pegar: lo que deja más monstruos en el giro (o el que me pega, si está a tiro), a ritmo de skill.
  // Viajando, solo lo que bloquea.
  const aggroInReach = aggro && Math.hypot(aggro.x - me.x, aggro.y - me.y) <= r + 0.5 ? aggro : null;
  // Mago con un compañero plantado en la esquina: se queda en su spot y tira de lejos (Decay a 5-6
  // tiles) al grupo más grande a tiro, sin caminar hacia los monstruos.
  const mateInCorner = [...world.players.values()].some((q) => q.name != null && isMate(q.name) && inCorner(q));
  const planted = here && isMage() && mateInCorner && skill != null;
  const st = here ? (spinTarget(me, mons, r, planted ? castReach(skill!.number) : undefined) ?? aggroInReach) : cornerTarget(me, mons, 0, r);
  // Mago solo (sin rivales ni compañero cerca): al centro del grupo más grande, para que Evil Spirit
  // agarre la mayor cantidad. Se mueve solo si allá agarra 2+ más que acá.
  if (here && isMage() && !mageNeedsPower()) {
    const c = mageCenter(mons, r);
    const nHere = mons.filter((m) => Math.hypot(m.x - me.x, m.y - me.y) <= r).length;
    if (c.n >= nHere + 2 && Math.hypot(c.at.x - me.x, c.at.y - me.y) > 1.5) {
      ctx.phase = 'walk';
      bot.goalPoint = [c.at.x, c.at.y];
      bot.doing = `esquina de Arena 2: sola, me centro en el grupo (${c.n} a tiro contra ${nHere})`;
      await walkTowards(ctx, c.at.x, c.at.y);
      return;
    }
  }
  // Mago parado en la esquina con un compañero a la vista: primero dejarle la esquina al DK (si no,
  // con monstruos siempre a tiro no salía nunca del giro).
  const matesSeen = [...world.players.values()].filter((q) => q.name != null && isMate(q.name));
  if (here && isMage() && matesSeen.length && Math.hypot(me.x - SIDES[0].x, me.y - SIDES[0].y) <= SIDE.near) {
    const side = corner.sides.pick(now, rivalPlayers(), matesSeen, false, true);
    ctx.phase = 'walk';
    bot.goalPoint = [side.x, side.y];
    bot.doing = `esquina de Arena 2: le dejo la esquina a ${matesSeen[0].name}, voy al lado ${side.name}`;
    await walkTowards(ctx, side.x, side.y);
    return;
  }
  if (st && Date.now() - ctx.lastCastAt >= SKILL_PACE_MS) {
    ctx.phase = 'fight';
    bot.doing = `esquina de Arena 2: ${here ? 'giro' : 'paso'} con ${monsterName(st.type)} (${mons.filter((m) => Math.hypot(m.x - st.x, m.y - st.y) <= r).length} en el giro)`;
    if (skill && useSkill(st.id, skill)) {
      ctx.lastCastAt = Date.now();
      ctx.skillsUsed++;
      await sleep(SKILL_PACE_MS);
      return;
    }
    // Sin skill o sin maná: golpe normal al que esté pegado.
    if (chebyshev(world.x, world.y, st.x, st.y) <= 1) {
      sendHit(st.id, directionTowards(world.x, world.y, st.x, st.y));
      await sleep(ATTACK_PACE_MS);
      return;
    }
  }
  if (here) {
    // Buff propio (Swell Life 48 / Mana Shield 16) cada ~55 s.
    const buff = [48, 16].map((k) => world.skills.get(k)).find((x) => x != null);
    if (buff && now - corner.buffAt > CORNER.buffMs && now - ctx.lastCastAt >= SKILL_PACE_MS) {
      corner.buffAt = now;
      ctx.lastCastAt = now;
      sendTargetedSkill(buff.index, bot.playerId);
      await sleep(SKILL_PACE_MS);
      return;
    }
    // En party, el mago le pone Soul Barrier (16) al compañero a <= 6 cada ~55 s (Swell Life del DK ya
    // alcanza a la party sola: ImplicitParty). Solo en un hueco del giro: primero se ganan los monstruos.
    const barrier = world.skills.get(16);
    const mateNear = bot.inParty && barrier && isMage() && now - corner.mateBuffAt > CORNER.buffMs && now - ctx.lastCastAt >= SKILL_PACE_MS
      ? [...world.players].find(([, q]) => q.name != null && isMate(q.name) && Math.hypot(q.x - me.x, q.y - me.y) <= 6) : undefined;
    if (barrier && mateNear) {
      corner.mateBuffAt = now;
      ctx.lastCastAt = now;
      sendTargetedSkill(barrier.index, mateNear[0]);
      bot.doing = `esquina de Arena 2: Soul Barrier a ${mateNear[1].name}`;
      await sleep(SKILL_PACE_MS);
      return;
    }
    // Sin nada a tiro: levantar cajas cerca, o caminar al grupo, o esperar en la esquina.
    if (await lootStep()) {
      bot.doing = 'esquina de Arena 2: levantando loot';
      return;
    }
    const playersNear = rivalPlayers().filter((q) => Math.hypot(q.x - world.x, q.y - world.y) <= CORNER.crowdDist).length;
    // El que me pega primero; si no, el grupo; si no, el lado elegido por exp medida.
    // (el que me pega, solo si está dentro de la esquina: si no, salía de la esquina y volvía sin parar)
    const aggroHere = aggro && Math.hypot(aggro.x - CORNER.home.x, aggro.y - CORNER.home.y) <= CORNER.radius + CORNER.fill ? aggro : null;
    // El prioritario (Horaz) disputa los grupos aunque haya rivales encima: esperando quieto, los rivales
    // se llevaban el 66-87 % de las kills del sector (datos 2026-10-11). Los demás, como antes.
    const contest = isPriorityChar(bot.charName) ? 0 : playersNear;
    const ct = planted ? null : (aggroHere ?? cornerTarget(me, mons, contest, r));
    // Con un compañero en la esquina, el lado que él no ocupa (el DK se planta en la esquina).
    const mates = [...world.players.values()].filter((q) => q.name != null && isMate(q.name));
    const before = corner.sides.side.name;
    const goal = ct ?? corner.sides.pick(now, rivalPlayers(), mates, !isMage(), isMage() && mates.length > 0);
    if (corner.sides.side.name !== before) {
      const why = mates.some((m) => inCorner(m)) ? `con ${mates.map((m) => m.name).join(', ')} en la esquina` : 'rinde más';
      decide(`Esquina: me paso al lado ${corner.sides.side.name} (${why}).`);
    }
    // Sin skill hay que llegar pegado para el golpe normal.
    const reach = ct ? (skill ? r : 1) : 0.8;
    bot.goalPoint = [goal.x, goal.y];
    if (Math.hypot(goal.x - world.x, goal.y - world.y) > reach) {
      ctx.phase = 'walk';
      bot.doing = ct ? `esquina de Arena 2: voy al grupo de ${monsterName(ct.type)}` : 'esquina de Arena 2: espero la reaparición';
      await walkTowards(ctx, goal.x, goal.y);
      return;
    }
    ctx.phase = 'wait';
    bot.doing = 'esquina de Arena 2: espero la reaparición';
    await sleep(300);
    return;
  }
  // Viajando por el camino de la llegada a la esquina.
  if (corner.routeIdx == null || now - corner.routeAt > 20_000) corner.routeIdx = null;
  const wp = nextRoutePoint(me, corner.routeIdx);
  corner.routeIdx = wp.idx;
  corner.routeAt = now;
  ctx.phase = 'walk';
  bot.goalPoint = [wp.x, wp.y];
  bot.doing = `camino a la esquina de Arena 2 (${wp.idx + 1}/${CORNER.route.length})`;
  await walkTowards(ctx, wp.x, wp.y);
}
