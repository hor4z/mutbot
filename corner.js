// Modo esquina (2026-10-11): el circuito de los primeros del ranking (LeanLive, Yatsuky, Soul
// Masters). Ellos aparecen en Arena 2 en nivel bajo (cómo llegan antes del 100 no se sabe todavía) y van (warp 24) y caminan a la esquina de arriba a la izquierda
// (5,11), donde se juntan 12-18 Gaint Drakan (nivel 100, 50.000 de vida). Horaz ahí: ~574M exp/min
// en nivel 300 contra ~116M de su mejor spot de antes.
//
// Qué hace (se carga después de browser-agent.js; `__corner.on = false` lo apaga):
//  - Fuera de Arena 2 (después del reset o de morir), warp 24 y campamento fijo en la esquina.
//  - Objetivo: el monstruo que deja más monstruos dentro del giro de Twisting Slash (2,5 tiles), con
//    preferencia por los que tienen la vida llena (nadie les pega: en MU la exp va según el daño) y
//    sin perseguir a uno suelto que ya está bajando otro jugador.
//  - Esquina vacía: pelear lo más cercano a <= 15 tiles (Phantom Knight, Deathvim Knight) y volver.
//  - Anota cada aparición en la esquina (posición y hora) en `__corner.spawns`, para pararse donde
//    reaparecen y medir cada cuánto (`__corner.report()`).
(() => {
  const ai = window.__ai, S = __store, W = () => __world;
  if (!ai) return 'primero browser-agent.js';
  if (window.__corner?.timer) clearInterval(window.__corner.timer);
  const C = (window.__corner = { on: true, minLevel: 100, map: 83, warp: 24, home: { x: 7, z: 11 }, radius: 12, spinR: 2.5, fill: 15, spawns: [], seen: new Map(), log: [], timer: null, warpAt: 0 });
  const L = (m) => { C.log.push(new Date().toLocaleTimeString() + ' ' + m); if (C.log.length > 200) C.log.shift(); ai.L('ESQUINA: ' + m); };
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const hp = (e) => e.attributeSystem?.getValue?.('currentHealth') ?? 0;
  const hpMax = (e) => e.attributeSystem?.getValue?.('maximumHealth') || hp(e) || 1;
  const alive = (e) => e && !e.dying && ai.isMonster(e) && hp(e) > 0;

  if (!ai.cornerWrapped) {
    const inner = ai.pickTarget;
    ai.pickTarget = (w, P, c) => {
      const C = window.__corner;
      if (!C?.on || w.mapIndex !== C.map || window.__hunt?.on) return inner(w, P, c);
      const mons = [...w.byNetId.values()].filter(alive);
      const local = mons.filter((e) => d(e.transform.pos, C.home) <= C.radius);
      const pool = local.length ? local : mons.filter((e) => d(e.transform.pos, P) <= C.fill);
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
    ai.cornerWrapped = true;
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
    if (ai.camp?.x !== C.home.x || ai.camp?.z !== C.home.z) {
      ai.camp = { x: C.home.x, z: C.home.z, map: C.map, since: Date.now(), lastSeen: Date.now(), known: true };
      if (!ai.target) { ai.explore = { ...C.home, kind: 'camp' }; ai.moveTo(pe, C.home); }
    }
    ai.camp.lastSeen = Date.now();
    // Apariciones: netId nuevo, con la vida llena, cerca de la esquina.
    const now = Date.now();
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
