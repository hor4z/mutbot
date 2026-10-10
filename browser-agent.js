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
  for (const t of ['timer', 'sampler', 'mgr']) if (old?.[t]) clearInterval(old[t]);
  const S = __store, W = () => __world;
  const SCREEN = { up: [-1, 1], right: [1, 1], down: [1, -1], left: [-1, -1] };
  const ai = (window.__ai = {
    on: true, busy: false, log: old?.log ?? [], samples: old?.samples ?? [], kills: old?.kills ?? 0, resets: old?.resets ?? 0,
    t0: Date.now(), lastPotion: 0, lastWarp: 0, spot: old?.spot ?? null,
    spotScore: old?.spotScore ?? {}, spotRun: null, tierSeen: old?.tierSeen ?? 0,
    expByType: old?.expByType ?? {}, expLog: old?.expLog ?? [], expHooked: old?.expHooked ?? false,
    killSecByType: old?.killSecByType ?? {}, targetSince: 0,
    target: null, explore: null, arrivedAt: 0, stuck: 0, lastPos: null,
    lastMonster: Date.now(), mapNoMonsterSince: Date.now(), scoutIdx: 0, hot: old?.hot ?? {},
    cfg: {
      hpPot: 0.55, mpPot: 0.2, scan: 28, secPerTile: 0.4, giveUpZoneMs: 20000, giveUpMapMs: 90000,
      skill: 41, skillMinMp: 0.15,
      resetLevel: 400, statBatch: 50, build: [['str', 50], ['ene', 33], ['vit', 17]],
      // Ruta del usuario: Lorencia → Devias 2/3/4 (Devias 1 no sirve) → Arena 1-4.
      spots: [[2, 'Lorencia', 10], [5, 'Devias 2', 20], [6, 'Devias 3', 20], [7, 'Devias 4', 20], [1, 'Arena', 50], [24, 'Arena 2', 100], [25, 'Arena 3', 200], [26, 'Arena 4', 300]],
      // Un spot que tras evalMs rinde menos de minKpm kills/min se abandona.
      // Spot = exp/min. Tras evalMs, si rinde menos que minFracOfBest del mejor conocido, se cambia.
      evalMs: 120000, minFracOfBest: 0.5, respawnWaitMs: 30000,
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
  // n = suma de vida máxima de lo visto ahí: un spot vale por lo que rinde, no por cuántos bichos tiene.
  ai.noteHot = (map, p, value = 1) => { const h = (ai.hot[map] ??= {}); const c = (h[cell(p)] ??= { x: Math.round(p.x), z: Math.round(p.z), n: 0, emptyAt: 0 }); c.n += value; c.emptyAt = 0; };
  // Valor de un monstruo = su vida máxima (el cliente no expone nivel ni exp).
  // En Arena la entrada tiene bichos de 30-60 HP que no rinden; adentro, 120-220+.
  // Lo que importa es la exp por kill para MI nivel: se aprende de experienceGained
  // ({added, killedNetId}; kills grandes llegan partidos en tramos de 65535).
  // Sin dato todavía, la vida máxima sirve de estimación.
  ai.valueOf = (e) => ai.expByType[e.npcType] ?? (e.attributeSystem?.getValue?.('maxHealth') || 1) * 50;
  if (!ai.expHooked) {
    __eventBus.on('experienceGained', (p) => {
      const a = window.__ai; if (!a || !p?.added) return;
      const now = Date.now();
      a.expLog.push({ t: now, added: p.added }); if (a.expLog.length > 5000) a.expLog.shift();
      const e = W().getByNetId(p.killedNetId);
      if (e?.npcType !== undefined) {
        const k = e.npcType, last = a.lastExpKill;
        // mismo kill partido en varios eventos: acumular
        if (last && last.netId === p.killedNetId && now - last.t < 1500) { last.sum += p.added; a.expByType[k] = last.prev == null ? last.sum : last.prev * 0.7 + last.sum * 0.3; }
        else { const prev = a.expByType[k]; a.lastExpKill = { netId: p.killedNetId, t: now, sum: p.added, prev }; a.expByType[k] = prev == null ? p.added : prev * 0.7 + p.added * 0.3; }
        a.noteHot(W().mapIndex, e.transform.pos, p.added);
      }
    });
    ai.expHooked = true;
  }
  // Lo que se optimiza es EXP POR SEGUNDO: exp que da el tipo / (segundos que tardo en
  // matarlo + segundos de caminar hasta él). Un bicho duro que da mucho puede rendir
  // menos que varios medianos de un golpe. Twisting Slash es de área: un objetivo con
  // otros bichos alrededor vale más (bonus por densidad).
  ai.killSecOf = (e) => ai.killSecByType[e.npcType] ?? 2.5;
  ai.pickTarget = (w, P, c) => {
    const ms = [];
    for (const e of w.byNetId.values()) if (ai.isMonster(e) && alive(e)) ms.push(e);
    let best = null, bestRate = 0;
    for (const e of ms) {
      const d = dist(P, e.transform.pos); if (d >= c.scan) continue;
      let crowd = 0; for (const o of ms) if (o !== e && dist(o.transform.pos, e.transform.pos) <= 3) crowd += ai.valueOf(o) * 0.5;
      const rate = (ai.valueOf(e) + crowd) / (ai.killSecOf(e) + d * c.secPerTile);
      if (rate > bestRate) { bestRate = rate; best = e; }
    }
    ai.lastPickRate = bestRate;
    return best;
  };
  ai.nextGoal = (P, w) => {
    const now = Date.now();
    // Spot = el punto que más exp dio en este mapa: volver ahí y esperar respawn.
    const h = Object.values(ai.hot[w.mapIndex] ?? {}).filter((c) => now - c.emptyAt > 90000).sort((a, b) => b.n - a.n)[0];
    if (h) return { x: h.x, z: h.z, kind: 'hot' };
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
  ai.distribute = async () => {
    const pts = S.playerData.points; if (!pts) return;
    const tot = ai.cfg.build.reduce((a, [, w]) => a + w, 0);
    const plan = ai.cfg.build.map(([s, w]) => [s, Math.floor((pts * w) / tot)]);
    plan[0][1] += pts - plan.reduce((a, [, n]) => a + n, 0);
    for (const [s, n] of plan) if (n > 0) { say(`/add ${s} ${n}`); await sleep(2600); }
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
      ai.resets++; ai.spot = null; ai.spotRun = null; ai.tierSeen = 0; ai.hot = {}; ai.lastWarp = 0;
      L(`RESET #${ai.resets} hecho, nivel ${S.playerData.level}, puntos ${S.playerData.points}`);
      await ai.distribute();
    } catch (e) { L('RESET error: ' + e.message); } finally { ai.busy = false; }
  };
  ai.tick = () => {
    try {
      if (!ai.on || ai.busy || S.uiState !== 5) return;
      if (S.sceneLoading) { ai.lastMonster = ai.mapNoMonsterSince = Date.now(); return; }
      const w = W(), pe = w?.playerEntity; if (!pe) return;
      const pd = S.playerData, P = pe.transform.pos, now = Date.now(), c = ai.cfg;
      if (S.selectSkill && S.currentSkill !== c.skill) S.selectSkill(c.skill);
      if (pd.currentHP / pd.maxHP < c.hpPot && now - ai.lastPotion > 900) { const s = potionSlot(1, 3); if (s >= 0) { S.consumeItemRequest(s); ai.lastPotion = now; L(`poción HP (${pd.currentHP}/${pd.maxHP})`); return; } }
      if (pd.currentMP / pd.maxMP < c.mpPot && now - ai.lastPotion > 900) { const s = potionSlot(4, 6); if (s >= 0) { S.consumeItemRequest(s); ai.lastPotion = now; return; } }
      // Spots: medir kills/min del actual y cambiar si no conviene.
      const run = ai.spotRun;
      const runMin = run ? (now - run.start) / 60000 : 0;
      const kpm = run && runMin > 0 ? ai.expLog.filter((x) => x.t >= run.start).reduce((a, x) => a + x.added, 0) / runMin : 0;
      if (run && runMin * 60000 >= c.evalMs) ai.spotScore[run.spot] = kpm;
      const bestKnown = Math.max(0, ...Object.values(ai.spotScore));
      const eligible = c.spots.filter((s) => s[2] <= pd.level);
      const tier = Math.max(...eligible.map((s) => s[2]));
      const newTier = tier > ai.tierSeen;
      const mapDead = now - ai.mapNoMonsterSince > c.giveUpMapMs;
      const poor = run && now - run.start >= c.evalMs && (kpm === 0 || kpm < bestKnown * c.minFracOfBest);
      if (now - ai.lastWarp > 15000 && eligible.length && (!run || newTier || mapDead || poor)) {
        ai.tierSeen = tier;
        const others = eligible.filter((s) => s[0] !== ai.spot);
        const untried = others.filter((s) => ai.spotScore[s[0]] === undefined).sort((a, b) => b[2] - a[2]);
        const tried = others.filter((s) => ai.spotScore[s[0]] !== undefined).sort((a, b) => ai.spotScore[b[0]] - ai.spotScore[a[0]]);
        const curScore = run ? kpm : -1;
        const to = newTier ? eligible.filter((s) => s[2] === tier && s[0] !== ai.spot)[0] ?? untried[0] : untried[0] ?? (tried[0] && ai.spotScore[tried[0][0]] > curScore ? tried[0] : null);
        if (to) {
          const why = !run ? 'inicio' : newTier ? `nuevo nivel de mapa (${tier})` : mapDead ? 'mapa sin monstruos' : `rinde poco (${Math.round(kpm)} exp/min vs mejor ${Math.round(bestKnown)})`;
          ai.lastWarp = now; ai.spot = to[0]; ai.target = null; w.attackTarget = null; ai.explore = null; ai.mapNoMonsterSince = ai.lastMonster = now; ai.scoutIdx = 0;
          ai.spotRun = { spot: to[0], start: now + 8000, kills0: ai.kills };
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
        ai.lastMonster = ai.mapNoMonsterSince = now;
        if (w.attackTarget !== ai.target) w.attackTarget = ai.target;
        const tp = ai.target.transform.pos;
        if (!w.castRequest && pd.currentMP / pd.maxMP >= c.skillMinMp && dist(P, tp) <= 4) w.castRequest = { target: ai.target, point: { x: tp.x, y: tp.z }, forced: false };
        return;
      }
      const arrived = ai.explore && dist(P, ai.explore) < 4;
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
  ai.timer = setInterval(ai.tick, 400);
  ai.sampler = setInterval(() => { const pd = S.playerData; ai.samples.push({ t: Date.now(), level: pd.level, map: W()?.mapIndex, kills: ai.kills }); if (ai.samples.length > 3000) ai.samples.shift(); }, 30000);
  ai.mgr = setInterval(async () => {
    if (ai.busy || !ai.on || S.uiState !== 5 || S.sceneLoading) return;
    const pd = S.playerData;
    if (pd.level >= ai.cfg.resetLevel && Date.now() > (ai.nextResetTry ?? 0)) return ai.doReset();
    if (pd.points >= ai.cfg.statBatch) { ai.busy = true; try { await ai.distribute(); } finally { ai.busy = false; } }
  }, 5000);
  return 'agente instalado';
})();
