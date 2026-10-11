// Modo esquina (2026-10-11): el circuito de los primeros del ranking (LeanLive, Yatsuky, Soul
// Masters). Llegan a Arena 2 (warp 24; nivel bajo, cómo antes del 100 no se sabe) y caminan a la
// esquina de x e y chicas (5,11), donde se juntan 12-18 Gaint Drakan (nivel 100, 50.000 de vida). Horaz ahí: ~574M exp/min
// en nivel 300 contra ~116M de su mejor spot de antes.
//
// Qué hace (se carga después de browser-agent.js; `__corner.on = false` lo apaga):
//  - Fuera de Arena 2 (después del reset o de morir), warp 24 y campamento fijo en la esquina.
//  - Objetivo: el monstruo que deja más monstruos dentro del giro de Twisting Slash (2,5 tiles), con
//    preferencia por los que tienen la vida llena (nadie les pega: en MU la exp va según el daño) y
//    sin perseguir a uno suelto que ya está bajando otro jugador.
//  - Camino: el mismo de LeanLive (entrada 61,114 → norte por x≈56-61 → oeste por z≈10), por puntos,
//    sin pelear salvo lo que bloquea el paso. Directo, el cliente cortaba por el medio de los Elite
//    Skeleton y zigzagueaba.
//  - Esquina vacía: esperar en el centro de las últimas apariciones (pega primero cuando reaparecen);
//    pelear solo lo que esté a <= 8 tiles de la esquina, para no alejarse.
//  - Swell Life (48) cada ~55 s mientras está en la esquina: más vida contra 12-18 Drakan.
//  - Anota cada aparición en la esquina (posición y hora) en `__corner.spawns`, para pararse donde
//    reaparecen y medir cada cuánto (`__corner.report()`).
(() => {
  const ai = window.__ai, S = __store, W = () => __world;
  if (!ai) return 'primero browser-agent.js';
  if (window.__corner?.timer) clearInterval(window.__corner.timer);
  const C = (window.__corner = { on: true, minLevel: 100, map: 83, warp: 24, home: { x: 7, z: 11 }, radius: 12, spinR: 2.5, fill: 8, swellAt: 0,
    route: [[61, 98], [58, 72], [56, 45], [52, 28], [40, 21], [30, 11], [16, 10], [7, 11]], spawns: [], seen: new Map(), log: [], timer: null, warpAt: 0 });
  const L = (m) => { C.log.push(new Date().toLocaleTimeString() + ' ' + m); if (C.log.length > 200) C.log.shift(); ai.L('ESQUINA: ' + m); };
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const hp = (e) => e.attributeSystem?.getValue?.('currentHealth') ?? 0;
  const hpMax = (e) => e.attributeSystem?.getValue?.('maximumHealth') || hp(e) || 1;
  const alive = (e) => e && !e.dying && ai.isMonster(e) && hp(e) > 0;

  {
    // Al recargar se reemplaza el envoltorio (no se apila otro): el original queda en ai.cornerInner.
    const inner = (ai.cornerInner ??= ai.pickTarget);
    ai.pickTarget = (w, P, c) => {
      const C = window.__corner;
      if (!C?.on || w.mapIndex !== C.map || window.__hunt?.on) return inner(w, P, c);
      const mons = [...w.byNetId.values()].filter(alive);
      // Camino a la esquina: derecho, sin pelear lo que hay en el camino (zigzagueaba con los Elite
      // Skeleton de (50,80) y tardaba minutos). Solo lo que bloquea el paso (<= 1,5 tiles).
      if (d(P, C.home) > C.radius + 3) return mons.find((e) => d(e.transform.pos, P) <= 1.5) ?? null;
      const local = mons.filter((e) => d(e.transform.pos, C.home) <= C.radius);
      const pool = local.length ? local : mons.filter((e) => d(e.transform.pos, C.home) <= C.radius + C.fill);
      let best = null, bs = -1e9;
      for (const e of pool) {
        const p = e.transform.pos;
        const cluster = pool.filter((o) => d(o.transform.pos, p) <= C.spinR).length;
        const full = hp(e) / hpMax(e) >= 0.98 ? 1 : 0;
        const contested = !full && cluster === 1 ? 1 : 0; // suelto y ya golpeado: probablemente de otro
        const s = cluster * 3 + full * 2 - contested * 4 - d(P, p) * 0.4;
        if (s > bs) { bs = s; best = e; }
      }
      return best ?? inner(w, P, c);
    };
  }

  C.timer = setInterval(() => {
    if (!C.on || !ai.on || ai.busy || S.uiState !== 5 || S.sceneLoading || window.__hunt?.on) return;
    const w = W(), pe = w?.playerEntity; if (!pe) return;
    // El warp a Arena 2 pide nivel 100 ("You need to be level 100 in order to warp", probado en nivel
    // 10 a 14) y el reset manda a Lorencia (MoveHome de OpenMU). Hasta 100, la ruta normal.
    if (S.playerData.level < C.minLevel) { if (C.savedSpots && ai.cfg.spots.length === 1 && ai.cfg.spots[0][0] === C.warp) { ai.cfg.spots = C.savedSpots; ai.camp = null; ai.explore = null; ai.lastWarp = 0; } return; }
    if (!(ai.cfg.spots.length === 1 && ai.cfg.spots[0][0] === C.warp)) { C.savedSpots ??= ai.cfg.allSpots ?? window.__drakSaved ?? ai.cfg.spots; ai.cfg.spots = [[C.warp, 'Arena 2 esquina', 0]]; }
    if (w.mapIndex !== C.map) {
      if (Date.now() - C.warpAt > 8000) { C.warpAt = Date.now(); ai.spot = C.warp; ai.lastWarp = Date.now(); S.warpCommandRequest(C.warp); L(`warp a Arena 2 en nivel ${S.playerData.level} (desde mapa ${w.mapIndex})`); }
      return;
    }
    if (C.warpAt && !C.arrivedLogged) { C.arrivedLogged = true; L(`en Arena 2 en nivel ${S.playerData.level}: el warp funciona`); }
    const P = pe.transform.pos, now = Date.now();
    if (ai.camp?.x !== C.home.x || ai.camp?.z !== C.home.z) ai.camp = { x: C.home.x, z: C.home.z, map: C.map, since: now, lastSeen: now, known: true };
    if (d(P, C.home) > C.radius + 3) {
      // Por los puntos de la ruta: el siguiente al más cercano (o el más cercano si todavía no llegó).
      if (!ai.target) {
        let i = 0, bd = 1e9; C.route.forEach(([x, z], k) => { const dd = d(P, { x, z }); if (dd < bd) { bd = dd; i = k; } });
        if (bd < 5 && i < C.route.length - 1) i++;
        const [x, z] = C.route[i];
        if (ai.explore?.x !== x || ai.explore?.z !== z || pe.playerMoveTo.handled) { ai.explore = { x, z, kind: 'camp-ruta' }; ai.arrivedAt = 0; ai.moveTo(pe, { x, z }); }
      }
    } else if (!ai.target) {
      // Esquina vacía: al centro de las apariciones de los últimos 3 min (o la esquina).
      const sp = C.spawns.filter((x) => now - x.t < 180000);
      const c = sp.length >= 3 ? { x: Math.round(sp.reduce((a, x) => a + x.x, 0) / sp.length), z: Math.round(sp.reduce((a, x) => a + x.z, 0) / sp.length) } : C.home;
      if (d(P, c) > 2 && (ai.explore?.x !== c.x || ai.explore?.z !== c.z)) { ai.explore = { ...c, kind: 'camp-espera' }; ai.arrivedAt = 0; ai.moveTo(pe, c); }
      ai.arrivedAt = 0; // sin "me fui por aburrido": acá se espera la reaparición
    }
    // Swell Life en la esquina.
    if (d(P, C.home) <= C.radius + 3 && now - C.swellAt > 55000 && !w.castRequest && (S.skills ?? []).some((k) => k.number === 48)) {
      // El agente vuelve a elegir su skill cada 400 ms: se le cambia el suyo un instante para que no
      // pise a Swell Life antes de que el cliente lo tire.
      C.swellAt = now; const sk = ai.cfg.skill; ai.cfg.skill = 48; S.selectSkill(48); w.castRequest = { target: pe, point: { x: P.x, y: P.z }, forced: false };
      setTimeout(() => { if (ai.cfg.skill === 48) ai.cfg.skill = sk; }, 900);
    }
    ai.camp.lastSeen = Date.now();
    // Apariciones: netId nuevo, con la vida llena, cerca de la esquina.
    for (const e of w.byNetId.values()) {
      if (!alive(e) || C.seen.has(e.netId)) continue;
      C.seen.set(e.netId, now);
      const p = e.transform.pos;
      if (d(p, C.home) <= C.radius && hp(e) / hpMax(e) >= 0.98) C.spawns.push({ t: now, x: Math.round(p.x), z: Math.round(p.z), type: e.npcType });
    }
    if (C.seen.size > 3000) C.seen = new Map([...C.seen].slice(-1500));
    if (C.spawns.length > 1000) C.spawns.splice(0, 500);
  }, 700);
  C.report = (min = 10) => {
    const since = Date.now() - min * 60000, sp = C.spawns.filter((s) => s.t >= since);
    const cells = {}; for (const s of sp) { const k = `${Math.round(s.x / 3) * 3},${Math.round(s.z / 3) * 3}`; cells[k] = (cells[k] ?? 0) + 1; }
    return { min, spawnsPerMin: +(sp.length / min).toFixed(1), top: Object.entries(cells).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  };
  C.off = () => { C.on = false; if (C.savedSpots) { ai.cfg.spots = C.savedSpots; C.savedSpots = null; } ai.camp = null; ai.explore = null; ai.lastWarp = 0; L('apagado: vuelve a la ruta normal'); };
  L('activo');
  return 'modo esquina activo: __corner.report(), __corner.off()';
})();
