/**
 * El loop de un bot. Un tick:
 *   1. si algo anda mal (ciego, trabado, vida baja, pausa, PK), arreglarlo;  2. cacería de dorados si hay invasión;
 *   3. resetear al nivel 400 y repartir puntos;  4. ir al lugar que le toca (place.ts) y quedarse;
 *   5. loot;  6. pegarle a un dorado a la vista o, si no hay, a lo más cercano dentro del lugar.
 * Cada paso puede cortar el tick con `continue`. Todo a ritmo mínimo seguro (config.ts): no se baja.
 */
import { announceGold, drainGold, teammates } from './bus';
import { track, trackEvent } from './telemetry';
import { closeSockets } from './connection';
import { ATTACK_PACE_MS, RESET_LEVEL, SKILL_PACE_MS, TARGET_NO_KILL_MS, UNREACHABLE_MS } from './config';
import { sendHit, sendTargetedSkill } from './actions';
import { SKILL_TABLE, castReach, checkSurvival, goldenSkill, isMage, pickAttackSkill, skillLevelOk, useSkill } from './combat';
import { CORNER, inCorner, nextRoutePoint } from './corner';
import { DRAGON_TYPES, GoldenRule } from './golden';
import { DragonFights, fightData } from './dragon-fight';
import { canFarmMonster, canFight } from './power';
import { partyUp } from './help';
import { huntPick, huntStep, huntWander, onGoldenRequest, stopHunt } from './hunt';
import { decide, journal, panelLog } from './journal';
import { drops, lootState, lootStep, watchDrops } from './loot';
import { castOnTheWay, newLoopCtx, walkTowards, type LoopCtx } from './loop-ctx';
import { EventBus } from './net/eventBus';
import { CurrentHealthAndShieldPacket, ExperienceGainedPacket, ObjectGotKilledPacket } from './packets';
import { currentMode, sessionStart, setLoopView } from './panel';
import { mapName } from './panel-logic';
import { farFrom, fighterNow, followsLeader, isStrong, travelTo, type Place } from './place';
import { strategy } from './strategy';
import { D } from './directivas';
import { scoutShopsStep } from './shop-scout';
import { doReset, investStatPointsInBackground } from './progress';
import { GOLDEN_TYPES, bot, expLog, isGolden, isMate, monsterName, world, type ScopedNpc } from './state';
import { warpAndWait } from './warps';
import { isSafeZone } from './terrain';
import { chebyshev, directionTowards, humanPace, log, sleep } from './util';
import { watchMoney } from './world';

const SWELL_LIFE_MS = 55_000;
// La muerte llega por dos lados (HP 0 y ObjectGotKilled): dentro de esta ventana es una sola.
const LEARN_DEATH_DEBOUNCE_MS = 15_000;
// Ningún monstruo a la vista durante esto = el server dejó de mandar el scope: reconectar.
const BLIND_RECONNECT_MS = 3 * 60_000;
// 15 s caminando sin moverse = traba (pared, objetivo inalcanzable): suelta el objetivo; si repite, vuelve a entrar al mapa.
const STUCK_BREAK_MS = 15_000;
// Foto a la base cada 5 s.
const TICK_MS = 5_000;

let lastTickAt = 0;
let lastStuckBreak = 0;
let economyWatched = false;
let lastDeathAt = -Infinity;

// Totales de todas las sesiones (el loop corre una vez por conexión).
export type LoopResult = { kills: number; totalExpGained: number; potionsDrunk: number; statPointsSpent: number; skillsUsed: number; resets: number; deaths: number };

function dataTick(ctx: LoopCtx) {
  const now = Date.now();
  lastTickAt = now;
  const near = (q: { x: number; y: number }, d: number) => Math.hypot(q.x - world.x, q.y - world.y) <= d;
  const mates = [...world.players.values()].filter((q) => q.name != null && isMate(q.name));
  track('ticks', {
    map: world.map, x: world.x, y: world.y, level: world.level, resets: world.resets ?? 0,
    exp_total: ctx.expTotal, exp_min_1m: expLog.perMin(now, 60_000),
    hp: Math.max(0, world.hp), mp: Math.max(0, world.mana),
    mode: currentMode(), phase: ctx.phase,
    mates_near: mates.filter((q) => near(q, 15)).length,
    monsters_near: [...ctx.npcs.values()].filter((m) => near(m, 8)).length,
    in_party: bot.inParty ? 1 : 0, doing: bot.doing,
    mate_spot: mates.some((q) => near(q, 8)) ? 1 : mates.length ? 2 : 0,
  }, now);
}

