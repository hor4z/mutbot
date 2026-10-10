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
  // 250 ms: el seguidor va pegado al líder y necesita su posición casi en tiempo real.
  const publish = (name) => every(() => { const pe = W()?.playerEntity; if (!pe || S.uiState !== 5) return; const P = pe.transform.pos; try { localStorage.setItem('mubot:follow:' + name, JSON.stringify({ x: Math.round(P.x), z: Math.round(P.z), map: W().mapIndex, spot: window.__ai?.spot, level: S.playerData.level, at: Date.now() })); } catch {} }, 1000);
  // Nivel mínimo de cada warp (lista del cliente, perfil v097d).
  const REQ = { 2: 10, 3: 10, 4: 20, 5: 20, 6: 20, 7: 20, 1: 50, 24: 100, 25: 200, 26: 300 };
  const stop = () => { while (timers.length) window.clearInterval(timers.pop()); };

  const leader = (followerName) => {
    stop();
    const ai = window.__ai; const me = S.playerData.name;
    publish(me);
    // Mapas: solo los que el seguidor puede entrar (tope = su nivel).
    const all = ai.cfg.allSpots ?? ai.cfg.spots; ai.cfg.allSpots = all;
    // Tope = nivel del seguidor. Si deja de publicar (p. ej. comprando en una tienda), usar su
    // ÚLTIMO nivel conocido: con "sin tope" el líder se fue a Arena 4 y el seguidor no podía entrar.
    let lastCap = null;
    // window.__duoSafeCap: tope extra mientras el seguidor no tenga armadura (Arena 3 lo mató sin ella).
    const capNow = () => { try { const v = JSON.parse(localStorage.getItem('mubot:follow:' + followerName) || 'null'); if (v?.level) lastCap = v.level; } catch {} return Math.min(lastCap ?? 999, window.__duoSafeCap ?? 999); };
    Object.defineProperty(ai.cfg, 'spots', { configurable: true, enumerable: true, get() { const cap = capNow(); return all.filter((s) => s[2] <= cap && !(s[0] === 2 && cap >= 20)); } });
    ai.tierSeen = 0; ai.spotRun = null; ai.lastWarp = 0; ai.cfg.leashDist = 10;
    // Proteger al seguidor: primero los monstruos a <= 3 tiles de él (en Arena 1 se le
    // pegaron 7 de golpe en la entrada).
    if (!ai.duoProtect) { const inner = ai.pickTarget; ai.pickTarget = (w, P, c) => { const f = read(followerName); if (f && f.map === w.mapIndex) { let best = null, bd = 1e9; for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const d = dist(e.transform.pos, f); if (d <= 5 && d < bd) { bd = d; best = e; } } if (best) return best; } return inner(w, P, c); }; ai.duoProtect = true; }
    // Arena 1 NO: también para el dúo rinde casi nada (dragoncitos/arañas). Medido: Melu
    // subió 26→66 en Devias y ~0 en Arena 1. Devias hasta que el seguidor llegue a 100.
    { const i = all.findIndex((s) => s[0] === 1); if (i >= 0) all.splice(i, 1); }
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
      if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < 0.85 && now - lastPot > 400) { const s = potion(); if (s >= 0) { S.consumeItemRequest(s); lastPot = now; } }
      w.attackTarget = null; w.castRequest = null;
      const h = read(leaderName); if (!h) return;
      // Si el líder está en un mapa que el seguidor no puede entrar (nivel), esperar en
      // Lorencia (zona segura) en vez de quedar solo y sin protección en el mapa anterior.
      const canEnter = h.spot != null && (REQ[h.spot] ?? 0) <= pd.level;
      if (w.mapIndex !== h.map) { if (now - lastWarp > 20000) { lastWarp = now; if (canEnter) S.warpCommandRequest(h.spot); else if (w.mapIndex !== 0) S.warpCommandRequest(2); } return; }
      // En el MISMO tile que el líder ("debajo de su espada", usuario), revisando 4 veces por segundo.
      const P0 = pe.transform.pos;
      if (Math.round(P0.x) !== h.x || Math.round(P0.z) !== h.z) { const m = pe.playerMoveTo; if (m.point.x !== h.x || m.point.y !== h.z || m.handled) { m.point.x = h.x; m.point.y = h.z; m.handled = false; m.sendToServer = true; } }
    }, 250);
    every(async () => { if (S.uiState !== 5 || ai.distributing || (S.playerData.points ?? 0) < 10) return; ai.distributing = true; try { await ai.distribute(); } finally { ai.distributing = false; } }, 5000);
    return `seguidor: ${me} sigue a ${leaderName} sin atacar`;
  };

  // Para el líder que farmea a su manera (sin correa ni tope de mapas): solo publicar su
  // posición e invitar al compañero cuando lo tenga cerca, hasta que el server confirme la party.
  const partyWith = (name) => {
    publish(S.playerData.name);
    window.__partyWith = name; window.__inParty = false;
    // En dúo el líder SIEMPRE protege al compañero (usuario): primero los monstruos a <= 5
    // tiles de él; la ruta y el estilo de farmeo del líder no cambian.
    const ai = window.__ai;
    if (ai && !ai.duoProtect) { const inner = ai.pickTarget; ai.pickTarget = (w, P, c) => { const f = read(name); if (f && f.map === w.mapIndex) { let best = null, bd = 1e9; for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const d = dist(e.transform.pos, f); if (d <= 5 && d < bd) { bd = d; best = e; } } if (best) return best; } return inner(w, P, c); }; ai.duoProtect = true; }
    if (!window.__partyListHooked) { __eventBus.on('PartyList', () => { window.__inParty = true; }); __eventBus.on('RemovePartyMember', () => { window.__inParty = false; }); window.__partyListHooked = true; }
    let last = 0;
    every(() => {
      const w = W(), pe = w?.playerEntity; if (!pe || S.uiState !== 5 || window.__inParty || Date.now() - last < 60000) return;
      const ent = (w.playersQuery?.entities ?? []).find((e) => !e.localPlayer && String(e.objectNameInWorld ?? '').trim() === name);
      if (!ent || dist(pe.transform.pos, ent.transform.pos) > 12) return;
      last = Date.now(); const id = ent.netId & 0x7fff; S.sendToGS(new DataView(Uint8Array.from([0xc1, 0x05, 0x40, id >> 8, id & 0xff]).buffer));
    }, 1500);
    return `party automática con ${name}`;
  };
  window.__duo = { leader, follower, partyWith, stop };
  return 'modo dúo cargado: __duo.leader(nombre) / __duo.follower(nombre)';
})();
