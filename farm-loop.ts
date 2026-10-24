/**
 * Loop autónomo, lo más simple posible. Un tick, en este orden (cada paso puede cortarlo con `continue`):
 *   reconectar si está ciego > corte de trabas > buffs > sobrevivir > pausa/PK > warp pedido > ayuda a un compañero >
 *   baúl/equipo > reset > stats > cambio de spot (ruta fija) > loot > elegir objetivo (dorado a la vista, si no
 *   campamento) > pelear / caminar > sin objetivo: campamento o explorar.
 * Quién fija el spot lo dice `intent.ts`; cooperar con un compañero está en `help.ts`. Una corrida por conexión, a
 * ritmo HUMANO (no flood): ver config.ts y AGENTS.md, "Anti-cheat".
 */
import { askHelp, newRequests, teammates } from './team';
import { sendServerCommand } from './chat';
import { insights } from './insights';
import { PK_RECOVERY } from './recovery';
import { track, trackEvent } from './telemetry';
import { closeSockets } from './connection';
import { ATTACK_PACE_MS, ATTACK_SKILL_POOL, BUILD, BUILD_ARG, EXPLORE_PREF, HEAL_AT_PCT, RESET_LEVEL, SKILL_PACE_MS, TARGET_NO_KILL_MS, UNREACHABLE_MS } from './config';
import { sendHit, sendTargetedSkill } from './actions';
import { SKILL_TABLE, castReach, checkSurvival, goldenSkill, isMage, pickAttackSkill, skillLevelOk, useSkill } from './combat';
import { CORNER, cornerTarget, inCorner, nextRoutePoint } from './corner';
import { GoldenRule } from './golden';
import { parseFight } from './fight-heat';
import { canFight } from './power';
import { farmMiddleware, statPower } from './farm-middleware';
import { ownAreaSkill, ownTargetedSkill } from './protocol097';
import { GOLDEN_TYPES, isMate } from './state';
import { partyUp } from './help';
import { huntPick, huntStep, huntWander, onGoldenRequest, stopHunt } from './hunt';
import { pin } from './intent';
import { toBytes } from './util';
import { EXPLORE, Explorer } from './explore';
import { classFamily, isFreshChar } from './farming';
import { decide, journal, panelLog } from './journal';
import { LEARN } from './learning';
import { drops, lootState, lootStep, watchDrops } from './loot';
import { castOnTheWay, newLoopCtx, walkTowards, type LoopCtx } from './loop-ctx';
import { EventBus } from './net/eventBus';
import { CurrentHealthAndShieldPacket, ExperienceGainedPacket, ObjectGotKilledPacket } from './packets';
import { currentMode, sessionStart, setLoopView } from './panel';
import { mapName } from './panel-logic';
import { doReset, investStatPointsInBackground } from './progress';
import { SAVE_EVERY_MS, WARP_COOLDOWN_MS, WARP_SPOTS, dryAt, maybeChangeSpot, persistLearning, seedRouteFromDb, warpAndWait } from './route';
import { bot, expLog, expTracker, hotGrid, isGolden, learned, monsterName, pkGuard, typeStats, world, type ScopedNpc } from './state';
import { isSafeZone } from './terrain';
import { chebyshev, directionTowards, humanPace, log, sleep } from './util';
import { watchMoney } from './world';

const SWELL_LIFE_MS = 55_000;
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
let castSkill = 0;
let aggroTarget: Map<number, number> | null = null;
let aggroHooked = false;

// Totales de todas las sesiones (el loop corre una vez por conexión).
export type LoopResult = { kills: number; totalExpGained: number; potionsDrunk: number; statPointsSpent: number; skillsUsed: number; resets: number; deaths: number };

// Kills por tipo (curiosidad: tipos con < 3 kills medidos van primero).
const typeKills: Record<number, number> = {};

