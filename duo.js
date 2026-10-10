/**
 * Modo dúo: un personaje fuerte (líder) farmea y sube a otro (seguidor) en party.
 * Pedido del usuario (2026-10-10): Horaz sube a Melu. Cada pestaña corre su parte;
 * se comunican por localStorage (mismo sitio = mismo localStorage):
 *   mubot:follow:<nombre> = { x, z, map, spot, level, at }
 *
 * IMPORTANTE: las dos ventanas tienen que estar A LA VISTA (lado a lado). Chrome casi
 * congela las pestañas en segundo plano y la del otro queda a cámara lenta.
 *
 * Uso, en la consola de cada pestaña, después de browser-agent.js:
 *   Líder:     __duo.leader('Melu')      // farmea normal, solo en mapas que el seguidor
 *                                        // puede entrar, a <= 10 tiles de él; lo invita a party
 *   Seguidor:  __duo.follower('Horaz')   // NO ataca: sigue al líder a <= 4 tiles, mismo
 *                                        // warp, pociones y reparto de puntos; acepta su party
 */
(() => {
  const S = __store, W = () => __world;
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const read = (name) => { try { const v = JSON.parse(localStorage.getItem('mubot:follow:' + name) || 'null'); return v && Date.now() - v.at < 20000 ? v : null; } catch { return null; } };
  const timers = (window.__duoTimers ??= []);
  const every = (fn, ms) => { const id = window.setInterval(fn, ms); timers.push(id); (window.__mubotTimers ??= []).push(id); return id; };
  const publish = (name) => every(() => { const pe = W()?.playerEntity; if (!pe || S.uiState !== 5) return; const P = pe.transform.pos; try { localStorage.setItem('mubot:follow:' + name, JSON.stringify({ x: Math.round(P.x), z: Math.round(P.z), map: W().mapIndex, spot: window.__ai?.spot, level: S.playerData.level, at: Date.now() })); } catch {} }, 1000);
  const stop = () => { while (timers.length) window.clearInterval(timers.pop()); };

  const leader = (followerName) => {
    stop();
    const ai = window.__ai; const me = S.playerData.name;
    publish(me);
    // Mapas: solo los que el seguidor puede entrar (tope = su nivel).
    const all = ai.cfg.allSpots ?? ai.cfg.spots; ai.cfg.allSpots = all;
    Object.defineProperty(ai.cfg, 'spots', { configurable: true, enumerable: true, get() { const f = read(followerName); const cap = f ? f.level : 999; return all.filter((s) => s[2] <= cap && !(s[0] === 2 && cap >= 20)); } });
    ai.tierSeen = 0; ai.spotRun = null; ai.lastWarp = 0; ai.cfg.leashDist = 10;
    // Proteger al seguidor: primero los monstruos a <= 3 tiles de él (en Arena 1 se le
    // pegaron 7 de golpe en la entrada).
    if (!ai.duoProtect) { const inner = ai.pickTarget; ai.pickTarget = (w, P, c) => { const f = read(followerName); if (f && f.map === w.mapIndex) { let best = null, bd = 1e9; for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const d = dist(e.transform.pos, f); if (d <= 3 && d < bd) { bd = d; best = e; } } if (best) return best; } return inner(w, P, c); }; ai.duoProtect = true; }
    // Arena 1 sirve para el dúo (seguidor 50-99), aunque el solo la descarte.
    if (!all.some((s) => s[0] === 1)) all.splice(Math.max(0, all.findIndex((s) => s[0] === 24)), 0, [1, 'Arena', 50]);
    let invitedAt = 0;
    every(() => {
      const f = read(followerName); const w = W(); const pe = w?.playerEntity; if (!f || !pe || f.map !== w.mapIndex) return;
      // Correa al seguidor (camina): pelear/acampar/explorar a <= 10 tiles de él.
      ai.arrival = { x: f.x, z: f.z, map: f.map }; if (!ai.cfg.leashMaps.includes(f.map)) ai.cfg.leashMaps.push(f.map);
      if (ai.camp && dist(ai.camp, f) > 10) { ai.camp = null; ai.explore = null; }
      // Party: invitar si está cerca y visible (C1 05 40 <id BE>).
      const ent = (w.playersQuery?.entities ?? []).find((e) => !e.localPlayer && String(e.objectNameInWorld ?? '').trim() === followerName);
      if (ent && dist(pe.transform.pos, ent.transform.pos) <= 12 && Date.now() - invitedAt > 60000 && !window.__duoInParty) { invitedAt = Date.now(); const id = ent.netId & 0x7fff; S.sendToGS(new DataView(Uint8Array.from([0xc1, 0x05, 0x40, id >> 8, id & 0xff]).buffer)); }
    }, 1000);
    return `líder: ${me} sube a ${followerName}`;
  };

  const follower = (leaderName) => {
    stop();
    const ai = window.__ai; const me = S.playerData.name;
    publish(me);
    ai.on = false; // sin combate ni ruta propia
    // Aceptar la party del líder y filtrar el rechazo automático (C1 06 41 00).
    window.__acceptPartyFrom = leaderName;
    if (!window.__duoSendWrapped) { const orig = S.sendToGS.bind(S); S.sendToGS = (dv) => { try { const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength); if (window.__acceptPartyFrom && b[0] === 0xc1 && b[2] === 0x41 && b[3] === 0x00) return; } catch {} return orig(dv); }; window.__duoSendWrapped = true; }
    if (!window.__duoAcceptHooked) { __eventBus.on('PartyRequest', (raw) => { try { const dv = raw instanceof DataView ? raw : new DataView(raw.buffer ?? raw); const id = dv.getUint16(3, false) & 0x7fff; setTimeout(() => S.sendToGS(new DataView(Uint8Array.from([0xc1, 0x06, 0x41, 0x01, id >> 8, id & 0xff]).buffer)), 500); } catch {} }); window.__duoAcceptHooked = true; }
    const potion = () => { const it = S.playerData.items || []; let best = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { best = i; bn = x.num; } }); return best; };
    let lastWarp = 0, lastPot = 0;
    every(() => {
      const w = W(), pe = w?.playerEntity, pd = S.playerData; if (!pe || S.uiState !== 5 || S.sceneLoading) return;
      const now = Date.now();
      if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < 0.6 && now - lastPot > 900) { const s = potion(); if (s >= 0) { S.consumeItemRequest(s); lastPot = now; } }
      w.attackTarget = null; w.castRequest = null;
      const h = read(leaderName); if (!h) return;
      if (w.mapIndex !== h.map) { if (now - lastWarp > 20000 && h.spot != null) { lastWarp = now; S.warpCommandRequest(h.spot); } return; }
      if (dist(pe.transform.pos, h) > 4) { const m = pe.playerMoveTo; m.point.x = h.x; m.point.y = h.z; m.handled = false; m.sendToServer = true; }
    }, 600);
    every(async () => { if (S.uiState !== 5 || ai.distributing || (S.playerData.points ?? 0) < 10) return; ai.distributing = true; try { await ai.distribute(); } finally { ai.distributing = false; } }, 5000);
    return `seguidor: ${me} sigue a ${leaderName} sin atacar`;
  };

  window.__duo = { leader, follower, stop };
  return 'modo dúo cargado: __duo.leader(nombre) / __duo.follower(nombre)';
})();
