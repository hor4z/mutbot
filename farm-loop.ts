/**
 * Loop autónomo: prioriza sobrevivir > órdenes del panel > reset > subir stats > esquina de
 * Arena 2 > cambiar de spot > loot > pelear > campamento/explorar. Una corrida por conexión, a
 * ritmo HUMANO (no flood): ver config.ts y AGENTS.md, "Anti-cheat".
 */
import { askHelp, newRequests, teammates } from './team';
import { track, trackEvent } from './telemetry';
import { DRAGON_TYPES } from './golden';
import { closeSockets } from './connection';
import { AUTO_HUNT_ON, ATTACK_PACE_MS, ATTACK_SKILL_POOL, BUILD, BUILD_ARG, EXPLORE_PREF, HEAL_AT_PCT, RESET_LEVEL, SKILL_PACE_MS, TARGET_NO_KILL_MS, UNREACHABLE_MS, WALK_PACE_MS } from './config';
import { sendHit, sendTargetedSkill, step } from './actions';
import { CAMP } from './camp';
import { SKILL_TABLE, castReach, checkSurvival, isMage, pickAttackSkill, useSkill } from './combat';
import { CORNER, cornerActive, inCorner } from './corner';
import { cornerStep, newCornerState, type CornerState } from './corner-step';
import { EARLY, dist, leashedTarget } from './early';
import { EarlyPlanner } from './early-step';
import { DEFENSE, Defense } from './defense';
import { GoldenRule } from './golden';
import { attackerOf, ownAreaSkill } from './protocol097';
import { GOLDEN_TYPES, MATES, isMate } from './state';
import { WARP_SPOTS } from './route';
import { toBytes } from './util';
import { EXPLORE, Explorer } from './explore';
import { SelfReport } from './farming';
import { decide, journal, panelLog } from './journal';
import { LEARN, routeTier, type Spot } from './learning';
import { lootState, drops, lootStep, watchDrops } from './loot';
import { castOnTheWay, newLoopCtx, walkTowards, type LoopCtx } from './loop-ctx';
import { EventBus } from './net/eventBus';
import { CurrentHealthAndShieldPacket, ExperienceGainedPacket, ObjectGotKilledPacket } from './packets';
import { currentMode, publishGold, sessionStart, setLoopView, stopHunt } from './panel';
import { AUTO_HUNT, GoldReporter, HUNT_MAPS, HuntExplorer, autoHuntChoice, invasionKey, mapName, resetBlockedByInvasion, shouldStopHunt } from './panel-logic';
import { doReset, investStatPointsInBackground } from './progress';
import { SAVE_EVERY_MS, WARP_COOLDOWN_MS, dryAt, maybeChangeSpot, persistLearning, warpAndWait, zenTxt } from './route';
import { bot, expLog, expTracker, hotGrid, isGolden, learned, monsterName, typeStats, world, type ScopedNpc } from './state';
import { isSafeZone } from './terrain';
import { chebyshev, directionTowards, log, sleep } from './util';
import { watchMoney } from './world';

// Autoevaluación en consola cada esto (ver SelfReport en farming.ts).
const REPORT_EVERY_MS = 5 * 60_000;
// Cazando, a un monstruo común solo se le pega si está a esto (no frena la búsqueda).
const HUNT_NORMAL_RANGE = 3;
// Cacería: un dorado visto se recuerda 3 min (para volver después de morir) y se le avisa al compañero
// (como mucho un aviso cada 15 s).
const HUNT_SPOT_TTL_MS = 3 * 60_000;
const HUNT_SHARE_MS = 15_000;
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