function dataTick(ctx: LoopCtx) {
  const now = Date.now();
  lastTickAt = now;
  insights(now); // mantiene tibia la caché de la base (insights.ts); no espera ni depende de ella
  const near = (q: { x: number; y: number }, d: number) => Math.hypot(q.x - world.x, q.y - world.y) <= d;
  const mates = [...world.players.values()].filter((q) => q.name != null && isMate(q.name));
  track('ticks', {
    map: world.map, x: world.x, y: world.y, level: world.level, resets: world.resets ?? 0,
    exp_total: ctx.expTotal, exp_min_1m: expLog.perMin(now, 60_000),
    hp: Math.max(0, world.hp), mp: Math.max(0, world.mana),
    mode: currentMode(), phase: ctx.phase,
    mates_near: mates.filter((q) => near(q, 15)).length,
    monsters_near: [...ctx.npcs.values()].filter((m) => near(m, 8)).length,
    in_party: bot.inParty ? 1 : 0, skill: castSkill, doing: bot.doing,
    mate_spot: mates.some((q) => near(q, 8)) ? 1 : mates.length ? 2 : 0,
  }, now);
}

// Qué skill tiro de verdad (lo confirma el server) y qué monstruo me pega (paquetes 0x18/0x19).
function hookAggro() {
  if (aggroHooked) return;
  aggroHooked = true;
  let lastOwnSkill: number | null = null;
  const own = (pick: (raw: Uint8Array) => number | null) => (raw: any) => {
    const n = pick(toBytes(raw));
    if (n == null || n === lastOwnSkill) return;
    lastOwnSkill = n;
    log(`Tiro ${SKILL_TABLE.get(n)?.name ?? 'skill ' + n} (${n}).`);
    trackEvent('cast', SKILL_TABLE.get(n)?.name ?? '', n);
    castSkill = n;
  };
  for (const ev of ['AreaSkillAnimation', 'AreaSkillAnimation075', 'AreaSkillAnimation095']) EventBus.on(ev, own((b) => ownAreaSkill(b, bot.playerId & 0x7fff)));
  for (const ev of ['SkillAnimation', 'SkillAnimation075', 'SkillAnimation095']) EventBus.on(ev, own((b) => ownTargetedSkill(b, bot.playerId & 0x7fff)));
  for (const ev of ['ObjectAnimation', 'SkillAnimation', 'SkillAnimation075', 'SkillAnimation095']) {
    EventBus.on(ev, (raw: any) => {
      const f = parseFight(toBytes(raw));
      if (!f) return;
      // Un monstruo le pega a un compañero: cuenta como aggro nuestro para que lo mate el que está cerca.
      const tgt = world.players.get(f.target);
      if (f.attacker !== (bot.playerId & 0x7fff) && tgt?.name && isMate(tgt.name) && world.npcs.has(f.attacker)) aggroTarget?.set(f.attacker, Date.now());
      if (f.target === (bot.playerId & 0x7fff) && world.npcs.has(f.attacker)) aggroTarget?.set(f.attacker, Date.now());
    });
  }
}

