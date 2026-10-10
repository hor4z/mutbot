/**
 * Agente que juega DENTRO del cliente web (mu.mormon.garden), para que el
 * usuario lo vea jugar en su pantalla. Usa los controles del propio cliente:
 *   __world.attackTarget     → perseguir y pegar (como clickear un monstruo)
 *   __world.castRequest      → lanzar el skill seleccionado (Twisting Slash, 41)
 *   playerMoveTo + sendToServer=true → caminar. SIN sendToServer el movimiento
 *                              es solo visual: el server no se entera, no manda
 *                              monstruos y te devuelve al pueblo.
 *   __store.consumeItemRequest → pociones;  __store.warpCommandRequest → warp
 *   chat C1 00 → /add <stat> <n> y /reset;  __store.selectCharacterRequest
 *
 * Se instala pegándolo en la consola de la pestaña del juego (o con la
 * extensión de Chrome) con el personaje ya en el mundo. Estado y log en
 * window.__ai (__ai.log, __ai.kills, __ai.hot). Pausar: __ai.on = false.
 *
 * Lo aprendido jugando (2026-10-10):
 * - Monstruo = NPC con TypeNumber fuera de 200-299 (los del pueblo). NO filtrar
 *   por `interactable` (todo lo es) ni por `playerAnimation` (el esqueleto, tipo
 *   14, usa el modelo de jugador).
 * - Lorencia: los monstruos están por la salida "de arriba" en pantalla, que en
 *   el mundo es hacia (-x,+z) del centro (cámara mirando a (-x,+z)): la cripta,
 *   esqueletos en ~(120-140, 175-210).
 * - Mientras `__store.sceneLoading` es true no hay que mandar nada.
 */
