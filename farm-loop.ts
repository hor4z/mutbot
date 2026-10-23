/**
 * Loop autónomo: prioriza sobrevivir > órdenes del panel > reset > subir stats > esquina de
 * Arena 2 > cambiar de spot > loot > pelear > campamento/explorar. Una corrida por conexión, a
 * ritmo HUMANO (no flood): ver config.ts y AGENTS.md, "Anti-cheat".
 */
import { askHelp, newRequests, postInsight, postScout, scoutCovered, scoutReports, teammates } from './team';
import { SCOUT, buildScoutBody, scoutDanger, scoutFactor, scoutHints } from './scout';
import { sendServerCommand } from './chat';
import { avoidCells, huntFactor, insights, predictDragonMap } from './insights';
import { silentMs } from './liveness';
import { PK_RECOVERY } from './recovery';
import { StuckWatch } from './watchdog';
import { track, trackEvent } from './telemetry';
import { isPriorityChar } from './knowledge';
import { dragonZones, goldenZones, mapsWithZones, nextZone, zoneWeights } from './zones';
import { DRAGON_TYPES } from './golden';
import { closeSockets, sendToGS } from './connection';
import { AUTO_HUNT_ON, ATTACK_PACE_MS, ATTACK_SKILL_POOL, BUILD, BUILD_ARG, EXPLORE_PREF, HEAL_AT_PCT, RESET_LEVEL, SKILL_PACE_MS, TARGET_NO_KILL_MS, UNREACHABLE_MS, WALK_PACE_MS } from './config';
import { sendHit, sendTargetedSkill, step } from './actions';
import { CAMP } from './camp';
import { SKILL_TABLE, castReach, checkSurvival, goldenSkill, isMage, pickAttackSkill, skillLevelOk, useSkill } from './combat';
import { CORNER, cornerActive, inCorner } from './corner';
import { cornerStep, newCornerState, type CornerState } from './corner-step';
import { EARLY, dist, leashedTarget } from './early';
import { EarlyPlanner } from './early-step';
import { DEFENSE, Defense } from './defense';
import { DragonFight, GoldenRule, dragonRush, stickyGolden } from './golden';
import monstersData from './data/monsters.json';
import { canFight, monsterCombat } from './power';
import { farmMiddleware, statPower } from './farm-middleware';
import { ObserverTracker } from './observer';
import { equipStep } from './equip';
import { attackerOf, buildPartyInvite, ownAreaSkill, ownTargetedSkill, parseHitDamage } from './protocol097';
import { GOLDEN_TYPES, MATES, isMate } from './state';
import { WARP_SPOTS, pinActive } from './route';
import { readVault, runEquip } from './vault';
import { toBytes } from './util';
import { EXPLORE, Explorer } from './explore';
import { SelfReport, classFamily, isFreshChar } from './farming';
import { decide, journal, panelLog } from './journal';
import { LEARN, routeTier, type Spot } from './learning';
import { bagRoom, lootState, drops, lootStep, watchDrops } from './loot';
import { castOnTheWay, newLoopCtx, walkTowards, type LoopCtx } from './loop-ctx';
import { squadActive, squadStep } from './squad-client';
import { EventBus } from './net/eventBus';
import { CurrentHealthAndShieldPacket, ExperienceGainedPacket, ObjectGotKilledPacket } from './packets';
import { currentMode, publishGold, sessionStart, setLoopView, stopHunt } from './panel';
import { AUTO_HUNT, GoldReporter, HUNT_MAPS, HuntExplorer, RED_HUNT_MS, autoHuntChoice, huntDryOut, invasionKey, mapName, pickHuntMap, resetBlockedByInvasion, shouldStopHunt } from './panel-logic';
import { doReset, investStatPointsInBackground } from './progress';
import { SAVE_EVERY_MS, WARP_COOLDOWN_MS, dryAt, maybeChangeSpot, persistLearning, seedRouteFromDb, warpAndWait, zenTxt } from './route';
import { bot, expLog, expTracker, hotGrid, isGolden, learned, monsterName, pkGuard, typeStats, world, type HuntState, type ScopedNpc } from './state';
import { isSafeZone, terrainOf, walkableFor } from './terrain';
import { chebyshev, directionTowards, humanPace, log, sleep } from './util';
import { watchMoney } from './world';

// Autoevaluación en consola cada esto (ver SelfReport en farming.ts).
const REPORT_EVERY_MS = 5 * 60_000;
// Cazando, a un monstruo común solo se le pega si está a esto (no frena la búsqueda).
// Cacería: un dorado visto se recuerda 3 min (para volver después de morir) y se le avisa al compañero
// (como mucho un aviso cada 15 s).
const HUNT_SPOT_TTL_MS = 3 * 60_000;
const HUNT_SHARE_MS = 15_000;
const SWELL_LIFE_MS = 55_000;
const DRAGON_MEMORY_MS = 6_000;
let lastRedAt = 0;
let lastDragon: { id: number; x: number; y: number; at: number } | null = null;
// El aviso "[Mapa] Golden invasion!" vale para esa invasión (15 min).
const DRAGON_MAP_TTL_MS = 20 * 60_000;
const freshDragonMap = (now: number) => (bot.dragonMap && now - bot.dragonMap.at < DRAGON_MAP_TTL_MS ? bot.dragonMap.map : null);
// Datos de la base (insights.ts) para elegir mapa: multiplicador por mapa (cajas medidas, muertes, rivales a esta hora)
// y el mapa probable del dragón mientras el server no lo avisó. Sin base (o sin datos suficientes): neutros.
function huntData(now: number) {
  const ins = insights(now);
  const d = new Date(now);
  const m = d.getUTCMinutes();
  const hourUtc = m >= 50 ? d.getUTCHours() : m < 5 ? (d.getUTCHours() + 23) % 24 : (d.getUTCHours() + 1) % 24;
  // Reportes de exploradores (scout.ts): dorados vivos vistos suben el mapa, la competencia lo baja. Sin reportes: 1.
  const reports = scoutReports(now);
  return { factor: (map: number) => huntFactor(ins, map, now) * scoutFactor(reports, map, now), predictedDragon: predictDragonMap(ins, hourUtc, now)?.map ?? null };
}
// Personaje nuevo: no encadena cacerías (no puede con los dorados).
const weakNow = () => isFreshChar(world.resets, world.stats);
const scoutMe = () => ({ family: classFamily(world.classId) ?? 'knight' as const, stats: world.stats, maxHp: world.maxHp });

// Explorador (scout.ts): un tick. Decide si pasa a otro mapa (peligro, muerte, ya vio el mapa), publica a la
// estación cuando toca y devuelve el motivo si hay que dejar de explorar (ningún mapa seguro).
function runScout(h: HuntState, ctx: LoopCtx, now: number, deaths: number): string | null {
  const sc = h.scout!;
  const here = world.map === h.hunt.map;
  const me = scoutMe();
  const threats = here ? [...ctx.npcs.values()].filter((n) => chebyshev(world.x, world.y, n.x, n.y) <= SCOUT.threatRadius && monsterCombat(n.type) && !canFight(me, n.type)).length : 0;
  const hpPct = world.maxHp > 0 ? (world.hp / world.maxHp) * 100 : 100;
  const st = sc.tour.step({ now, map: world.map, level: world.level, weak: weakNow(), deaths, danger: scoutDanger({ hpPct, threats }), lapDone: h.explorer.passes >= 1, covered: scoutCovered(now) });
  if (st.kind === 'stop') return st.why;
  if (st.kind === 'go') {
    h.hunt = st.to;
    h.warpTries = 0;
    h.nextWarpAt = 0;
    h.explorer = new HuntExplorer();
    ctx.target = null;
    decide(`Explorador: paso a ${st.to.name} (${st.why}).`);
    journal('travel', `explorador: ${st.to.name}`, { map: st.to.map, reason: 'scout', why: st.why });
    return null;
  }
  if (here && world.maxHp > 0 && world.hp > 0 && sc.pub.due(now, world.map)) {
    sc.pub.sent(now);
    const others = [...world.players.values()].filter((q) => !(q.name != null && isMate(q.name))).length;
    postScout(buildScoutBody({ from: bot.charName, map: world.map, mapName: mapName(world.map), x: world.x, y: world.y, players: others, monsters: ctx.npcs.size,
      golds: [...ctx.npcs.values()].filter(isGolden).map((n) => monsterName(n.type)) }));
  }
  return null;
}
// Arranque: este tiempo en el mapa sin nada de exp = spot agotado.
const EARLY_STARVE_MS = 60_000;
// Equipo: pedir ayuda en la esquina con esta cantidad de rivales y rindiendo menos que esto.
const TEAM_HELP_RIVALS = 2;
const TEAM_HELP_RATE = 150e6;
// Ningún monstruo a la vista durante esto = el server dejó de mandar el scope: reconectar.
const BLIND_RECONNECT_MS = 3 * 60_000;
// Datos (telemetry.ts): foto cada 5 s y jugadores a la vista cada 10 s.
const TICK_MS = 5_000;
const PLAYERS_EVERY_MS = 10_000;
let lastTickAt = 0;
let lastPlayersAt = 0;
// Kills en scope desde el último tick: nuestras, del compañero y de rivales (por nombre).
const killsSeen = { me: 0, mate: 0, rival: 0, rivals: new Map<string, number>() };