// Hasta `deadline` (0 = sin límite) o hasta que se corte la conexión.
export async function autonomousLoop(deadline: number): Promise<LoopResult> {
  log(`\n--- Modo autónomo: ${deadline ? `hasta ${new Date(deadline).toLocaleTimeString()}` : 'sin límite'} ---`);
  log(`Build=${BUILD.join('>')}${BUILD_ARG ? '' : ' (planStats)'} heal<=${HEAL_AT_PCT}% skills=[${ATTACK_SKILL_POOL.join(',')}] ruta fija por tramo`);

  const ctx = newLoopCtx();
  const fighterNow = () => ({ family: classFamily(world.classId) ?? 'knight' as const, stats: world.stats, maxHp: world.maxHp });

  // Monstruos atacables: los de world.npcs que NO están en zona segura (en el pueblo no hay daño: 0 exp). Un
  // personaje limitado (stats por detrás del nivel) solo ataca lo que su poder permite (farm-middleware.ts).
  const refreshAttackable = () => {
    ctx.npcs = new Map();
    const f = fighterNow();
    const limited = isFreshChar(world.resets, world.stats) || farmMiddleware.profile(f, world.level, world.skills.has(41), Date.now()).limited;
    for (const [id, n] of world.npcs) {
      if (isSafeZone(world.map, n.x, n.y)) continue;
      if (limited && !isGolden(n) && !farmMiddleware.target(f, n.type, world.skills.has(41))) continue;
      ctx.npcs.set(id, n);
    }
  };

  let totalExpGained = 0;
  let kills = 0;
  let potionsDrunk = 0;
  let statPointsSpent = 0;
  let resets = 0;
  let deaths = 0;
  let nextResetTry = 0;
  let lastSave = Date.now();
  let lastCycleCheck = 0;
  let lastBarrierAt = 0;
  let lastSwellAt = 0;
  let targetSince = 0;
  let targetType = -1;
  let seededRoute = '';
  let lastAnyNpcAt = Date.now();
  let attackTarget: number | null = null;
  let attackSince = 0;
  let lastGoalTxt = '';
  let explorerMap: number | null = null;
  let ticks = 0;
  let routeIdx: number | null = null;
  const golden = new GoldenRule();
  const goldAnnounced = new Set<number>();
  const explorer = new Explorer(EXPLORE_PREF, EXPLORE, hotGrid);

  // Muerte propia: llega por dos lados (HP a 0 y ObjectGotKilled con nuestro id); dentro de la ventana es una sola.
  // El respawn es en el pueblo: se olvida el spot (canAdopt = false) y la ruta vuelve a warpear.
  const onDeath = (source: string) => {
    if (Date.now() - lastDeathAt < LEARN.DEATH_DEBOUNCE_MS) return;
    lastDeathAt = Date.now();
    deaths++;
    log(`Muerte #${deaths} (${source}) en ${bot.currentSpot?.name ?? 'spot desconocido'}.`);
    if (farmMiddleware.profile(fighterNow(), world.level, world.skills.has(41), Date.now()).limited && farmMiddleware.death(world.map, Date.now()))
      decide(`Muerte en ${mapName(world.map)}: no vuelvo a este mapa por 10 min.`);
    bot.lastSpotIndex = bot.currentSpot?.index ?? bot.lastSpotIndex;
    bot.currentSpot = null;
    bot.canAdopt = false;
    learned.camps.camp = null;
    void persistLearning();
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
    const wasOurTarget = id === ctx.target;
    const dead = world.npcs.get(id);
    // Dorado muerto a la vista y quién lo mató: "vistos contra matados" y quién se queda con los dragones.
    if (dead && GOLDEN_TYPES.has(dead.type)) {
      const kid = p.KillerId & 0x7fff;
      const mine = kid === bot.playerId;
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
      return;
    }
    if ((p.KillerId & 0x7fff) === bot.playerId) {
      kills++;
      // Segundos de kill por tipo: desde que se eligió el objetivo hasta acá.
      if (wasOurTarget) typeStats.recordKillSec(targetType, (Date.now() - targetSince) / 1000);
    }
  };
  // ExperienceGained: un kill de más de 65535 llega partido en ~60 packets con el mismo id: ExpSplitTracker los suma
  // para la exp por tipo (farming.ts) y ExpLog los agrega por segundo.
  const onExp = (raw: any) => {
    const p = new ExperienceGainedPacket(raw);
    const added = p.AddedExperience;
    const now = Date.now();
    totalExpGained += added;
    ctx.expTotal += added;
    expLog.add(added, now); // la exp por segundo que mira todo lo demás (rendimiento, campamentos, ciego)
    const ev = expTracker.onExp(p.KilledObjectId & 0x7fff, added, now);
    if (ev.info && !ev.continuation) typeKills[ev.info.type] = (typeKills[ev.info.type] ?? 0) + 1;
    if (ev.info && ev.info.map === world.map) explorer.onExp(world.map, ev.info.x, ev.info.y, added, now);
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
  hookAggro();
  aggroTarget = ctx.aggro;
  const logCampEvents = () => {
    for (const e of learned.camps.events) log(`Campamento: ${e}.`);
    learned.camps.events = [];
  };
  const pickTarget = (n: { id: number; type: number }) => {
    ctx.target = n.id;
    targetType = n.type;
    targetSince = Date.now();
  };

  while ((deadline <= 0 || Date.now() < deadline) && !bot.kicked) {
    refreshAttackable();
    const nowT = Date.now();
    if (world.npcs.size > 0 || !bot.inGameAt || bot.resetting) lastAnyNpcAt = nowT;

    // Ciego: el server a veces deja de mandar el scope de monstruos, o la sesión queda "fantasma" (monstruos pero
    // ninguna exp). Reconectar lo arregla.
    const farming = !bot.paused && !bot.resetting && !bot.hunting && bot.inGameAt > 0;
    const sinceIn = nowT - Math.max(bot.inGameAt, bot.lastArrivalAt);
    const noExp = farming && sinceIn > BLIND_RECONNECT_MS && expLog.perMin(nowT, BLIND_RECONNECT_MS) === 0 && world.map !== 0;
    if (noExp || nowT - Math.max(lastAnyNpcAt, bot.lastArrivalAt) > BLIND_RECONNECT_MS) {
      bot.blind = true;
      decide(noExp ? `${BLIND_RECONNECT_MS / 60_000} min sin nada de exp en ${mapName(world.map)}: reconecto.` : `Sin ningún monstruo a la vista hace ${BLIND_RECONNECT_MS / 60_000} min en ${mapName(world.map)}: reconecto.`);
      journal('travel', 'reconecto: sin monstruos a la vista', { map: world.map, reason: 'blind' });
      bot.kicked = true;
      closeSockets();
      break;
    }
    if (bot.inGameAt > 0 && nowT - lastTickAt >= TICK_MS) dataTick(ctx);

    // Corte de trabas: 15 s caminando sin moverse → suelta objetivo y campamento; si repite enseguida, vuelve a entrar al mapa.
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
      else if (learned.camps.camp) learned.camps.leave(nowT, world.level, 'trabado caminando', true, expLog);
      if (ctx.stuckStrikes >= 2 && bot.currentSpot && !bot.pendingWarp) { await warpAndWait(bot.currentSpot); ctx.stuckStrikes = 0; }
      continue;
    }
    ticks++;

    // Registro de tramos por ciclo (nivel 20/50/100/.../400) y lo aprendido, cada ~2 min.
    if (nowT - lastCycleCheck >= 2000) {
      lastCycleCheck = nowT;
      if (learned.cycleLog.observe(world.level, nowT).length) void persistLearning();
    }
    if (nowT - lastSave >= SAVE_EVERY_MS) {
      lastSave = nowT;
      await persistLearning();
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

    // Sobrevivir tiene prioridad absoluta.
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
    // Auto-recuperación del PK (recovery.ts): con el aviso del server o varios warps sin respuesta, manda /pkclear.
    {
      const act = pkGuard.next(nowT);
      if (act && 'send' in act) {
        if (sendServerCommand(act.send, nowT)) {
          pkGuard.sent(nowT);
          decide(`PK: mando ${act.send} (intento ${act.tryNo}/${PK_RECOVERY.maxTries}): ${act.why}.`, { tryNo: act.tryNo });
          trackEvent('pk_clear', act.why, act.tryNo);
        }
      } else if (act && 'giveUp' in act) {
        decide(`PK: ${act.giveUp}.`);
        trackEvent('pk_clear', act.giveUp, -1);
      }
    }
    // Warp pedido (panel, ayuda a un compañero).
    if (bot.pendingWarp) {
      const sp = bot.pendingWarp;
      bot.pendingWarp = null;
      bot.doing = `viajando a ${sp.name}`;
      journal('travel', `warp a ${sp.name} (${pin.owner() ?? 'ruta'})`, { warp: sp.index });
      if (!(await warpAndWait(sp))) panelLog(`El warp a ${sp.name} no respondió; lo reintento.`);
      ctx.target = null;
      continue;
    }
    const profile = farmMiddleware.profile(fighterNow(), world.level, world.skills.has(41), nowT);
    learned.camps.setPower(statPower(fighterNow()), profile.spot != null);
    const seedKey = `${world.resets}:${Math.floor(world.level / 80)}`;
    if (profile.spot != null && world.resets != null && seededRoute !== seedKey) {
      seededRoute = seedKey;
      void seedRouteFromDb(world.resets, world.level, statPower(fighterNow()));
    }
    const weak = isFreshChar(world.resets, world.stats) || profile.limited;
    const me = weak ? fighterNow() : null;

    // Compañeros: party con el cercano más débil (help.ts) y avisos de dorados (hunt.ts).
    partyUp();
    for (const r of newRequests()) if (r.kind === 'golden') onGoldenRequest(r, weak);
    // Cacería de dorados (hunt.ts): arrancar con la invasión o un aviso, cortar, viajar al mapa.
    if (await huntStep(ctx, weak)) continue;

    // Reset al llegar al nivel, salvo cazando o con un dorado en juego.
    const goldHold = !!bot.hunting || golden.holding(nowT);
    // La esquina de Arena 2 (corner.ts): desde el nivel 100 hasta el reset, para quien la aguanta, salvo cazando o con el spot fijado.
    const cornerOn = !goldHold && !pin.current() && profile.corner && world.level >= CORNER.minLevel && world.level < RESET_LEVEL;
    if (!goldHold && world.level >= RESET_LEVEL && nowT >= nextResetTry) {
      if (await doReset()) {
        resets++;
        ctx.target = null;
        log(`Reset hecho (${learned.char.resets}).`);
      } else nextResetTry = Date.now() + 2 * 60_000;
      continue;
    }
    // Invertir puntos de atributo cuando junte un lote, en segundo plano (sigue peleando).
    investStatPointsInBackground((n) => { statPointsSpent += n; });

    // Medición neta de la exp (incluye la caminata desde el warp): un mapa que no rinde se deja 10 min.
    if (weak && !cornerOn && !pin.current() && bot.currentSpot && !goldHold) {
      const why = farmMiddleware.observe({ spot: bot.currentSpot.index, map: world.map, level: world.level,
        now: nowT, arrivalAt: bot.lastArrivalAt, rate: expLog.rateSince(bot.lastArrivalAt, nowT), f: fighterNow(), twistingSlash: world.skills.has(41) });
      if (why) {
        decide(`Rendimiento: ${why}.`);
        if (await maybeChangeSpot()) { ctx.target = null; continue; }
      }
    }
    // Ruta fija por tramo: cada 10 ticks (o sin spot) revisa si toca cambiar de mapa.
    if (!goldHold && !cornerOn && (ticks % 10 === 0 || !bot.currentSpot)) {
      if (await maybeChangeSpot()) { ctx.target = null; continue; }
    }

    // Viajar a la esquina y caminar el camino hasta ella.
    if (cornerOn && !inCorner({ x: world.x, y: world.y })) {
      ctx.target = null;
      if (world.map !== CORNER.map) {
        routeIdx = null;
        if (nowT - bot.lastWarpAt < WARP_COOLDOWN_MS) { bot.doing = 'esperando para ir a la esquina de Arena 2'; await sleep(500); continue; }
        bot.doing = `viajando a la esquina de Arena 2 (nivel ${world.level})`;
        journal('travel', `warp a Arena 2 para la esquina (nivel ${world.level})`, { warp: CORNER.warp, reason: 'corner' });
        await warpAndWait(WARP_SPOTS.find((sp) => sp.index === CORNER.warp)!);
        continue;
      }
      const next = nextRoutePoint({ x: world.x, y: world.y }, routeIdx);
      routeIdx = next.idx;
      bot.doing = `camino a la esquina (${next.x},${next.y})`;
      ctx.phase = 'walk';
      castOnTheWay(ctx);
      await walkTowards(ctx, next.x, next.y);
      continue;
    }

    // Loot valioso, salvo con un objetivo a distancia de golpe.
    const targetInMeleeRange = ctx.target != null && ctx.npcs.has(ctx.target) && chebyshev(world.x, world.y, ctx.npcs.get(ctx.target)!.x, ctx.npcs.get(ctx.target)!.y) <= 1;
    if (!targetInMeleeRange && (await lootStep(false, false))) {
      ctx.phase = 'walk';
      bot.doing = `levantando loot en ${mapName(world.map)}`;
      continue;
    }

    // Elegir / mantener objetivo: un dorado a la vista manda (dragones primero); si no, campamento (camp.ts) por exp/s.
    if (ctx.target != null && !ctx.npcs.has(ctx.target)) ctx.target = null;
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
        // Avisar a los compañeros: si pueden, vienen (help.ts).
        if (teammates().length && askHelp('golden', world.map, gold.x, gold.y, `${monsterName(gold.type)} en ${mapName(world.map)}`))
          decide(`Aviso al equipo del ${monsterName(gold.type)} en ${mapName(world.map)}.`);
      }
      pickTarget(gold);
    } else if (ctx.target == null && !bot.hunting && cornerOn) {
      const t = cornerTarget({ x: world.x, y: world.y }, [...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)));
      if (t) pickTarget(t);
    } else if (ctx.target == null && !bot.hunting) {
      const pick = learned.camps.pick({
        now: nowT, map: world.map, me: { x: world.x, y: world.y }, level: world.level,
        monsters: [...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)),
        players: [], stats: typeStats, exp: expLog, typeKills,
      });
      logCampEvents();
      if (pick) pickTarget(pick);
    }
    if (explorerMap !== world.map) {
      explorerMap = world.map;
      explorer.enterMap(world.map, world.x, world.y, nowT);
    }
    if (ctx.npcs.size) explorer.sawMonster(nowT);

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
      // Acercarse por el camino del terreno, girando con lo que esté a <= 3 (no frena la caminata). Si no avanza,
      // el corte de trabas de arriba lo suelta a los 15 s.
      castOnTheWay(ctx);
      await walkTowards(ctx, t.x, t.y);
      continue;
    }

    // Sin objetivo en la esquina: esperar adentro, en el punto de espera.
    if (cornerOn) {
      bot.goalPoint = [CORNER.wait.x, CORNER.wait.y];
      if (chebyshev(world.x, world.y, CORNER.wait.x, CORNER.wait.y) > 2) { bot.doing = 'esperando en la esquina'; ctx.phase = 'walk'; await walkTowards(ctx, CORNER.wait.x, CORNER.wait.y); }
      else { bot.doing = 'esperando monstruos en la esquina'; ctx.phase = 'wait'; await sleep(400); }
      continue;
    }
    // Sin objetivo. Cazando: al dorado recordado, a una zona o recorrer el mapa.
    if (bot.hunting && (await huntWander(ctx))) continue;
    // a) Mapa vacío 90 s: otra entrada del tramo.
    if (explorer.isDry(nowT)) {
      log(`Mapa sin monstruos hace ${EXPLORE.DRY_MAP_MS / 1000} s en ${bot.currentSpot?.name ?? `map ${world.map}`}: busco otro spot.`);
      if (bot.currentSpot) dryAt.set(bot.currentSpot.index, nowT);
      if (!(await maybeChangeSpot({ mapDead: true }))) explorer.resetDry(Date.now());
      continue;
    }
    // b) Campamento (actual, memoria) o volver a la correa.
    const cg = learned.camps.goal(nowT, world.map, { x: world.x, y: world.y }, world.level, expLog);
    logCampEvents();
    if (cg) {
      const txt = `${cg.kind} (${cg.x},${cg.y})`;
      if (txt !== lastGoalTxt) {
        lastGoalTxt = txt;
        log(`Voy a ${txt} desde (${world.x},${world.y}) map=${world.map}.`);
      }
      bot.goalPoint = [cg.x, cg.y];
      if (chebyshev(world.x, world.y, cg.x, cg.y) <= 2) {
        bot.doing = `acampando en ${mapName(world.map)} (${cg.x},${cg.y})`;
        ctx.phase = 'wait';
        await sleep(500);
        continue;
      }
      ctx.phase = 'walk';
      bot.doing = `yendo al ${cg.kind === 'camp' ? 'campamento' : 'punto de llegada'} (${cg.x},${cg.y}) en ${mapName(world.map)}`;
      castOnTheWay(ctx);
      await walkTowards(ctx, cg.x, cg.y);
      continue;
    }
    // c) Explorar: spots calientes y, sin ellos, las salidas del pueblo.
    explorer.setLeash(learned.camps.leashFor(world.map));
    const act = explorer.tick(world.map, world.x, world.y, nowT);
    ctx.phase = act.action === 'wait' ? 'wait' : 'walk';
    bot.goalPoint = [act.goal.x, act.goal.y];
    bot.doing = `explorando ${mapName(world.map)}: ${act.goal.kind === 'hot' ? 'spot caliente' : 'salida'} (${act.goal.x},${act.goal.y})`;
    if (act.action === 'wait') {
      await sleep(500);
      continue;
    }
    castOnTheWay(ctx);
    await walkTowards(ctx, act.x, act.y);
  }

  EventBus.off('ObjectGotKilled', onKilled);
  EventBus.off('ExperienceGained', onExp);
  EventBus.off('CurrentHealthAndShield', onHp);
  stopWatchingDrops();
  await persistLearning();
  drops.clear();
  lootState.looting = null;
  log(`\nFin del loop: ${kills} kill(s), +${totalExpGained} exp, ${potionsDrunk} pocion(es), ${statPointsSpent} stat(s), ${ctx.skillsUsed} skill(s), ${resets} reset(s), ${deaths} muerte(s).`);
  log(`Posición final (${world.x},${world.y}) map=${world.map}. Desconectado: ${bot.kicked}`);
  return { kills, totalExpGained, potionsDrunk, statPointsSpent, skillsUsed: ctx.skillsUsed, resets, deaths };
}
