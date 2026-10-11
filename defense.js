// Defensa propia (pedido del usuario: "si te atacan te defendés con todo; si no podés, seguí tu camino").
// Se carga después de browser-agent.js. Solo responde a un JUGADOR que le pegó a este personaje en los
// últimos segundos (nunca ataca primero). Mientras pelea pausa el farmeo, usa el skill más fuerte
// (DK: Death Stab) y toma pociones. Si la vida baja de `fleeHp`, se va a otro mapa de la ruta y deja
// ese mapa unos minutos.
//
// De dónde sale "me atacó" (paquetes del server, ver los formatos medidos en 0.97d):
//   0x18 ObjectAnimation  C1 09 18 [atacante u16] [dir] [anim] [objetivo u16]   golpe normal
//   0x19 SkillAnimation   C3 09 19 [skill u16] [atacante u16] [objetivo u16|0x8000]
//   0x1E AreaSkillAnimation C3 0a 1e [skill u16] [atacante u16] [x] [y] [rot]    sin objetivo: cuenta
//        solo si el que lo tiró es un jugador a <= 5 tiles y en el segundo siguiente nos bajó la vida.
(() => {
  const S = window.__store, W = () => window.__world;
  for (const t of window.__defense?.timers ?? []) clearInterval(t);
  const cfg = { memoryMs: 10000, chaseTiles: 10, fleeHp: 0.35, hpPot: 0.75, avoidMapMs: 5 * 60000, areaTiles: 5 };
  const D = (window.__defense = { cfg, attackers: new Map(), log: [], engaged: null, timers: [], fights: 0, flees: 0 });
  const L = (m) => { D.log.push(new Date().toLocaleTimeString() + ' ' + m); if (D.log.length > 100) D.log.shift(); window.__ai?.L?.('DEFENSA: ' + m); };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const bytes = (raw) => raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw?.buffer ? new Uint8Array(raw.buffer) : null;
  const myId = () => (W()?.playerEntity?.netId ?? -1) & 0x7fff;
  const isPlayer = (e) => e && e.heroState !== undefined && !e.localPlayer && e !== W()?.playerEntity;
  const friends = () => new Set([...(window.__defenseFriends ?? ['Horaz', 'Melu'])]);
  const ent = (id) => { const w = W(); for (const e of w?.byNetId?.values?.() ?? []) if ((e.netId & 0x7fff) === id) return e; return null; };
  const mark = (id, how) => {
    const e = ent(id); if (!isPlayer(e) || friends().has(e.objectNameInWorld)) return;
    if (!D.attackers.has(id)) L(`me ataca ${e.objectNameInWorld} (${how})`);
    D.attackers.set(id, Date.now());
  };
  const u16 = (u, i) => (u[i] << 8) | u[i + 1];
  let areaCasts = [], lastHp = S.playerData.currentHP;
  const on = (name, fn) => __eventBus.on(name, (raw) => { if (D !== window.__defense) return; try { const u = bytes(raw); if (u) fn(u); } catch {} });
  on('ObjectAnimation', (u) => { if (u[2] === 0x18 && u.length >= 9 && (u16(u, 7) & 0x7fff) === myId()) mark(u16(u, 3) & 0x7fff, 'golpe'); });
  for (const n of ['SkillAnimation', 'SkillAnimation075', 'SkillAnimation095']) on(n, (u) => { if (u[2] === 0x19 && u.length >= 9 && (u16(u, 7) & 0x7fff) === myId()) mark(u16(u, 5) & 0x7fff, 'skill ' + u16(u, 3)); });
  for (const n of ['AreaSkillAnimation', 'AreaSkillAnimation075', 'AreaSkillAnimation095']) on(n, (u) => { if (u[2] === 0x1e && u.length >= 9) areaCasts.push({ id: u16(u, 5) & 0x7fff, t: Date.now() }); });
  // Vida que baja con un jugador que acaba de tirar un skill de área cerca = ataque.
  D.timers.push(setInterval(() => {
    const hp = S.playerData.currentHP, now = Date.now(), w = W(), P = w?.playerEntity?.transform?.pos;
    areaCasts = areaCasts.filter((a) => now - a.t < 1200);
    if (P && hp < lastHp) for (const a of areaCasts) { const e = ent(a.id); if (isPlayer(e) && dist(e.transform.pos, P) <= cfg.areaTiles) mark(a.id, 'área'); }
    lastHp = hp;
  }, 200));

  const bestSkill = () => { const have = new Set((S.skills ?? []).map((s) => s.number)); for (const k of [43, 42, 41, 19]) if (have.has(k)) return k; return window.__ai?.cfg?.skill ?? null; };
  const potion = () => {
    const pd = S.playerData; if (!(pd.currentHP > 0 && pd.currentHP / pd.maxHP < cfg.hpPot) || Date.now() - (D.lastPot ?? 0) < 900) return;
    const it = S.playerData.items || []; let slot = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { slot = i; bn = x.num; } });
    if (slot >= 0) { S.consumeItemRequest(slot); D.lastPot = Date.now(); }
  };
  const release = (why) => {
    const g = D.engaged; if (!g) return; D.engaged = null;
    const w = W(); if (w) { w.attackTarget = null; w.castRequest = null; }
    const ai = window.__ai; if (ai) { ai.target = null; ai.on = g.aiWasOn; }
    L(`fin de la pelea con ${g.name}: ${why}`);
  };
  const flee = (name) => {
    const ai = window.__ai, w = W(); const here = w.mapIndex;
    const spots = (ai?.cfg?.spots ?? []).filter((s) => s[2] <= S.playerData.level);
    const curSpot = ai?.spot; const other = spots.filter((s) => s[0] !== curSpot).sort((a, b) => b[2] - a[2])[0];
    D.flees++; release('me voy (vida baja)');
    if (ai && curSpot != null) ai.crowdedAt = { ...(ai.crowdedAt ?? {}), [curSpot]: Date.now() };
    D.avoid = { map: here, until: Date.now() + cfg.avoidMapMs };
    if (other && ai) { ai.lastWarp = Date.now(); ai.spot = other[0]; ai.explore = null; ai.camp = null; ai.arrivalPending = Date.now(); S.warpCommandRequest(other[0]); L(`no puedo con ${name}: sigo mi camino en ${other[1]}`); }
    D.attackers.clear();
  };

  D.timers.push(setInterval(() => {
    const w = W(), pe = w?.playerEntity, pd = S.playerData, now = Date.now();
    if (!pe || S.uiState !== 5 || S.sceneLoading || pd.currentHP <= 0) { if (D.engaged) release('muerto o cargando'); return; }
    const P = pe.transform.pos;
    for (const [id, t] of D.attackers) { const e = ent(id); if (now - t > cfg.memoryMs || !e || e.dying || e.objOutOfScope) D.attackers.delete(id); }
    // El que pegó más reciente y sigue cerca.
    let foe = null, ft = 0;
    for (const [id, t] of D.attackers) { const e = ent(id); if (e && dist(e.transform.pos, P) <= cfg.chaseTiles && t > ft) { foe = e; ft = t; } }
    if (!foe) { if (D.engaged) release('ya no me ataca'); return; }
    if (pd.currentHP / pd.maxHP < cfg.fleeHp) { flee(foe.objectNameInWorld); return; }
    const ai = window.__ai;
    if (!D.engaged) { D.engaged = { name: foe.objectNameInWorld, since: now, aiWasOn: ai?.on ?? false }; D.fights++; if (ai) ai.on = false; L(`me defiendo de ${foe.objectNameInWorld}`); }
    D.engaged.name = foe.objectNameInWorld;
    potion();
    const sk = bestSkill(); if (sk != null && S.currentSkill !== sk) S.selectSkill(sk);
    w.attackTarget = foe;
    if (!w.castRequest) { const tp = foe.transform.pos; w.castRequest = { target: foe, point: { x: tp.x, y: tp.z }, forced: true }; }
  }, 150));
  L('activa');
})();
