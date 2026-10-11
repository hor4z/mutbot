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
      try { localStorage.setItem(`mubot:pos:${me}`, JSON.stringify({ map: w.mapIndex, x: Math.round(p.x), z: Math.round(p.z), at: Date.now() })); } catch {}
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
    if (window.__ai?.on) window.__ai.on = false;
    const now = Date.now();
    // Pociones (el agente está apagado).
    if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < 0.6 && now - (F.potAt ?? 0) > 900) {
      const it = pd.items || []; let slot = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { slot = i; bn = x.num; } });
      if (slot >= 0) { S.consumeItemRequest(slot); F.potAt = now; }
    }
    let lp = null; try { lp = JSON.parse(localStorage.getItem(`mubot:pos:${leader}`) || 'null'); } catch {}
    if (!lp || now - lp.at > 10000) return; // el líder no publica (pestaña cerrada o cargando)
    if (w.mapIndex !== lp.map) {
      const wp = WARP[lp.map];
      if (wp != null && now - F.warpAt > 8000) { F.warpAt = now; S.warpCommandRequest(wp); L(`voy con ${leader} (mapa ${lp.map})`); }
      return;
    }
    const P = pe.transform.pos;
    if (d(P, lp) > 2.5 && pe.playerMoveTo.handled) {
      // Un paso al lado (no encima), del lado de donde viene.
      const k = Math.min(1, 1.5 / Math.max(d(P, lp), 0.1)), x = Math.round(lp.x + (P.x - lp.x) * k), z = Math.round(lp.z + (P.z - lp.z) * k);
      const m = pe.playerMoveTo; m.point.x = x; m.point.y = z; m.handled = false; m.sendToServer = true;
    }
  }, 500));
  L(`seguidor de ${leader}: sin pelear`);
  return `siguiendo a ${leader}`;
})();
