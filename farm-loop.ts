/**
 * El loop del bot Slow. Un tick = una decisión:
 *   1. si algo anda mal (ciego, trabado, vida baja, pausa), arreglarlo;  2. repartir puntos;
 *   3. ir al spot que le toca (spots.ts) y quedarse;  4. loot;  5. pegarle al monstruo de más valor del spot.
 * Cada paso puede cortar el tick con `continue`. Toda decisión con su motivo va a `decide()` (journal.ts): es lo que el panel muestra.
 * Todo a ritmo mínimo seguro (config.ts): no se baja.
 */
import { track, trackEvent } from './telemetry';
import { closeSockets } from './connection';
import { ATTACK_PACE_MS, SKILL_PACE_MS, TARGET_NO_KILL_MS, UNREACHABLE_MS } from './config';
import { sendHit, sendTargetedSkill } from './actions';
import { SKILL_TABLE, castReach, checkSurvival, isMage, pickAttackSkill, skillLevelOk, useSkill } from './combat';
import { D } from './directivas';
import { decide } from './journal';
import { lootStep, watchDrops } from './loot';
import { drops, lootState } from './loot-state';
import { castOnTheWay, newLoopCtx, walkTowards, type LoopCtx } from './loop-ctx';
import { EventBus } from './net/eventBus';
import { CurrentHealthAndShieldPacket, ExperienceGainedPacket, ObjectGotKilledPacket } from './packets';
import { currentMode, sessionStart, setLoopView } from './panel';
import { mapName } from './panel-logic';
import { choosePlace, farFrom, isAttackable, lastPlace, noteDeath, targetValue, travelTo, type Place } from './area';
import { noteExp, noteKill } from './learning';
import { investStatPointsInBackground } from './progress';
import { scoutShopsStep } from './shop-scout';
import { bot, expLog, monsterName, world, type ScopedNpc } from './state';
import { isSafeZone } from './terrain';
import { warp, warpAndWait } from './warps';
import { chebyshev, directionTowards, humanPace, log, sleep } from './util';
import { watchMoney } from './world';

const SWELL_LIFE_MS = 55_000;
// La muerte llega por dos lados (HP 0 y ObjectGotKilled): dentro de esta ventana es una sola.
const DEATH_DEBOUNCE_MS = 15_000;
// Ningún monstruo a la vista durante esto = el server dejó de mandar el scope: reconectar.
const BLIND_RECONNECT_MS = 3 * 60_000;
// 15 s caminando sin moverse = traba (pared, objetivo inalcanzable): suelta el objetivo; si repite, vuelve a entrar al mapa.
const STUCK_BREAK_MS = 15_000;
// Foto a la base cada 5 s.
const TICK_MS = 5_000;
/** Espera mínima entre warps al huir (el bot no se queda esperando 15 s con monstruos encima). */
const FLEE_WARP_MS = 3_000;
/** De camino a un lugar lejano, se pelea con lo que esté a este alcance. */
const WAY_TILES = 8;
/** Solo se persigue lo que está a este alcance mientras haya algo; recién sin nada cerca se va más lejos. */
const CHASE_TILES = 12;
/** Vida (fracción) por debajo de la cual huye al pueblo si hay monstruos encima, y a la que vuelve a salir. Sin pociones es lo único que lo salva. */
const FLEE_BELOW = 0.5;
const RECOVER_TO = 0.7;

let lastTickAt = 0;
let lastStuckBreak = 0;
let economyWatched = false;
let lastDeathAt = -Infinity;

// Totales de todas las sesiones (el loop corre una vez por conexión).
export type LoopResult = { kills: number; totalExpGained: number; potionsDrunk: number; statPointsSpent: number; skillsUsed: number; deaths: number };

function dataTick(ctx: LoopCtx) {
  const now = Date.now();
  lastTickAt = now;
  track('ticks', {
    map: world.map, x: world.x, y: world.y, level: world.level,
    exp_total: ctx.expTotal, exp_min_1m: expLog.perMin(now, 60_000),
    hp: Math.max(0, world.hp), mp: Math.max(0, world.mana),
    mode: currentMode(), phase: ctx.phase, spot: lastPlace.v?.name ?? '', skill: pickAttackSkill()?.number ?? 0,
    monsters_near: [...ctx.npcs.values()].filter((m) => Math.hypot(m.x - world.x, m.y - world.y) <= 8).length,
    doing: bot.doing,
  }, now);
}

