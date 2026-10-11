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
//    pelear solo dentro de 7 (+2) tiles de la esquina: persiguiendo Deathvim Knights hasta (22,9) perdía
//    los Drakan que reaparecían (usuario: "al moverte tan lejos pierdes").
//  - Swell Life (48) cada ~55 s mientras está en la esquina: más vida contra 12-18 Drakan.
//  - Anota cada aparición en la esquina (posición y hora) en `__corner.spawns`, para pararse donde
//    reaparecen y medir cada cuánto (`__corner.report()`).
(() => {
  const ai = window.__ai, S = __store, W = () => __world;
  if (!ai) return 'primero browser-agent.js';
  if (window.__corner?.timer) clearInterval(window.__corner.timer);
  const C = (window.__corner = { ROUTE: [[2, 'Lorencia', 10], [7, 'Devias 4', 20], [6, 'Devias 3', 20], [5, 'Devias 2', 20], [24, 'Arena 2', 100], [25, 'Arena 3', 200], [26, 'Arena 4', 300]], on: true, minLevel: 100, map: 83, warp: 24, home: { x: 7, z: 11 }, lorencia: { x: 134, z: 202 }, radius: 7, deviasR: 8, sides: [{ name: 'esquina', x: 2, z: 10 }, { name: 'medio', x: 7, z: 11 }, { name: 'este', x: 12, z: 11 }], sideR: 4, side: 'esquina', sideLog: [], sideStats: {}, sideAt: 0, spinR: 2.5, fill: 2, swellAt: 0,
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
      // Devias hasta el 100: solo lo que está a <= 8 tiles del campamento (usuario: "en Devias no te
      // salgas del spot muy lejos"). Sin nada cerca, esperar ahí la reaparición.
      // (lo mismo en Lorencia hasta el 20: "en Lorencia te saliste del spot")
      if (C?.on && ((w.mapIndex === 2 && S.playerData.level < C.minLevel && ai.camp?.map === 2) || (w.mapIndex === 0 && S.playerData.level < 20 && ai.camp?.map === 0)) && !window.__hunt?.on) {
        const near = [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, ai.camp) <= C.deviasR);
        let best = null, bs = -1e9;
        for (const e of near) { const n = near.filter((o) => d(o.transform.pos, e.transform.pos) <= C.spinR).length; const sc = n * 3 - d(P, e.transform.pos) * 0.5; if (sc > bs) { bs = sc; best = e; } }
        return best;
      }
      if (!C?.on || w.mapIndex !== C.map || window.__hunt?.on || (C.awayUntil && Date.now() < C.awayUntil)) return inner(w, P, c);
      const mons = [...w.byNetId.values()].filter(alive);
      // Camino a la esquina: derecho, sin pelear lo que hay en el camino (zigzagueaba con los Elite
      // Skeleton de (50,80) y tardaba minutos). Solo lo que bloquea el paso (<= 1,5 tiles).
      if (d(P, C.home) > C.radius + 3) return mons.find((e) => d(e.transform.pos, P) <= 1.5) ?? null;
      // Dos lados (medido 2026-10-11): oeste (1-4, 9-11) y este (11-13, 10-12), a ~10 tiles. Elegir
      // todo el campo hacía ir y venir de un lado al otro. Regla del usuario: "si el enemigo ataca un
      // lado, nosotros el otro; si cambia, cambiamos". Lado = el que no tiene jugadores a <= 5; si los
      // dos están igual, quedarse en el actual salvo que el otro tenga el doble de monstruos (+2).
      const side = (() => {
        // Posición: esquina (2,10), medio (7,11) o este (12,11). Usuario: "si conviene, foco en la
        // esquina; si no, en el spot del medio; adaptate". Se queda >= 20 s en cada una y después
        // elige la de mayor exp/min medida (EMA; la que no probó, optimista para probarla), dividida
        // por (1 + 0,5 × jugadores a <= 4 tiles de ese punto).
        const now = Date.now(), cur = C.sides.find((x) => x.name === C.side) ?? C.sides[0];
        if (now - C.sideAt < 20000) return cur;
        const others = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== w.playerEntity);
        const known = Object.values(C.sideStats).map((x) => x.rate).filter((x) => x > 0);
        const best = known.length ? Math.max(...known) : 1;
        const score = (sd) => { const st = C.sideStats[sd.name]; const r = st?.rate > 0 ? st.rate : best * 1.1; return r / (1 + 0.5 * others.filter((e) => d(e.transform.pos, sd) <= 4).length); };
        let pick = cur; for (const sd of C.sides) if (score(sd) > score(pick) * 1.15) pick = sd;
        C.sideAt = now;
        if (pick !== cur) { C.side = pick.name; C.sideLog.push(`${new Date().toLocaleTimeString()} → ${pick.name} (${C.sides.map((sd) => `${sd.name} ${Math.round(score(sd) / 1e6)}M`).join(', ')})`); if (C.sideLog.length > 50) C.sideLog.shift(); }
        return pick;
      })();
      const sideMons = mons.filter((e) => d(e.transform.pos, side) <= C.sideR);
      const local = sideMons.length ? sideMons : mons.filter((e) => d(e.transform.pos, C.home) <= C.radius && d(e.transform.pos, P) <= 4);
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
    // (la ruta completa también si se recargó este archivo: C.savedSpots arranca vacío)
    // Lorencia (nivel 10-20, después del reset): directo al grupo de Lich (134,202), al salir derecho
    // del pueblo (atlas de Melu: 35 Lich vistos ahí; (132,193) medido 207k/min contra 47k de (149,171),
    // que elegía por estar más cerca). Usuario: "hacés el peor
    // recorrido en Lorencia".
    if (w.mapIndex === 0 && S.playerData.level < 20 && (ai.camp?.x !== C.lorencia.x || ai.camp?.z !== C.lorencia.z)) {
      ai.camp = { ...C.lorencia, map: 0, since: Date.now(), lastSeen: Date.now(), known: true };
      if (!ai.target) { ai.explore = { ...C.lorencia, kind: 'camp' }; ai.moveTo(pe, C.lorencia); }
    }
    if (w.mapIndex === 0 && S.playerData.level < 20 && ai.camp?.map === 0) {
      if (ai.target && d(ai.target.transform.pos, ai.camp) > C.deviasR + 2) { ai.target = null; w.attackTarget = null; }
      if (!ai.target && d(pe.transform.pos, ai.camp) > 3 && pe.playerMoveTo.handled) { ai.explore = { x: ai.camp.x, z: ai.camp.z, kind: 'camp' }; ai.moveTo(pe, ai.camp); }
    }
    // Hasta 100: la ruta del usuario con Arena 1 desde nivel 50 (faltaba: se quedaba con los Yetis de
    // Devias, "muy esparcidos", del 20 al 100).
    // Devias (nivel 20-100): el spot lleno pegado a la llegada de Devias 4 (usuario: "tenés un spot
    // pegado lleno", "spot de arriba"). Campamento = centro del grupo más grande a la vista a <= 15
    // tiles de la llegada; no salir de ahí persiguiendo Yetis sueltos (se iba hacia el este).
    if (w.mapIndex === 2 && S.playerData.level < C.minLevel && ai.arrival) {
      const A = ai.arrival, mons = [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, A) <= 15);
      let best = null, bn = 0;
      for (const e of mons) { const n = mons.filter((o) => d(o.transform.pos, e.transform.pos) <= 4).length; if (n > bn) { bn = n; best = e.transform.pos; } }
      if (best && bn >= 3 && (!ai.camp || ai.camp.map !== 2 || d(ai.camp, best) > 4 || d(ai.camp, A) > 15)) {
        ai.camp = { x: Math.round(best.x), z: Math.round(best.z), map: 2, since: Date.now(), lastSeen: Date.now(), known: true };
        if (!ai.target) { ai.explore = { x: ai.camp.x, z: ai.camp.z, kind: 'camp' }; ai.moveTo(pe, ai.camp); }
      }
      if (ai.target && ai.camp && d(ai.target.transform.pos, ai.camp) > C.deviasR + 2) { ai.target = null; w.attackTarget = null; }
      if (!ai.target && ai.camp && d(pe.transform.pos, ai.camp) > 3 && pe.playerMoveTo.handled) { ai.explore = { x: ai.camp.x, z: ai.camp.z, kind: 'camp' }; ai.moveTo(pe, ai.camp); }
    }
    if (S.playerData.level < C.minLevel) { if (!ai.cfg.spots.some((x) => x[0] === 1)) { ai.cfg.spots = C.ROUTE; ai.camp = null; ai.explore = null; ai.lastWarp = 0; } return; }
    // Esquina llena: con 3 o más jugadores cerca y el último minuto rindiendo menos que el mejor spot
    // de Arena 3/4, irse ahí 5 min y volver a mirar. 2026-10-11: con LeanLive, Yatsuky,
    // Nancho y Pachegas encima, Horaz sacaba 16M/min (usuario: "estamos molestando bastante").
    const nowA = Date.now();
    // Afuera (Arena 2 otro spot / 3 / 4): si hay un jugador farmeando a <= 6 tiles del campamento,
    // pasar al mejor spot medido de ese mapa sin nadie a <= 8 (2026-10-11: un DK en el spot de Horaz en
    // Arena 4; usuario: "no lo dejes ganarme"). Competencia limpia: no se le roban los monstruos.
    if (C.awayUntil && nowA < C.awayUntil) {
      if (nowA - (C.freeAt ?? 0) > 15000 && ai.camp && ai.camp.map === w.mapIndex) {
        C.freeAt = nowA;
        const others = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== pe);
        if (others.some((e) => d(e.transform.pos, ai.camp) <= 6)) {
          const alt = (ai.campHist?.[w.mapIndex] ?? []).filter((k) => !k.seed && k.rate > 0 && d(k, ai.camp) > 10 && !others.some((e) => d(e.transform.pos, k) <= 8)).sort((a, b) => b.rate - a.rate)[0];
          if (alt) { ai.camp = { x: alt.x, z: alt.z, map: w.mapIndex, since: nowA, lastSeen: nowA, known: true }; ai.target = null; w.attackTarget = null; ai.explore = { x: alt.x, z: alt.z, kind: 'camp' }; ai.moveTo(pe, alt); L(`spot ocupado: paso a (${alt.x},${alt.z}) ~${Math.round(alt.rate / 1e6)}M/min sin nadie`); }
        }
      }
      return;
    }
    // Cerca del reset no vale la pena volver: el camino a la esquina lleva ~1 min (a las 1:25 dejó
    // Arena 4 en nivel 385 para encontrarla llena otra vez).
    if (C.awayUntil && nowA >= C.awayUntil && S.playerData.level >= 360) C.awayUntil = nowA + 60000;
    if (C.awayUntil && nowA >= C.awayUntil) { C.awayUntil = 0; L('vuelvo a mirar la esquina'); }
    if (w.mapIndex === C.map && d(pe.transform.pos, C.home) <= C.radius + 3) {
      const rivals = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== pe && d(e.transform.pos, C.home) <= 15).length;
      const rate = ai.expLog.filter((x) => x.t > nowA - 60000).reduce((a, x) => a + x.added, 0);
      C.inCornerSince ??= nowA;
      const alt = S.playerData.level >= 300 ? 26 : S.playerData.level >= 200 ? 25 : 24; // 24: Arena 2 fuera de la esquina
      const altRate = Math.max(ai.spotScore?.[alt] ?? 0, 60e6);
      if (rivals >= 3 && nowA - C.inCornerSince > 60000 && rate < altRate * 0.8) {
        C.awayUntil = nowA + 300000; C.inCornerSince = null;
        ai.cfg.spots = C.ROUTE.filter((x) => x[0] === alt); ai.spot = alt; ai.lastWarp = nowA; ai.camp = null; ai.explore = null; ai.target = null; w.attackTarget = null; ai.arrivalPending = nowA;
        S.warpCommandRequest(alt); L(`esquina llena (${rivals} jugadores, ${Math.round(rate / 1e6)}M en el último min): ${['Arena 2 (otro spot)', 'Arena 3', 'Arena 4'][alt - 24]} por 3 min`);
        return;
      }
    } else C.inCornerSince = null;
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
        // Índice que solo avanza (antes elegía "el más cercano" y oscilaba entre los dos primeros
        // puntos). Se recalcula al aparecer de nuevo en el mapa (warp o muerte): el más cercano.
        if (C.routeIdx == null || now - (C.routeAt ?? 0) > 20000) { let bd = 1e9; C.route.forEach(([x, z], k) => { const dd = d(P, { x, z }); if (dd < bd) { bd = dd; C.routeIdx = k; } }); }
        C.routeAt = now;
        if (d(P, { x: C.route[C.routeIdx][0], z: C.route[C.routeIdx][1] }) < 4 && C.routeIdx < C.route.length - 1) C.routeIdx++;
        const i = C.routeIdx;
        const [x, z] = C.route[i];
        if (ai.explore?.x !== x || ai.explore?.z !== z || pe.playerMoveTo.handled) { ai.explore = { x, z, kind: 'camp-ruta' }; ai.arrivedAt = 0; ai.moveTo(pe, { x, z }); }
      }
    } else if (!ai.target) {
      // Esquina vacía: elegir entre los focos de reaparición (celdas de 3x3 con >= 3 apariciones en los
      // últimos 5 min). Medido 2026-10-11: dos focos, (12,12) y (1-3,10-12), y un jugador pegando fijo
      // en uno (usuario: "primero ganarle a ese los monstruos y luego subir, o viceversa"). Puntaje:
      // el foco cuya próxima tanda se espera antes (última aparición + intervalo medio), con castigo
      // por cada otro jugador parado a <= 3 tiles (ese foco lo pelea alguien que ya está encima).
      const sp = C.spawns.filter((x) => now - x.t < 300000), cells = {};
      for (const x of sp) { const k = `${Math.round(x.x / 3) * 3},${Math.round(x.z / 3) * 3}`; const c = (cells[k] ??= { n: 0, x: 0, z: 0, ts: [] }); c.n++; c.x += x.x; c.z += x.z; c.ts.push(x.t); }
      const players = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== pe);
      const foci = Object.values(cells).filter((c) => c.n >= 3).map((c) => {
        const at = { x: Math.round(c.x / c.n), z: Math.round(c.z / c.n) };
        // tandas: apariciones separadas por > 3 s
        const waves = []; for (const t of c.ts.sort((a, b) => a - b)) if (!waves.length || t - waves[waves.length - 1] > 3000) waves.push(t);
        const gap = waves.length >= 2 ? (waves[waves.length - 1] - waves[0]) / (waves.length - 1) : 30000;
        const next = waves[waves.length - 1] + gap - now;
        const rivals = players.filter((e) => d(e.transform.pos, at) <= 3).length;
        return { ...at, next, rivals, score: Math.max(next, -5000) + rivals * 15000 + d(P, at) * 300 };
      }).sort((a, b) => a.score - b.score);
      C.foci = foci.map((f) => ({ x: f.x, z: f.z, nextS: Math.round(f.next / 1000), rivals: f.rivals }));
      const sd = C.sides.find((x) => x.name === C.side); const c = sd ? { x: sd.x, z: sd.z } : foci[0] ? { x: foci[0].x, z: foci[0].z } : C.home;
      if (d(P, c) > 0.8 && (ai.explore?.x !== c.x || ai.explore?.z !== c.z)) { ai.explore = { ...c, kind: 'camp-espera' }; ai.arrivedAt = 0; ai.moveTo(pe, c); }
      ai.arrivedAt = 0; // sin "me fui por aburrido": acá se espera la reaparición
    }
    // Exp por posición (para elegir esquina / medio / este): la exp de este tick se le anota a la
    // posición elegida si Horaz está a <= 4 tiles de ella.
    { const sd = C.sides.find((x) => x.name === C.side); const exp = ai.expLog.filter((x) => x.t > (C.statAt ?? now)).reduce((a, x) => a + x.added, 0); const dt = now - (C.statAt ?? now); C.statAt = now;
      if (sd && dt > 0 && d(P, sd) <= 4) { const st = (C.sideStats[sd.name] ??= { exp: 0, ms: 0, rate: 0 }); st.exp += exp; st.ms += dt; if (st.ms >= 15000) { const r = st.exp / st.ms * 60000; st.rate = st.rate ? st.rate * 0.6 + r * 0.4 : r; st.exp = 0; st.ms = 0; } } }
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
  // Primer golpe: cada 100 ms, si hay un monstruo dentro del giro y no hay un skill pendiente, tirarlo
  // ya (el agente revisa cada 400 ms y el mago de al lado borra la tanda en ~1 s).
  if (window.__corner?.fast) clearInterval(window.__corner.fast);
  C.fast = setInterval(() => {
    if (!C.on || !ai.on || ai.busy || ai.looting || S.uiState !== 5 || S.sceneLoading || window.__hunt?.on || window.__defense?.engaged || (C.awayUntil && Date.now() < C.awayUntil)) return;
    const w = W(), pe = w?.playerEntity; if (!pe || w.mapIndex !== C.map || w.castRequest) return;
    const P = pe.transform.pos; if (d(P, C.home) > C.radius + C.fill) return;
    let best = null, bn = 0;
    for (const e of w.byNetId.values()) { if (!alive(e) || d(e.transform.pos, P) > C.spinR + 0.5) continue; const n = [...w.byNetId.values()].filter((o) => alive(o) && d(o.transform.pos, e.transform.pos) <= C.spinR).length; if (n > bn) { bn = n; best = e; } }
    if (!best) return;
    if (S.currentSkill !== ai.cfg.skill) S.selectSkill(ai.cfg.skill);
    const tp = best.transform.pos; w.castRequest = { target: best, point: { x: tp.x, y: tp.z }, forced: false }; C.fastCasts = (C.fastCasts ?? 0) + 1;
  }, 100);
  C.report = (min = 10) => {
    const since = Date.now() - min * 60000, sp = C.spawns.filter((s) => s.t >= since);
    const cells = {}; for (const s of sp) { const k = `${Math.round(s.x / 3) * 3},${Math.round(s.z / 3) * 3}`; cells[k] = (cells[k] ?? 0) + 1; }
    return { min, spawnsPerMin: +(sp.length / min).toFixed(1), top: Object.entries(cells).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  };
  C.off = () => { C.on = false; if (C.savedSpots) { ai.cfg.spots = C.savedSpots; C.savedSpots = null; } ai.camp = null; ai.explore = null; ai.lastWarp = 0; L('apagado: vuelve a la ruta normal'); };
  L('activo');
  return 'modo esquina activo: __corner.report(), __corner.off()';
})();
