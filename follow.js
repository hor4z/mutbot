// Seguidor pasivo (2026-10-11, usuario: "que vaya al lado de Horaz y lo siga, no es necesario que
// ataque; si lo matan, que vuelva a Horaz"). Para Melu en party con Horaz: cobra parte de la exp de
// lo que mata Horaz sin pelear.
//
// En la pestaña del LÍDER:      window.__followRole = 'lider';      y cargar este archivo.
// En la pestaña del SEGUIDOR:   window.__followRole = 'seguidor';  window.__followLeader = 'Horaz';
//
// El líder publica su posición en localStorage (`mubot:pos:<nombre>`) cada 500 ms; el seguidor la lee
// (las dos pestañas son del mismo navegador). Seguidor: agente apagado, warp al mapa del líder,
// caminar a <= 2 tiles, pociones propias, y al morir o reaparecer en otro lado, vuelve solo.
// Party: el líder invita al seguidor cuando lo tiene cerca y no hay party; el seguidor acepta solo
// las invitaciones de su líder.
(() => {
  const S = __store, W = () => __world;
  for (const t of window.__follow?.timers ?? []) clearInterval(t);
  const role = window.__followRole, me = S.playerData?.name;
  const F = (window.__follow = { role, timers: [], log: [], warpAt: 0 });
  const L = (m) => { F.log.push(new Date().toLocaleTimeString() + ' ' + m); if (F.log.length > 100) F.log.shift(); window.__ai?.L?.('SEGUIR: ' + m); };
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  // Mapa → warp para llegar (Devias por la entrada 4, la que usa la ruta de Horaz).
  const WARP = { 0: 2, 2: 7, 3: 3, 6: 1, 83: 24, 84: 25, 85: 26 };
  const send = (bytes) => S.sendToGS(new DataView(Uint8Array.from(bytes).buffer));

  if (role === 'lider') {
    F.timers.push(setInterval(() => {
      const w = W(), p = w?.playerEntity?.transform?.pos; if (!p || S.uiState !== 5) return;
      try { localStorage.setItem(`mubot:pos:${me}`, JSON.stringify({ map: w.mapIndex, x: Math.round(p.x), z: Math.round(p.z), level: S.playerData.level, at: Date.now() })); } catch {}
      // Invitar al seguidor a la party si está a <= 10 tiles (cada 30 s como mucho).
      const name = window.__followMate; if (!name || window.__inParty || Date.now() - (F.invAt ?? 0) < 30000) return;
      for (const e of w.byNetId.values()) if (e.objectNameInWorld === name && d(e.transform.pos, p) <= 10) { F.invAt = Date.now(); const id = e.netId & 0x7fff; send([0xc1, 0x05, 0x40, id >> 8, id & 0xff]); L(`invito a ${name} a la party`); break; }
    }, 500));
    if (!window.__followPartyHooked) { __eventBus.on('PartyList', () => { window.__inParty = true; }); __eventBus.on('RemovePartyMember', () => { window.__inParty = false; }); window.__followPartyHooked = true; }
    L('líder: publico mi posición');
    return 'líder listo';
  }

  const leader = window.__followLeader ?? 'Horaz';
  window.__partyAllow = [...new Set([...(window.__partyAllow ?? []), leader])];
  if (window.__ai) window.__ai.on = false;
  // Aceptar solo la party del líder (0x40 llega con el id de quien invita; respuesta C1 06 41 01 id).
  if (!window.__followAcceptHooked) {
    __eventBus.on('PartyRequest', (raw) => {
      try {
        const u = raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw.buffer ?? raw);
        const id = ((u[3] << 8) | u[4]) & 0x7fff; let from = null;
        for (const e of W().byNetId.values()) if ((e.netId & 0x7fff) === id) from = e.objectNameInWorld;
        if (from === (window.__followLeader ?? 'Horaz')) setTimeout(() => send([0xc1, 0x06, 0x41, 0x01, id >> 8, id & 0xff]), 400);
      } catch {}
    });
    window.__followAcceptHooked = true;
  }
  F.timers.push(setInterval(() => {
    const w = W(), pe = w?.playerEntity, pd = S.playerData; if (!pe || S.uiState !== 5 || S.sceneLoading) return;
    const now = Date.now();
    // Pociones (el agente está apagado).
    if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < 0.6 && now - (F.potAt ?? 0) > 900) {
      const it = pd.items || []; let slot = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { slot = i; bn = x.num; } });
      if (slot >= 0) { S.consumeItemRequest(slot); F.potAt = now; }
    }
    // Reset propio en 400 (el agente está apagado y no lo haría): doReset del agente reparte puntos y
    // vuelve a entrar; después sigue al líder desde donde aparezca.
    const ai = window.__ai;
    if (pd.level >= 400 && ai?.doReset && !ai.busy && now - (F.resetAt ?? 0) > 60000) { F.resetAt = now; L('nivel 400: reseteo'); ai.doReset(); return; }
    if (ai?.busy) return;
    let lp = null; try { lp = JSON.parse(localStorage.getItem(`mubot:pos:${leader}`) || 'null'); } catch {}
    if (!lp || now - lp.at > 10000) return; // el líder no publica (pestaña cerrada o cargando)
    // Mapa del líder fuera de su nivel (después del reset Melu está en 10 y Horaz en Arena 4): farmear
    // sola con su agente (misma ruta) hasta que le alcance; ahí vuelve a seguirlo.
    const REQ = { 0: 0, 3: 10, 2: 20, 6: 50, 83: 100, 84: 200, 85: 300 };
    // Tampoco seguirlo si el líder va por debajo de ella (Horaz recién reseteado en Lorencia y Melu en
    // 150): la party rinde cuando el que mata es de nivel parecido o más alto.
    if (pd.level < (REQ[lp.map] ?? 0) || (lp.level != null && lp.level < pd.level - 30)) { if (ai && !ai.on) { ai.on = true; L(`nivel ${pd.level} (${leader} ${lp.level ?? '?'} en mapa ${lp.map}): farmeo sola`); } F.solo = true; return; }
    if (F.solo) { F.solo = false; L(`nivel ${pd.level}: vuelvo con ${leader}`); }
    if (ai?.on) { ai.on = false; ai.target = null; w.attackTarget = null; }
    // Escapar: con poca vida, teleport a 7 tiles en dirección contraria al monstruo más cercano.
    if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < 0.4 && (S.skills ?? []).some((k) => k.number === 6) && now - (F.tpAt ?? 0) > 1500 && !w.castRequest && w.mapIndex === lp.map) {
      const P0 = pe.transform.pos; let m = null, md = 1e9;
      for (const e of w.byNetId.values()) { if (!window.__ai?.isMonster?.(e) || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const dd = d(e.transform.pos, P0); if (dd < md) { md = dd; m = e.transform.pos; } }
      if (m && md < 6) { const vx = P0.x - m.x, vz = P0.z - m.z, n = Math.hypot(vx, vz) || 1, x = Math.round(P0.x + vx / n * 7), z = Math.round(P0.z + vz / n * 7);
        if (w.isWalkable?.(x, z) !== false) { F.tpAt = now; if (S.currentSkill !== 6) S.selectSkill(6); w.castRequest = { target: null, point: { x, y: z }, forced: false }; L(`escapo (vida ${Math.round(pd.currentHP / pd.maxHP * 100)}%)`); return; } }
    }
    if (w.mapIndex !== lp.map) {
      const wp = WARP[lp.map];
      if (wp != null && now - F.warpAt > 8000) { F.warpAt = now; S.warpCommandRequest(wp); L(`voy con ${leader} (mapa ${lp.map})`); }
      return;
    }
    const P = pe.transform.pos;
    // Teleport (skill 6), refinado (usuario: "las teletransportaciones no parecen buenas"): solo si
    // está a > 10 tiles (para menos, caminar), cada 2 s, cayendo a ~2 tiles del líder (no más allá) y
    // nunca en medio de un grupo (>= 3 monstruos a <= 3 tiles del punto de llegada).
    const dl = d(P, lp);
    const monsNear = (q, r) => [...w.byNetId.values()].filter((e) => window.__ai?.isMonster?.(e) && !e.dying && (e.attributeSystem?.getValue?.('currentHealth') ?? 0) > 0 && d(e.transform.pos, q) <= r).length;
    if (dl > 10 && (S.skills ?? []).some((k) => k.number === 6) && now - (F.tpAt ?? 0) > 2000 && !w.castRequest && (pd.currentMana ?? 100) > 30) {
      const step = Math.min(7, dl - 2), k = step / dl, x = Math.round(P.x + (lp.x - P.x) * k), z = Math.round(P.z + (lp.z - P.z) * k);
      if (w.isWalkable?.(x, z) !== false && monsNear({ x, z }, 3) < 3) { F.tpAt = now; if (S.currentSkill !== 6) S.selectSkill(6); w.castRequest = { target: null, point: { x, y: z }, forced: false }; F.tps = (F.tps ?? 0) + 1; return; }
    }
    // Ayudar (usuario: "ya Melu puede ayudar un poco"; "mientras se mueve puede ir atacando"): a <= 12
    // tiles del líder, también caminando, si hay un monstruo a <= 5 tiles de ella, tirar su skill de
    // área (Evil Spirit, 9) sin desviarse hacia él. Nunca se aleja de Horaz por pelear. window.__followHelp = false lo apaga.
    // Recibiendo mucho daño, no pegar (usuario): con < 70% de vida, o si perdió > 15% en los últimos
    // 3 s, deja de atacar 8 s (pegar la vuelve objetivo de los monstruos).
    F.hpHist = (F.hpHist ?? []).filter((x) => now - x.t < 3000); F.hpHist.push({ t: now, hp: pd.currentHP });
    const lost = pd.maxHP ? (Math.max(...F.hpHist.map((x) => x.hp)) - pd.currentHP) / pd.maxHP : 0;
    if (pd.maxHP && (pd.currentHP / pd.maxHP < 0.7 || lost > 0.15)) { if (!F.calmUntil || now > F.calmUntil) L(`recibo daño (${Math.round(pd.currentHP / pd.maxHP * 100)}%): dejo de pegar`); F.calmUntil = now + 8000; }
    if ((window.__followHelp ?? true) && !(F.calmUntil && now < F.calmUntil) && dl <= 12 && !w.castRequest && (pd.currentMana ?? 100) > 30 && now - (F.helpAt ?? 0) > 250) {
      // Decay (38, Soul Master) primero: 16.145 de daño/s; Inferno (14) 14.997 como Soul Master (10.434
      // como Dark Wizard), Evil Spirit 5.383, Hellfire 4.278 (medido 2026-10-11 en Arena 2).
      // Usuario: "usá Spirit principalmente" (alcance ~5 tiles: agarra más monstruos que Decay/Inferno).
      const skill = [9, 38, 14, 17, 5].find((k) => (S.skills ?? []).some((x) => x.number === k));
      let m = null, md = 1e9;
      for (const e of w.byNetId.values()) { if (!window.__ai?.isMonster?.(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const dd = d(e.transform.pos, P); if (dd <= 6 && dd < md) { md = dd; m = e; } } // 6 tiles: con más nivel ayuda más ("a menos que la golpeen": eso lo corta calmUntil)
      if (m && skill != null) { F.helpAt = now; if (S.currentSkill !== skill) S.selectSkill(skill); const tp = m.transform.pos; w.castRequest = { target: m, point: { x: tp.x, y: tp.z }, forced: false }; F.helps = (F.helps ?? 0) + 1; return; }
    }
    if (dl > 2.5 && pe.playerMoveTo.handled) {
      // Un paso al lado (no encima), del lado de donde viene.
      const k = Math.min(1, 1.5 / Math.max(d(P, lp), 0.1)), x = Math.round(lp.x + (P.x - lp.x) * k), z = Math.round(lp.z + (P.z - lp.z) * k);
      const m = pe.playerMoveTo; m.point.x = x; m.point.y = z; m.handled = false; m.sendToServer = true;
    }
  }, 500));
  L(`seguidor de ${leader}: sin pelear`);
  return `siguiendo a ${leader}`;
})();