/** El de más valor por distancia (valor / (d + 8)) dentro del lugar, sin correr por todo el spot: primero lo que está cerca. Sin los marcados inalcanzables. */
function bestIn(place: Place, npcs: Iterable<ScopedNpc>, skip: (id: number) => boolean): ScopedNpc | null {
  const list = [...npcs].filter((m) => !skip(m.id) && chebyshev(m.x, m.y, place.anchor.x, place.anchor.y) <= place.radius);
  const dist = (m: ScopedNpc) => chebyshev(m.x, m.y, world.x, world.y);
  const value = (m: ScopedNpc) => -targetValue(m.type) / (dist(m) + 8);
  const near = list.filter((m) => dist(m) <= CHASE_TILES);
  return (near.length ? near : list).reduce<ScopedNpc | null>((b, m) => (b == null || value(m) < value(b) ? m : b), null);
}

// Hasta `deadline` (0 = sin límite) o hasta que se corte la conexión.
export async function autonomousLoop(deadline: number): Promise<LoopResult> {
  log(`\n--- Modo autónomo: ${deadline ? `hasta ${new Date(deadline).toLocaleTimeString()}` : 'sin límite'} ---`);
  const ctx = newLoopCtx();
  let fleeing = false;

  // Monstruos atacables: los de world.npcs fuera de zona segura que el personaje puede farmear (power.ts).
  const refreshAttackable = () => {
    ctx.npcs = new Map();
    for (const [id, n] of world.npcs) {
      if (!isAttackable(n)) continue;
      ctx.npcs.set(id, n);
    }
  };

  let totalExpGained = 0, kills = 0, potionsDrunk = 0, statPointsSpent = 0, deaths = 0;
  let lastBarrierAt = 0, lastSwellAt = 0;
  let lastAnyNpcAt = Date.now();
  let attackTarget: number | null = null;
  let attackSince = 0;

  // Muerte propia: llega por dos lados (HP a 0 y ObjectGotKilled con nuestro id); dentro de la ventana es una sola.
  const onDeath = (source: string) => {
    if (Date.now() - lastDeathAt < DEATH_DEBOUNCE_MS) return;
    lastDeathAt = Date.now();
    deaths++;
    log(`Muerte #${deaths} (${source}).`);
    noteDeath(); // la zona se evita y se vuelve a decidir a dónde ir
    bot.currentSpot = null; // el respawn es en el pueblo
    bot.canAdopt = false;
  };
  let lastHp = world.hp;
  const onHp = (raw: any) => {
    const hp = new CurrentHealthAndShieldPacket(raw).Health;
    if (hp === 0 && lastHp > 0) onDeath('HP 0');
    lastHp = hp;
  };
  const onKilled = (raw: any) => {
    const p = new ObjectGotKilledPacket(raw);
    const id = p.KilledId & 0x7fff;
    const deadType = world.npcs.get(id)?.type;
    world.npcs.delete(id);
    world.hits.delete(id);
    ctx.npcs.delete(id);
    if (id === bot.playerId) {
      const kid = p.KillerId & 0x7fff;
      const killer = world.players.get(kid);
      const by = killer ? `${killer.name ?? 'jugador #' + kid}` : world.npcs.has(kid) ? monsterName(world.npcs.get(kid)!.type) : `#${kid}`;
      decide(`Me mató ${by} en ${lastPlace.v?.name ?? mapName(world.map)} (nivel ${world.level}, vida máx ${world.maxHp}).`, { kind: 'death', by });
      trackEvent('death', by, kid, killer ? 1 : 0, { killer: killer?.name ?? null, npc: killer ? null : world.npcs.get(kid)?.type ?? null });
      onDeath('ObjectGotKilled');
    } else if ((p.KillerId & 0x7fff) === bot.playerId) {
      kills++;
      if (deadType != null) noteKill(deadType); // la exp que llegue después se le atribuye (learning.ts)
    }
  };
  // ExperienceGained: un kill de más de 65535 llega partido en ~60 packets; ExpLog los agrega por segundo.
  const onExp = (raw: any) => {
    const added = new ExperienceGainedPacket(raw).AddedExperience;
    totalExpGained += added;
    noteExp(added);
    ctx.expTotal += added;
    expLog.add(added, Date.now());
  };
  EventBus.on('ObjectGotKilled', onKilled);
  EventBus.on('ExperienceGained', onExp);
  EventBus.on('CurrentHealthAndShield', onHp);
  const stopWatchingDrops = watchDrops();
  if (!economyWatched) {
    watchMoney();
    economyWatched = true;
  }

  // Objetivos abandonados (inalcanzables o que no mueren): se ignoran UNREACHABLE_MS (el server reusa los ids).
  const unreachableUntil = new Map<number, number>();
  const unreachable = {
    has: (id: number) => (unreachableUntil.get(id) ?? 0) > Date.now(),
    add: (id: number) => {
      unreachableUntil.set(id, Date.now() + UNREACHABLE_MS);
      if (unreachableUntil.size > 500) for (const [k, t] of unreachableUntil) if (t <= Date.now()) unreachableUntil.delete(k);
    },
  };
  setLoopView(() => ({ kills, deaths, casts: ctx.skillsUsed, exp: totalExpGained, target: ctx.target }));
  if (!sessionStart.level) sessionStart.level = world.level;
  const pickTarget = (n: ScopedNpc) => { ctx.target = n.id; };

  while ((deadline <= 0 || Date.now() < deadline) && !bot.kicked && !bot.reloadBrain) {
    refreshAttackable();
    const nowT = Date.now();
    if (world.npcs.size > 0 || !bot.inGameAt) lastAnyNpcAt = nowT;

    // --- 1. Que no esté roto ---------------------------------------------------------------------------------------
    // Ciego: el server a veces deja de mandar el scope, o la sesión queda "fantasma" (monstruos pero ninguna exp).
    const farming = !bot.paused && bot.inGameAt > 0;
    const sinceIn = nowT - Math.max(bot.inGameAt, bot.lastArrivalAt);
    const noExp = farming && sinceIn > BLIND_RECONNECT_MS && expLog.perMin(nowT, BLIND_RECONNECT_MS) === 0 && world.map !== 0;
    if (noExp || nowT - Math.max(lastAnyNpcAt, bot.lastArrivalAt) > BLIND_RECONNECT_MS) {
      decide(noExp ? `${BLIND_RECONNECT_MS / 60_000} min sin nada de exp en ${mapName(world.map)}: reconecto.` : `Sin ningún monstruo a la vista hace ${BLIND_RECONNECT_MS / 60_000} min en ${mapName(world.map)}: reconecto.`, { kind: 'system', reason: 'blind' });
      bot.blind = true;
      bot.kicked = true;
      closeSockets();
      break;
    }
    if (bot.inGameAt > 0 && nowT - lastTickAt >= TICK_MS) dataTick(ctx);

    // Corte de trabas: 15 s caminando sin moverse → suelta el objetivo; si repite enseguida, vuelve a entrar al mapa.
    if (ctx.stuckSince && nowT - ctx.stuckSince > STUCK_BREAK_MS) {
      ctx.stuckStrikes = nowT - lastStuckBreak < 90_000 ? ctx.stuckStrikes + 1 : 1;
      lastStuckBreak = nowT;
      decide(`Trabado ${Math.round((nowT - ctx.stuckSince) / 1000)} s en (${world.x},${world.y}) ${mapName(world.map)} (${bot.doing}): ${ctx.stuckStrikes >= 2 ? 'vuelvo a entrar al mapa' : 'suelto el objetivo'}.`, { kind: 'stuck' });
      trackEvent('walk_stuck', bot.doing, ctx.stuckStrikes, 0, { x: world.x, y: world.y, map: world.map });
      if (ctx.target != null) unreachable.add(ctx.target);
      ctx.target = null;
      ctx.walkStuck = 0;
      ctx.stuckSince = 0;
      if (ctx.stuckStrikes >= 2 && bot.currentSpot) { await warpAndWait(bot.currentSpot); ctx.stuckStrikes = 0; }
      continue;
    }

    // Buffs propios: mago Soul Barrier (16) cada ~50 s; caballero Swell Life (48) cada ~55 s.
    if (isMage() && world.skills.has(16) && nowT - lastBarrierAt > 50_000 && world.maxMana > 0 && world.mana / world.maxMana > 0.2 && nowT - ctx.lastCastAt > SKILL_PACE_MS) {
      lastBarrierAt = nowT; ctx.lastCastAt = nowT;
      sendTargetedSkill(world.skills.get(16)!.index, bot.playerId);
      await sleep(humanPace(SKILL_PACE_MS));
    }
    if (!isMage() && world.skills.has(48) && skillLevelOk(48) && nowT - lastSwellAt > SWELL_LIFE_MS && world.mana >= (SKILL_TABLE.get(48)?.mana ?? 0) && nowT - ctx.lastCastAt > SKILL_PACE_MS) {
      lastSwellAt = nowT; ctx.lastCastAt = nowT;
      sendTargetedSkill(world.skills.get(48)!.index, bot.playerId);
      await sleep(humanPace(SKILL_PACE_MS));
    }

    if (checkSurvival()) {
      potionsDrunk++;
      await sleep(200);
      continue;
    }
    // Huir con poca vida (sin pociones): en Atlans Capitan quedó parado con 9 monstruos encima y bajó de 526 a 113 de vida en 16 s
    // porque no podía pelear con ellos. Con monstruos cerca y la vida por debajo del límite, warp al pueblo y esperar a recuperarse.
    if (world.maxHp > 0) {
      const pct = world.hp / world.maxHp;
      const attackers = [...world.npcs.values()].filter((m) => chebyshev(m.x, m.y, world.x, world.y) <= 6 && !isSafeZone(world.map, m.x, m.y)).length;
      // En el pueblo con poca vida no se sale a farmear: se descansa hasta el 70 % (al reiniciar el bot, por ejemplo).
      const resting = isSafeZone(world.map, world.x, world.y) && pct < RECOVER_TO && !attackers;
      if (!fleeing && (resting || (pct < FLEE_BELOW && attackers))) {
        fleeing = true;
        decide(resting ? `Descanso en el pueblo: vida al ${Math.round(pct * 100)} %, salgo al ${Math.round(RECOVER_TO * 100)} %.` : `Huyo: vida al ${Math.round(pct * 100)} % (límite ${Math.round(FLEE_BELOW * 100)} %) con ${attackers} monstruo(s) encima en ${bot.currentSpot?.name ?? mapName(world.map)}.`, { kind: 'flee', pct: Math.round(pct * 100), attackers });
        if (!resting) trackEvent('flee', mapName(world.map), Math.round(pct * 100), attackers, { map: world.map, x: world.x, y: world.y, spot: bot.currentSpot?.name ?? null });
      }
      if (fleeing) {
        ctx.target = null;
        if (pct >= RECOVER_TO) { fleeing = false; decide(`Recuperado (${Math.round(pct * 100)} %): vuelvo a ${bot.currentSpot?.name ?? 'mi spot'}.`, { kind: 'flee' }); }
        else {
          bot.doing = `recuperando vida (${Math.round(pct * 100)} %)`;
          // Huir no espera los 15 s de siempre entre warps: con monstruos encima cada segundo cuenta.
          if (!isSafeZone(world.map, world.x, world.y) && Date.now() - bot.lastWarpAt > FLEE_WARP_MS) await warpAndWait(warp(2));
          await sleep(1000);
          continue;
        }
      }
    }
    if (bot.retarget) {
      bot.retarget = false;
      ctx.target = null;
      lootState.looting = null;
    }
    if (bot.paused) {
      ctx.phase = 'wait';
      // Orden "pueblo": va a Lorencia y se queda en pausa (orden del panel).
      if (bot.townNow) {
        bot.townNow = false;
        if (world.map !== 0) await warpAndWait(warp(2));
      }
      await sleep(500);
      continue;
    }

    if (D.scoutShops && (await scoutShopsStep(ctx))) continue;

    // --- 2. Puntos -------------------------------------------------------------------------------------------------
    investStatPointsInBackground((n) => { statPointsSpent += n; });

    // --- 3. Ir al spot ---------------------------------------------------------------------------------------------
    const place = choosePlace();
    if (!place) { bot.doing = 'esperando stats y vida'; await sleep(500); continue; }
    if (await travelTo(place)) { ctx.target = null; await sleep(500); continue; }
    // Camino al spot: si hay monstruos al paso (a 8 tiles), se pelea con ellos en vez de pasar entre medio.
    if (farFrom(place, 4) && (ctx.target == null || !ctx.npcs.has(ctx.target))) {
      const onTheWay = [...ctx.npcs.values()].filter((m) => !unreachable.has(m.id) && chebyshev(m.x, m.y, world.x, world.y) <= WAY_TILES);
      const t = onTheWay.reduce<ScopedNpc | null>((b, m) => (b == null || chebyshev(m.x, m.y, world.x, world.y) < chebyshev(b.x, b.y, world.x, world.y) ? m : b), null);
      if (t) pickTarget(t);
    }
    if (farFrom(place, 4) && (ctx.target == null || !ctx.npcs.has(ctx.target))) {
      bot.doing = `yendo a ${place.name}`;
      bot.goalPoint = [place.anchor.x, place.anchor.y];
      ctx.phase = 'walk';
      castOnTheWay(ctx);
      await walkTowards(ctx, place.anchor.x, place.anchor.y);
      continue;
    }

    // --- 4. Loot (salvo con un objetivo a distancia de golpe) ------------------------------------------------------
    const targetInMelee = ctx.target != null && ctx.npcs.has(ctx.target) && chebyshev(world.x, world.y, ctx.npcs.get(ctx.target)!.x, ctx.npcs.get(ctx.target)!.y) <= 1;
    if (!targetInMelee && (await lootStep(true, false))) {
      ctx.phase = 'walk';
      bot.doing = `levantando loot en ${mapName(world.map)}`;
      continue;
    }

    // --- 5. Objetivo: el de más valor del spot ---------------------------------------------------------------------
    if (ctx.target != null && !ctx.npcs.has(ctx.target)) ctx.target = null;
    if (ctx.target == null) {
      const t = bestIn(place, ctx.npcs.values(), unreachable.has);
      if (t) pickTarget(t);
    }

    // --- 6. Pelear / acercarse / esperar ---------------------------------------------------------------------------
    if (ctx.target != null) {
      const target = ctx.target;
      const t = ctx.npcs.get(target)!;
      const tDist = chebyshev(world.x, world.y, t.x, t.y);
      ctx.phase = 'fight';
      const reachSkill = pickAttackSkill();
      const inReach = tDist <= (reachSkill ? castReach(reachSkill.number) : 1);
      // El cartel dice lo que hace de verdad: "peleando" solo al alcance; si no, está yendo hacia el monstruo.
      bot.doing = `${inReach ? 'peleando con' : 'yendo a'} ${monsterName(t.type)} en ${mapName(world.map)} (${world.x},${world.y})`;
      if (inReach) {
        if (attackTarget !== target) {
          attackTarget = target;
          attackSince = Date.now();
        } else if (Date.now() - attackSince > TARGET_NO_KILL_MS) {
          log(`Objetivo ${target} (${monsterName(t.type)}) no muere en ${TARGET_NO_KILL_MS / 1000} s de golpes: lo abandono.`);
          unreachable.add(target);
          ctx.target = null;
          attackTarget = null;
          continue;
        }
        const sinceCast = Date.now() - ctx.lastCastAt;
        if (sinceCast < SKILL_PACE_MS && pickAttackSkill()) {
          await sleep(SKILL_PACE_MS - sinceCast);
          continue;
        }
        if (useSkill(target)) {
          ctx.lastCastAt = Date.now();
          ctx.skillsUsed++;
          await sleep(humanPace(SKILL_PACE_MS));
        } else if (tDist <= 1) {
          sendHit(target, directionTowards(world.x, world.y, t.x, t.y));
          await sleep(humanPace(ATTACK_PACE_MS));
        } else {
          // Sin maná para el skill y a más de 1 tile: se acerca a pegar a mano (esperar parado a que vuelva el maná rendía la mitad).
          bot.doing = `sin maná: acercándome a pegarle a ${monsterName(t.type)}`;
          ctx.phase = 'walk';
          await walkTowards(ctx, t.x, t.y);
        }
        continue;
      }
      attackTarget = null;
      // Acercarse por el camino del terreno, girando con lo que esté a <= 3. Si no avanza, el corte de trabas lo suelta.
      castOnTheWay(ctx);
      await walkTowards(ctx, t.x, t.y);
      continue;
    }

    // Sin objetivo: esperar en el ancla del spot.
    bot.goalPoint = [place.anchor.x, place.anchor.y];
    if (chebyshev(world.x, world.y, place.anchor.x, place.anchor.y) > 2) {
      bot.doing = `volviendo a ${place.name}`;
      ctx.phase = 'walk';
      await walkTowards(ctx, place.anchor.x, place.anchor.y);
    } else {
      bot.doing = `esperando monstruos en ${place.name}`;
      ctx.phase = 'wait';
      await sleep(400);
    }
  }

  EventBus.off('ObjectGotKilled', onKilled);
  EventBus.off('ExperienceGained', onExp);
  EventBus.off('CurrentHealthAndShield', onHp);
  stopWatchingDrops();
  drops.clear();
  lootState.looting = null;
  log(`\nFin del loop: ${kills} kill(s), +${totalExpGained} exp, ${potionsDrunk} pocion(es), ${statPointsSpent} stat(s), ${ctx.skillsUsed} skill(s), ${deaths} muerte(s).`);
  log(`Posición final (${world.x},${world.y}) map=${world.map}. Desconectado: ${bot.kicked}`);
  return { kills, totalExpGained, potionsDrunk, statPointsSpent, skillsUsed: ctx.skillsUsed, deaths };
}
