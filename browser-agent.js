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
  for (const t of ['timer', 'sampler', 'mgr', 'saver', 'markVisited', 'densityTimer', 'caster', 'deathTimer', 'looter', 'campMem']) if (old?.[t]) clearInterval(old[t]);
  const S = __store, W = () => __world;
  // Lo aprendido sobrevive a un F5: localStorage por personaje.
  const KEY = `mubot-ai:${S.playerData?.name ?? 'pj'}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const SCREEN = { up: [-1, 1], right: [1, 1], down: [1, -1], left: [-1, -1] };
  const ai = (window.__ai = {
    on: true, busy: false, log: old?.log ?? [], samples: old?.samples ?? [], kills: old?.kills ?? 0, resets: old?.resets ?? 0,
    t0: Date.now(), lastPotion: 0, lastWarp: old?.lastWarp ?? 0, spot: old?.spot ?? null,
    // Reinstalar no debe hacerlo abandonar el spot en el que está.
    spotScore: old?.spotScore ?? saved.spotScore ?? {}, spotRun: old?.spotRun ?? null, tierSeen: old?.tierSeen ?? 0,
    cycles: old?.cycles ?? [], cycleStart: old?.cycleStart ?? null, time: old?.time,
    expByType: old?.expByType ?? saved.expByType ?? {}, expLog: old?.expLog ?? [], expHooked: old?.expHooked ?? false,
    killSecByType: old?.killSecByType ?? saved.killSecByType ?? {}, hpByType: old?.hpByType ?? saved.hpByType ?? {}, netInfo: old?.netInfo ?? new Map(), targetSince: 0,
    target: null, explore: null, arrivedAt: 0, stuck: 0, lastPos: null,
    lastMonster: Date.now(), mapNoMonsterSince: Date.now(), scoutIdx: 0, hot: old?.hot ?? saved.hot ?? {},
    camp: null, campBest: old?.campBest ?? {}, leftCamps: [], visited: old?.visited ?? {},
    cfg: {
      // scan cubre todo el scope: la distancia ya pesa en la cuenta de exp/s.
      // hpPot 0.55 no alcanzó en Arena 4 con skill continuo: murió en un grupo.
      // castRange 3: Twisting Slash gira alrededor del DK (~2-3 tiles). Con 6 giraba en el aire.
      hpPot: 0.7, mpPot: 0.3, castRange: 3, vitShare: 0.15, scan: 80, secPerTile: 0.4, maxKillSec: 8, unknownPessimism: 1.4,
      // Campamento: pelear solo a <= campRadius de un centro; mudarse si tras campEvalMs
      // rinde < campMinFrac del mejor campamento del mapa, o si pasa campEmptyMs vacío.
      campRadius: 10, campEvalMs: 90000, campEmptyMs: 12000, campMinFrac: 0.5,
      // Mudarse si hay >= crowdRivals jugadores cerca del campamento durante crowdMs.
      // Con 2 jugadores/10 s saltaba de campamento todo el tiempo en Arena (25% caminando).
      crowdRivals: 3, crowdMs: 20000, campDistDecay: 12, hotMaxDist: 30, lootRadius: 12, campMemDist: 40,
      // Quedarse cerca del punto de llegada del warp: Devias 1-4 son el MISMO mapa y,
      // saltando de campamento en campamento, terminaba en la zona de Devias 1. El usuario:
      // "en las otras Devias hay spots muy cerca de donde sale el pj".
      // Solo en Devias (mapa 2). En Arena los buenos están ADENTRO, lejos de la llegada.
      leashDist: 25, leashMaps: [2],
      // Arenas (83/84/85 = Arena 2/3/4): la zona de abajo y por fuera en pantalla (+x, -z)
      // está llena de monstruos de mucha exp (125/126/127 dan ~1.6M en <2 s a nivel 240).
      // El usuario la señaló; al llegar se va directo ahí.
      preferDownMaps: [83, 84, 85],
      // Curiosidad: atacar primero tipos con < curiosityKills kills medidos a <= curiosityRadius.
      curiosityRadius: 8, curiosityKills: 3,
      // Densidad: cada 3 s, lo que se ve suma densityWeight × valor a la grilla caliente.
      // Ronda exploratoria (ai.exploreRound): los primeros exploreRoundMs en cada mapa,
      // recorrer lo menos visitado y pelear solo a <= exploreFightRadius.
      densityWeight: 0.02, exploreRoundMs: 60000, exploreFightRadius: 6,
      // Competencia: cada jugador a <= playerRadius del objetivo le resta competitionPenalty.
      playerRadius: 5, competitionPenalty: 0.6, giveUpZoneMs: 20000, giveUpMapMs: 90000,
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
      a.expLog.push({ t: now, added: p.added }); if (a.expLog.length > 5000) a.expLog.shift();
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
      const crowded = cp.crowdSince && now - cp.crowdSince > c.crowdMs;
      if (poor || empty || crowded) { L(`dejo el campamento (${cp.x},${cp.z}): ${poor ? `rinde ${Math.round(rate)} exp/min` : crowded ? `${rivalsHere} jugadores cerca` : 'sin monstruos'}`); ai.leftCamps = [...ai.leftCamps.slice(-6), { ...cp, at: now }]; ai.camp = null; }
    }
    if (!ai.camp) {
      const found = ai.findCamp(w, P);
      const recentlyLeft = (p) => ai.leftCamps.some((l) => l.map === map && now - l.at < 120000 && dist(l, p) <= c.campRadius);
      if (found && !recentlyLeft(found)) { ai.camp = { ...found, map, since: now, lastSeen: now }; L(`campamento en (${found.x},${found.z})`); }
      else return ai.freePick(w, P, c);
    }
    const cp = ai.camp;
    const t = ai.freePick(w, { x: cp.x, z: cp.z }, { ...c, scan: c.campRadius + 1 });
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
    // En el campamento: quedarse esperando el respawn, nunca salir a cruzar el mapa.
    if (ai.camp && ai.camp.map === w.mapIndex) return { x: ai.camp.x, z: ai.camp.z, kind: 'camp' };
    // Spots conocidos solo si están cerca (hotMaxDist): Devias 1-4 son el MISMO mapa con
    // entradas en puntas opuestas; sin este tope cruzaba todo el mapa sin pelear.
    const h = Object.values(ai.hot[w.mapIndex] ?? {}).filter((c) => now - c.emptyAt > 90000 && dist(c, P) > 4 && dist(c, P) <= ai.cfg.hotMaxDist).sort((a, b) => b.n - a.n)[0];
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
      await ai.distribute();
      if (W().mapIndex !== 0) { S.warpCommandRequest(2); await sleep(6000); }
      say('/reset');
      for (let i = 0; i < 40 && S.uiState === 5; i++) await sleep(500);
      if (S.uiState === 5) { L('RESET: el server no nos sacó del mundo; reintento en 10 min'); ai.nextResetTry = Date.now() + 600000; return; }
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
      ai.resets++; ai.spot = null; ai.spotRun = null; ai.tierSeen = 0; ai.campBest = {}; ai.camp = null; ai.lastWarp = 0;
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
        if (c.preferDownMaps.includes(w.mapIndex)) { const g = ai.downZone(w); if (g) { ai.camp = { x: g.x, z: g.z, map: w.mapIndex, since: Date.now(), lastSeen: Date.now() }; L(`voy a la zona de abajo (${g.x},${g.z})`); } }
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
      const poor = !c.fixedRoute && run && now - run.start >= c.evalMs && (kpm === 0 || kpm < bestKnown * c.minFracOfBest);
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
    return { level: S.playerData.level, resets: ai.resets, kills: ai.kills, expPerMin5: Math.round(win(300000)), expPerMin30: Math.round(win(1800000)),
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
  ai.densityTimer = setInterval(() => {
    const w = W(); if (!w?.playerEntity || S.sceneLoading || S.uiState !== 5) return;
    for (const e of w.byNetId.values()) if (ai.isMonster(e) && !e.dying && hpOf(e) > 0) ai.noteHot(w.mapIndex, e.transform.pos, ai.valueOf(e) * ai.cfg.densityWeight);
  }, 3000);
  // Skill sin pausa: el cliente omite el golpe normal mientras haya un castRequest,
  // así que recargarlo cada 50 ms deja todo el ataque en Twisting Slash (área).
  // Medido: de 74 skills + 26 golpes por minuto (cada 200 ms) a 0 golpes.
  ai.caster = setInterval(() => {
    const w = W(), t = ai.target, pe = w?.playerEntity, pd = S.playerData;
    if (!ai.on || ai.busy || !t || !pe || w.castRequest || S.sceneLoading || pd.currentMP / pd.maxMP < ai.cfg.skillMinMp) return;
    const P = pe.transform.pos, tp = t.transform.pos;
    if (dist(P, tp) <= ai.cfg.castRange) w.castRequest = { target: t, point: { x: tp.x, y: tp.z }, forced: false };
  }, 50);
  ai.deaths = old?.deaths ?? 0;
  let wasDead = false;
  ai.deathTimer = setInterval(() => { const dead = S.uiState === 5 && S.playerData.currentHP <= 0; if (dead && !wasDead) { ai.deaths++; L(`MUERTE #${ai.deaths} en mapa ${W().mapIndex}`); } wasDead = dead; }, 300);
  // Loot valioso: cajas (Box of Kundun 14/11), joyas (Bless 14/13, Soul 14/14,
  // Life 14/16, Creation 14/22, Guardian 14/31, Chaos 12/15) e ítems excelentes.
  // El zen y el equipo común no se levantan. Mientras levanta, pausa la pelea.
  ai.isValuable = (di) => {
    if (!di || di.isMoney) return false;
    if (di.item?.isExcellent) return true;
    return (di.group === 14 && [11, 13, 14, 16, 22, 31].includes(di.num)) || (di.group === 12 && di.num === 15);
  };
  ai.lootCount = old?.lootCount ?? 0;
  ai.looter = setInterval(() => {
    const w = W(), pe = w?.playerEntity; if (!pe || S.uiState !== 5 || S.sceneLoading || ai.busy) return;
    const P = pe.transform.pos, now = Date.now();
    if (ai.looting) {
      const e = w.getByNetId(ai.looting.id);
      if (!e || !e.droppedItem || now - ai.looting.at > 8000) { if (!e || !e.droppedItem) { ai.lootCount++; L(`levanté ${ai.looting.what}`); } ai.looting = null; ai.on = true; }
      else if (w.pickupTarget !== e) w.pickupTarget = e;
      return;
    }
    if (!ai.on) return;
    let best = null, bd = 1e9;
    for (const e of w.byNetId.values()) { if (!e.droppedItem || !ai.isValuable(e.droppedItem)) continue; const d = dist(P, e.transform.pos); if (d <= ai.cfg.lootRadius && d < bd) { bd = d; best = e; } }
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
    if (!cur && !ai.target && ai.on && !ai.busy) {
      const P = w.playerEntity.transform.pos, lvl = S.playerData.level;
      const cands = (ai.campHist[w.mapIndex] ?? []).filter((c) => (!ai.arrival || !ai.cfg.leashMaps.includes(w.mapIndex) || dist(c, ai.arrival) <= ai.cfg.leashDist) && dist(c, P) <= ai.cfg.campMemDist && Math.abs((c.level ?? lvl) - lvl) < 150 && !ai.leftCamps.some((l) => l.map === w.mapIndex && Date.now() - l.at < 60000 && dist(l, c) <= 4));
      cands.sort((a, b) => b.rate / (1 + dist(b, P) / 12) - a.rate / (1 + dist(a, P) / 12));
      if (cands[0]) { const b = cands[0]; ai.camp = { x: b.x, z: b.z, map: w.mapIndex, since: Date.now(), lastSeen: Date.now() }; ai.explore = null; L(`voy al campamento conocido (${b.x},${b.z}) ~${Math.round(b.rate / 1e6)}M exp/min`); }
    }
  }, 1000);
  ai.markVisited = setInterval(() => { const pe = W()?.playerEntity; if (!pe) return; const v = (ai.visited[W().mapIndex] ??= {}); const k = cell(pe.transform.pos); v[k] = (v[k] ?? 0) + 1; }, 2000);
  return 'agente instalado';
})();
