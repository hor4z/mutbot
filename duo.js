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
 *   window.__pullSkill = 9                // opcional: el seguidor tira Evil Spirit para atraer monstruos al líder
 *   window.__coopFight = true             // cooperación: el seguidor pelea (Evil Spirit) a <= 2 tiles del líder
 */
(() => {
  const S = __store, W = () => __world;
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const read = (name) => { try { const v = JSON.parse(localStorage.getItem('mubot:follow:' + name) || 'null'); return v && Date.now() - v.at < 20000 ? v : null; } catch { return null; } };
  const timers = (window.__duoTimers ??= []);
  const every = (fn, ms) => { const id = window.setInterval(fn, ms); timers.push(id); (window.__mubotTimers ??= []).push(id); return id; };
  // 250 ms: el seguidor va pegado al líder y necesita su posición casi en tiempo real.
  const publish = (name) => { let lastK = '', movedAt = 0; return every(() => { const pe = W()?.playerEntity; if (!pe || S.uiState !== 5) return; const P = pe.transform.pos; const x = Math.round(P.x), z = Math.round(P.z); const k = x + ',' + z; if (k !== lastK) { lastK = k; movedAt = Date.now(); } try { localStorage.setItem('mubot:follow:' + name, JSON.stringify({ x, z, still: Date.now() - movedAt > 1000, map: W().mapIndex, spot: window.__ai?.spot, level: S.playerData.level, at: Date.now() })); } catch {} }, 250); };
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
    // Puntos del seguidor (Melu, Dark Wizard): el reparto de Dark Knight (fuerza/energía) no le
    // sirve. Solo sigue y atrae, y se muere si queda sola: sobre todo vida y agilidad (defensa);
    // la energía ya pasa de 2400 (sobra para Evil Spirit). window.__followerStats lo cambia.
    ai.planStats = (pts) => { const sh = window.__followerStats ?? { sta: 0.5, agi: 0.3, ene: 0.2 }; const out = []; let left = pts; const ks = Object.keys(sh); ks.forEach((k, i) => { const n = i === ks.length - 1 ? left : Math.floor(pts * sh[k]); left -= n; out.push([k === 'sta' ? 'vit' : k, n]); }); return out; };
    // Aceptar la party del líder y filtrar el rechazo automático (C1 06 41 00).
    window.__acceptPartyFrom = leaderName;
    if (!window.__duoSendWrapped) { const orig = S.sendToGS.bind(S); S.sendToGS = (dv) => { try { const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength); if (window.__acceptPartyFrom && b[0] === 0xc1 && b[2] === 0x41 && b[3] === 0x00) return; } catch {} return orig(dv); }; window.__duoSendWrapped = true; }
    if (!window.__duoAcceptHooked) { __eventBus.on('PartyRequest', (raw) => { try { const dv = raw instanceof DataView ? raw : new DataView(raw.buffer ?? raw); const id = dv.getUint16(3, false) & 0x7fff; setTimeout(() => S.sendToGS(new DataView(Uint8Array.from([0xc1, 0x06, 0x41, 0x01, id >> 8, id & 0xff]).buffer)), 500); } catch {} }); window.__duoAcceptHooked = true; }
    const potion = () => { const it = S.playerData.items || []; let best = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { best = i; bn = x.num; } }); return best; };
    let lastWarp = 0, lastPot = 0, lastPull = 0;
    every(() => {
      const w = W(), pe = w?.playerEntity, pd = S.playerData; if (!pe || S.uiState !== 5 || S.sceneLoading) return;
      const now = Date.now();
      if (pd.currentHP > 0 && pd.currentHP / pd.maxHP < 0.85 && now - lastPot > 400) { const s = potion(); if (s >= 0) { S.consumeItemRequest(s); lastPot = now; } }
      w.attackTarget = null;
      const h = read(leaderName); if (!h) return;
      // Reset en dúo: el líder espera a que el seguidor llegue a 400 (partyWith); el seguidor
      // resetea apenas los dos están en 400 o el líder ya reseteó, para arrancar el ciclo juntos
      // y medir si el dúo rinde más que Horaz solo (ai.cycles en las dos pestañas).
      if (pd.level >= (ai.cfg.resetLevel ?? 400) && !ai.busy && now > (ai.nextResetTry ?? 0) && (h.level >= 400 || h.level < 50)) { ai.doReset(); return; }
      // Atraer (usuario, 2026-10-10): con window.__pullSkill (Evil Spirit = 9) el seguidor lanza
      // el área cuando hay >= 2 monstruos a <= 6 tiles y está con el líder: se le vienen encima y,
      // como está en el mismo tile, el giro del líder los toma a todos juntos. Sin golpe normal.
      // Cooperación (usuario, 2026-10-10: "que cooperen, hacé crecer a Melu"): con window.__coopFight el
      // seguidor pelea de verdad: Evil Spirit al monstruo más cercano a <= 4 tiles cada 0,4 s, con vida
      // > 60 % y maná > 20 %, sin esperar a que el líder esté quieto. Va a <= 2 tiles del líder.
      if (window.__coopFight && w.mapIndex === h.map && pd.currentHP / pd.maxHP > 0.6 && pd.currentMP / pd.maxMP > 0.2 && now - lastPull > 400 && !w.castRequest) {
        // Agrupar (usuario: "agrupando mayor número de atacantes"): con >= 2 monstruos a <= 4 tiles,
        // Evil Spirit (área alrededor); si no, Ice al más lejano a <= 7 tiles que esté lejos del líder,
        // para traerlo al grupo y que el giro del líder lo agarre junto con el resto.
        const P = pe.transform.pos; let near = null, nd = 99, close = 0, far = null, fd = -1;
        for (const e of w.byNetId.values()) {
          if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue;
          const d = dist(P, e.transform.pos), dl = dist(h, e.transform.pos);
          if (d < nd) { nd = d; near = e; } if (d <= 4) close++;
          if (d <= 7 && dl >= 4 && dl > fd) { fd = dl; far = e; }
        }
        const pick = close >= 2 ? [near, window.__coopSkill ?? 9] : far ? [far, window.__pullFarSkill ?? 7] : near && nd <= 4 ? [near, window.__coopSkill ?? 9] : null;
        if (pick) { const [tg, sk] = pick; if (S.currentSkill !== sk) S.selectSkill(sk); const tp = tg.transform.pos; w.castRequest = { target: tg, point: { x: tp.x, y: tp.z }, forced: false }; lastPull = now; }
      }
      const pull = window.__pullSkill;
      if (pull && w.mapIndex === h.map && dist(pe.transform.pos, h) <= 1 && h.still && pd.currentMP / pd.maxMP > 0.2 && now - lastPull > 1500) {
        const P = pe.transform.pos; let n = 0, near = null;
        for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; if (dist(P, e.transform.pos) <= 6) { n++; near ??= e; } }
        if (n >= 2 && !w.castRequest) { if (S.currentSkill !== pull) S.selectSkill(pull); const tp = near.transform.pos; w.castRequest = { target: near, point: { x: tp.x, y: tp.z }, forced: false }; lastPull = now; }
      } else if (!pull && !window.__coopFight) w.castRequest = null;
      // Si el líder está en un mapa que el seguidor no puede entrar (nivel), esperar en
      // Lorencia (zona segura) en vez de quedar solo y sin protección en el mapa anterior.
      // window.__followMaxReq: tope de mapa por seguridad (Melu murió 5 veces en Arena 3 sin
      // guantes/botas/Mana Shield; Arena 4 es peor). Con 200 sigue hasta Arena 3.
      const req = REQ[h.spot] ?? 0;
      const canEnter = h.spot != null && req <= pd.level && req <= (window.__followMaxReq ?? 999);
      if (w.mapIndex !== h.map || !canEnter) { if (now - lastWarp > 20000) { lastWarp = now; if (canEnter && w.mapIndex !== h.map) S.warpCommandRequest(h.spot); else if (!canEnter && w.mapIndex !== 0) S.warpCommandRequest(2); } return; }
      // En el MISMO tile que el líder ("debajo de su espada", usuario), revisando 4 veces por segundo.
      const P0 = pe.transform.pos;
      // En cooperación alcanza con <= 2 tiles (pegada pero peleando); si no, el mismo tile.
      if (window.__coopFight ? dist(P0, h) > 2 : (Math.round(P0.x) !== h.x || Math.round(P0.z) !== h.z)) { const m = pe.playerMoveTo; if (m.point.x !== h.x || m.point.y !== h.z || m.handled) { m.point.x = h.x; m.point.y = h.z; m.handled = false; m.sendToServer = true; } }
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
    // window.__duoProtect = false: el compañero se cuida solo (usuario: "no necesita tanto cuidado de Horaz").
    if (ai && !ai.duoProtect) { const inner = ai.pickTarget; ai.pickTarget = (w, P, c) => { const f = window.__duoProtect === false ? null : read(name); if (f && f.map === w.mapIndex) { let best = null, bd = 1e9; for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const d = dist(e.transform.pos, f); if (d <= 5 && d < bd) { bd = d; best = e; } } if (best) return best; } return inner(w, P, c); }; ai.duoProtect = true; }
    // Llegar los dos a 400 (usuario, 2026-10-10): el líder no resetea hasta que el compañero
    // llegue a su nivel de reset; mientras tanto sigue farmeando en party para subirlo.
    // Basta con haberlo visto en 400 una vez: el compañero resetea primero y vuelve a nivel 10
    // (con "nivel actual >= 400" Horaz quedó esperando para siempre en Arena 4).
    if (ai && !ai.cfg.__resetHeld) { const base = ai.cfg.resetLevel; let seen = false; Object.defineProperty(ai.cfg, 'resetLevel', { configurable: true, enumerable: true, get() { try { const v = JSON.parse(localStorage.getItem('mubot:follow:' + name) || 'null'); if (v?.level >= base) seen = true; } catch {} if (S.playerData.level < base) seen = false; return seen ? base : 999; }, set(v) {} }); ai.cfg.__resetHeld = true; }
    // Esperar al compañero (Melu murió a 23 tiles: Horaz siguió cambiando de campamento mientras
    // ella quedaba quieta lanzando): si está a > 8 tiles en el mismo mapa, el líder no avanza a su
    // próxima meta, vuelve hacia él; protegerlo (pickTarget) sigue igual. Con 4 tiles quedaban en
    // bucle en Lorencia: al caminar el seguidor siempre va 4-6 tiles atrás y el líder volvía.
    if (ai && !ai.duoWait) { const inner = ai.nextGoal; ai.nextGoal = (P, w) => { const f = read(name); if (f && f.map === w.mapIndex && dist(P, f) > (window.__duoWaitDist ?? 8)) return { x: f.x, z: f.z, kind: 'compañero' }; return inner(P, w); }; ai.duoWait = true; }
    // nextGoal solo se consulta al llegar: cortar el viaje en curso si el compañero quedó atrás.
    if (ai) every(() => { const w = W(), pe = w?.playerEntity, f = read(name); if (pe && f && f.map === w.mapIndex && dist(pe.transform.pos, f) > (window.__duoWaitDist ?? 8) && ai.explore && ai.explore.kind !== 'compañero') ai.explore = null; }, 500);
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