function dataTick(ctx: LoopCtx, corner: CornerState) {
  const now = Date.now();
  lastTickAt = now;
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
  }, now);
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
  // Monstruos atacables: los de world.npcs que NO están en zona segura. Después del reset Horaz quedó
  // pegándole a unos Lord centurion parados en el pueblo de Lorencia (en zona segura no hay daño):
  // 0 exp hasta que se lo cortó. Se recalcula al inicio de cada tick; el panel sigue viendo todos.
  const refreshAttackable = () => {
    ctx.npcs = new Map();
    for (const [id, n] of world.npcs) if (!isSafeZone(world.map, n.x, n.y)) ctx.npcs.set(id, n);
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
  let phaseAt = Date.now();
  // Desde cuándo perseguimos al objetivo actual (segundos hasta matarlo).
  let targetSince = 0;
  let targetType = -1;
  let starvingLogged = 0;

  // Muerte propia: llega por dos lados (HP a 0 y ObjectGotKilled con nuestro
  // id); el meter descarta el duplicado. Se corta el tramo y se olvida el spot
  // actual: el respawn es en el pueblo, así que el próximo maybeChangeSpot
  // vuelve a warpear (canAdopt = false: no adoptar el pueblo como spot).
  const onDeath = (source: string) => {
    if (Date.now() - lastDeathAt < LEARN.DEATH_DEBOUNCE_MS) return;
    lastDeathAt = Date.now();
    deaths++;
    log(`Muerte #${deaths} (${source}) en ${bot.currentSpot?.name ?? 'spot desconocido'}.`);
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
    const wasOurTarget = (p.KilledId & 0x7fff) === ctx.target;
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
    // Ciego: el server a veces deja de mandar el scope de monstruos (Horaz y Melu en Lorencia: 0
    // monstruos, 0 muertes, solo jugadores y paquetes 0x11). Reconectar lo arregla: con NINGÚN
    // monstruo a la vista (ni en zona segura) durante BLIND_RECONNECT_MS, se corta y se vuelve a entrar.
    // También sin exp: con la sesión "fantasma" llegan monstruos pero ninguno muere y no entra exp.
    const farming = !bot.paused && !bot.hunting && !bot.resetting && bot.inGameAt > 0;
    if (bot.inGameAt > 0 && Date.now() - lastTickAt >= TICK_MS) dataTick(ctx, corner);
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
      await sleep(SKILL_PACE_MS);
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
    // Cacería: cortar a tiempo (0xFD dice 0 vivos, derrotada, 15 min) y llegar al mapa.
    if (bot.hunting) {
      const h = bot.hunting;
      const nowH = Date.now();
      const stop = shouldStopHunt({ invasion: bot.invasion, map: h.hunt.map, since: h.since, now: nowH, stopAlive: h.auto ? AUTO_HUNT.stopAlive : undefined });
      if (stop) {
        stopHunt(stop);
        ctx.target = null;
        continue;
      }
      if (world.map !== h.hunt.map) {
        ctx.target = null;
        if (nowH < h.nextWarpAt) {
          await sleep(500);
          continue;
        }
        if (h.warpTries >= 3) {
          stopHunt(`no pude llegar a ${h.hunt.name}`);
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
        if (world.map !== 0 && nowD - lastFleeAt > 30_000 && defense.shouldFlee(hpPct, world.map, nowD)) {
          lastFleeAt = nowD;
          decide(`Defensa: vida ${Math.round(hpPct * 100)} % peleando con un jugador: me voy a Lorencia y evito este mapa ${DEFENSE.avoidMapMs / 60_000} min.`);
          if (world.map === CORNER.map) corner.awayUntil = nowD + DEFENSE.avoidMapMs;
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
          await sleep(SKILL_PACE_MS);
        } else if (!info && d <= 1) {
          sendHit(foe.id, directionTowards(world.x, world.y, foe.x, foe.y));
          await sleep(ATTACK_PACE_MS);
        } else await walkTowards(ctx, foe.x, foe.y);
        continue;
      }
    }

    // 1d) Regla fuerte de dorados (golden.ts): farmeando, un dorado a <= 20 es el objetivo (dragones
    //     primero); mientras tanto y 15 s después (cajas) no se resetea, no se cambia de spot ni se
    //     vuelve a la esquina.
    const nowG = Date.now();
    const gold = bot.hunting ? null : golden.pick({ x: world.x, y: world.y }, ctx.npcs.values(), (t) => GOLDEN_TYPES.has(t), nowG);
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
          if (bot.hunting && bot.hunting.hunt.map === r.map) {
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
    if (AUTO_HUNT_ON && !bot.hunting && !bot.pinnedSpot && !bot.paused && !bot.resetting) {
      const ch = autoHuntChoice({ invasion: bot.invasion, level: world.level, now: nowG, lastKey: lastAutoHuntKey });
      if (ch?.ok) {
        lastAutoHuntKey = invasionKey(bot.invasion!);
        bot.hunting = { hunt: ch.hunt, since: nowG, warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set(), auto: true };
        ctx.target = null;
        decide(`Cazador: invasión dorada con ${ch.alive} vivos en ${ch.hunt.name}: salgo a cazar (corto con ${AUTO_HUNT.stopAlive} o menos).`);
        journal('travel', `cazador automático: ${ch.hunt.name}`, { map: ch.hunt.map, alive: ch.alive, reason: 'auto-hunt' });
        continue;
      }
    }

    // 2) Reset al llegar al nivel: lo más importante para progresar (no a mitad de una cacería). Entre
    //    :47 y :51 no, para llegar a la invasión de las :50 (con el cazador prendido).
    if (!bot.hunting && !goldHold && !(AUTO_HUNT_ON && resetBlockedByInvasion(Date.now())) && world.level >= RESET_LEVEL && Date.now() >= nextResetTry) {
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
    if (corner.awayUntil && Date.now() >= corner.awayUntil && world.level >= CORNER.noReturnLevel) corner.awayUntil = Date.now() + 60_000;
    if (!bot.hunting && !bot.pinnedSpot && !goldHold && cornerActive({ level: world.level, resetLevel: RESET_LEVEL, awayUntil: corner.awayUntil, now: Date.now() })) {
      await cornerStep(ctx, corner);
      continue;
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
    if (!bot.hunting && !goldHold && (ticks % 10 === 0 || crowded || earlyDry || !bot.currentSpot)) {
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
    if (!targetInMeleeRange && (await lootStep())) {
      ctx.phase = 'walk';
      bot.doing = `levantando loot en ${mapName(world.map)}`;
      continue;
    }

    // 8) Elegir / mantener objetivo: campamento (camp.ts) + exp/s (farming.ts).
    if (ctx.target != null && !ctx.npcs.has(ctx.target)) ctx.target = null;
    const hunting = bot.hunting;
    if (hunting) {
      // Cacería: el dorado más cercano siempre manda (aunque estemos pegándole a
      // otro); a los comunes solo si están a HUNT_NORMAL_RANGE (no frenan la búsqueda).
      const now = Date.now();
      let gold: ScopedNpc | null = null;
      let gd = Infinity;
      for (const n of ctx.npcs.values()) {
        if (!isGolden(n) || unreachable.has(n.id)) continue;
        const d = chebyshev(world.x, world.y, n.x, n.y);
        if (d < gd) {
          gd = d;
          gold = n;
        }
      }
      // Recordar dónde está cada dorado a la vista (y avisar al compañero de los nuevos, rápido).
      const spots = (hunting.spots ??= new Map());
      for (const n of ctx.npcs.values()) {
        if (!isGolden(n)) continue;
        if (!spots.has(n.id) && world.map === hunting.hunt.map) {
          askHelp('golden', world.map, n.x, n.y, monsterName(n.type), HUNT_SHARE_MS);
          trackEvent('golden_seen', monsterName(n.type), n.type, n.id, { gx: n.x, gy: n.y });
        }
        spots.set(n.id, { x: n.x, y: n.y, type: n.type, at: now });
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
      } else if (ctx.target != null) {
        const t = ctx.npcs.get(ctx.target)!;
        if (!isGolden(t) && chebyshev(world.x, world.y, t.x, t.y) > HUNT_NORMAL_RANGE) ctx.target = null;
      }
      if (ctx.target == null) {
        let near: ScopedNpc | null = null;
        let nd = Infinity;
        for (const n of ctx.npcs.values()) {
          if (unreachable.has(n.id)) continue;
          const d = chebyshev(world.x, world.y, n.x, n.y);
          if (d <= HUNT_NORMAL_RANGE && d < nd) {
            nd = d;
            near = n;
          }
        }
        if (near) {
          ctx.target = near.id;
          targetType = near.type;
          targetSince = now;
          stuckCount = 0;
        }
      }
    } else if (early.active() && !goldHold) {
      // Arranque: objetivo con correa del campamento; uno que se alejó más de 10 se suelta.
      const { camp } = early.goal([...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)), ticks);
      const cur = ctx.target != null ? ctx.npcs.get(ctx.target) : null;
      if (cur && dist(cur, camp) > EARLY.dropTargetAt) ctx.target = null;
      if (ctx.target == null && !early.viaPending()) {
        const t = leashedTarget({ x: world.x, y: world.y }, camp, [...ctx.npcs.values()].filter((n) => !unreachable.has(n.id)));
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
        if (useSkill(target)) {
          ctx.lastCastAt = Date.now();
          ctx.skillsUsed++;
          await sleep(SKILL_PACE_MS);
        } else if (tDist <= 1) {
          sendHit(target, directionTowards(world.x, world.y, t.x, t.y));
          await sleep(ATTACK_PACE_MS);
        } else {
          await sleep(SKILL_PACE_MS); // sin maná para el skill: esperar en vez de pegar de lejos
        }
        continue;
      }
      attackTarget = null; // fuera de alcance: el reloj de "no muere" vuelve a empezar al llegar
      if (stuckCount >= 8) {
        log(`Objetivo ${target} inalcanzable, lo abandono.`);
        unreachable.add(target);
        ctx.target = null;
        stuckCount = 0;
        continue;
      }
      // Girar con lo que esté a <= 3 mientras se acerca (no frena la caminata).
      castOnTheWay(ctx);
      const straight = directionTowards(world.x, world.y, t.x, t.y);
      const dir = stuckCount >= 3 ? (straight + 2 + (stuckCount % 4)) % 8 : straight;
      step(dir);
      await sleep(WALK_PACE_MS);
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
      if (spots && world.map === bot.hunting.hunt.map) {
        let md = Infinity;
        for (const [id, sp] of spots) {
          const d = chebyshev(world.x, world.y, sp.x, sp.y);
          if (now - sp.at > HUNT_SPOT_TTL_MS || (d <= 4 && !ctx.npcs.has(id))) { spots.delete(id); continue; }
          if (d < md) { md = d; mem = { id, x: sp.x, y: sp.y }; }
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
      const g = bot.hunting.explorer.next(world.x, world.y, now);
      bot.goalPoint = [g.x, g.y];
      bot.doing = `cazando dorados en ${bot.hunting.hunt.name}: recorro la celda (${g.x},${g.y})`;
      ctx.phase = 'walk';
      castOnTheWay(ctx);
      await walkTowards(ctx, g.x, g.y);
      continue;
    }
    if (explorer.isDry(now)) {
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