(() => {
  const old = window.__ai;
  // Todos los temporizadores del agente (y de tuner/skill-ab) se registran acá: reinstalar
  // apaga TODO lo anterior, incluso lo que quedó colgado de copias viejas del agente.
  for (const id of window.__mubotTimers ?? []) clearInterval(id);
  window.__mubotTimers = [];
  const setInterval = (fn, ms) => { const id = window.setInterval(fn, ms); window.__mubotTimers.push(id); return id; };
  for (const t of ['timer', 'sampler', 'mgr', 'saver', 'markVisited', 'densityTimer', 'caster', 'deathTimer', 'looter', 'campMem', 'segTimer', 'expCompactor', 'castWatch', 'idleWatch']) if (old?.[t]) clearInterval(old[t]);
  const S = __store, W = () => __world;
  // Lo aprendido sobrevive a un F5: localStorage por personaje.
  const KEY = `mubot-ai:${S.playerData?.name ?? 'pj'}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const SCREEN = { up: [-1, 1], right: [1, 1], down: [1, -1], left: [-1, -1] };
  const ai = (window.__ai = {
    on: true, busy: false, log: [...(old?.log ?? [])], // copia: lo que quede colgado de copias viejas no ensucia este log samples: old?.samples ?? [], kills: old?.kills ?? 0, resets: old?.resets ?? 0,
    t0: Date.now(), lastPotion: 0, lastWarp: old?.lastWarp ?? 0, spot: old?.spot ?? null,
    // Reinstalar no debe hacerlo abandonar el spot en el que está.
    spotScore: old?.spotScore ?? saved.spotScore ?? {}, spotRun: old?.spotRun ?? null, tierSeen: old?.tierSeen ?? 0,
    cycles: old?.cycles ?? [], cycleStart: old?.cycleStart ?? null, time: old?.time,
    expByType: old?.expByType ?? saved.expByType ?? {}, expLog: old?.expLog ?? [], expHooked: old?.expHooked ?? false,
    killSecByType: old?.killSecByType ?? saved.killSecByType ?? {}, hpByType: old?.hpByType ?? saved.hpByType ?? {}, netInfo: old?.netInfo ?? new Map(), targetSince: 0,
    target: null, explore: null, arrivedAt: 0, stuck: 0, lastPos: null,
    lastMonster: Date.now(), mapNoMonsterSince: Date.now(), scoutIdx: 0, hot: old?.hot ?? saved.hot ?? {},
    camp: null, campBest: old?.campBest ?? {}, leftCamps: [], visited: old?.visited ?? {}, tierRef: old?.tierRef ?? {},
    cfg: {
      // scan cubre todo el scope: la distancia ya pesa en la cuenta de exp/s.
      // hpPot 0.55 no alcanzó en Arena 4 con skill continuo: murió en un grupo.
      // castRange 3: Twisting Slash gira alrededor del DK (~2-3 tiles). Con 6 giraba en el aire.
      // vitShare 0.05: con 15% la vida y el maná quedaban siempre llenos en Arena 4.
      hpPot: 0.7, mpPot: 0.3, castRange: 3, vitShare: 0.05, scan: 80, secPerTile: 0.4, maxKillSec: 8, unknownPessimism: 1.4,
      // Campamento: pelear solo a <= campRadius de un centro; mudarse si tras campEvalMs
      // rinde < campMinFrac del mejor campamento del mapa, o si pasa campEmptyMs vacío.
      campRadius: 10, campEvalMs: 90000, campEmptyMs: 12000, campMinFrac: 0.5,
      // Mudarse si hay >= crowdRivals jugadores cerca del campamento durante crowdMs.
      // Con 2 jugadores/10 s saltaba de campamento todo el tiempo en Arena (25% caminando).
      crowdRivals: 3, crowdMs: 20000, crowdMinFrac: 0.7, campDistDecay: 12, clusterStop: 3, clusterStopDown: 8,
      anchor: 0, anchorRadius: 4, anchorWaitMs: 6000, roam: 0, enRouteScan: 8, hotMaxDist: 30, lootRadius: 12, campMemDist: 40,
      // Quedarse cerca del punto de llegada del warp: Devias 1-4 son el MISMO mapa y,
      // saltando de campamento en campamento, terminaba en la zona de Devias 1. El usuario:
      // "en las otras Devias hay spots muy cerca de donde sale el pj".
      // Solo en Devias (mapa 2). En Arena los buenos están ADENTRO, lejos de la llegada.
      leashDist: 25, leashMaps: [2],
      // Campamento de arranque por mapa: en Lorencia los esqueletos de la cripta (salida
      // de arriba). Sin esto, el tope de hotMaxDist la descartaba (queda a ~100 tiles del
      // punto de aparición) y daba vueltas cerca del pueblo sin monstruos.
      startCamp: { 0: { x: 132, z: 200 } },
      // Arenas (83/84/85 = Arena 2/3/4): la zona de abajo y por fuera en pantalla (+x, -z)
      // está llena de monstruos de mucha exp (125/126/127 dan ~1.6M en <2 s a nivel 240).
      // El usuario la señaló; al llegar se va directo ahí.
      preferDownMaps: [83, 84, 85],
      // Devias (2): "el spot está arriba" de la llegada (usuario). En pantalla arriba = (-x, +z).
      arrivalSpotDir: { 2: [-1, 1] },
      // Curiosidad: atacar primero tipos con < curiosityKills kills medidos a <= curiosityRadius.
      curiosityRadius: 8, curiosityKills: 3,
      // Densidad: cada 3 s, lo que se ve suma densityWeight × valor a la grilla caliente.
      // Ronda exploratoria (ai.exploreRound): los primeros exploreRoundMs en cada mapa,
      // recorrer lo menos visitado y pelear solo a <= exploreFightRadius.
      densityWeight: 0.02, exploreRoundMs: 60000, exploreFightRadius: 6,
      // Competencia: cada jugador a <= playerRadius del objetivo le resta competitionPenalty.
      playerRadius: 5, competitionPenalty: 0.3, giveUpZoneMs: 20000, giveUpMapMs: 90000,
      skill: 41, skillMinMp: 0.15,
      resetLevel: 400, statBatch: 200,
      // Ruta del usuario: Lorencia → Devias 3/4 (mejor), Devias 2 si no → Arena 2/3/4. Devias 1 y Arena 1 no sirven (Arena 1: monstruos flojos y dispersos, ~0 exp/min medido).
      spots: [[2, 'Lorencia', 10], [6, 'Devias 3', 20], [7, 'Devias 4', 20], [5, 'Devias 2', 20], [24, 'Arena 2', 100], [25, 'Arena 3', 200], [26, 'Arena 4', 300]],
      // Spot = exp/min. Tras evalMs, si rinde menos que minFracOfBest del mejor conocido, se cambia.
      evalMs: 120000, minFracOfBest: 0.5, respawnWaitMs: 8000,
      // Ruta fija: cambiar de mapa solo al cruzar el nivel de un tramo nuevo o si el
      // mapa se queda sin monstruos. Probar mapas "a ver si rinden más" costaba más
      // en warps y cargas de lo que ganaba (el usuario lo vio en pantalla).
      fixedRoute: true,
      // Plan B si todas las Devias están llenas de gente (nivel 50-99): Arena 1.
      crowdFallback: [[1, 'Arena', 50]],
      home: { 0: { x: 135, z: 128 } },
      scoutOrder: ['up', 'right', 'left', 'down'],
    },
  });
  const L = (ai.L = (m) => { ai.log.push(`${new Date().toLocaleTimeString()} ${m}`); if (ai.log.length > 400) ai.log.shift(); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hpOf = (e) => e.attributeSystem?.getValue?.('currentHealth') ?? 0;
  const alive = (e) => e && !e.dying && !e.objOutOfScope && W().getByNetId(e.netId) === e && hpOf(e) > 0;
  ai.isMonster = (e) => e.npcType !== undefined && !e.localPlayer && !(e.npcType >= 200 && e.npcType < 300);
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const potionSlot = (lo, hi) => { const it = S.playerData.items || []; let best = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= lo && x.num <= hi && i >= 12 && x.num > bn) { best = i; bn = x.num; } }); return best; };
  const walkable = (w, x, z) => x > 3 && z > 3 && x < 252 && z < 252 && w.isWalkable(x, z);
  ai.moveTo = (pe, p) => { const m = pe.playerMoveTo; m.point.x = p.x; m.point.y = p.z; m.handled = false; m.sendToServer = true; };
  const cell = (p) => `${Math.floor(p.x / 12)},${Math.floor(p.z / 12)}`;
  // n = exp acumulada en la celda: un spot vale por lo que rinde, no por cuántos bichos tiene.
  ai.noteHot = (map, p, value = 1) => { const h = (ai.hot[map] ??= {}); const c = (h[cell(p)] ??= { x: Math.round(p.x), z: Math.round(p.z), n: 0, emptyAt: 0 }); c.n += value; c.emptyAt = 0; };
  // Exp por kill: se aprende de experienceGained ({added, killedNetId}; kills grandes
  // llegan partidos en tramos de 65535). Cuando llega el evento el monstruo ya salió
  // del mundo, por eso el tipo se busca en netInfo (lo que vimos de cada netId).
  // Sin dato, se estima exp ∝ sqrt(vida): en MU la exp va con el NIVEL del monstruo,
  // que crece mucho más lento que su vida. El usuario lo confirmó jugando: con
  // monstruos más débiles sube más rápido.
  const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  const maxHpOf = (e) => { const h = e.attributeSystem?.getValue?.('maxHealth') || 0; if (h) ai.hpByType[e.npcType] = h; return h || ai.hpByType[e.npcType] || 1; };
  ai.expPerSqrtHp = () => median(Object.keys(ai.expByType).filter((k) => ai.hpByType[k]).map((k) => ai.expByType[k] / Math.sqrt(ai.hpByType[k])));
  ai.dps = () => median(Object.keys(ai.killSecByType).filter((k) => ai.hpByType[k]).map((k) => ai.hpByType[k] / ai.killSecByType[k]));
  ai.valueOf = (e) => ai.expByType[e.npcType] ?? Math.sqrt(maxHpOf(e)) * (ai.expPerSqrtHp() ?? 300);
  if (!ai.expHooked) {
    __eventBus.on('experienceGained', (p) => {
      const a = window.__ai; if (!a || !p?.added) return;
      const now = Date.now();
      // Un registro por segundo: los kills grandes llegan en ~60 tramos de 65535 y con un
      // registro por tramo los 5000 lugares cubrían ~30 s de juego, así que toda medición
      // de 1-3 min (spots, campamentos, autoajuste) salía truncada.
      const b = Math.floor(now / 1000) * 1000, lastE = a.expLog[a.expLog.length - 1];
      if (lastE && lastE.t === b) lastE.added += p.added; else { a.expLog.push({ t: b, added: p.added }); if (a.expLog.length > 20000) a.expLog.shift(); }
      const info = a.netInfo.get(p.killedNetId); if (!info) return;
      const k = info.type, last = a.lastExpKill;
      if (last && last.netId === p.killedNetId && now - last.t < 1500) { last.sum += p.added; a.expByType[k] = last.prev == null ? last.sum : last.prev * 0.7 + last.sum * 0.3; }
      else { const prev = a.expByType[k]; a.lastExpKill = { netId: p.killedNetId, t: now, sum: p.added, prev }; a.expByType[k] = prev == null ? p.added : prev * 0.7 + p.added * 0.3; }
      a.noteHot(W().mapIndex, info, p.added);
    });
    ai.expHooked = true;
  }
  // Sin medición: vida / daño por segundo medido, con algo de pesimismo.
  ai.killSecOf = (e) => { const k = ai.killSecByType[e.npcType]; if (k != null) return k; const dps = ai.dps(); return dps ? (maxHpOf(e) / dps) * ai.cfg.unknownPessimism : 3; };
  // Los otros jugadores están en playersQuery, no en byNetId.
  const rivalsPos = (w) => (w.playersQuery?.entities ?? []).filter((e) => !e.localPlayer && e.transform).map((e) => e.transform.pos);
  const expSince = (t) => ai.expLog.filter((x) => x.t >= t).reduce((a, x) => a + x.added, 0);
  ai.freePick = (w, P, c) => {
    const ms = [], players = rivalsPos(w);
    for (const e of w.byNetId.values()) {
      if (e.localPlayer || !ai.isMonster(e)) continue;
      ai.netInfo.set(e.netId, { type: e.npcType, x: e.transform.pos.x, z: e.transform.pos.z }); maxHpOf(e); if (alive(e)) ms.push(e);
    }
    if (ai.netInfo.size > 3000) ai.netInfo.clear();
    // Duros (kill estimado > maxKillSec) solo si no hay nada razonable.
    const easy = ms.filter((e) => ai.killSecOf(e) <= c.maxKillSec);
    const pool = easy.length ? easy : ms;
    let best = null, bestRate = 0;
    const leashed = (p) => !ai.arrival || ai.arrival.map !== w.mapIndex || !ai.cfg.leashMaps.includes(w.mapIndex) || dist(p, ai.arrival) <= c.leashDist;
    for (const e of pool) {
      const p = e.transform.pos, d = dist(P, p); if (d >= c.scan || !leashed(p)) continue;
      let crowd = 0; for (const o of pool) if (o !== e && dist(o.transform.pos, p) <= 3) crowd += ai.valueOf(o) * 0.5;
      const rivals = players.filter((q) => dist(q, p) <= c.playerRadius).length;
      const rate = ((ai.valueOf(e) + crowd) / (ai.killSecOf(e) + d * c.secPerTile)) * Math.pow(1 - c.competitionPenalty, rivals);
      if (rate > bestRate) { bestRate = rate; best = e; }
    }
    ai.lastPickRate = bestRate; ai.lastRivals = players.length;
    return best;
  };
  // Como juega una persona: elegir un lugar, quedarse mientras rinde, cambiar cuando no.
  ai.findCamp = (w, P) => {
    const ms = []; for (const e of w.byNetId.values()) if (ai.isMonster(e) && alive(e) && ai.killSecOf(e) <= ai.cfg.maxKillSec) ms.push(e);
    const players = rivalsPos(w);
    let best = null, bv = 0;
    const leashed = (p) => !ai.arrival || ai.arrival.map !== w.mapIndex || !ai.cfg.leashMaps.includes(w.mapIndex) || dist(p, ai.arrival) <= ai.cfg.leashDist;
    for (const e of ms) {
      const p = e.transform.pos; if (!leashed(p)) continue; let v = 0;
      for (const o of ms) if (dist(o.transform.pos, p) <= ai.cfg.campRadius) v += ai.valueOf(o) / ai.killSecOf(o);
      v *= Math.pow(1 - ai.cfg.competitionPenalty, players.filter((q) => dist(q, p) <= ai.cfg.campRadius).length);
      v /= 1 + dist(P, p) / ai.cfg.campDistDecay; // caminar cuesta: a 12 tiles vale la mitad
      if (v > bv) { bv = v; best = { x: Math.round(p.x), z: Math.round(p.z) }; }
    }
    return best;
  };
  ai.pickTarget = (w, P, c) => {
    const now = Date.now(), map = w.mapIndex;
    // Modo recorrida (roam=1): sin campamento, al mejor exp/s con la distancia como costo.
    // El usuario: "a veces moverse e ir tirando golpes rinde". El autoajuste decide.
    // Recorrida con competencia (usuario, Arena 4 con 3 jugadores y 3 monstruos): la recorrida
    // solo castigaba cada monstruo con gente cerca y se quedaba en la zona. Si hay >= crowdRivals
    // a <= 10 tiles durante crowdMs y la exp de los últimos 45 s cae bajo crowdMinFrac de lo
    // normal del tier, sale de recorrida por 4 min y acampa en la zona de abajo (Arenas).
    if (c.roam && !ai.roamOff) {
      const near = rivalsPos(w).filter((q) => dist(q, P) <= 10).length;
      if (near >= c.crowdRivals) ai.roamCrowdSince ??= now; else ai.roamCrowdSince = null;
      const ref = ai.tierRef?.[`t${ai.tierSeen ?? 0}`], recent = (expSince(now - 45000) / 45000) * 60000;
      const g = c.preferDownMaps.includes(map) && ai.downZone(w);
      if (g && dist(P, g) > 20 && ai.roamCrowdSince && now - ai.roamCrowdSince > c.crowdMs && (!ref || recent < ref * c.crowdMinFrac)) {
        ai.roamOff = now + 240000; ai.roamCrowdSince = null;
        ai.camp = { x: g.x, z: g.z, map, since: now, lastSeen: now, toDownZone: true };
        L(`recorrida con ${near} jugadores cerca y poca exp: voy a la zona de abajo (${g.x},${g.z})`);
      }
    }
    if (ai.roamOff && now > ai.roamOff) ai.roamOff = null;
    if (c.roam && !ai.roamOff) { ai.camp = null; return ai.freePick(w, P, c); }
    if (ai.camp && ai.camp.map !== map) ai.camp = null;
    // Mientras viaja al campamento, los relojes de "vacío" y "competencia" no corren:
    // si no, lo abandonaba a mitad de camino y elegía otro (iba y venía).
    if (ai.camp && dist(P, ai.camp) > c.campRadius) { ai.camp.lastSeen = now; ai.camp.crowdSince = null; }
    if (ai.camp) {
      const cp = ai.camp, min = (now - cp.since) / 60000, rate = min > 0 ? expSince(cp.since) / min : 0;
      // Referencia del mapa = promedio móvil de lo que rindieron sus campamentos (no el
      // máximo): un campamento con suerte subía la vara y hacía abandonar spots estables.
      // El usuario: "a veces conviene quedarse en un spot"; lo que importa es lo rentable sostenido.
      if (now - cp.since > c.campEvalMs && !cp.counted) { cp.counted = true; const prev = ai.campBest[map]; ai.campBest[map] = prev == null ? rate : prev * 0.7 + rate * 0.3; }
      const poor = now - cp.since > c.campEvalMs && rate < (ai.campBest[map] ?? 0) * c.campMinFrac;
      const empty = now - cp.lastSeen > c.campEmptyMs;
      const rivalsHere = rivalsPos(w).filter((q) => dist(q, cp) <= c.campRadius + 2).length;
      if (rivalsHere >= c.crowdRivals) cp.crowdSince ??= now; else cp.crowdSince = null;
      // Con gente pero rindiendo bien no se va: "a veces hay competencia pero no es mejor que
      // yo" (usuario). Solo cuenta si además la exp del campamento cayó bajo crowdMinFrac
      // de lo normal del mapa.
      const crowded = cp.crowdSince && now - cp.crowdSince > c.crowdMs && now - cp.since > 45000 && rate < (ai.campBest[map] ?? Infinity) * c.crowdMinFrac;
      if (crowded) { ai.crowdLeaves = [...(ai.crowdLeaves ?? []).filter((t) => now - t < 120000), now]; }
      if (poor || empty || crowded) { L(`dejo el campamento (${cp.x},${cp.z}): ${poor ? `rinde ${Math.round(rate)} exp/min` : crowded ? `${rivalsHere} jugadores cerca` : 'sin monstruos'}`); ai.leftCamps = [...ai.leftCamps.slice(-6), { ...cp, at: now }]; ai.camp = null; }
    }
    if (!ai.camp && ai.arrivalPending) return ai.freePick(w, P, { ...c, scan: 6 });
    if (!ai.camp) {
      const found = ai.findCamp(w, P);
      const recentlyLeft = (p) => ai.leftCamps.some((l) => l.map === map && now - l.at < 120000 && dist(l, p) <= c.campRadius);
      if (found && !recentlyLeft(found)) { ai.camp = { ...found, map, since: now, lastSeen: now }; L(`campamento en (${found.x},${found.z})`); }
      else return ai.freePick(w, P, c);
    }
    const cp = ai.camp;
    // En camino al campamento: pelear con lo que esté a <= 6 tiles. Antes ignoraba todo lo
    // que no estuviera dentro del campamento y cruzaba lugares buenos sin pegar (usuario).
    if (dist(P, cp) > c.campRadius) {
      // Si en el camino hay un montón de monstruos juntos, quedarse ahí (usuario: "lugares
      // con conglomerados de monstruos"): la memoria de spots mide si rinde.
      let n = 0; for (const e of w.byNetId.values()) if (ai.isMonster(e) && alive(e) && ai.killSecOf(e) <= c.maxKillSec && dist(e.transform.pos, P) <= 8) n++;
      // En Arenas, yendo a la zona de abajo, solo cortar el viaje por un grupo grande: con 3
      // se quedaba siempre en la entrada (~60M/min en Arena 3) y la zona de abajo nunca se medía.
      const stopAt = c.preferDownMaps.includes(map) && cp.toDownZone ? c.clusterStopDown : c.clusterStop;
      if (n >= stopAt) { ai.camp = { x: Math.round(P.x), z: Math.round(P.z), map, since: now, lastSeen: now }; ai.explore = null; L(`me quedo: ${n} monstruos juntos en (${Math.round(P.x)},${Math.round(P.z)})`); }
      else { const near = ai.freePick(w, P, { ...c, scan: c.enRouteScan }); if (near) return near; }
    }
    // Modo ancla (anchor=1): dentro del campamento solo atacar lo que esté a <= anchorRadius
    // del centro y dejar que los agresivos se acerquen; si en anchorWaitMs no entra nada,
    // buscar en todo el campamento. Caminar no da exp: el autoajuste decide si conviene.
    let t = null;
    if (c.anchor) { t = ai.freePick(w, { x: cp.x, z: cp.z }, { ...c, scan: c.anchorRadius + 1 }); if (!t && now - cp.lastSeen < c.anchorWaitMs) return null; }
    if (!t) t = ai.freePick(w, { x: cp.x, z: cp.z }, { ...c, scan: c.campRadius + 1 });
    if (t) cp.lastSeen = now;
    return t;
  };
  // Centro de los puntos caminables más "abajo" en pantalla (máxima proyección x − z).
  ai.downZoneCache = {};
  ai.downZone = (w) => {
    if (ai.downZoneCache[w.mapIndex]) return ai.downZoneCache[w.mapIndex];
    const pts = [];
    for (let x = 4; x < 252; x += 3) for (let z = 4; z < 252; z += 3) if (w.isWalkable(x, z)) pts.push({ x, z, s: x - z });
    if (!pts.length) return null;
    pts.sort((a, b) => b.s - a.s); const top = pts.slice(0, 40);
    const cx = top.reduce((a, p) => a + p.x, 0) / top.length, cz = top.reduce((a, p) => a + p.z, 0) / top.length;
    const g = top.reduce((b, p) => (Math.abs(p.x - cx) + Math.abs(p.z - cz) < Math.abs(b.x - cx) + Math.abs(b.z - cz) ? p : b));
    return (ai.downZoneCache[w.mapIndex] = { x: g.x, z: g.z });
  };
  ai.nextGoal = (P, w) => {
    const now = Date.now();
    // Modo recorrida: sin campamento (si no, la memoria y el campamento se pisaban).
    if (ai.cfg.roam && !ai.roamOff) ai.camp = null;
    // En el campamento: quedarse esperando el respawn, nunca salir a cruzar el mapa.
    if (ai.camp && ai.camp.map === w.mapIndex) return { x: ai.camp.x, z: ai.camp.z, kind: 'camp' };
    const sc = ai.cfg.startCamp[w.mapIndex];
    if (sc && (!ai.cfg.roam || ai.roamOff) && dist(sc, P) > 10) { ai.camp = { ...sc, map: w.mapIndex, since: now, lastSeen: now }; return { ...sc, kind: 'camp' }; }
    // Spots conocidos solo si están cerca (hotMaxDist): Devias 1-4 son el MISMO mapa con
    // entradas en puntas opuestas; sin este tope cruzaba todo el mapa sin pelear.
    const inLeash = (p) => !ai.arrival || ai.arrival.map !== w.mapIndex || !ai.cfg.leashMaps.includes(w.mapIndex) || dist(p, ai.arrival) <= ai.cfg.leashDist;
    const h = Object.values(ai.hot[w.mapIndex] ?? {}).filter((c) => now - c.emptyAt > 90000 && dist(c, P) > 4 && dist(c, P) <= ai.cfg.hotMaxDist && inLeash(c)).sort((a, b) => b.n - a.n)[0];
    // Fuera de la correa (llegó lejos de la llegada): volver a la llegada.
    if (!inLeash(P)) return { x: Math.round(ai.arrival.x), z: Math.round(ai.arrival.z), kind: 'llegada' };
    if (h) return { x: h.x, z: h.z, kind: 'hot' };
    // Explorar hacia donde menos estuvimos (celdas visitadas por mapa).
    const vis = (ai.visited[w.mapIndex] ??= {});
    let best = null, bs = -1e9;
    for (let k = 0; k < 80; k++) {
      const a = Math.random() * Math.PI * 2, r = 18 + Math.random() * 22;
      const x = Math.round(P.x + Math.cos(a) * r), z = Math.round(P.z + Math.sin(a) * r);
      if (!walkable(w, x, z) || (ai.arrival && ai.arrival.map === w.mapIndex && ai.cfg.leashMaps.includes(w.mapIndex) && dist({ x, z }, ai.arrival) > ai.cfg.leashDist)) continue;
      const sc = -(vis[cell({ x, z })] ?? 0) * 10 + Math.random() * 5;
      if (sc > bs) { bs = sc; best = { x, z, kind: 'explore' }; }
    }
    if (best) return best;
    const home = ai.cfg.home[w.mapIndex] ?? { x: P.x, z: P.z };
    for (let tries = 0; tries < 8; tries++) {
      const dirName = ai.cfg.scoutOrder[ai.scoutIdx % ai.cfg.scoutOrder.length];
      const [dx, dz] = SCREEN[dirName];
      for (const R of [40, 55, 70, 30]) for (let j = 0; j < 12; j++) {
        const x = Math.round(home.x + dx * R + (Math.random() - 0.5) * 16), z = Math.round(home.z + dz * R + (Math.random() - 0.5) * 16);
        if (walkable(w, x, z) && dist({ x, z }, P) > 6) return { x, z, kind: 'scout:' + dirName };
      }
      ai.scoutIdx++;
    }
    return null;
  };
  const say = (text) => { const name = new Uint8Array(10); name.set(new TextEncoder().encode(S.playerData.name).slice(0, 10)); const tb = new TextEncoder().encode(text); const b = new Uint8Array(13 + tb.length); b.set([0xc1, b.length, 0x00]); b.set(name, 3); b.set(tb, 13); S.sendToGS(new DataView(b.buffer)); L(`chat: ${text}`); };
  // Reparto de puntos para el Dark Knight con Twisting Slash:
  //   daño del skill ≈ daño base (fuerza/4) × (2 + energía/1000).
  //   +1 fuerza → +0.25 × (2 + ene/1000);  +1 energía → (fuerza/4) × 0.001.
  //   Rinden igual cuando energía ≈ fuerza − 2000. Debajo de eso, todo a energía;
  //   arriba, mitad y mitad para mantener la relación. Vitalidad: vitShare (15%):
  //   con 5% murió en Arena 4.
  // La energía no viene en playerData: se estima del maná (~1 de maná por punto,
  // + medio por nivel; verificado al repartir 1000 de energía en el reset 3).
  ai.planStats = (pts) => {
    const pd = S.playerData, str = pd.str ?? 0, ene = Math.max(0, (pd.maxMP ?? 0) - 0.5 * (pd.level ?? 0));
    const vit = Math.floor(pts * ai.cfg.vitShare); let left = pts - vit;
    const gap = Math.max(0, str - 2000 - ene);
    const toEne1 = Math.min(left, gap); left -= toEne1;
    const half = Math.floor(left / 2);
    return [['ene', toEne1 + half], ['str', left - half], ['vit', vit]];
  };
  ai.distribute = async () => {
    const pts = S.playerData.points; if (!pts) return;
    for (const [s, n] of ai.planStats(pts)) if (n > 0) { say(`/add ${s} ${n}`); await sleep(2600); }
  };
  ai.doReset = async () => {
    ai.busy = true; W().attackTarget = null;
    try {
      L(`RESET: nivel ${S.playerData.level}`);
      // Sin repartir antes: los puntos sobrantes se suman a los del reset (ahorra ~8 s).
      // Primero /reset donde esté; si el server no lo acepta fuera de Lorencia, warp y reintento.
      say('/reset');
      for (let i = 0; i < 12 && S.uiState === 5; i++) await sleep(500);
      if (S.uiState === 5 && W().mapIndex !== 0) { L('RESET: no lo aceptó acá; voy a Lorencia y reintento'); ai.resetNeedsLorencia = true; S.warpCommandRequest(2); await sleep(6000); say('/reset'); for (let i = 0; i < 40 && S.uiState === 5; i++) await sleep(500); }
      else if (S.uiState !== 5 && W()?.mapIndex !== 0) ai.resetNeedsLorencia = false;
      if (S.uiState === 5) { L('RESET: el server no nos sacó del mundo; reintento en 2 min'); ai.nextResetTry = Date.now() + 120000; return; }
      await sleep(2500);
      S.selectCharacterRequest(S.playerData.name || 'Horaz');
      for (let i = 0; i < 40 && S.uiState !== 5; i++) await sleep(500);
      await sleep(3000);
      // Los spots (hot) dependen del mapa, no del nivel: se conservan. Lo que rinde
      // cada mapa sí depende del nivel: se vuelve a medir.
      const cycleMin = ai.cycleStart ? (Date.now() - ai.cycleStart) / 60000 : null;
      ai.cycles = ai.cycles ?? []; if (cycleMin) ai.cycles.push(Math.round(cycleMin));
      ai.cycleStart = Date.now();
      // Lo que rinde cada mapa se conserva: Arena 1 no sirve en ningún ciclo.
      // La ronda exploratoria dura un ciclo: se apaga al resetear (se prende a mano o al pedirla).
      ai.mapEnteredAt = {}; ai.exploreRound = !!ai.exploreRoundNext; ai.exploreRoundNext = false;
      // Tras el reset aparece en Lorencia: marcarlo como spot actual evita un warp inútil.
      ai.resets++; ai.spot = W()?.mapIndex === 0 ? 2 : null; ai.spotRun = ai.spot ? { spot: 2, start: Date.now(), kills0: ai.kills } : null; ai.tierSeen = 0; ai.campBest = {}; ai.camp = null; ai.lastWarp = 0;
      L(`RESET #${ai.resets} hecho, nivel ${S.playerData.level}, puntos ${S.playerData.points}`);
      await ai.distribute();
    } catch (e) { L('RESET error: ' + e.message); } finally { ai.busy = false; }
  };
  ai.tick = () => {
    try {
      if (!ai.on) return;
      if (ai.busy || S.uiState !== 5) { ai.time && (ai.time.other += 0.4); return; }
      if (S.sceneLoading) { ai.lastMonster = ai.mapNoMonsterSince = Date.now(); return; }
      const w = W(), pe = w?.playerEntity; if (!pe) return;
      // Punto de llegada del último warp (correa): se fija al terminar de cargar.
      if (ai.arrivalPending && Date.now() - ai.arrivalPending > 3000) {
        const p0 = pe.transform.pos; ai.arrival = { x: p0.x, z: p0.z, map: w.mapIndex }; ai.arrivalPending = 0; L(`llegada en (${Math.round(p0.x)},${Math.round(p0.z)})`);
        // Un campamento elegido durante el warp (con monstruos del mapa anterior) fuera de la correa se descarta.
        if (ai.camp && (ai.camp.map !== w.mapIndex || (ai.cfg.leashMaps.includes(w.mapIndex) && dist(ai.camp, ai.arrival) > ai.cfg.leashDist))) { L(`descarto campamento (${ai.camp.x},${ai.camp.z}): lejos de la llegada`); ai.camp = null; ai.explore = null; }
        // 1) Lo aprendido primero: el mejor campamento medido en este mapa a nivel parecido.
        const lvlNow = S.playerData.level ?? 0;
        // En Arenas, si la zona de abajo nunca se midió, medirla primero: si no, la memoria
        // se quedaba con un campamento flojo de la entrada (34M/min en Arena 2) sin comparar.
        const dz = ai.cfg.preferDownMaps.includes(w.mapIndex) ? ai.downZone(w) : null;
        const dzMeasured = !dz || (ai.campHist[w.mapIndex] ?? []).some((k) => dist(k, dz) <= 15 && !k.seed);
        const known = !dzMeasured ? null : (ai.campHist[w.mapIndex] ?? []).filter((k) => Math.abs((k.level ?? lvlNow) - lvlNow) <= 60 && k.n >= 1 && !k.seed && (!ai.cfg.leashMaps.includes(w.mapIndex) || dist(k, ai.arrival) <= ai.cfg.leashDist)).sort((a, b) => b.rate - a.rate)[0];
        const dir = known ? null : ai.cfg.arrivalSpotDir[w.mapIndex];
        if (known) { ai.camp = { x: known.x, z: known.z, map: w.mapIndex, since: Date.now(), lastSeen: Date.now() }; L(`voy al mejor spot aprendido (${known.x},${known.z}) ~${Math.round(known.rate / 1e6)}M exp/min (n=${known.n})`); }
        // 2) Si no conoce nada: la regla del usuario para ese mapa como primera apuesta.
        if (dir) {
          let g = null;
          for (const R of [12, 15, 9, 18]) { for (let j = 0; j < 12 && !g; j++) { const x = Math.round(p0.x + dir[0] * R + (Math.random() - 0.5) * 6), z = Math.round(p0.z + dir[1] * R + (Math.random() - 0.5) * 6); if (walkable(w, x, z)) g = { x, z }; } if (g) break; }
          if (g) { ai.camp = { x: g.x, z: g.z, map: w.mapIndex, since: Date.now(), lastSeen: Date.now() }; L(`spot de llegada (arriba) en (${g.x},${g.z})`); }
        }
        if (!known && ai.cfg.preferDownMaps.includes(w.mapIndex)) { const g = ai.downZone(w); if (g) { ai.camp = { x: g.x, z: g.z, map: w.mapIndex, since: Date.now(), lastSeen: Date.now(), toDownZone: true }; L(`voy a la zona de abajo (${g.x},${g.z})`); } }
      }
      const pd = S.playerData, P = pe.transform.pos, now = Date.now(), c = ai.cfg;
      if (S.selectSkill && S.currentSkill !== c.skill) S.selectSkill(c.skill);
      if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < c.hpPot && now - ai.lastPotion > 900) { const s = potionSlot(1, 3); if (s >= 0) { S.consumeItemRequest(s); ai.lastPotion = now; L(`poción HP (${pd.currentHP}/${pd.maxHP})`); return; } }
      if (pd.currentMP / pd.maxMP < c.mpPot && now - ai.lastPotion > 900) { const s = potionSlot(4, 6); if (s >= 0) { S.consumeItemRequest(s); ai.lastPotion = now; return; } }
      // Spots: medir exp/min del actual y cambiar si no conviene.
      const run = ai.spotRun;
      const runMin = run ? (now - run.start) / 60000 : 0;
      const kpm = run && runMin > 0 ? ai.expLog.filter((x) => x.t >= run.start).reduce((a, x) => a + x.added, 0) / runMin : 0;
      if (run && runMin * 60000 >= c.evalMs) ai.spotScore[run.spot] = kpm;
      // Desde nivel 100, solo mapas acordes (reqLevel >= nivel/2, o el más alto habilitado):
      // sin esto, a nivel 367 "probar uno sin medir" lo mandó a Devias 2. Antes del 100
      // Devias sigue valiendo (Arena 1 rinde casi nada).
      // Lorencia solo para arrancar (< 20): sin medir, "probar lo no medido" lo mandaba
      // de vuelta a cazar dragones a nivel 79.
      const allowed = c.spots.filter((s) => s[2] <= pd.level && !(s[0] === 2 && pd.level >= 20));
      const topReq = Math.max(0, ...allowed.map((s) => s[2]));
      const eligible = allowed.filter((s) => pd.level < 100 || s[2] >= pd.level * 0.5 || s[2] === topReq);
      // Comparar solo contra mapas elegibles AHORA: los puntajes se conservan entre resets
      // y Arena a nivel 300 (100M exp/min) hacía ver "pobre" a Devias a nivel 40.
      const bestKnown = Math.max(0, ...eligible.map((s) => ai.spotScore[s[0]] ?? 0));
      const tier = Math.max(...eligible.map((s) => s[2]));
      const newTier = tier > ai.tierSeen;
      const mapDead = now - ai.mapNoMonsterSince > c.giveUpMapMs;
      // Competencia: 2 campamentos abandonados por gente en 2 min = spot lleno. Pasar a otra
      // entrada del mismo tramo (Devias 2/3/4); si todas estuvieron llenas hace poco y el
      // nivel lo permite, plan B (Arena 1). Pedido del usuario.
      // Hambre: casi nada de exp en los últimos 45 s con jugadores cerca → irse YA. Pasó en
      // Devias 3: 2M exp/min con un jugador a 1 tile y la regla de campamento no saltaba.
      const tierKey = `t${tier}`, recentRate = (expSince(now - 45000) / 45000) * 60000;
      if (now - ai.lastWarp > 60000 && recentRate > 0) ai.tierRef[tierKey] = ai.tierRef[tierKey] == null ? recentRate : ai.tierRef[tierKey] * 0.95 + recentRate * 0.05;
      const ref = ai.tierRef[tierKey];
      const rivalsNear = rivalsPos(w).filter((q) => dist(q, P) <= 12).length;
      // Desde nivel 20 (antes solo existe Lorencia) y con al menos 45 s en el lugar.
      // Con todo lleno, saltar cada 50 s entre Devias 3/4/2 empeoró el ciclo 6: como mucho un
      // salto por hambre cada 2 min, ≥2 jugadores y ≥60 s en el lugar.
      const starving = pd.level >= 20 && now - ai.lastWarp > 60000 && now - (ai.lastHungerWarp ?? 0) > 120000 && rivalsNear >= 2 && recentRate < (ref ? ref * 0.25 : 5e6);
      const crowdedSpot = starving || (ai.crowdLeaves ?? []).filter((t) => now - t < 120000).length >= 2;
      const poor = !c.fixedRoute && run && now - run.start >= c.evalMs && (kpm === 0 || kpm < bestKnown * c.minFracOfBest);
      if (crowdedSpot && now - ai.lastWarp > 15000) {
        ai.crowdedAt = { ...(ai.crowdedAt ?? {}), [ai.spot]: now }; ai.crowdLeaves = [];
        if (starving) ai.lastHungerWarp = now;
        const fresh = eligible.filter((s) => s[2] === tier && s[0] !== ai.spot && now - (ai.crowdedAt?.[s[0]] ?? 0) > 300000);
        const fb = c.crowdFallback.find((f) => pd.level >= f[2] && pd.level < 100);
        const to = fresh[0] ?? (fb && fb[0] !== ai.spot ? fb : null);
        if (to) {
          ai.lastWarp = now; ai.spot = to[0]; ai.target = null; w.attackTarget = null; ai.explore = null; ai.camp = null; ai.mapNoMonsterSince = ai.lastMonster = now; ai.scoutIdx = 0;
          ai.spotRun = { spot: to[0], start: now + 8000, kills0: ai.kills }; ai.arrival = null; ai.arrivalPending = now;
          S.warpCommandRequest(to[0]); L(`warp → ${to[1]} (${starving ? `casi sin exp: ${Math.round(recentRate / 1e6)}M/min con ${rivalsNear} jugador(es) cerca` : 'mucha competencia'})`); return;
        }
      }
      if (now - ai.lastWarp > 15000 && eligible.length && (!run || newTier || mapDead || poor)) {
        ai.tierSeen = tier;
        const others = eligible.filter((s) => s[0] !== ai.spot);
        const untried = others.filter((s) => ai.spotScore[s[0]] === undefined).sort((a, b) => b[2] - a[2]);
        const tried = others.filter((s) => ai.spotScore[s[0]] !== undefined).sort((a, b) => ai.spotScore[b[0]] - ai.spotScore[a[0]]);
        const curScore = run ? kpm : -1;
        const to = c.fixedRoute
          ? (newTier || !run ? eligible.filter((s) => s[2] === tier)[0] : others.filter((s) => s[2] === tier)[0] ?? null)
          : newTier ? eligible.filter((s) => s[2] === tier && s[0] !== ai.spot)[0] ?? untried[0] : untried[0] ?? (tried[0] && ai.spotScore[tried[0][0]] > curScore ? tried[0] : null);
        if (to && to[0] === ai.spot && !mapDead) { ai.tierSeen = tier; }
        else if (to) {
          const why = !run ? 'inicio' : newTier ? `nuevo nivel de mapa (${tier})` : mapDead ? 'mapa sin monstruos' : `rinde poco (${Math.round(kpm)} exp/min vs mejor ${Math.round(bestKnown)})`;
          ai.lastWarp = now; ai.spot = to[0]; ai.target = null; w.attackTarget = null; ai.explore = null; ai.mapNoMonsterSince = ai.lastMonster = now; ai.scoutIdx = 0;
          ai.spotRun = { spot: to[0], start: now + 8000, kills0: ai.kills };
          ai.arrival = null; ai.arrivalPending = Date.now();
          S.warpCommandRequest(to[0]); L(`warp → ${to[1]} (${why})`); return;
        }
        if (run && (poor || mapDead)) { ai.spotRun = { ...run, start: now, kills0: ai.kills }; ai.mapNoMonsterSince = now; }
      }
      if (!alive(ai.target)) {
        if (ai.target && hpOf(ai.target) <= 0) {
          ai.kills++;
          const secs = (now - ai.targetSince) / 1000, k = ai.target.npcType;
          if (secs > 0 && secs < 60) ai.killSecByType[k] = ai.killSecByType[k] == null ? secs : ai.killSecByType[k] * 0.7 + secs * 0.3;
        }
        ai.target = null;
        const tb = ai.pickTarget(w, P, c);
        if (tb) { ai.target = tb; ai.targetSince = now; ai.explore = null; }
      }
      if (ai.target) {
        ai.time.fight += 0.4;
        ai.lastMonster = ai.mapNoMonsterSince = now;
        if (w.attackTarget !== ai.target) w.attackTarget = ai.target;
        const tp = ai.target.transform.pos;
        return;
      }
      const arrived = ai.explore && dist(P, ai.explore) < 4;
      if (arrived) ai.time.idle += 0.4; else ai.time.walk += 0.4;
      if (arrived && !ai.arrivedAt) ai.arrivedAt = now;
      const lingerOver = arrived && now - ai.arrivedAt > (ai.explore.kind === 'hot' ? c.respawnWaitMs : c.giveUpZoneMs);
      if (!ai.explore || ai.stuck > 15 || lingerOver) {
        if (lingerOver) { const k = ai.hot[w.mapIndex]?.[cell(ai.explore)]; if (k) k.emptyAt = now; if (ai.explore.kind?.startsWith('scout')) ai.scoutIdx++; }
        ai.explore = ai.nextGoal(P, w); ai.stuck = 0; ai.arrivedAt = 0;
        if (ai.explore) { ai.moveTo(pe, ai.explore); L(`voy a ${ai.explore.kind} (${ai.explore.x},${ai.explore.z})`); }
      } else if (!arrived && ai.explore && pe.playerMoveTo.handled && (pe.movement?.velocity?.x ?? 0) === 0 && (pe.movement?.velocity?.y ?? 0) === 0) {
        ai.moveTo(pe, ai.explore);
      }
      if (ai.lastPos && dist(ai.lastPos, P) < 0.2) ai.stuck++; else ai.stuck = 0;
      ai.lastPos = { x: P.x, z: P.z };
    } catch (e) { L('error: ' + e.message); }
  };
  // Autoevaluación: exp/min reciente y en qué se fue el tiempo.
  ai.time ??= { fight: 0, walk: 0, idle: 0, other: 0 };
  ai.report = () => {
    const now = Date.now(), win = (ms) => ai.expLog.filter((x) => x.t > now - ms).reduce((a, x) => a + x.added, 0) / (ms / 60000);
    const T = ai.time, tot = T.fight + T.walk + T.idle + T.other || 1;
    const killsN = Object.values(ai.typeKills ?? {}).reduce((a, x) => a + x, 0) || ai.kills || 1;
    return { level: S.playerData.level, resets: ai.resets, kills: ai.kills,
      killsPerCast: ai.castCount ? +(killsN / ai.castCount).toFixed(2) : null, walkSecPerKill: +(T.walk / killsN).toFixed(2), expPerMin5: Math.round(win(300000)), expPerMin30: Math.round(win(1800000)),
      time: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Math.round((100 * v) / tot) + '%'])), cyclesMin: ai.cycles ?? [],
      spots: Object.fromEntries(Object.entries(ai.spotScore).map(([k, v]) => [c_name(k), Math.round(v)])), map: W().mapIndex };
  };
  const c_name = (idx) => (ai.cfg.spots.find((s) => String(s[0]) === String(idx)) ?? [0, idx])[1];
  ai.save = () => { try { localStorage.setItem(KEY, JSON.stringify({ spotScore: ai.spotScore, expByType: ai.expByType, killSecByType: ai.killSecByType, hpByType: ai.hpByType, hot: ai.hot, at: Date.now() })); } catch {} };
  ai.saver = setInterval(ai.save, 30000);
  ai.timer = setInterval(ai.tick, 400);
  ai.sampler = setInterval(() => { const pd = S.playerData; ai.samples.push({ t: Date.now(), level: pd.level, map: W()?.mapIndex, kills: ai.kills }); if (ai.samples.length > 3000) ai.samples.shift(); }, 30000);
  ai.mgr = setInterval(async () => {
    // Retomar desde la selección de personaje (corte, reset a medias, pestaña recargada).
    const me = S.playerData?.name || 'Horaz';
    if (ai.on && !ai.busy && S.uiState === 3 && (S.charactersList ?? []).some((c) => c.Name === me)) { ai.charSelectSince ??= Date.now(); if (Date.now() - ai.charSelectSince > 5000) { ai.charSelectSince = null; L(`en selección de personaje: entro con ${me}`); S.selectCharacterRequest(me); } return; }
    ai.charSelectSince = null;
    if (ai.busy || !ai.on || S.uiState !== 5 || S.sceneLoading) return;
    const pd = S.playerData;
    if (pd.level >= ai.cfg.resetLevel && Date.now() > (ai.nextResetTry ?? 0)) return ai.doReset();
    // Repartir puntos sin frenar el juego (antes se perdía ~1/3 del tiempo acá).
    if (pd.points >= ai.cfg.statBatch && !ai.distributing) { ai.distributing = true; try { await ai.distribute(); } finally { ai.distributing = false; } }
  }, 5000);
  ai.mapEnteredAt = {};
  const exploring = (w) => ai.exploreRound && Date.now() - (ai.mapEnteredAt[w.mapIndex] ??= Date.now()) < ai.cfg.exploreRoundMs;
  const campPick = ai.pickTarget, campGoal = ai.nextGoal;
  ai.pickTarget = (w, P, c) => (exploring(w) ? ai.freePick(w, P, { ...c, scan: c.exploreFightRadius }) : campPick(w, P, c));
  ai.nextGoal = (P, w) => {
    if (!exploring(w)) return campGoal(P, w);
    const vis = (ai.visited[w.mapIndex] ??= {});
    let best = null, bs = -1e9;
    for (let k = 0; k < 100; k++) {
      const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 30;
      const x = Math.round(P.x + Math.cos(a) * r), z = Math.round(P.z + Math.sin(a) * r);
      if (!walkable(w, x, z)) continue;
      const sc = -(vis[cell({ x, z })] ?? 0) * 10 + Math.random() * 3;
      if (sc > bs) { bs = sc; best = { x, z, kind: 'ronda' }; }
    }
    return best ?? campGoal(P, w);
  };
  // Curiosidad (pedido del usuario: "golpeá a cada monstruo que te cruces para probar
  // sus características"): tipos con pocos kills medidos van primero si están cerca.
  ai.typeKills = old?.typeKills ?? {};
  { let lastId = null; __eventBus.on('experienceGained', (p) => { const a = window.__ai; if (a !== ai || !p?.killedNetId || p.killedNetId === lastId) return; lastId = p.killedNetId; const info = a.netInfo.get(p.killedNetId); if (info) a.typeKills[info.type] = (a.typeKills[info.type] ?? 0) + 1; }); }
  const plannedPick = ai.pickTarget;
  ai.pickTarget = (w, P, c) => {
    let best = null, bd = 1e9;
    for (const e of w.byNetId.values()) {
      if (!ai.isMonster(e) || !alive(e) || (ai.typeKills[e.npcType] ?? 0) >= c.curiosityKills) continue;
      const d = dist(P, e.transform.pos); if (d <= c.curiosityRadius && d < bd) { bd = d; best = e; }
    }
    if (best) { ai.netInfo.set(best.netId, { type: best.npcType, x: best.transform.pos.x, z: best.transform.pos.z }); return best; }
    return plannedPick(w, P, c);
  };
  // Invitaciones a party: rechazar siempre (pedido del usuario). PartyRequest trae el
  // id del que invita en el byte 3 (BE); la respuesta es PartyInviteResponse C1 06 41
  // <aceptado=0> <id BE>. Un respiro humano antes de contestar.
  if (!window.__partyDeclineHooked) {
    __eventBus.on('PartyRequest', (raw) => {
      try {
        const dv = raw instanceof DataView ? raw : new DataView(raw.buffer ?? raw);
        const id = dv.getUint16(3, false) & 0x7fff;
        setTimeout(() => { S.sendToGS(new DataView(Uint8Array.from([0xc1, 0x06, 0x41, 0x00, id >> 8, id & 0xff]).buffer)); window.__ai?.L?.(`party rechazada (de #${id})`); }, 600 + Math.random() * 900);
      } catch (e) { window.__ai?.L?.('error al rechazar party: ' + e.message); }
    });
    window.__partyDeclineHooked = true;
  }
  // Rechazar no alcanza: el cartel de la invitación queda abierto y frena los controles
  // unos segundos (usuario: "se queda como colgado cuando le dan party"). Se cierra con su
  // botón Cancel apenas aparece.
  // El cartel es `.v097d-party-request` y su botón no tiene texto: `[aria-label="Cancel"]`.
  window.__closePartyDialog = () => {
    const c = document.querySelector('.v097d-party-request [aria-label="Cancel"]');
    if (!c) return false;
    for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) c.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true }));
    return true;
  };
  if (!window.__partyCloseHooked) {
    __eventBus.on('PartyRequest', () => { let tries = 0; const t = window.setInterval(() => { if (window.__closePartyDialog() || ++tries > 20) window.clearInterval(t); }, 150); });
    window.__partyCloseHooked = true;
  }
  ai.densityTimer = setInterval(() => {
    const w = W(); if (!w?.playerEntity || S.sceneLoading || S.uiState !== 5) return;
    for (const e of w.byNetId.values()) if (ai.isMonster(e) && !e.dying && hpOf(e) > 0) ai.noteHot(w.mapIndex, e.transform.pos, ai.valueOf(e) * ai.cfg.densityWeight);
  }, 3000);
  // Skill sin pausa: el cliente omite el golpe normal mientras haya un castRequest,
  // así que recargarlo cada 50 ms deja todo el ataque en Twisting Slash (área).
  // Medido: de 74 skills + 26 golpes por minuto (cada 200 ms) a 0 golpes.
  // Girar con CUALQUIER monstruo a <= castRange, tenga objetivo o no y aunque esté
  // caminando: el giro es de área y en el camino quedaban monstruos sin tocar (usuario:
  // "aprovechá todo y andá tirando golpes de giro").
  ai.caster = setInterval(() => {
    const w = W(), pe = w?.playerEntity, pd = S.playerData;
    if (!ai.on || ai.busy || !pe || w.castRequest || S.sceneLoading || S.uiState !== 5 || pd.currentMP / pd.maxMP < ai.cfg.skillMinMp) return;
    const P = pe.transform.pos; let best = null, bd = 1e9;
    const t = ai.target; if (alive(t) && dist(P, t.transform.pos) <= ai.cfg.castRange) best = t;
    if (!best) for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || !alive(e)) continue; const d = dist(P, e.transform.pos); if (d <= ai.cfg.castRange && d < bd) { bd = d; best = e; } }
    if (!best) return;
    if (S.currentSkill !== ai.cfg.skill) S.selectSkill(ai.cfg.skill);
    const tp = best.transform.pos; w.castRequest = { target: best, point: { x: tp.x, y: tp.z }, forced: false };
    ai.castCount = (ai.castCount ?? 0) + 1;
  }, 50);
  // Vigilante de skills trabados: a veces el cliente no consume un castRequest y, como no
  // pega golpes normales mientras hay uno pendiente, el personaje queda quieto entre los
  // monstruos (pasó en Arena 2: 3 min sin exp). Si dura > 1,5 s sin consumirse, se descarta.
  { let seen = null, since = 0; ai.castStuck = old?.castStuck ?? 0;
    ai.castWatch = setInterval(() => {
      const cr = W()?.castRequest; if (!cr) { seen = null; return; }
      if (cr !== seen) { seen = cr; since = Date.now(); return; }
      if (Date.now() - since > 1500) { W().castRequest = null; seen = null; ai.castStuck++; if (ai.castStuck % 10 === 1) L(`skill trabado descartado (${ai.castStuck})`); }
    }, 250); }
  // Vigilante general: 30 s sin exp con monstruos vivos a <= 3 tiles = algo trabado.
  // Reinicia objetivo, skill, ataque y campamento, sea cual sea la causa.
  ai.unstuck = old?.unstuck ?? 0;
  ai.idleWatch = setInterval(() => {
    const w = W(), pe = w?.playerEntity; if (!pe || !ai.on || ai.busy || S.uiState !== 5 || S.sceneLoading) return;
    const now = Date.now(), last = ai.expLog[ai.expLog.length - 1]?.t ?? 0;
    if (now - last < 30000 || now - ai.lastWarp < 30000) return;
    const P = pe.transform.pos; let close = 0;
    for (const e of w.byNetId.values()) if (ai.isMonster(e) && alive(e) && dist(P, e.transform.pos) <= 3) close++;
    if (!close) return;
    ai.unstuck++; L(`vigilante: 30 s sin exp con ${close} monstruo(s) al lado → reinicio objetivo/skill/campamento (${ai.unstuck})`);
    w.castRequest = null; w.attackTarget = null; ai.target = null; ai.camp = null; ai.explore = null;
    ai.expLog.push({ t: now, added: 0 }); // no volver a disparar en el próximo segundo
  }, 3000);
  // Zona segura: el cliente no deja atacar ahí. Con un objetivo elegido desde adentro del
  // pueblo el personaje quedaba quieto para siempre (pasó con Melu). Si está quieto en zona
  // segura, soltar el objetivo y salir hacia el campamento.
  ai.safeOut = setInterval(() => {
    const pe = W()?.playerEntity; if (!pe || !ai.on || ai.busy || S.uiState !== 5) return;
    if (pe.attributeSystem?.isAboveZero?.('inSafeZone') && (pe.movement?.velocity?.x ?? 0) === 0 && (pe.movement?.velocity?.y ?? 0) === 0) {
      ai.target = null; W().attackTarget = null;
      const sc = ai.camp ?? ai.cfg.startCamp[W().mapIndex]; if (sc) ai.moveTo(pe, sc);
    }
  }, 2000);
  ai.deaths = old?.deaths ?? 0;
  let wasDead = false;
  ai.deathTimer = setInterval(() => { const dead = S.uiState === 5 && S.playerData.currentHP <= 0; if (dead && !wasDead) { ai.deaths++; L(`MUERTE #${ai.deaths} en mapa ${W().mapIndex}`); } wasDead = dead; }, 300);
  // Loot valioso: cajas (Box of Kundun 14/11), joyas (Bless 14/13, Soul 14/14,
  // Life 14/16, Creation 14/22, Guardian 14/31, Chaos 12/15) e ítems excelentes.
  // El zen y el equipo común no se levantan. Mientras levanta, pausa la pelea.
  // Solo lo que sirve: cajas, joyas y piezas del set de Horaz (set 1: casco 7, armadura 8,
  // pantalón 9, guantes 10, botas 11). Levantar "cualquier excelente" llenó el inventario
  // de armas que un DK no usa (usuario: "lleno de cosas que son basura").
  ai.isValuable = (di) => {
    if (!di || di.isMoney) return false;
    if (di.group === 14 && [11, 13, 14, 16, 22, 31].includes(di.num)) return true;
    if (di.group === 12 && di.num === 15) return true;
    return [7, 8, 9, 10, 11].includes(di.group) && di.num === 1 && !!di.item?.isExcellent; // comunes no: juntó 9 pares de guantes +2/+3
  };
  ai.lootCount = old?.lootCount ?? 0; ai.lootSkip = new Set(); ai.lootFails = 0; ai.lootOffUntil = old?.lootOffUntil ?? 0;
  ai.looter = setInterval(() => {
    const w = W(), pe = w?.playerEntity; if (!pe || S.uiState !== 5 || S.sceneLoading || ai.busy) return;
    const P = pe.transform.pos, now = Date.now();
    if (ai.looting) {
      const e = w.getByNetId(ai.looting.id);
      if (!e || !e.droppedItem) { ai.lootCount++; ai.lootFails = 0; L(`levanté ${ai.looting.what}`); ai.looting = null; ai.on = true; return; }
      // Sigue en el piso a los 8 s: no se pudo (inventario lleno u otro dueño). No reintentar ese
      // drop; dos fallos seguidos = inventario lleno, no levantar por 10 min (pasaba en loop).
      if (now - ai.looting.at > 8000) { ai.lootSkip.add(ai.looting.id); ai.lootFails++; ai.looting = null; ai.on = true; if (ai.lootFails >= 2) { ai.lootOffUntil = now + 600000; ai.lootFails = 0; L('inventario lleno: dejo de levantar por 10 min'); } return; }
      if (w.pickupTarget !== e) w.pickupTarget = e;
      return;
    }
    if (!ai.on || now < ai.lootOffUntil) return;
    let best = null, bd = 1e9;
    for (const e of w.byNetId.values()) { if (!e.droppedItem || ai.lootSkip.has(e.netId) || !ai.isValuable(e.droppedItem)) continue; const d = dist(P, e.transform.pos); if (d <= ai.cfg.lootRadius && d < bd) { bd = d; best = e; } }
    if (best) { const di = best.droppedItem; ai.looting = { id: best.netId, at: now, what: `${di.group}/${di.num}${di.item?.isExcellent ? ' exc' : ''}` }; ai.on = false; w.attackTarget = null; w.castRequest = null; w.pickupTarget = best; L(`voy a levantar ${ai.looting.what} a ${bd} tiles`); }
  }, 300);
  // Memoria de campamentos: al dejar uno se guarda posición + exp/min real (persiste
  // entre resets). Sin campamento, ir directo al mejor conocido a <= campMemDist en vez
  // de buscar: el usuario pidió caminar menos y encontrar el spot rápido.
  const CAMPS_KEY = `mubot-camps:${S.playerData?.name ?? 'pj'}`;
  try { ai.campHist = old?.campHist ?? JSON.parse(localStorage.getItem(CAMPS_KEY) || '{}'); } catch { ai.campHist = {}; }
  let lastCamp = null;
  ai.campMem = setInterval(() => {
    const w = W(); if (!w?.playerEntity || S.sceneLoading || S.uiState !== 5) return;
    const cur = ai.camp;
    if (lastCamp && lastCamp !== cur) {
      const mins = (Date.now() - lastCamp.since) / 60000;
      if (mins > 0.75) {
        const rate = expSince(lastCamp.since) / mins, list = (ai.campHist[lastCamp.map] ??= []);
        const near = list.find((c) => dist(c, lastCamp) <= 4);
        if (near) { near.rate = near.rate * 0.6 + rate * 0.4; near.n++; near.level = S.playerData.level; } else list.push({ x: lastCamp.x, z: lastCamp.z, rate, n: 1, level: S.playerData.level });
        list.sort((a, b) => b.rate - a.rate); list.length = Math.min(list.length, 20);
        try { localStorage.setItem(CAMPS_KEY, JSON.stringify(ai.campHist)); } catch {}
      }
    }
    lastCamp = cur;
    if (!cur && !ai.target && ai.on && !ai.busy && !ai.cfg.roam) {
      const P = w.playerEntity.transform.pos, lvl = S.playerData.level;
      const cands = (ai.campHist[w.mapIndex] ?? []).filter((c) => (!ai.arrival || !ai.cfg.leashMaps.includes(w.mapIndex) || dist(c, ai.arrival) <= ai.cfg.leashDist) && dist(c, P) <= ai.cfg.campMemDist && Math.abs((c.level ?? lvl) - lvl) < 150 && !ai.leftCamps.some((l) => l.map === w.mapIndex && Date.now() - l.at < 60000 && dist(l, c) <= 4));
      cands.sort((a, b) => b.rate / (1 + dist(b, P) / 12) - a.rate / (1 + dist(a, P) / 12));
      if (cands[0]) { const b = cands[0]; ai.camp = { x: b.x, z: b.z, map: w.mapIndex, since: Date.now(), lastSeen: Date.now() }; ai.explore = null; L(`voy al campamento conocido (${b.x},${b.z}) ~${Math.round(b.rate / 1e6)}M exp/min`); }
    }
  }, 1000);
  // Ranking de spots aprendidos, para que el usuario vea qué aprendió.
  ai.spots = () => Object.fromEntries(Object.entries(ai.campHist).map(([m, l]) => [m, l.slice(0, 5).map((k) => `(${k.x},${k.z}) ${Math.round(k.rate / 1e6)}M/min lvl${k.level} n=${k.n}`)]));
  // Registro de tramos por ciclo: minuto en que llega a cada nivel hito. Persiste en
  // localStorage (`mubot-cycles:<pj>`) para comparar ciclos y proyectar resets/día.
  const CYC_KEY = `mubot-cycles:${S.playerData?.name ?? 'pj'}`;
  try { ai.cycleLog = old?.cycleLog ?? JSON.parse(localStorage.getItem(CYC_KEY) || '[]'); } catch { ai.cycleLog = []; }
  ai.cur = old?.cur ?? { start: ai.cycleStart ?? Date.now(), marks: {} };
  const MARKS = [20, 50, 100, 200, 300, 350, 400];
  ai.segTimer = setInterval(() => {
    const lvl = S.playerData?.level ?? 0;
    if (ai.cycleStart && ai.cur.start !== ai.cycleStart) {
      // Nuevo ciclo: cerrar el anterior.
      if (ai.cur.marks[400]) { ai.cycleLog.push({ ...ai.cur, end: ai.cycleStart, min: +((ai.cycleStart - ai.cur.start) / 60000).toFixed(1) }); try { localStorage.setItem(CYC_KEY, JSON.stringify(ai.cycleLog.slice(-200))); } catch {} }
      ai.cur = { start: ai.cycleStart, marks: {} };
    }
    for (const m of MARKS) if (lvl >= m && ai.cur.marks[m] == null && S.uiState === 5) { ai.cur.marks[m] = +((Date.now() - ai.cur.start) / 60000).toFixed(1); if (m >= 100) L(`tramo: nivel ${m} al minuto ${ai.cur.marks[m]}`); }
  }, 2000);
  ai.cycleReport = () => ai.cycleLog.slice(-10).map((c) => ({ min: c.min, perDay: c.min ? Math.round(1440 / c.min) : null, marks: c.marks }));
  ai.markVisited = setInterval(() => { const pe = W()?.playerEntity; if (!pe) return; const v = (ai.visited[W().mapIndex] ??= {}); const k = cell(pe.transform.pos); v[k] = (v[k] ?? 0) + 1; }, 2000);
  return 'agente instalado';
})();