function dataTick(ctx: LoopCtx, corner: CornerState) {
  const now = Date.now();
  lastTickAt = now;
  insights(now); // mantiene tibia la caché de la base (insights.ts); no espera ni depende de ella
  const near = (q: { x: number; y: number }, d: number) => Math.hypot(q.x - world.x, q.y - world.y) <= d;
  const players = [...world.players.values()];
  const mates = players.filter((q) => q.name != null && isMate(q.name));
  track('ticks', {
    map: world.map, x: world.x, y: world.y, level: world.level, resets: world.resets ?? 0,
    exp_total: ctx.expTotal, exp_min_1m: expLog.perMin(now, 60_000),
    hp: Math.max(0, world.hp), mp: Math.max(0, world.mana),
    mode: currentMode(), phase: ctx.phase, side: corner.since != null ? corner.sides.side.name : '',
    rivals_near: players.filter((q) => !mates.includes(q) && near(q, 8)).length, mates_near: mates.filter((q) => near(q, 15)).length,
    monsters_near: [...ctx.npcs.values()].filter((m) => near(m, 8)).length,
    in_party: bot.inParty ? 1 : 0, skill: castSkill, doing: bot.doing,
    kills_me: killsSeen.me, kills_mate: killsSeen.mate, kills_rival: killsSeen.rival,
    top_rival: [...killsSeen.rivals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    mate_spot: mates.some((q) => near(q, 8)) ? 1 : mates.length ? 2 : 0,
  }, now);
  killsSeen.me = killsSeen.mate = killsSeen.rival = 0;
  killsSeen.rivals.clear();
  if (now - lastPlayersAt >= PLAYERS_EVERY_MS) {
    lastPlayersAt = now;
    // En el pueblo (zona segura) nadie compite: no se guarda.
    if (!isSafeZone(world.map, world.x, world.y))
      for (const q of players) track('players_seen', { map: world.map, x: q.x, y: q.y, name: q.name ?? '', mate: mates.includes(q) ? 1 : 0 }, now);
  }
}

// Totales de todas las sesiones (el loop corre una vez por conexión).
export type LoopResult = { kills: number; totalExpGained: number; potionsDrunk: number; statPointsSpent: number; skillsUsed: number; resets: number; deaths: number };

// Autoevaluación acumulada entre sesiones (reconexiones), sobre el ExpLog.
const report = new SelfReport(Date.now(), expLog);
// Kills por tipo (curiosidad: tipos con < 3 kills medidos van primero).
const typeKills: Record<number, number> = {};
// Muerte propia: llega por dos lados (HP 0 y ObjectGotKilled); dentro de esta ventana es una sola.
let lastDeathAt = -Infinity;
let economyWatched = false;
// Defensa propia (defense.ts) y aggro: quién me pega, de los paquetes 0x18/0x19 (protocol097.ts).
const defense = new Defense(new Set([...MATES]));
let lastFleeAt = 0;
// Invasión ya cazada por el cazador automático (una por invasión).
let lastAutoHuntKey: number | null = null;
let aggroHooked = false;
// Último skill de área confirmado por el server (para los datos).
let castSkill = 0;
// Apoyo esperando el reset del prioritario.
let supportHoldSince: number | null = null;
let supportHoldLogged = 0;
let longCycleWarned = 0;
let aggroTarget: Map<number, number> | null = null;
function hookAggro() {
  if (aggroHooked) return;
  aggroHooked = true;
  // Qué skill de área tiro de verdad (lo confirma el server): se anota cuando cambia.
  let lastOwnSkill: number | null = null;
  for (const ev of ['AreaSkillAnimation', 'AreaSkillAnimation075', 'AreaSkillAnimation095']) {
    EventBus.on(ev, (raw: any) => {
      const n = ownAreaSkill(toBytes(raw), bot.playerId & 0x7fff);
      if (n == null || n === lastOwnSkill) return;
      lastOwnSkill = n;
      log(`Tiro ${SKILL_TABLE.get(n)?.name ?? 'skill ' + n} (${n}).`);
      trackEvent('cast', SKILL_TABLE.get(n)?.name ?? '', n);
      castSkill = n;
    });
  }
  for (const ev of ['SkillAnimation', 'SkillAnimation075', 'SkillAnimation095']) {
    EventBus.on(ev, (raw: any) => {
      const n = ownTargetedSkill(toBytes(raw), bot.playerId & 0x7fff);
      if (n == null || n === lastOwnSkill) return;
      lastOwnSkill = n;
      log(`Tiro ${SKILL_TABLE.get(n)?.name ?? 'skill ' + n} (${n}).`);
      trackEvent('cast', SKILL_TABLE.get(n)?.name ?? '', n);
      castSkill = n;
    });
  }
  for (const ev of ['ObjectAnimation', 'SkillAnimation', 'SkillAnimation075', 'SkillAnimation095']) {
    EventBus.on(ev, (raw: any) => {
      const id = attackerOf(toBytes(raw), bot.playerId & 0x7fff);
      if (id == null) return;
      const now = Date.now();
      if (world.players.has(id)) {
        if (defense.hit(id, now)) decide(`Defensa: un jugador (id ${id}) me pega: le contesto.`);
      } else if (world.npcs.has(id)) aggroTarget?.set(id, now);
    });
  }
}

// Hasta `deadline` (0 = sin límite) o hasta que se corte la conexión.
export async function autonomousLoop(deadline: number): Promise<LoopResult> {
  log(`\n--- Modo autónomo: ${deadline ? `hasta ${new Date(deadline).toLocaleTimeString()}` : 'sin límite'} ---`);
  log(`Build=${BUILD.join('>')}${BUILD_ARG ? '' : ' (planStats)'} heal<=${HEAL_AT_PCT}% skills=[${ATTACK_SKILL_POOL.join(',')}] ruta fija por tramo`);

  // Estado compartido con cornerStep, walkTowards y castOnTheWay (loop-ctx.ts).
  const ctx = newLoopCtx();
  const observers = new ObserverTracker();
  let lastObserverChange = 0;
  // Monstruos atacables: los de world.npcs que NO están en zona segura. Después del reset Horaz quedó
  // pegándole a unos Lord centurion parados en el pueblo de Lorencia (en zona segura no hay daño):
  // 0 exp hasta que se lo cortó. Se recalcula al inicio de cada tick; el panel sigue viendo todos.
  const refreshAttackable = () => {
    ctx.npcs = new Map();
    const fighter = { family: classFamily(world.classId) ?? 'knight' as const, stats: world.stats, maxHp: world.maxHp };
    const limited = isFreshChar(world.resets, world.stats) || farmMiddleware.profile(fighter, world.level, world.skills.has(41), Date.now()).limited;
    for (const [id, n] of world.npcs) {
      if (isSafeZone(world.map, n.x, n.y)) continue;
      // También en Devias y campamentos generales: el modelo de poder protege a los
      // personajes que subieron de nivel más rápido que sus stats. Los dorados los
      // evalúa aparte la regla fuerte, con el límite estricto.
      if (limited && !isGolden(n) && !farmMiddleware.target(fighter, n.type, world.skills.has(41))) continue;
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
  let lastReport = Date.now();
  let lastCycleCheck = 0;
  let lastBarrierAt = 0;
  let lastSwellAt = 0;
  let phaseAt = Date.now();
  // Desde cuándo perseguimos al objetivo actual (segundos hasta matarlo).
  let targetSince = 0;
  let targetType = -1;
  let starvingLogged = 0;
  let seededRoute = '';
  // Vigía de trabas (watchdog.ts): sin progreso por X min → diagnóstico y remedio, siempre con traza.
  const stuckWatch = new StuckWatch();

  // Muerte propia: llega por dos lados (HP a 0 y ObjectGotKilled con nuestro
  // id); el meter descarta el duplicado. Se corta el tramo y se olvida el spot
  // actual: el respawn es en el pueblo, así que el próximo maybeChangeSpot
  // vuelve a warpear (canAdopt = false: no adoptar el pueblo como spot).
  const onDeath = (source: string) => {
    if (Date.now() - lastDeathAt < LEARN.DEATH_DEBOUNCE_MS) return;
    lastDeathAt = Date.now();
    deaths++;
    log(`Muerte #${deaths} (${source}) en ${bot.currentSpot?.name ?? 'spot desconocido'}.`);
    const f = { family: classFamily(world.classId) ?? 'knight' as const, stats: world.stats, maxHp: world.maxHp };
    if (farmMiddleware.profile(f, world.level, world.skills.has(41), Date.now()).limited && farmMiddleware.death(world.map, Date.now()))
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

  // Datos de cada pelea con un dragón (golden.ts, DragonFight): evento `dragon_fight`.
  const dragonFight = new DragonFight((t) => (monstersData as { Numb: number; HP: number }[]).find((m) => m.Numb === t)?.HP ?? null);
  const trackFight = (rec: ReturnType<DragonFight['lost']>) => {
    if (rec) trackEvent('dragon_fight', monsterName(rec.type), rec.type, rec.mine ? 1 : 0, { ...rec, map: world.map });
  };
  // ObjectHit (0x15 de 10 bytes): el daño que se ve sobre el dragón de la pelea (de cualquiera).
  const onHitDamage = (raw: any) => {
    const h = parseHitDamage(toBytes(raw));
    if (h) dragonFight.damage(h.id, h.damage);
  };
  const onKilled = (raw: any) => {
    const p = new ObjectGotKilledPacket(raw);
    const wasOurTarget = (p.KilledId & 0x7fff) === ctx.target;
    const dead = world.npcs.get(p.KilledId & 0x7fff);
    if (dead && DRAGON_TYPES.has(dead.type)) {
      const kid0 = p.KillerId & 0x7fff;
      const mine0 = kid0 === bot.playerId;
      trackFight(dragonFight.killed(p.KilledId & 0x7fff, Date.now(), mine0 ? bot.charName : world.players.get(kid0)?.name ?? null, mine0));
    }
    world.npcs.delete(p.KilledId & 0x7fff);
    ctx.npcs.delete(p.KilledId & 0x7fff);
    if ((p.KilledId & 0x7fff) === bot.playerId) {
      // Quién me mató: casi siempre un rival (los dorados no pueden con Horaz ni con Melu).
      const kid = p.KillerId & 0x7fff;
      const killer = world.players.get(kid);
      const by = killer ? `${killer.name ?? 'jugador #' + kid} en (${killer.x},${killer.y})` : world.npcs.has(kid) ? monsterName(world.npcs.get(kid)!.type) : `#${kid}`;
      decide(`Me mató ${by}.`);
      trackEvent('death', killer?.name ?? by, kid, killer ? 1 : 0, { killer: killer?.name ?? null, kx: killer?.x, ky: killer?.y, npc: killer ? null : world.npcs.get(kid)?.type ?? null });
      onDeath('ObjectGotKilled');
      return;
    }
    {
      // Para los datos: quién mata en nuestro sector.
      const kid = p.KillerId & 0x7fff;
      const who = world.players.get(kid);
      // Dorado muerto a la vista y quién lo mató: "vistos contra matados" y quién nos gana los dragones.
      if (dead && GOLDEN_TYPES.has(dead.type)) {
        const mine = kid === bot.playerId;
        trackEvent('golden_kill', monsterName(dead.type), dead.type, mine ? 1 : 0, { gx: dead.x, gy: dead.y, killer: mine ? bot.charName : who?.name ?? null, hunting: !!bot.hunting });
      }
      if (kid === bot.playerId) killsSeen.me++;
      else if (who?.name && isMate(who.name)) killsSeen.mate++;
      else if (who) {
        killsSeen.rival++;
        if (who.name) killsSeen.rivals.set(who.name, (killsSeen.rivals.get(who.name) ?? 0) + 1);
      }
    }
    if ((p.KillerId & 0x7fff) === bot.playerId) {
      kills++;
      // Segundos de kill por tipo: desde que se eligió el objetivo hasta acá.
      if (wasOurTarget) typeStats.recordKillSec(targetType, (Date.now() - targetSince) / 1000);
      if (process.env.MUBOT_DEBUG_COMBAT) log(`Kill #${kills} (Id=${p.KilledId & 0x7fff})`);
    } else if (wasOurTarget && process.env.MUBOT_DEBUG_COMBAT) {
      // Zona concurrida: puede que otro jugador/NPC mate a nuestro objetivo
      // antes que nosotros — no es un bug, pero conviene verlo.
      log(`DEBUG combate: nuestro objetivo Id=${p.KilledId} lo mató otro (KillerId=${p.KillerId})`);
    }
  };
  // ExperienceGained (C3 16): KilledObjectId u16 BE @3, AddedExperience u16
  // BE @5. Un kill de más de 65535 llega partido en ~60 packets con el mismo
  // id: ExpSplitTracker los suma para la exp por tipo (farming.ts) y ExpLog
  // los agrega por segundo (no un registro por tramo: ver ExpLog).
  const onExp = (raw: any) => {
    const p = new ExperienceGainedPacket(raw);
    const added = p.AddedExperience;
    const now = Date.now();
    totalExpGained += added;
    ctx.expTotal += added;
    report.addExp(added, now);
    const ev = expTracker.onExp(p.KilledObjectId & 0x7fff, added, now);
    if (ev.info && !ev.continuation) typeKills[ev.info.type] = (typeKills[ev.info.type] ?? 0) + 1;
    // El spot caliente se pondera por exp: se suma donde estaba el monstruo.
    if (ev.info && ev.info.map === world.map) explorer.onExp(world.map, ev.info.x, ev.info.y, added, now);
    if (process.env.MUBOT_DEBUG_EXP) {
      const what = ev.info ? ` tipo ${ev.info.type}${ev.continuation ? `, kill partido: ${ev.sum}` : ''}` : '';
      log(`+${added} exp${what} (total ${totalExpGained})`);
    }
  };
  EventBus.on('ObjectGotKilled', onKilled);
  EventBus.on('ObjectMoved', onHitDamage);
  EventBus.on('ExperienceGained', onExp);
  EventBus.on('CurrentHealthAndShield', onHp);
  const stopWatchingDrops = watchDrops();
  if (!economyWatched) {
    watchMoney();
    economyWatched = true;
  }

  // Objetivos abandonados (inalcanzables o que no mueren): se ignoran UNREACHABLE_MS. El server reusa
  // los ids al respawnear, así que una lista para siempre achicaba el campamento durante la sesión.
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
  let stuckCount = 0;
  // Objetivo a distancia de golpe que no muere: tras TARGET_NO_KILL_MS se abandona (red de seguridad
  // si la posición que conocemos del monstruo no es la real).
  const goldReporter = new GoldReporter(bot.charName);
  // Esquina de Arena 2 (corner-step.ts).
  const corner = newCornerState();
  let altMeasuredAt = 0;
  let lastAnyNpcAt = Date.now();
  let devCrowdSince: number | null = null;
  const early = new EarlyPlanner();
  let lastEquipTry = 0;
  let lastPartyAsk = 0;
  let lastFieldLeave = 0;
  // Regla fuerte de dorados (golden.ts) y los ya avisados.
  const golden = new GoldenRule();
  const goldAnnounced = new Set<number>();
  hookAggro();
  aggroTarget = ctx.aggro;
  let attackTarget: number | null = null;
  let attackSince = 0;
  // Explorador (explore.ts): spots calientes, salidas del pueblo y mapa seco.
  // Se usa solo cuando no hay campamento (camp.ts) al que ir.
  const explorer = new Explorer(EXPLORE_PREF, EXPLORE, hotGrid);
  let explorerMap: number | null = null;
  let lastGoalTxt = '';
  let ticks = 0;
  const logCampEvents = () => {
    for (const e of learned.camps.events) log(`Campamento: ${e}.`);
    learned.camps.events = [];
  };

  while ((deadline <= 0 || Date.now() < deadline) && !bot.kicked) {
    refreshAttackable();
    const observerSignal = observers.update(Date.now(), world.map, { x: world.x, y: world.y },
      [...world.players.entries()].map(([id, p]) => ({ id, ...p, mate: !!p.name && isMate(p.name) })));
    // Ciego: el server a veces deja de mandar el scope de monstruos (Horaz y Melu en Lorencia: 0
    // monstruos, 0 muertes, solo jugadores y paquetes 0x11). Reconectar lo arregla: con NINGÚN
    // monstruo a la vista (ni en zona segura) durante BLIND_RECONNECT_MS, se corta y se vuelve a entrar.
    // También sin exp: con la sesión "fantasma" llegan monstruos pero ninguno muere y no entra exp.
    const farming = !bot.paused && !bot.hunting && !bot.resetting && bot.inGameAt > 0;
    if (bot.inGameAt > 0 && Date.now() - lastTickAt >= TICK_MS) dataTick(ctx, corner);
    // Vigía de ciclo largo (mesa de agentes): más de 15 min sin resetear → aviso (una vez por ciclo), con el tramo.
    const cyc = learned.cycleLog.cur;
    if (Date.now() - cyc.start > 15 * 60_000 && longCycleWarned !== cyc.start) {
      longCycleWarned = cyc.start;
      decide(`Vigía: ciclo de más de 15 min (nivel ${world.level} en ${mapName(world.map)}, ${bot.doing}).`);
      trackEvent('long_cycle', bot.doing, world.level);
    }
    if (world.npcs.size > 0 || !bot.inGameAt || bot.resetting) lastAnyNpcAt = Date.now();
    const sinceIn = Date.now() - Math.max(bot.inGameAt, bot.lastArrivalAt);
    const noExp = farming && sinceIn > BLIND_RECONNECT_MS && expLog.perMin(Date.now(), BLIND_RECONNECT_MS) === 0;
    if (noExp || (Date.now() - Math.max(lastAnyNpcAt, bot.lastArrivalAt) > BLIND_RECONNECT_MS)) {
      bot.blind = true;
      decide(noExp
        ? `${BLIND_RECONNECT_MS / 60_000} min sin nada de exp en ${mapName(world.map)}: reconecto (sesión trabada).`
        : `Sin ningún monstruo a la vista hace ${BLIND_RECONNECT_MS / 60_000} min en ${mapName(world.map)}: reconecto (el server dejó de mandar el scope).`);
      journal('travel', 'reconecto: sin monstruos a la vista', { map: world.map, reason: 'blind' });
      bot.kicked = true;
      closeSockets();
      break;
    }
    // Señales de dorados a la estación (nuevos, movidos, idos): los ve aunque estén en zona segura.
    for (const { payload } of goldReporter.update(world.map, [...world.npcs.values()].filter(isGolden).map((n) => ({ id: n.id, x: n.x, y: n.y, name: monsterName(n.type) })), Date.now())) publishGold(payload);
    // Vigía de trabas (watchdog.ts): sin exp, kills, movimiento ni objetivo nuevo por 4/8/12 min → diagnóstico y
    // remedio seguro (cada uno deja traza en Decisiones y en la base, evento `stuck`).
    {
      const nowW = Date.now();
      const hpPct = world.maxHp > 0 ? (world.hp / world.maxHp) * 100 : 100;
      const potions = [...world.inventory.values()].filter((it) => it.group === 14 && it.num >= 1 && it.num <= 3).length;
      const wd = stuckWatch.feed({
        now: nowW, mode: currentMode(), map: world.map, x: world.x, y: world.y, level: world.level, expTotal: ctx.expTotal, kills,
        target: ctx.target, pk: pkGuard.active, freeSlots: world.inventory.size ? bagRoom() : null, potions, hpPct, monsters: ctx.npcs.size,
        walkStuck: ctx.walkStuck, lootingLong: !!lootState.looting && nowW - lootState.looting.since > 30_000, silentMs: silentMs(nowW), hunting: !!bot.hunting,
      });
      if (wd) {
        const idleMin = +(wd.idleMs / 60_000).toFixed(1);
        decide(`Vigía [${wd.step}/3]: ${idleMin} min sin progreso en ${mapName(world.map)} (${bot.doing}). Diagnóstico: ${wd.diagnosis}. ${wd.why}.`, { diagnosis: wd.diagnosis, remedy: wd.remedy, step: wd.step, idleMin });
        trackEvent('stuck', wd.diagnosis, wd.step, idleMin, { remedy: wd.remedy, doing: bot.doing, hunting: !!bot.hunting, x: world.x, y: world.y });
        postInsight(`trabado ${idleMin} min: ${wd.diagnosis} → ${wd.remedy}`, { diagnosis: wd.diagnosis, remedy: wd.remedy, step: wd.step, idleMin, map: world.map }, 'stuck', 60_000);
        // Explorador: la traba veta el mapa y vuelve al más seguro (scout.ts).
        if (bot.hunting?.scout) {
          const to = bot.hunting.scout.tour.onStuck({ now: nowW, level: world.level, weak: weakNow(), covered: scoutCovered(nowW) });
          if (to) { bot.hunting.hunt = to; bot.hunting.warpTries = 0; bot.hunting.nextWarpAt = 0; bot.hunting.explorer = new HuntExplorer(); ctx.target = null; }
        }
        if (wd.remedy === 'pkclear') pkGuard.force(nowW, 'vigía: sin progreso y PK');
        else if (wd.remedy === 'ignore_loot') { drops.clear(); lootState.looting = null; }
        else if (wd.remedy === 'drop_target' || wd.remedy === 'leave_camp') {
          if (ctx.target != null) unreachable.add(ctx.target);
          ctx.target = null;
          ctx.walkStuck = 0;
          if (bot.hunting) { bot.hunting.explorer.reset(); bot.hunting.zonesVisited = new Set(); }
          else if (learned.camps.camp) learned.camps.leave(nowW, world.level, 'vigía: sin progreso', true, expLog);
        } else if (wd.remedy === 'rewarp' || wd.remedy === 'warp_town') {
          ctx.target = null;
          ctx.walkStuck = 0;
          journal('travel', `vigía: ${wd.remedy === 'warp_town' ? 'warp a Lorencia' : 'vuelvo a entrar al mapa'}`, { reason: 'watchdog', diagnosis: wd.diagnosis });
          if (wd.remedy === 'warp_town') await warpAndWait(WARP_SPOTS.find((sp) => sp.index === 2)!);
          else if (bot.hunting) {
            const h = bot.hunting.hunt;
            await warpAndWait({ index: h.warp, name: `cacería ${h.name}`, reqLevel: h.reqLevel, zen: 0, map: h.map });
          } else {
            if (wd.diagnosis === 'dry_map' && bot.currentSpot) dryAt.set(bot.currentSpot.index, nowW);
            if (!(wd.diagnosis === 'dry_map' && (await maybeChangeSpot({ mapDead: true }))) && bot.currentSpot) await warpAndWait(bot.currentSpot);
          }
          continue;
        } else if (wd.remedy === 'reconnect') {
          bot.blind = true;
          bot.kicked = true;
          closeSockets();
          break;
        }
      }
    }
    ticks++;
    {
      const t = Date.now();
      report.addTime(ctx.phase, t - phaseAt);
      phaseAt = t;
      ctx.phase = 'other';
    }
    // Registro de tramos por ciclo: minuto al llegar a 20/50/100/.../400.
    if (Date.now() - lastCycleCheck >= 2000) {
      lastCycleCheck = Date.now();
      const marks = learned.cycleLog.observe(world.level, lastCycleCheck);
      for (const m of marks) if (m >= 100) log(`Tramo: nivel ${m} al minuto ${learned.cycleLog.cur.marks[m]} del ciclo.`);
      if (marks.length) void persistLearning();
    }
    // Autoevaluación cada ~5 min (con la proyección de resets/día).
    if (Date.now() - lastReport >= REPORT_EVERY_MS) {
      lastReport = Date.now();
      const camps = learned.camps;
      const spotTxt = bot.currentSpot ? `spot ${bot.currentSpot.name} (${Math.round(expLog.perMin(lastReport, 5 * 60_000))} exp/min)` : 'sin spot';
      const campTxt = camps.camp ? `, campamento (${camps.camp.x},${camps.camp.y}) vara ${Math.round(camps.best[world.map] ?? 0)} exp/min` : '';
      log(report.format(lastReport, world.level, learned.char.resets, `${kills} kills, ${lootState.count} loot, ${spotTxt}${campTxt}`));
      log(`Tramos por ciclo:\n${learned.cycleLog.format()}`);
    }
    // Lo aprendido se guarda cada ~2 min.
    if (Date.now() - lastSave >= SAVE_EVERY_MS) {
      lastSave = Date.now();
      await persistLearning();
    }
    // 0b) Mago: Soul Barrier (16, escudo de maná) cada ~50 s, como el agente del navegador.
    if (isMage() && world.skills.has(16) && Date.now() - lastBarrierAt > 50_000 && world.maxMana > 0 && world.mana / world.maxMana > 0.2 && Date.now() - ctx.lastCastAt > SKILL_PACE_MS) {
      lastBarrierAt = Date.now(); ctx.lastCastAt = Date.now();
      sendTargetedSkill(world.skills.get(16)!.index, bot.playerId);
      await sleep(humanPace(SKILL_PACE_MS));
    }
    // 0c) Caballero: Swell Life (48, más vida para él y la party) siempre prendido, cada ~55 s. Contra los
    //     dorados quedaba en 22 % sin pociones (2026-10-23).
    if (!isMage() && world.skills.has(48) && skillLevelOk(48) && Date.now() - lastSwellAt > SWELL_LIFE_MS && world.mana >= (SKILL_TABLE.get(48)?.mana ?? 0) && Date.now() - ctx.lastCastAt > SKILL_PACE_MS) {
      lastSwellAt = Date.now(); ctx.lastCastAt = Date.now();
      sendTargetedSkill(world.skills.get(48)!.index, bot.playerId);
      await sleep(humanPace(SKILL_PACE_MS));
    }
    // 1) Sobrevivir tiene prioridad absoluta.
    if (checkSurvival()) {
      potionsDrunk++;
      await sleep(200);
      continue;
    }

    // 1b) Órdenes del panel. Cambio de modo: soltar el objetivo.
    if (bot.retarget) {
      bot.retarget = false;
      ctx.target = null;
      lootState.looting = null;
    }
    // En pausa no se hace nada más (las pociones de arriba siguen).
    if (bot.paused) {
      ctx.phase = 'wait';
      await sleep(500);
      continue;
    }
    // Auto-recuperación del PK (recovery.ts): con el aviso del server o varios warps sin respuesta, manda /pkclear
    // (tope de intentos, 20 s entre uno y otro y descanso de 30 min si no hay caso; el chat respeta el gap de 2 s).
    {
      const nowK = Date.now();
      const act = pkGuard.next(nowK);
      if (act && 'send' in act) {
        if (sendServerCommand(act.send, nowK)) {
          pkGuard.sent(nowK);
          decide(`PK: mando ${act.send} (intento ${act.tryNo}/${PK_RECOVERY.maxTries}): ${act.why}.`, { tryNo: act.tryNo });
          trackEvent('pk_clear', act.why, act.tryNo);
          postInsight(`PK: /pkclear intento ${act.tryNo}`, { tryNo: act.tryNo, map: world.map }, 'pk', 60_000);
        }
      } else if (act && 'giveUp' in act) {
        decide(`PK: ${act.giveUp}.`);
        trackEvent('pk_clear', act.giveUp, -1);
      }
    }
    // Orden `warp` pendiente.
    if (bot.pendingWarp) {
      const sp = bot.pendingWarp;
      bot.pendingWarp = null;
      bot.doing = `viajando a ${sp.name}`;
      journal('travel', `warp a ${sp.name} por orden del panel (${zenTxt(sp)})`, { warp: sp.index, reason: 'panel' });
      if (!(await warpAndWait(sp))) panelLog(`El warp a ${sp.name} no respondió; sigue fijado y lo reintento.`);
      ctx.target = null;
      continue;
    }
    // Escuadra (squad-client.ts): órdenes firmadas por la estación local. Solo con una escuadra vigente.
    if (squadActive() && (await squadStep(ctx))) continue;
    // Orden `vault`: leer el baúl (vault.ts). Después, la ruta vuelve sola al spot.
    if (bot.pendingVault && !bot.hunting) {
      bot.pendingVault = false;
      const r = await readVault();
      panelLog(`Baúl: ${r.msg}`);
      bot.currentSpot = null;
      ctx.target = null;
      continue;
    }
    // Orden `equip` (solo si alguien la manda): sacar del baúl y equipar (vault.ts, runEquip).
    if (bot.pendingEquip && !bot.hunting) {
      bot.pendingEquip = false;
      const r = await runEquip();
      panelLog(`Equipo: ${r.msg}`);
      bot.currentSpot = null;
      ctx.target = null;
      continue;
    }
    // Cacería: cortar a tiempo (0xFD dice 0 vivos, derrotada, 15 min) y llegar al mapa.
    if (bot.hunting) {
      const h = bot.hunting;
      const nowH = Date.now();
      const known = () => mapsWithZones(HUNT_MAPS.map((x) => x.map), nowH);
      const stop = h.scout ? runScout(h, ctx, nowH, deaths) : h.red
        ? shouldStopHunt({ invasion: null, map: h.hunt.map, since: h.since, now: nowH, maxMs: RED_HUNT_MS })
        : shouldStopHunt({ invasion: bot.invasion, map: h.hunt.map, since: h.since, now: nowH, stopAlive: h.auto ? AUTO_HUNT.stopAlive : undefined }) ??
          (h.auto && world.map === h.hunt.map
            ? huntDryOut({ invasion: bot.invasion, map: h.hunt.map, lastSeenAt: h.lastSeenAt ?? h.since, now: nowH, since: h.since,
                next: pickHuntMap({ invasion: bot.invasion, level: world.level, done: new Set([...(h.done ?? []), h.hunt.map]), knownMaps: known(), ...huntData(nowH) }) })
            : null);
      if (stop && !h.scout) trackEvent('hunt_end', stop, h.hunt.map, h.seen.size, { map: h.hunt.map, seen: h.seen.size, min: +((nowH - h.since) / 60_000).toFixed(1), red: !!h.red });
      if (stop) {
        stopHunt(stop);
        ctx.target = null;
        // Encadenar (usuario, 2026-10-23: "los dragones y dorados salen en varios mapas"): con la invasión
        // activa, al mejor mapa que quede. Devias se vació en 3 min con Noria en 38 y Lorencia en 28.
        if (h.auto && !h.red && !weakNow()) {
          const done = new Set([...(h.done ?? []), h.hunt.map]);
          const next = pickHuntMap({ invasion: bot.invasion, level: world.level, done, dragonMap: freshDragonMap(nowH), knownMaps: known(), ...huntData(nowH) });
          if (next.ok) {
            bot.hunting = { hunt: next.hunt, since: nowH, warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set(), auto: true, done };
            decide(`Cazador: sigo en ${next.hunt.name} (${next.alive} vivos).`);
            journal('travel', `cazador encadenado: ${next.hunt.name}`, { map: next.hunt.map, alive: next.alive, reason: 'auto-hunt-chain' });
          }
        }
        continue;
      }
      if (world.map !== h.hunt.map) {
        ctx.target = null;
        if (nowH < h.nextWarpAt) {
          await sleep(500);
          continue;
        }
        if (h.warpTries >= 3) {
          // Explorador: veta el mapa y la próxima vuelta del tour elige otro; cazador: corta.
          if (h.scout) { h.scout.tour.warpFailed(nowH); h.warpTries = 0; h.nextWarpAt = nowH + WARP_COOLDOWN_MS; decide(`Explorador: no pude llegar a ${h.hunt.name}, pruebo otro mapa.`); }
          else stopHunt(`no pude llegar a ${h.hunt.name}`);
          continue;
        }
        h.warpTries++;
        h.nextWarpAt = nowH + WARP_COOLDOWN_MS;
        bot.doing = `viajando a ${h.hunt.name} a cazar dorados`;
        const spot: Spot = { index: h.hunt.warp, name: `cacería ${h.hunt.name}`, reqLevel: h.hunt.reqLevel, zen: 0, map: h.hunt.map };
        journal('travel', `warp a ${h.hunt.name} para cazar dorados`, { warp: h.hunt.warp, map: h.hunt.map, reason: 'hunt' });
        await warpAndWait(spot);
        continue;
      }
    }

    // 1c) Defensa propia: solo a un jugador que me pegó (10 s, <= 10 tiles), con el skill más fuerte;
    //     con vida < 35 % me voy a Lorencia y evito ese mapa 5 min.
    {
      const nowD = Date.now();
      const foe = defense.target({ x: world.x, y: world.y }, [...world.players].map(([id, q]) => ({ id, x: q.x, y: q.y, name: q.name })), nowD);
      if (foe) {
        const hpPct = world.maxHp > 0 ? world.hp / world.maxHp : 1;
        if (world.map !== 0 && nowD - lastFleeAt > 30_000 && defense.shouldFlee(hpPct, world.map, nowD, isPriorityChar(bot.charName) ? 60_000 : DEFENSE.avoidMapMs)) {
          lastFleeAt = nowD;
          decide(`Defensa: vida ${Math.round(hpPct * 100)} % peleando con un jugador: me voy a Lorencia y evito este mapa ${DEFENSE.avoidMapMs / 60_000} min.`);
          // El prioritario vuelve al minuto (5 min afuera costaban ~30 % del ciclo).
          if (world.map === CORNER.map) corner.awayUntil = nowD + (isPriorityChar(bot.charName) ? 60_000 : DEFENSE.avoidMapMs);
          ctx.target = null;
          journal('travel', 'huyo de un jugador: warp a Lorencia', { warp: 2, reason: 'defense' });
          await warpAndWait(WARP_SPOTS.find((sp) => sp.index === 2)!);
          continue;
        }
        const sk = Defense.skill((n) => world.skills.has(n));
        const info = sk != null ? world.skills.get(sk)! : null;
        const d = chebyshev(world.x, world.y, foe.x, foe.y);
        ctx.phase = 'fight';
        bot.doing = `defensa: le contesto a un jugador en (${foe.x},${foe.y})`;
        if (info && d <= castReach(sk!) && nowD - ctx.lastCastAt >= SKILL_PACE_MS) {
          sendTargetedSkill(info.index, foe.id);
          ctx.lastCastAt = nowD;
          await sleep(humanPace(SKILL_PACE_MS));
        } else if (!info && d <= 1) {
          sendHit(foe.id, directionTowards(world.x, world.y, foe.x, foe.y));
          await sleep(humanPace(ATTACK_PACE_MS));
        } else await walkTowards(ctx, foe.x, foe.y);
        continue;
      }
    }

    // 1d) Regla fuerte de dorados (golden.ts): farmeando, un dorado a <= 20 es el objetivo (dragones
    //     primero); mientras tanto y 15 s después (cajas) no se resetea, no se cambia de spot ni se
    //     vuelve a la esquina.
    const nowG = Date.now();
    // Personaje nuevo: solo los dorados con los que puede según sus stats (power.ts). Hume (nivel 10)
    // fue por un Golden Dragon y lo mató (2026-10-12). Horaz y Melu siguen yendo por todos.
    const fighter = { family: classFamily(world.classId) ?? 'knight' as const, stats: world.stats, maxHp: world.maxHp };
    const profile = farmMiddleware.profile(fighter, world.level, world.skills.has(41), nowG);
    learned.camps.setPower(statPower(fighter), profile.spot != null);
    // Selector de mapa: sembrar con lo medido en la base una vez por reset y tramo de 80 niveles.
    const seedKey = `${world.resets}:${Math.floor(world.level / 80)}`;
    if (profile.spot != null && world.resets != null && seededRoute !== seedKey) {
      seededRoute = seedKey;
      void seedRouteFromDb(world.resets, world.level, statPower(fighter));
    }
    const routeLevel = profile.routeLevel;
    const fresh = isFreshChar(world.resets, world.stats);
    const weak = fresh || profile.limited;
    const me = weak ? { family: classFamily(world.classId) ?? 'knight' as const, stats: world.stats, maxHp: world.maxHp } : null;
    const gold = bot.hunting ? null : golden.pick({ x: world.x, y: world.y }, ctx.npcs.values(), (t) => GOLDEN_TYPES.has(t) && (!me || canFight(me, t)), nowG, ctx.target);
    const goldHold = !bot.hunting && golden.holding(nowG);
    if (gold && ctx.target !== gold.id) {
      if (!goldAnnounced.has(gold.id)) {
        goldAnnounced.add(gold.id);
        decide(`Dorado: ${monsterName(gold.type)} a la vista en (${gold.x},${gold.y}): lo ataco.`);
        // Un dragón: pedir ayuda al equipo (lo matan entre los dos y hay más cajas para levantar).
        if (DRAGON_TYPES.has(gold.type) && teammates().length && askHelp('golden', world.map, gold.x, gold.y, `${monsterName(gold.type)} en ${mapName(world.map)}`))
          decide(`Pido ayuda al equipo con el ${monsterName(gold.type)} en ${mapName(world.map)}.`);
      }
      ctx.target = gold.id;
      targetType = gold.type;
      targetSince = nowG;
      stuckCount = 0;
    }

    // 1f) Equipo (team.ts): pedir ayuda para sostener la esquina y contestar los pedidos de los compañeros.
    {
      const me = { x: world.x, y: world.y };
      const mates = teammates();
      if (world.map === CORNER.map && inCorner(me) && mates.length) {
        const rivals = [...world.players.values()].filter((q) => !(q.name && isMate(q.name)) && Math.hypot(q.x - me.x, q.y - me.y) <= CORNER.fullRivalDist).length;
        const mateHere = mates.some((m) => m.map === CORNER.map && inCorner(m));
        const rate = expLog.perMin(nowG, 60_000);
        if (rivals >= TEAM_HELP_RIVALS && !mateHere && rate < TEAM_HELP_RATE && nowG - bot.lastArrivalAt > 60_000 &&
          askHelp('corner', world.map, me.x, me.y, `${rivals} rivales en la esquina, ${Math.round(rate / 1e6)}M/min`))
          decide(`Pido ayuda a ${mates.map((m) => m.char).join(', ')} en la esquina: ${rivals} rivales y ${Math.round(rate / 1e6)}M/min.`);
      }
      for (const r of newRequests()) {
        if (r.kind === 'corner') {
          if (world.level < CORNER.minLevel) decide(`${r.from} pide ayuda en la esquina, pero me falta nivel (${world.level}/${CORNER.minLevel}).`);
          else if (bot.hunting || bot.resetting || bot.paused) decide(`${r.from} pide ayuda en la esquina, pero estoy ${bot.hunting ? 'cazando' : bot.resetting ? 'reseteando' : 'en pausa'}.`);
          else if (world.map === CORNER.map && inCorner(me)) decide(`${r.from} pide ayuda en la esquina: ya estoy acá, sostenemos el sector juntos.`);
          else {
            corner.awayUntil = 0;
            bot.pinnedSpot = null;
            decide(`${r.from} pide ayuda en la esquina (${r.note}): voy.`);
          }
        } else if (r.kind === 'golden') {
          const hm = HUNT_MAPS.find((h) => h.map === r.map);
          if (isPriorityChar(bot.charName) && !bot.hunting) decide(`${r.from} vio ${r.note}: sigo en la carrera de resets, que vaya ${r.from}.`);
          else if (bot.hunting && bot.hunting.hunt.map === r.map) {
            (bot.hunting.spots ??= new Map()).set(-r.at, { x: r.x, y: r.y, type: 0, at: nowG });
            decide(`${r.from} vio ${r.note} en (${r.x},${r.y}): voy.`);
          } else if (bot.hunting || bot.resetting || bot.paused) decide(`${r.from} vio ${r.note}, pero estoy ${bot.hunting ? 'cazando' : bot.resetting ? 'reseteando' : 'en pausa'}.`);
          else if (!hm || world.level < hm.reqLevel) decide(`${r.from} vio ${r.note}: no puedo ir a ese mapa.`);
          else {
            bot.hunting = { hunt: hm, since: nowG, warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set(), auto: true,
              spots: new Map([[-r.at, { x: r.x, y: r.y, type: 0, at: nowG }]]) };
            ctx.target = null;
            decide(`${r.from} vio ${r.note}: voy a ayudarlo.`);
          }
        }
      }
    }

    // 1e) Cazador automático: invasión activa con más de 25 vivos en un mapa al alcance → a cazar, una
    //     vez por invasión (hunter.js del navegador).
    // Carrera de resets: el prioritario (Horaz) no sale a cazar; los dorados son de Melu.
    const racing = isPriorityChar(bot.charName);
    // Un personaje nuevo no sale a cazar dorados: no puede con ellos.
    // 1e') Dragón Rojo (caja +4): con el aviso del server, a ese mapa a cazarlo (una vez por aviso).
    if (AUTO_HUNT_ON && !racing && !weak && !bot.hunting && !bot.paused && !bot.resetting && bot.redDragon &&
        nowG - bot.redDragon.at < RED_HUNT_MS && lastRedAt !== bot.redDragon.at && world.level >= AUTO_HUNT.minLevel) {
      lastRedAt = bot.redDragon.at;
      const hm = HUNT_MAPS.find((x) => x.map === bot.redDragon!.map);
      if (hm && world.level >= hm.reqLevel) {
        bot.hunting = { hunt: hm, since: nowG, warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set(), auto: true, red: true };
        ctx.target = null;
        decide(`Cazador: invasión del Dragón Rojo en ${hm.name}: salgo a cazarlo (${RED_HUNT_MS / 60_000} min).`);
        journal('travel', `cazador: Dragón Rojo en ${hm.name}`, { map: hm.map, reason: 'red-dragon' });
        continue;
      }
    }
    if (AUTO_HUNT_ON && !racing && !weak && !bot.hunting && !bot.paused && !bot.resetting) {
      const ch = autoHuntChoice({ invasion: bot.invasion, level: world.level, now: nowG, lastKey: lastAutoHuntKey, dragonMap: freshDragonMap(nowG), knownMaps: mapsWithZones(HUNT_MAPS.map((h) => h.map), nowG), ...huntData(nowG) });
      if (ch?.ok) {
        lastAutoHuntKey = invasionKey(bot.invasion!);
        bot.hunting = { hunt: ch.hunt, since: nowG, warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set(), auto: true };
        ctx.target = null;
        decide(`Cazador: invasión dorada con ${ch.alive} vivos en ${ch.hunt.name}${freshDragonMap(nowG) === ch.hunt.map ? ' (el Golden Dragon está acá)' : ''}: salgo a cazar (corto con ${ch.hunt.stopAlive ?? AUTO_HUNT.stopAlive} o menos y sigo en otro mapa${huntData(nowG).factor(ch.hunt.map) !== 1 ? `; datos de la base: ×${huntData(nowG).factor(ch.hunt.map).toFixed(2)} por cajas, muertes y rivales a esta hora` : ''}).`);
        journal('travel', `cazador automático: ${ch.hunt.name}`, { map: ch.hunt.map, alive: ch.alive, reason: 'auto-hunt' });
        continue;
      }
    }

    // 2) Reset al llegar al nivel: lo más importante para progresar (no a mitad de una cacería). Entre
    //    :47 y :51 no, para llegar a la invasión de las :50 (con el cazador prendido).
    // Apoyo: resetea mientras el prioritario hace 10→100, así la esquina nunca queda sola (espera como
    // mucho 20 min; sin datos del prioritario, resetea).
    const prio = isPriorityChar(bot.charName) ? undefined : teammates().find((m) => isPriorityChar(m.char));
    const holdForPrio = world.level >= RESET_LEVEL && prio != null && prio.level >= 100 && prio.level < RESET_LEVEL;
    if (holdForPrio) supportHoldSince ??= Date.now(); else supportHoldSince = null;
    const supportWaits = holdForPrio && Date.now() - supportHoldSince! < 20 * 60_000;
    if (supportWaits && world.level >= RESET_LEVEL && Date.now() - supportHoldLogged > 60_000) {
      supportHoldLogged = Date.now();
      decide(`Nivel ${world.level}: espero que ${prio!.char} resetee para resetear yo (sostengo la esquina).`);
    }
    if (!supportWaits && !bot.hunting && !goldHold && !(AUTO_HUNT_ON && !isPriorityChar(bot.charName) && resetBlockedByInvasion(Date.now())) && world.level >= RESET_LEVEL && Date.now() >= nextResetTry) {
      if (await doReset()) {
        resets++;
        ctx.target = null;
        report.cycleDone(Date.now());
        log(report.format(Date.now(), world.level, learned.char.resets, 'reset hecho'));
        log(`Tramos por ciclo:\n${learned.cycleLog.format()}`);
      } else {
        nextResetTry = Date.now() + 2 * 60_000; // como el navegador: reintento a los 2 min
      }
      continue;
    }

    // 3) Invertir puntos de atributo cuando junte un lote, en segundo plano (sigue peleando).
    investStatPointsInBackground((n) => { statPointsSpent += n; });

    // Una presencia persistente cerca del recorrido justifica cambiar de grupo
    // o entrada. No se presume que sea un guardia: puede ser otro granjero.
    // Solo personajes limitados: con stats completos lo cubre el hambre (exp real con
    // jugadores cerca). Hume (39 resets) se iba de Arena 2 a 359M/min por un jugador quieto.
    if (weak && observerSignal && !bot.hunting && !bot.pinnedSpot && Date.now() - lastObserverChange > 120_000) {
      lastObserverChange = Date.now();
      decide(`Jugador ${observerSignal.name ?? '#' + observerSignal.id} ${observerSignal.kind} cerca hace ${Math.round(observerSignal.ms / 1000)} s: cambio de zona sin disputarle el lugar.`);
      if (world.map === 2 && await maybeChangeSpot({ crowded: true })) { ctx.target = null; continue; }
      if (world.map === CORNER.map) corner.awayUntil = Date.now() + 3 * 60_000;
      if (learned.camps.camp) learned.camps.leave(Date.now(), world.level, 'presencia persistente de otro jugador', true, expLog);
      ctx.target = null;
    }

    // Afuera de la esquina (llena o sin rendir): medir cuánto rinde esta Arena, para compararla la
    // próxima vez (promedio móvil por warp, una medición por minuto con al menos 1 min en el mapa).
    if (corner.awayUntil > Date.now() && bot.currentSpot && Date.now() - bot.lastArrivalAt > 60_000 && Date.now() - altMeasuredAt > 60_000) {
      altMeasuredAt = Date.now();
      const r = expLog.perMin(altMeasuredAt, 60_000);
      const prev = corner.altRates.get(bot.currentSpot.index);
      corner.altRates.set(bot.currentSpot.index, prev == null ? r : prev * 0.6 + r * 0.4);
    }
    // 3b) La esquina de Arena 2 (corner.ts): desde el nivel 100 hasta el reset, salvo cazando, con un
    //     spot fijado por el panel o mientras está afuera porque estaba llena.
    // Cerca del reset no vuelve a la esquina (el camino lleva ~1 min): sigue afuera.
    // (el prioritario vuelve siempre: afuera hacía 350→400 en Arena 4 a ~50M/min, el ciclo de 36 min)
    if (corner.awayUntil && Date.now() >= corner.awayUntil && world.level >= CORNER.noReturnLevel && !isPriorityChar(bot.charName)) corner.awayUntil = Date.now() + 60_000;
    if (!bot.hunting && !pinActive() && !goldHold && profile.corner &&
        !farmMiddleware.keepCurrentArena(world.map, world.level, CORNER.altMinRate, statPower(fighter)) &&
        cornerActive({ level: routeLevel, resetLevel: RESET_LEVEL, awayUntil: corner.awayUntil, now: Date.now() })) {
      await cornerStep(ctx, corner);
      continue;
    }

    // Medición neta: incluye la caminata desde el warp. Si un mapa no da exp o
    // rinde mucho menos que uno ya medido a nivel parecido, el middleware lo
    // deja 10 min; en Devias prueba otra entrada. Así no pasea por todo el mapa.
    // Solo personajes limitados: evitar una Arena baja el tramo a Devias, y a Hume con
    // stats completos lo mandaba de Arena 2 (nivel 300) a Devias 4 a 20M/min.
    if (weak && !bot.hunting && !bot.pinnedSpot && bot.currentSpot && !goldHold) {
      const now = Date.now();
      const why = farmMiddleware.observe({ spot: bot.currentSpot.index, map: world.map, level: world.level,
        now, arrivalAt: bot.lastArrivalAt, rate: expLog.rateSince(bot.lastArrivalAt, now), f: fighter, twistingSlash: world.skills.has(41) });
      if (why) {
        decide(`Rendimiento: ${why}.`);
        if (await maybeChangeSpot({ crowded: world.map === 2 })) { ctx.target = null; continue; }
      }
    }

    // 4) Hambre: casi nada de exp en 45 s con jugadores cerca → cambiar YA de
    //    entrada o de mapa (o, si no hay a dónde, de campamento).
    const camps = learned.camps;
    const now0 = Date.now();
    const rivalsNear = [...world.players.values()].filter((q) => chebyshev(q.x, q.y, world.x, world.y) <= CAMP.HUNGER_RIVAL_DIST).length;
    const recentRate = expLog.perMin(now0, CAMP.HUNGER_WINDOW_MS);
    const hungry = learned.hunger.check({ now: now0, tier: routeTier(world.level).minLevel, recentRate, lastWarpAt: bot.lastArrivalAt, rivalsNear });
    if (hungry.starving && !bot.hunting && now0 - starvingLogged > 15_000) {
      starvingLogged = now0;
      log(`Casi sin exp (${Math.round(recentRate)} exp/min en 45 s, referencia ${Math.round(hungry.ref ?? 0)}) con ${rivalsNear} jugador(es) cerca: cambio de lugar.`);
    }

    // 5) ¿Cambiar de spot? (ruta fija: tramo nuevo, competencia, hambre). Cada
    //    10 ticks, o ya si hay hambre/competencia; respeta WARP_COOLDOWN_MS.
    // Devias lleno (como el navegador): 3+ jugadores a <= 8 del campamento durante 20 s.
    const inEarly = early.active();
    const crowdCamp = inEarly ? early.camp : camps.camp;
    const devCrowd = world.map === 2 && world.level < CORNER.minLevel && crowdCamp != null &&
      [...world.players.values()].filter((q) => chebyshev(q.x, q.y, crowdCamp.x, crowdCamp.y) <= 8).length >= 3;
    if (devCrowd) devCrowdSince ??= now0;
    else devCrowdSince = null;
    const devCrowded = devCrowdSince != null && now0 - devCrowdSince > 20_000;
    if (devCrowded) decide(`Devias lleno (3+ jugadores en el campamento hace 20 s): cambio de entrada.`);
    // En el arranque solo cuenta Devias lleno (el navegador tenía el hambre apagado debajo del 100), con
    // una red: 60 s en el mapa sin NADA de exp (17 jugadores en Devias 4 a las 13 h: 99 skills y 0
    // kills; otra vez, Devias 4 vacío sin un monstruo a la vista) → otra entrada o Arena 1 desde el 50.
    // Solo en Devias: en Lorencia no hay otro spot (y el camino al Lich con el punto de paso puede pasar 60 s).
    const earlyStarving = inEarly && world.map === 2 && now0 - bot.lastArrivalAt > EARLY_STARVE_MS && expLog.perMin(now0, EARLY_STARVE_MS) === 0;
    if (earlyStarving && now0 - starvingLogged > 15_000) {
      starvingLogged = now0;
      decide(`Arranque: ${EARLY_STARVE_MS / 1000} s sin exp en ${bot.currentSpot?.name ?? mapName(world.map)}: cambio de spot.`);
    }
    // Sin exp: con jugadores cerca cuenta como lleno (desde el 50 → Arena 1); sin nadie, como mapa
    // vacío (otra entrada de Devias).
    const crowded = inEarly ? devCrowded || (earlyStarving && rivalsNear > 0) : hungry.starving || camps.crowdedSpot(now0) || devCrowded;
    const earlyDry = earlyStarving && rivalsNear === 0;
    if (devCrowded) devCrowdSince = null;
    // Cazando no se cambia de spot: manda la cacería.
    // Farmeo inicial (personaje nuevo en Lorencia): la ruta no lo mueve hasta que esté listo (early-step).
    if (!bot.hunting && !goldHold && !early.initial() && (ticks % 10 === 0 || crowded || earlyDry || !bot.currentSpot)) {
      if (earlyDry && bot.currentSpot) dryAt.set(bot.currentSpot.index, now0); // no volver enseguida (rebote entre entradas)
      const moved = await maybeChangeSpot({ crowded, mapDead: earlyDry });
      if (moved) {
        ctx.target = null;
        continue;
      }
      if (!inEarly && hungry.starving && learned.camps.camp && now0 - learned.camps.camp.since > CAMP.HUNGER_WINDOW_MS) {
        // No hay otra entrada/mapa: al menos cambiar de campamento.
        learned.camps.leave(now0, world.level, 'hambre con jugadores cerca', true, expLog);
        logCampEvents();
        ctx.target = null;
      }
    }

    // 7) Loot valioso (cajas, joyas, excelentes, guantes 10/1), PERO no si ya
    //    hay un objetivo a distancia de golpe (bug real: en una zona con mucho
    //    drop acumulado el bot se quedaba recogiendo y nunca peleaba).
    const npcs = ctx.npcs;
    const targetInMeleeRange =
      ctx.target != null && npcs.has(ctx.target) && chebyshev(world.x, world.y, npcs.get(ctx.target)!.x, npcs.get(ctx.target)!.y) <= 1;
    // Personaje nuevo: equiparse con lo que levantó (equip.ts), cada 8 s, en segundo plano.
    if (fresh && Date.now() - lastEquipTry > 8000) {
      lastEquipTry = Date.now();
      void equipStep().catch(() => {});
    }
    const fightNear = fresh && early.initial() && early.targets(ctx.npcs.values()).some((n) => chebyshev(world.x, world.y, n.x, n.y) <= 8);
    // Personaje nuevo en un spot ocupado sin rendir: pedir party al jugador más cercano (una vez cada 5 min)
    // y, si a los 90 s sigue sin exp, irse a otro campo (pedido del usuario: "pedir party o salir de ahí").
    if (fresh && early.initial() && !bot.inParty) {
      const nowP = Date.now();
      const near = [...world.players.entries()].map(([id, p]) => ({ id, p, d: chebyshev(world.x, world.y, p.x, p.y) })).filter((x) => x.d <= 10).sort((a, b) => a.d - b.d);
      const dry = nowP - bot.lastArrivalAt > 60_000 && expLog.perMin(nowP, 60_000) === 0;
      if (near.length && dry && nowP - lastPartyAsk > 5 * 60_000) {
        lastPartyAsk = nowP;
        sendToGS(new DataView(buildPartyInvite(near[0].id).buffer));
        decide(`Spot ocupado y sin exp: le pido party a ${near[0].p.name ?? '#' + near[0].id}.`);
      }
      if (near.length && nowP - bot.lastArrivalAt > 90_000 && expLog.perMin(nowP, 90_000) === 0 && nowP - lastFieldLeave > 3 * 60_000) {
        lastFieldLeave = nowP;
        const left = early.leaveField(5 * 60_000);
        if (left) decide(`${left}: ocupado por ${near.length} jugador(es) y sin exp en 90 s: me voy a otro campo por 5 min.`);
      }
    }
    if (!targetInMeleeRange && (await lootStep(fresh, fightNear))) {
      ctx.phase = 'walk';
      bot.doing = `levantando loot en ${mapName(world.map)}`;
      continue;
    }

    // 8) Elegir / mantener objetivo: campamento (camp.ts) + exp/s (farming.ts).
    if (ctx.target != null && !ctx.npcs.has(ctx.target)) ctx.target = null;
    const hunting = bot.hunting;
    // Dragones primero (golden.ts, dragonRush): en la ventana del aviso, sin dragón a la vista y con zona
    // conocida a donde ir, ni dorados comunes nuevos ni recordados: directo a las zonas de dragones.
    let rush = false;
    if (hunting && world.map === hunting.hunt.map && bot.dragonMap) {
      const dz = dragonZones(world.map);
      const visited = hunting.zonesVisited;
      rush = dragonRush({ now: Date.now(), announceAt: bot.dragonMap.at, huntMap: hunting.hunt.map, dragonMap: bot.dragonMap.map,
        dragonVisible: [...ctx.npcs.values()].some((n) => DRAGON_TYPES.has(n.type)), hasZone: dz.some((z) => !visited?.has(`${z.x},${z.y}`)) });
    }
    {
      // Datos de la pelea con el dragón más cercano a la vista (no cambia nada de lo que se hace).
      let dr: ScopedNpc | null = null;
      for (const n of ctx.npcs.values()) if (DRAGON_TYPES.has(n.type) && (!dr || chebyshev(world.x, world.y, n.x, n.y) < chebyshev(world.x, world.y, dr.x, dr.y))) dr = n;
      const nowF = Date.now();
      if (dr) {
        trackFight(dragonFight.see(dr, nowF, bot.dragonMap && nowF - bot.dragonMap.at < DRAGON_MAP_TTL_MS ? bot.dragonMap.at : null));
        dragonFight.players([...world.players.values()].filter((q) => !isMate(q.name ?? '')).map((q) => q.name));
      } else if (dragonFight.expired(nowF)) trackFight(dragonFight.lost());
    }
    if (hunting?.scout) {
      // Explorador: no pelea. Solo se defiende de lo que le pegó hace poco, a <= 2 tiles y que puede vencer.
      const nowS = Date.now();
      const me = scoutMe();
      const ok = (n: ScopedNpc) => nowS - (ctx.aggro.get(n.id) ?? -Infinity) <= SCOUT.defenseMs && chebyshev(world.x, world.y, n.x, n.y) <= SCOUT.defenseRadius && canFight(me, n.type);
      const cur = ctx.target != null ? ctx.npcs.get(ctx.target) : undefined;
      if (cur && !ok(cur)) ctx.target = null;
      if (ctx.target == null) {
        const t = [...ctx.npcs.values()].find((n) => !unreachable.has(n.id) && ok(n));
        if (t) {
          ctx.target = t.id;
          targetType = t.type;
          targetSince = nowS;
          stuckCount = 0;
          panelLog(`Explorador: me defiendo de ${monsterName(t.type)}.`);
        }
      }
    } else if (hunting) {
      // Cacería: un dorado siempre manda sobre los comunes, pero con correa (stickyGolden): no se suelta
      // el que ya tiene el golpe salvo por un dragón. A los comunes, nunca.
      const now = Date.now();
      let gold = stickyGolden({ x: world.x, y: world.y }, ctx.target, [...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)), (t) => GOLDEN_TYPES.has(t));
      // En la carrera por el dragón solo se sigue con el común que ya tiene el golpe.
      if (rush && gold && !DRAGON_TYPES.has(gold.type) && gold.id !== ctx.target) gold = null;
      const gd = gold ? chebyshev(world.x, world.y, gold.x, gold.y) : Infinity;
      // El dragón que se le está pegando sale un instante de la vista: no repartir el daño con un Goblin
      // cercano (lo vio el usuario, 2026-10-23); ir a donde estaba hasta DRAGON_MEMORY_MS.
      if (gold && DRAGON_TYPES.has(gold.type)) lastDragon = { id: gold.id, x: gold.x, y: gold.y, at: now };
      if (lastDragon && (!gold || !DRAGON_TYPES.has(gold.type)) && !ctx.npcs.has(lastDragon.id) && now - lastDragon.at < DRAGON_MEMORY_MS && world.map === hunting.hunt.map) {
        ctx.target = null;
        ctx.phase = 'walk';
        bot.doing = `cazando: el Golden Dragon salió de la vista, voy a (${lastDragon.x},${lastDragon.y})`;
        await walkTowards(ctx, lastDragon.x, lastDragon.y);
        continue;
      }
      // Recordar dónde está cada dorado a la vista (y avisar al compañero de los nuevos, rápido).
      const spots = (hunting.spots ??= new Map());
      for (const n of ctx.npcs.values()) {
        if (!isGolden(n)) continue;
        if (world.map === hunting.hunt.map) hunting.lastSeenAt = now;
        if (!spots.has(n.id) && world.map === hunting.hunt.map) {
          askHelp('golden', world.map, n.x, n.y, monsterName(n.type), HUNT_SHARE_MS);
          trackEvent('golden_seen', monsterName(n.type), n.type, n.id, { gx: n.x, gy: n.y });
        }
        spots.set(n.id, { x: n.x, y: n.y, type: n.type, at: now });
      }
      // Pistas de exploradores (scout.ts): dorados vistos hace < 3 min en este mapa se anotan como recordados
      // (una vez cada una: si se llega y ya no están, no se vuelve).
      if (world.map === hunting.hunt.map) {
        const hinted = (hunting.hinted ??= new Set());
        for (const hint of scoutHints(scoutReports(now), world.map, now, HUNT_SPOT_TTL_MS)) {
          if (hinted.has(hint.key)) continue;
          hinted.add(hint.key);
          spots.set(hint.key, { x: hint.x, y: hint.y, type: 0, at: hint.at });
        }
        if (hinted.size > 200) hinted.clear();
      }
      if (gold && ctx.target !== gold.id) {
        if (!hunting.seen.has(gold.id)) {
          hunting.seen.add(gold.id);
          panelLog(`Cacería: ${monsterName(gold.type)} a ${gd} tiles en (${gold.x},${gold.y}).`);
        }
        ctx.target = gold.id;
        targetType = gold.type;
        targetSince = now;
        stuckCount = 0;
      } else if (ctx.target != null && !isGolden(ctx.npcs.get(ctx.target)!)) {
        // Cazando no se pelea con comunes (EVENTOS.md; el usuario lo vio el 2026-10-23: "mata monstruos
        // irrelevantes"): cada golpe frena ~1 s y lo único que importa es llegar al próximo dorado.
        ctx.target = null;
      }
    } else if (early.active() && !goldHold) {
      // Arranque: objetivo con correa del campamento; uno que se alejó más de 10 se suelta.
      const { camp } = early.goal([...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)), ticks);
      const cur = ctx.target != null ? ctx.npcs.get(ctx.target) : null;
      if (cur && dist(cur, camp) > EARLY.dropTargetAt) ctx.target = null;
      if (ctx.target == null && !early.viaPending()) {
        const t = leashedTarget({ x: world.x, y: world.y }, camp, early.targets([...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)), ctx.aggro));
        if (t) {
          ctx.target = t.id;
          targetType = t.type;
          targetSince = Date.now();
          stuckCount = 0;
        }
      }
    } else if (ctx.target == null) {
      const now = Date.now();
      const pick = learned.camps.pick({
        now,
        map: world.map,
        me: { x: world.x, y: world.y },
        level: world.level,
        monsters: [...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)),
        players: [...world.players.values()],
        stats: typeStats,
        exp: expLog,
        typeKills,
      });
      logCampEvents();
      if (pick) {
        ctx.target = pick.id;
        targetType = pick.type;
        targetSince = now;
        stuckCount = 0;
        if (process.env.MUBOT_DEBUG_COMBAT) log(`DEBUG objetivo: Id=${ctx.target} tipo=${targetType} en (${pick.x},${pick.y})`);
      }
    }
    // El reloj de mapa vacío corre desde la llegada, aunque el explorador
    // todavía no haya tenido que elegir a dónde caminar (había campamento).
    if (explorerMap !== world.map) {
      explorerMap = world.map;
      explorer.enterMap(world.map, world.x, world.y, Date.now());
    }
    if (ctx.npcs.size) explorer.sawMonster(Date.now());

    if (ctx.target != null) {
      const target = ctx.target;
      const t = ctx.npcs.get(target)!;
      const tDist = chebyshev(world.x, world.y, t.x, t.y);
      if (process.env.MUBOT_DEBUG_COMBAT && ticks % 5 === 0) {
        log(`DEBUG combate: target=${target} yo=(${world.x},${world.y}) target_pos=(${t.x},${t.y}) dist=${tDist} stuck=${stuckCount}`);
      }
      ctx.phase = 'fight';
      bot.doing = `${bot.hunting ? 'cazando: ' : ''}peleando con ${monsterName(t.type)} en ${mapName(world.map)} (${world.x},${world.y})`;
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
        // A distancia de golpe (o de cast, para un mago): skill si hay (respetando SKILL_PACE_MS desde el
        // último cast, también los del camino), si no el hit normal.
        const sinceCast = Date.now() - ctx.lastCastAt;
        if (sinceCast < SKILL_PACE_MS && pickAttackSkill()) {
          await sleep(SKILL_PACE_MS - sinceCast);
          continue;
        }
        if (useSkill(target, isGolden(t) ? goldenSkill() : undefined)) {
          ctx.lastCastAt = Date.now();
          ctx.skillsUsed++;
          if (DRAGON_TYPES.has(t.type)) dragonFight.hit(target, ctx.lastCastAt);
          await sleep(humanPace(SKILL_PACE_MS));
        } else if (tDist <= 1) {
          sendHit(target, directionTowards(world.x, world.y, t.x, t.y));
          if (DRAGON_TYPES.has(t.type)) dragonFight.hit(target, Date.now());
          await sleep(humanPace(ATTACK_PACE_MS));
        } else {
          await sleep(humanPace(SKILL_PACE_MS)); // sin maná para el skill: esperar en vez de pegar de lejos
        }
        continue;
      }
      attackTarget = null; // fuera de alcance: el reloj de "no muere" vuelve a empezar al llegar
      // Cazando un dorado: caminar con el camino del terreno (path.ts), no en línea recta contra la
      // pared (2026-10-23: a 10 tiles de dos dragones y no llegó en 60 s); un dragón no se da por
      // inalcanzable tan pronto (cae a comunes y pierde la caja).
      const huntDr = !!bot.hunting && DRAGON_TYPES.has(t.type);
      if (stuckCount >= (huntDr ? 24 : 8)) {
        log(`Objetivo ${target} inalcanzable, lo abandono.`);
        unreachable.add(target);
        ctx.target = null;
        stuckCount = 0;
        continue;
      }
      if (bot.hunting && isGolden(t)) {
        const bx = world.x;
        const by = world.y;
        await walkTowards(ctx, t.x, t.y);
        stuckCount = world.x === bx && world.y === by ? stuckCount + 1 : 0;
        continue;
      }
      // Girar con lo que esté a <= 3 mientras se acerca (no frena la caminata).
      castOnTheWay(ctx);
      const straight = directionTowards(world.x, world.y, t.x, t.y);
      const dir = stuckCount >= 3 ? (straight + 2 + (stuckCount % 4)) % 8 : straight;
      step(dir);
      await sleep(humanPace(WALK_PACE_MS));
      if (world.x === ctx.lastX && world.y === ctx.lastY) stuckCount++;
      else stuckCount = 0;
      ctx.lastX = world.x;
      ctx.lastY = world.y;
      continue;
    }

    // 9) Sin objetivo.
    //  a) Mapa vacío DRY_MAP_MS (90 s): la ruta fija pasa a otra entrada del
    //     tramo (o se queda si no hay); el spot queda excluido un rato.
    const now = Date.now();
    // Arranque sin objetivo: al campamento (o al punto de paso de Lorencia) y esperar ahí.
    if (early.active()) {
      const { goal } = early.goal([...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)), ticks);
      bot.goalPoint = [goal.x, goal.y];
      if (dist({ x: world.x, y: world.y }, goal) > 2) {
        ctx.phase = 'walk';
        bot.doing = `arranque: voy al campamento (${goal.x},${goal.y}) en ${mapName(world.map)}`;
        castOnTheWay(ctx);
        await walkTowards(ctx, goal.x, goal.y);
      } else {
        ctx.phase = 'wait';
        bot.doing = `arranque: espero en el campamento (${goal.x},${goal.y}) de ${mapName(world.map)}`;
        await sleep(300);
      }
      continue;
    }
    //  0) Cacería: recorrer el mapa en celdas de 25 tiles (panel-logic.ts).
    if (bot.hunting) {
      // Primero el dorado recordado más cercano (visto hace < 3 min en este mapa); llegado ahí sin verlo,
      // se olvida. Si no hay ninguno, recorrer celdas.
      const spots = bot.hunting.spots;
      let mem: { id: number; x: number; y: number } | null = null;
      if (!bot.hunting.scout && spots && world.map === bot.hunting.hunt.map && !rush) {
        let md = Infinity;
        for (const [id, sp] of spots) {
          const d = chebyshev(world.x, world.y, sp.x, sp.y);
          if (now - sp.at > HUNT_SPOT_TTL_MS || (d <= 4 && !ctx.npcs.has(id))) { spots.delete(id); continue; }
          if (d < md) { md = d; mem = { id, x: sp.x, y: sp.y }; }
        }
      }
      // Sin dorado recordado: la zona de dragones más cercana sin visitar (zones.ts, de la base).
      if (!bot.hunting.scout && !mem && world.map === bot.hunting.hunt.map) {
        const visited = (bot.hunting.zonesVisited ??= new Set());
        // Primero las zonas de dragones; después las de cualquier dorado.
        const zs = dragonZones(world.map).length && [...dragonZones(world.map)].some((z) => !visited.has(`${z.x},${z.y}`)) ? dragonZones(world.map) : goldenZones(world.map);
        for (const z of zs) if (chebyshev(world.x, world.y, z.x, z.y) <= 6) visited.add(`${z.x},${z.y}`);
        const z = nextZone(zs, { x: world.x, y: world.y }, visited);
        if (z) {
          bot.goalPoint = [z.x, z.y];
          bot.doing = `cazando dorados en ${bot.hunting.hunt.name}: voy a la zona de dragones (${z.x},${z.y}) (${z.n} avistamientos)`;
          ctx.phase = 'walk';
          castOnTheWay(ctx);
          await walkTowards(ctx, z.x, z.y);
          continue;
        }
      }
      if (mem) {
        bot.goalPoint = [mem.x, mem.y];
        bot.doing = `cazando dorados en ${bot.hunting.hunt.name}: voy al dorado visto en (${mem.x},${mem.y})`;
        ctx.phase = 'walk';
        castOnTheWay(ctx);
        await walkTowards(ctx, mem.x, mem.y);
        continue;
      }
      // Con el terreno del mapa solo recorre lo caminable y alcanzable, sin repetir, primero las celdas con
      // dorados vistos (zones.ts); sin el .att del mapa, a ciegas como antes.
      if (terrainOf(world.map)) {
        const walk = walkableFor(world.map);
        bot.hunting.explorer.useTerrain(world.map, walk, (x, y) => walk(x, y) && !isSafeZone(world.map, x, y), { x: world.x, y: world.y }, zoneWeights(world.map, bot.hunting.explorer.cell, now), avoidCells(insights(now), world.map, now));
      }
      const g = bot.hunting.explorer.next(world.x, world.y, now);
      bot.goalPoint = [g.x, g.y];
      bot.doing = bot.hunting.scout ? `explorando ${bot.hunting.hunt.name} sin pelear: recorro la celda (${g.x},${g.y})` : `cazando dorados en ${bot.hunting.hunt.name}: recorro la celda (${g.x},${g.y})`;
      ctx.phase = 'walk';
      castOnTheWay(ctx);
      await walkTowards(ctx, g.x, g.y);
      continue;
    }
    if (explorer.isDry(now) && !early.initial()) {
      const where = bot.currentSpot?.name ?? `map ${world.map}`;
      log(`Mapa sin monstruos hace ${EXPLORE.DRY_MAP_MS / 1000} s en ${where}: busco otro spot.`);
      if (bot.currentSpot) dryAt.set(bot.currentSpot.index, now);
      const moved = await maybeChangeSpot({ mapDead: true });
      if (!moved) {
        log('No hay otro spot elegible (o se rechazó el warp): sigo explorando acá.');
        explorer.resetDry(Date.now());
      }
      continue;
    }
    //  b) Campamento (actual, memoria, arranque) o volver a la correa.
    const cg = learned.camps.goal(now, world.map, { x: world.x, y: world.y }, world.level, expLog);
    logCampEvents();
    if (cg) {
      const txt = `${cg.kind} (${cg.x},${cg.y})`;
      if (txt !== lastGoalTxt) {
        lastGoalTxt = txt;
        log(`Voy a ${txt} desde (${world.x},${world.y}) map=${world.map}.`);
      }
      bot.goalPoint = [cg.x, cg.y];
      if (chebyshev(world.x, world.y, cg.x, cg.y) <= 2) {
        // En el campamento esperando el respawn: sin packets.
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
    //  c) Explorador: spots calientes (<= 30 tiles, dentro de la correa) y,
    //     sin ellos, salidas del pueblo (o alrededor de la llegada si hay correa).
    explorer.setLeash(learned.camps.leashFor(world.map));
    const act = explorer.tick(world.map, world.x, world.y, now);
    for (const e of explorer.events) {
      const g = e.goal;
      const txt = {
        'hot-empty': `spot caliente (${g.x},${g.y}) vacío, lo marco y sigo`,
        'hot-timeout': `no llego al spot caliente (${g.x},${g.y}), lo marco vacío`,
        'exit-abandoned': `salida (${g.x},${g.y}) sin monstruos tras esperar, pruebo la siguiente`,
        'exit-timeout': `no llego a la salida (${g.x},${g.y}), pruebo la siguiente`,
      }[e.kind];
      log(`Explorar: ${txt}.`);
    }
    {
      const g = act.goal;
      const txt = g.kind === 'hot' ? `spot caliente (${g.x},${g.y})` : `salida #${g.index + 1}/${explorer.exitList.length} (${g.x},${g.y})`;
      if (txt !== lastGoalTxt) {
        lastGoalTxt = txt;
        log(`Explorar: voy a ${txt}${g.kind === 'hot' ? `, ${Math.round(explorer.hot.get(world.map, g.cx, g.cy)?.exp ?? 0)} exp acumulada ahí` : ''} desde (${world.x},${world.y}) map=${world.map}.`);
      }
    }
    ctx.phase = act.action === 'wait' ? 'wait' : 'walk';
    bot.goalPoint = [act.goal.x, act.goal.y];
    bot.doing = `explorando ${mapName(world.map)}: ${act.goal.kind === 'hot' ? 'spot caliente' : 'salida'} (${act.goal.x},${act.goal.y})`;
    if (act.action === 'wait') {
      // Parado mirando: sin packets, solo deja correr el tick (si aparece un
      // monstruo, el paso 8 lo toma).
      await sleep(500);
      continue;
    }
    castOnTheWay(ctx);
    await walkTowards(ctx, act.x, act.y);
  }

  EventBus.off('ObjectGotKilled', onKilled);
  EventBus.off('ObjectMoved', onHitDamage);
  EventBus.off('ExperienceGained', onExp);
  EventBus.off('CurrentHealthAndShield', onHp);
  stopWatchingDrops();
  await persistLearning();
  drops.clear();
  lootState.looting = null;

  log(report.format(Date.now(), world.level, learned.char.resets, bot.kicked ? 'conexión cortada' : 'fin'));
  log(`Tramos por ciclo:\n${learned.cycleLog.format()}`);
  log(`\nFin del loop: ${kills} kill(s), +${totalExpGained} exp, ${potionsDrunk} pocion(es), ${statPointsSpent} stat(s), ${ctx.skillsUsed} skill(s), ${resets} reset(s), ${deaths} muerte(s).`);
  log(`Posición final (${world.x},${world.y}) map=${world.map}. Desconectado: ${bot.kicked}`);
  return { kills, totalExpGained, potionsDrunk, statPointsSpent, skillsUsed: ctx.skillsUsed, resets, deaths };
}