/** Lo más cercano a mí dentro del lugar (ancla + radio), sin los marcados inalcanzables. */
function nearestIn(place: Place, npcs: Iterable<ScopedNpc>, skip: (id: number) => boolean): ScopedNpc | null {
  let best: ScopedNpc | null = null;
  let bd = Infinity;
  for (const m of npcs) {
    if (skip(m.id) || chebyshev(m.x, m.y, place.anchor.x, place.anchor.y) > place.radius) continue;
    const d = chebyshev(m.x, m.y, world.x, world.y);
    // Con valor por tipo (Slow): el de más valor por distancia (valor / (d + 8)); sin él, el más cercano (Fast).
    const score = strategy.targetValue ? -strategy.targetValue(m.type) / (d + 8) : d;
    if (score < bd) { bd = score; best = m; }
  }
  return best;
}

// Hasta `deadline` (0 = sin límite) o hasta que se corte la conexión.
export async function autonomousLoop(deadline: number): Promise<LoopResult> {
  log(`\n--- Modo autónomo: ${deadline ? `hasta ${new Date(deadline).toLocaleTimeString()}` : 'sin límite'} ---`);
  const ctx = newLoopCtx();

  // Monstruos atacables: los de world.npcs fuera de zona segura. Un personaje que no aguanta la esquina solo ataca lo que
  // su poder permite; los dorados los decide la regla de dorados.
  const refreshAttackable = () => {
    ctx.npcs = new Map();
    const f = fighterNow();
    const strong = isStrong();
    for (const [id, n] of world.npcs) {
      if (isSafeZone(world.map, n.x, n.y)) continue;
      if (strong !== true && !isGolden(n) && !canFarmMonster(f, n.type, world.skills.has(41))) continue;
      ctx.npcs.set(id, n);
    }
  };

  let totalExpGained = 0, kills = 0, potionsDrunk = 0, statPointsSpent = 0, resets = 0, deaths = 0;
  let nextResetTry = 0, lastBarrierAt = 0, lastSwellAt = 0, ticks = 0;
  let lastAnyNpcAt = Date.now();
  let attackTarget: number | null = null;
  let attackSince = 0;
  let routeIdx: number | null = null;
  const golden = new GoldenRule();
  const goldAnnounced = new Set<number>();
  const fights = new DragonFights();
  const endFight = (e: ReturnType<DragonFights['expire']>[number] | null) => {
    if (e) trackEvent('dragon_fight', monsterName(e.type), e.type, e.mine ? 1 : 0, { ...fightData(e), map: world.map });
  };

  // Muerte propia: llega por dos lados (HP a 0 y ObjectGotKilled con nuestro id); dentro de la ventana es una sola.
  const onDeath = (source: string) => {
    if (Date.now() - lastDeathAt < LEARN_DEATH_DEBOUNCE_MS) return;
    lastDeathAt = Date.now();
    deaths++;
    log(`Muerte #${deaths} (${source}) en ${bot.currentSpot?.name ?? 'spot desconocido'}.`);
    bot.currentSpot = null; // el respawn es en el pueblo: el lugar vuelve a decidir a dónde ir
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
    const dead = world.npcs.get(id);
    // Dorado muerto a la vista y quién lo mató: "vistos contra matados".
    if (dead && GOLDEN_TYPES.has(dead.type)) {
      const kid = p.KillerId & 0x7fff;
      const mine = kid === bot.playerId;
      if (DRAGON_TYPES.has(dead.type)) endFight(fights.killed(id, Date.now(), mine ? bot.charName : world.players.get(kid)?.name ?? null, mine));
      trackEvent('golden_kill', monsterName(dead.type), dead.type, mine ? 1 : 0, { gx: dead.x, gy: dead.y, killer: mine ? bot.charName : world.players.get(kid)?.name ?? null, hunting: !!bot.hunting });
    }
    world.npcs.delete(id);
    ctx.npcs.delete(id);
    if (id === bot.playerId) {
      const kid = p.KillerId & 0x7fff;
      const killer = world.players.get(kid);
      const by = killer ? `${killer.name ?? 'jugador #' + kid}` : world.npcs.has(kid) ? monsterName(world.npcs.get(kid)!.type) : `#${kid}`;
      decide(`Me mató ${by}.`);
      trackEvent('death', by, kid, killer ? 1 : 0, { killer: killer?.name ?? null, npc: killer ? null : world.npcs.get(kid)?.type ?? null });
      onDeath('ObjectGotKilled');
    } else if ((p.KillerId & 0x7fff) === bot.playerId) kills++;
  };
  // ExperienceGained: un kill de más de 65535 llega partido en ~60 packets; ExpLog los agrega por segundo.
  const onExp = (raw: any) => {
    const added = new ExperienceGainedPacket(raw).AddedExperience;
    totalExpGained += added;
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
  const pickTarget = (n: { id: number }) => { ctx.target = n.id; };

  while ((deadline <= 0 || Date.now() < deadline) && !bot.kicked) {
    refreshAttackable();
    const nowT = Date.now();
    if (world.npcs.size > 0 || !bot.inGameAt || bot.resetting) lastAnyNpcAt = nowT;

    // --- 1. Que no esté roto ---------------------------------------------------------------------------------------
    // Ciego: el server a veces deja de mandar el scope, o la sesión queda "fantasma" (monstruos pero ninguna exp).
    const farming = !bot.paused && !bot.resetting && !bot.hunting && bot.inGameAt > 0;
    const sinceIn = nowT - Math.max(bot.inGameAt, bot.lastArrivalAt);
    const noExp = farming && sinceIn > BLIND_RECONNECT_MS && expLog.perMin(nowT, BLIND_RECONNECT_MS) === 0 && world.map !== 0;
    if (noExp || nowT - Math.max(lastAnyNpcAt, bot.lastArrivalAt) > BLIND_RECONNECT_MS) {
      decide(noExp ? `${BLIND_RECONNECT_MS / 60_000} min sin nada de exp en ${mapName(world.map)}: reconecto.` : `Sin ningún monstruo a la vista hace ${BLIND_RECONNECT_MS / 60_000} min en ${mapName(world.map)}: reconecto.`);
      journal('travel', 'reconecto: sin monstruos a la vista', { map: world.map, reason: 'blind' });
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
      decide(`Trabado ${Math.round((nowT - ctx.stuckSince) / 1000)} s en (${world.x},${world.y}) ${mapName(world.map)} (${bot.doing}): ${ctx.stuckStrikes >= 2 ? 'vuelvo a entrar al mapa' : 'suelto el objetivo'}.`);
      trackEvent('walk_stuck', bot.doing, ctx.stuckStrikes, 0, { x: world.x, y: world.y, map: world.map });
      if (ctx.target != null) unreachable.add(ctx.target);
      ctx.target = null;
      ctx.walkStuck = 0;
      ctx.stuckSince = 0;
      if (bot.hunting) { bot.hunting.explorer.reset(); bot.hunting.zonesVisited = new Set(); }
      if (ctx.stuckStrikes >= 2 && bot.currentSpot) { await warpAndWait(bot.currentSpot); ctx.stuckStrikes = 0; }
      continue;
    }
    ticks++;

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
    if (bot.retarget) {
      bot.retarget = false;
      ctx.target = null;
      lootState.looting = null;
    }
    if (bot.paused) {
      ctx.phase = 'wait';
      await sleep(500);
      continue;
    }
    // --- 2. Compañeros y cacería de dorados ------------------------------------------------------------------------
    partyUp();
    const strong = isStrong();
    for (const r of drainGold()) if (strategy.hunts) onGoldenRequest(r, strong === false);
    for (const n of ctx.npcs.values()) {
      if (!DRAGON_TYPES.has(n.type)) continue;
      const near = [...world.players.values()].filter((q) => q.name != null && chebyshev(q.x, q.y, n.x, n.y) <= 15);
      const mates = near.filter((q) => isMate(q.name!)).length + 1; // yo también
      fights.seen(n.id, n.type, n.x, n.y, nowT, mates, near.length - (mates - 1), bot.dragonMap && Math.abs(nowT - bot.dragonMap.at) < 20 * 60_000 ? bot.dragonMap.at : null);
    }
    for (const e of fights.expire(nowT)) endFight(e);
    if (bot.hunting && !strategy.hunts) stopHunt(`en el ${strategy.server} no se caza`);
    if (bot.hunting && strong === false && followsLeader()) stopHunt('sigo a mi líder');
    // El débil con un líder que vale la pena no sale a cazar solo: lo sigue (place.ts) y caza como su sombra.
    if (strategy.hunts && strong != null && !(strong === false && followsLeader()) && (await huntStep(ctx, strong === false))) continue;

    if (D.scoutShops && (await scoutShopsStep(ctx))) continue;

    // --- 3. Reset y puntos -----------------------------------------------------------------------------------------
    const goldHold = !!bot.hunting || golden.holding(nowT);
    if (strategy.resets && !goldHold && world.level >= RESET_LEVEL && nowT >= nextResetTry) {
      if (await doReset()) {
        resets++;
        ctx.target = null;
        log(`Reset hecho (${world.resets ?? '?'}).`);
      } else nextResetTry = Date.now() + 2 * 60_000;
      continue;
    }
    if (strategy.spendsPoints) investStatPointsInBackground((n) => { statPointsSpent += n; });

    // --- 4. Ir al lugar --------------------------------------------------------------------------------------------
    const place = bot.hunting ? null : strategy.choosePlace();
    if (!bot.hunting && !place) { bot.doing = 'esperando stats y vida'; await sleep(500); continue; }
    if (place) {
      if (await travelTo(place, { sameMapWarp: strategy.sameMapWarp })) { ctx.target = null; await sleep(500); continue; }
      // La esquina tiene un camino desde la llegada (directo cortaba por los monstruos); el resto, en línea al ancla.
      if (place.kind === 'corner' && !inCorner({ x: world.x, y: world.y })) {
        ctx.target = null;
        const next = nextRoutePoint({ x: world.x, y: world.y }, routeIdx);
        routeIdx = next.idx;
        bot.doing = `camino a ${place.name} (${next.x},${next.y})`;
        ctx.phase = 'walk';
        castOnTheWay(ctx);
        await walkTowards(ctx, next.x, next.y);
        continue;
      }
      if (place.kind !== 'corner' && farFrom(place, 4) && (ctx.target == null || !ctx.npcs.has(ctx.target))) {
        bot.doing = `yendo a ${place.name}`;
        bot.goalPoint = [place.anchor.x, place.anchor.y];
        ctx.phase = 'walk';
        castOnTheWay(ctx);
        await walkTowards(ctx, place.anchor.x, place.anchor.y);
        continue;
      }
    }

    // --- 5. Loot (salvo con un objetivo a distancia de golpe) ------------------------------------------------------
    const targetInMelee = ctx.target != null && ctx.npcs.has(ctx.target) && chebyshev(world.x, world.y, ctx.npcs.get(ctx.target)!.x, ctx.npcs.get(ctx.target)!.y) <= 1;
    if (!targetInMelee && (await lootStep(strategy.lootAll, false))) {
      ctx.phase = 'walk';
      bot.doing = `levantando loot en ${mapName(world.map)}`;
      continue;
    }

    // --- 6. Objetivo: un dorado manda; si no, lo más cercano del lugar ---------------------------------------------
    if (ctx.target != null && !ctx.npcs.has(ctx.target)) ctx.target = null;
    const me = strong === true ? null : fighterNow();
    let gold: ScopedNpc | null = null;
    if (bot.hunting) {
      const hp = await huntPick(ctx, unreachable, (t) => !me || canFight(me, t));
      if (hp.walked) continue;
      gold = hp.gold;
      // Cazando no se pelea con comunes: cada golpe frena y lo único que importa es llegar al próximo dorado.
      if (!gold && ctx.target != null && !isGolden(ctx.npcs.get(ctx.target)!)) ctx.target = null;
    } else gold = golden.pick({ x: world.x, y: world.y }, ctx.npcs.values(), (t) => GOLDEN_TYPES.has(t) && (!me || canFight(me, t)), nowT, ctx.target);
    if (gold && ctx.target !== gold.id) {
      if (!goldAnnounced.has(gold.id)) {
        goldAnnounced.add(gold.id);
        decide(`Dorado: ${monsterName(gold.type)} a la vista en (${gold.x},${gold.y}): lo ataco.`);
        // Avisar a los compañeros: si pueden, vienen (hunt.ts).
        if (teammates().length && announceGold(world.map, gold.x, gold.y, `${monsterName(gold.type)} en ${mapName(world.map)}`, 15_000, DRAGON_TYPES.has(gold.type)))
          decide(`Aviso al equipo del ${monsterName(gold.type)} en ${mapName(world.map)}.`);
      }
      pickTarget(gold);
    } else if (gold && DRAGON_TYPES.has(gold.type) && teammates().length) {
      // Mientras dura la pelea con un dragón se repite el aviso (con su posición actual): llegan los que lo perdieron o se conectaron después.
      announceGold(world.map, gold.x, gold.y, `${monsterName(gold.type)} en ${mapName(world.map)}`, 30_000, true);
    } else if (ctx.target == null && place) {
      const t = nearestIn(place, ctx.npcs.values(), unreachable.has);
      if (t) pickTarget(t);
    }

    // --- 7. Pelear / acercarse / esperar ---------------------------------------------------------------------------
    if (ctx.target != null) {
      const target = ctx.target;
      const t = ctx.npcs.get(target)!;
      const tDist = chebyshev(world.x, world.y, t.x, t.y);
      ctx.phase = 'fight';
      bot.doing = `peleando con ${monsterName(t.type)} en ${mapName(world.map)} (${world.x},${world.y})`;
      const reachSkill = pickAttackSkill();
      if (tDist <= (reachSkill ? castReach(reachSkill.number) : 1)) {
        if (attackTarget !== target) {
          attackTarget = target;
          attackSince = Date.now();
        } else if (!isGolden(t) && Date.now() - attackSince > TARGET_NO_KILL_MS) {
          // Los dorados tienen mucha vida: a esos no se los abandona por tiempo.
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
        if (useSkill(target, isGolden(t) ? goldenSkill() : undefined)) {
          ctx.lastCastAt = Date.now();
          if (DRAGON_TYPES.has(t.type)) fights.hit(target, ctx.lastCastAt);
          ctx.skillsUsed++;
          await sleep(humanPace(SKILL_PACE_MS));
        } else if (tDist <= 1) {
          sendHit(target, directionTowards(world.x, world.y, t.x, t.y));
          await sleep(humanPace(ATTACK_PACE_MS));
        } else {
          await sleep(humanPace(SKILL_PACE_MS)); // sin maná para el skill: esperar en vez de pegar de lejos
        }
        continue;
      }
      attackTarget = null;
      // Acercarse por el camino del terreno, girando con lo que esté a <= 3. Si no avanza, el corte de trabas lo suelta.
      castOnTheWay(ctx);
      await walkTowards(ctx, t.x, t.y);
      continue;
    }

    // Sin objetivo. Cazando: al dorado recordado, a una zona o recorrer el mapa. Si no: esperar en el ancla del lugar.
    if (bot.hunting) {
      if (await huntWander(ctx)) continue;
    } else if (place) {
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
      continue;
    }
    await sleep(300);
  }

  EventBus.off('ObjectGotKilled', onKilled);
  EventBus.off('ExperienceGained', onExp);
  EventBus.off('CurrentHealthAndShield', onHp);
  stopWatchingDrops();
  drops.clear();
  lootState.looting = null;
  log(`\nFin del loop: ${kills} kill(s), +${totalExpGained} exp, ${potionsDrunk} pocion(es), ${statPointsSpent} stat(s), ${ctx.skillsUsed} skill(s), ${resets} reset(s), ${deaths} muerte(s).`);
  log(`Posición final (${world.x},${world.y}) map=${world.map}. Desconectado: ${bot.kicked}`);
  return { kills, totalExpGained, potionsDrunk, statPointsSpent, skillsUsed: ctx.skillsUsed, resets, deaths };
}
