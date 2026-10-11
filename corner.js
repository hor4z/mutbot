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
  const C = (window.__corner = { ROUTE: [[2, 'Lorencia', 10], [7, 'Devias 4', 20], [24, 'Arena 2', 100], [25, 'Arena 3', 200], [26, 'Arena 4', 300]], on: true, minLevel: 100, map: 83, warp: 24, home: { x: 7, z: 11 }, lorencia: { x: 134, z: 202 }, devias4: { x: 69, z: 181 }, radius: 7, deviasR: 8, sides: [{ name: 'esquina', x: 2, z: 10 }, { name: 'medio', x: 7, z: 11 }, { name: 'este', x: 12, z: 11 }], sideR: 4, dwellMs: 40000, rivalPenalty: 0.25, side: 'esquina', sideLog: [], sideStats: {}, sideAt: 0, spinR: 2.5, fill: 2, swellAt: 0,
    route: [[61, 98], [58, 72], [56, 45], [52, 28], [40, 21], [30, 11], [16, 10], [7, 11]], spawns: [], seen: new Map(), log: [], timer: null, warpAt: 0 });
  // Alcance del skill de área: Twisting Slash (DK, 41) ~2,5 tiles; Evil Spirit (DW, 9) ~5 (Melu, la
  // misma clase que los magos que lideran la esquina).
  C.spinR = ({ 9: 5, 14: 3, 38: 3.5, 41: 2.5, 42: 3 })[ai.cfg.skill] ?? 2.5;
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
      // Primero, los monstruos que le pegaron en los últimos 5 s y están a <= 15 tiles (los que atacan de
      // lejos en Arena 4 lo desgastaban mientras él esperaba en el campamento; usuario: "tiene que
      // limpiar todo, estos atacan de distancia").
      if (C?.on && !window.__hunt?.on) {
        const now = Date.now(); let ag = null, ad = 1e9;
        for (const [id, t] of C.aggro ?? []) { if (now - t > 5000) { C.aggro.delete(id); continue; } const e = w.getByNetId?.(id) ?? [...w.byNetId.values()].find((x) => (x.netId & 0x7fff) === id); if (!e || !alive(e)) continue; const dd = d(e.transform.pos, P); if (dd <= 15 && dd < ad) { ad = dd; ag = e; } }
        if (ag) return ag;
      }
      // Devias hasta el 100: solo lo que está a <= 8 tiles del campamento (usuario: "en Devias no te
      // salgas del spot muy lejos"). Sin nada cerca, esperar ahí la reaparición.
      // (lo mismo en Lorencia hasta el 20: "en Lorencia te saliste del spot")
      // (y afuera de la esquina, en Arena 2/3/4: el agente perseguía hasta 15 tiles del campamento)
      if (C?.on && ((w.mapIndex === 2 && S.playerData.level < C.minLevel && ai.camp?.map === 2) || (w.mapIndex === 0 && S.playerData.level < 20 && ai.camp?.map === 0) || (C.awayUntil && Date.now() < C.awayUntil && ai.camp?.map === w.mapIndex)) && !window.__hunt?.on) {
        const near = [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, ai.camp) <= (C.awayUntil && Date.now() < C.awayUntil ? 6 : C.deviasR));
        let best = null, bs = -1e9;
        for (const e of near) { const n = near.filter((o) => d(o.transform.pos, e.transform.pos) <= C.spinR).length; const sc = n * 3 - d(P, e.transform.pos) * 0.5; if (sc > bs) { bs = sc; best = e; } }
        // Nada cerca pero monstruos a distancia (los que atacan de lejos en Arena 4 le pegaban y Horaz
        // quedaba quieto): el más cercano a <= 12 tiles.
        if (!best) best = [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, P) <= 12).sort((a, b) => d(a.transform.pos, P) - d(b.transform.pos, P))[0] ?? null;
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
        // esquina; si no, en el spot del medio; adaptate". Se queda >= 40 s en cada una (con 20 s saltaba de este a medio con las mediciones movidas por los rivales) y después
        // elige la de mayor exp/min medida (EMA; la que no probó, optimista para probarla), dividida
        // por (1 + 0,25 × jugadores a <= 4 tiles): un rival encima pesa poco, se compite (usuario: "ganale
        // al DK en la esquina o ganá en el medio").
        const now = Date.now(), cur = C.sides.find((x) => x.name === C.side) ?? C.sides[0];
        if (now - C.sideAt < C.dwellMs) return cur;
        const others = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== w.playerEntity && !(window.__corner?.mates ?? []).includes(e.objectNameInWorld));
        const known = Object.values(C.sideStats).map((x) => x.rate).filter((x) => x > 0);
        const best = known.length ? Math.max(...known) : 1;
        const score = (sd) => { const st = C.sideStats[sd.name]; const r = st?.rate > 0 ? st.rate : best * 1.1; return r / (1 + C.rivalPenalty * others.filter((e) => d(e.transform.pos, sd) <= 4).length); };
        let pick = cur; for (const sd of C.sides) if (score(sd) > score(pick) * 1.15) pick = sd;
        C.sideAt = now;
        if (pick !== cur) { C.side = pick.name; C.sideLog.push(`${new Date().toLocaleTimeString()} → ${pick.name} (${C.sides.map((sd) => `${sd.name} ${Math.round(score(sd) / 1e6)}M`).join(', ')})`); if (C.sideLog.length > 50) C.sideLog.shift(); }
        return pick;
      })();
      // Con mucha competencia (2+ jugadores a <= 6 tiles), no caminar hacia los monstruos: cuando llega
      // ya los mataron (usuario: "zigzag con mucha competencia no sirve, no llego a pegar"). Quieto en
      // el puesto, pegar solo lo que entra en el giro.
      const crowd = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== w.playerEntity && !(window.__corner?.mates ?? []).includes(e.objectNameInWorld) && d(e.transform.pos, P) <= 6).length;
      if (crowd >= 2) return mons.filter((e) => d(e.transform.pos, P) <= C.spinR + 0.5).sort((a, b) => d(a.transform.pos, P) - d(b.transform.pos, P))[0] ?? null;
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
    // Objetivo viejo: después de un warp el cliente puede conservar la entidad del mapa anterior (a las
    // 1:37 caminó de Devias 4 (79,180) hacia un Elite Yeti de Devias 3 en (211,215)). Nada a > 25 tiles.
    if (ai.target && d(ai.target.transform.pos, pe.transform.pos) > 25) { ai.target = null; w.attackTarget = null; }
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
    // Devias (nivel 20-100): el spot lleno pegado a la llegada de Devias 4 (usuario: "tenés un spot
    // pegado lleno", "spot de arriba"). Campamento = centro del grupo más grande a la vista a <= 15
    // tiles de la llegada; no salir de ahí persiguiendo Yetis sueltos (se iba hacia el este).
    if (w.mapIndex === 2 && S.playerData.level < C.minLevel && ai.arrival?.map === 2 && !C.planB) {
      const A = ai.arrival, mons = [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, A) <= 15);
      let best = null, bn = 0;
      for (const e of mons) { const n = mons.filter((o) => d(o.transform.pos, e.transform.pos) <= 4).length; if (n > bn) { bn = n; best = e.transform.pos; } }
      // Campamento pobre (< 3 monstruos) 10 s (Melu quedó en (57,191), el "spot de arriba" del agente, con 0 monstruos):
      // ir al grupo más grande a <= 25 de la llegada, o al spot que usa Horaz, (69,181).
      const campEmpty = ai.camp?.map === 2 && [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, ai.camp) <= 10).length < 3; // < 3: con 1-2 Yetis sueltos también rinde poco
      if (campEmpty) C.campEmptySince ??= Date.now(); else C.campEmptySince = null;
      if (C.campEmptySince && Date.now() - C.campEmptySince > 10000) {
        C.campEmptySince = null;
        const far = [...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, A) <= 25);
        let fb = null, fn = 0; for (const e of far) { const n = far.filter((o) => d(o.transform.pos, e.transform.pos) <= 4).length; if (n > fn) { fn = n; fb = e.transform.pos; } }
        const to = fb && fn >= 2 ? { x: Math.round(fb.x), z: Math.round(fb.z) } : C.devias4;
        ai.camp = { ...to, map: 2, since: Date.now(), lastSeen: Date.now(), known: true }; ai.explore = { ...to, kind: 'camp' }; ai.moveTo(pe, to); L(`campamento vacío en Devias: voy a (${to.x},${to.z})`);
      }
      if (best && bn >= 3 && (!ai.camp || ai.camp.map !== 2 || d(ai.camp, best) > 4 || d(ai.camp, A) > 15)) {
        ai.camp = { x: Math.round(best.x), z: Math.round(best.z), map: 2, since: Date.now(), lastSeen: Date.now(), known: true };
        if (!ai.target) { ai.explore = { x: ai.camp.x, z: ai.camp.z, kind: 'camp' }; ai.moveTo(pe, ai.camp); }
      }
      if (ai.target && ai.camp && d(ai.target.transform.pos, ai.camp) > C.deviasR + 2) { ai.target = null; w.attackTarget = null; }
      if (!ai.target && ai.camp && d(pe.transform.pos, ai.camp) > 3 && pe.playerMoveTo.handled) { ai.explore = { x: ai.camp.x, z: ai.camp.z, kind: 'camp' }; ai.moveTo(pe, ai.camp); }
    }
    // Devias 4 lleno (3+ jugadores ajenos a <= 8 del campamento por 20 s): irse. 2026-10-11 2:08:
    // Tyuy, ZackFair, Lucy y Yatsuky en el spot de la llegada y Horaz sacaba 4M/min. Plan B: Arena 1
    // desde el 50 (warp 1); antes del 50, Devias 3. Se queda ahí hasta el 100 / 50.
    if (w.mapIndex === 2 && S.playerData.level < C.minLevel && ai.camp?.map === 2 && !C.planB) {
      const mine = new Set([S.playerData.name, ...(window.__partyAllow ?? []), window.__followMate].filter(Boolean));
      const crowd = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== pe && !mine.has(e.objectNameInWorld) && d(e.transform.pos, ai.camp) <= 8).length;
      if (crowd >= 3) C.devCrowdSince ??= Date.now(); else C.devCrowdSince = null;
      if (C.devCrowdSince && Date.now() - C.devCrowdSince > 20000) {
        C.devCrowdSince = null; const lv = S.playerData.level, alt = lv >= 50 ? [1, 'Arena', 50] : [6, 'Devias 3', 20];
        ai.cfg.spots = [C.ROUTE[0], alt]; C.planB = { until: lv >= 50 ? C.minLevel : 50 };
        ai.spot = alt[0]; ai.lastWarp = Date.now(); ai.camp = null; ai.explore = null; ai.target = null; w.attackTarget = null; ai.arrivalPending = Date.now();
        S.warpCommandRequest(alt[0]); L(`Devias 4 lleno (${crowd} jugadores): ${alt[1]}`); return;
      }
    }
    if (C.planB && S.playerData.level >= C.planB.until) C.planB = null;
    // Hasta 100: Lorencia y solo Devias 4 (Arena 1 perdía tiempo; Devias 3/2 y el plan B de Arena los
    // usaba la regla de "hambre" del agente para irse a los segundos de llegar: "se fue para abajo").
    // Ojo: asignar la ruta SOLO si cambió. Una versión vieja la reasignaba cada 0,7 s y borraba el
    // campamento y el último warp en cada vuelta: en Devias cambiaba de campamento sin parar.
    if (ai.cfg.crowdFallback?.length) { C.savedFallback = ai.cfg.crowdFallback; ai.cfg.crowdFallback = []; }
    if (S.playerData.level < C.minLevel) { if (!C.planB && JSON.stringify(ai.cfg.spots) !== JSON.stringify(C.ROUTE)) { ai.cfg.spots = C.ROUTE; ai.camp = null; ai.explore = null; ai.lastWarp = 0; } return; }
    // Esquina llena: con 3 o más jugadores cerca y el último minuto rindiendo menos que el mejor spot
    // de Arena 3/4, irse ahí 5 min y volver a mirar. 2026-10-11: con LeanLive, Yatsuky,
    // Nancho y Pachegas encima, Horaz sacaba 16M/min (usuario: "estamos molestando bastante").
    const nowA = Date.now();
    // Afuera (Arena 2 otro spot / 3 / 4): si hay un jugador farmeando a <= 6 tiles del campamento,
    // pasar al mejor spot medido de ese mapa sin nadie a <= 8 (2026-10-11: un DK en el spot de Horaz en
    // Arena 4; usuario: "no lo dejes ganarme"). Competencia limpia: no se le roban los monstruos.
    if (C.awayUntil && nowA < C.awayUntil) {
      // Al cruzar 200/300 estando afuera, subir de Arena: se fue a Arena 3 en nivel 2xx y en 305 seguía
      // ahí con 103M/min (Arena 4 rindió hasta 881M).
      const want = S.playerData.level >= 300 ? 26 : S.playerData.level >= 200 ? 25 : 24;
      if (!(C.yieldAt && nowA - C.yieldAt < 180000) && ai.cfg.spots.length === 1 && ai.cfg.spots[0][0] !== want && want > ai.cfg.spots[0][0]) { // (cediendo a un compañero, no volver a su Arena)
        ai.cfg.spots = C.ROUTE.filter((x) => x[0] === want); ai.spot = want; ai.lastWarp = nowA; ai.camp = null; ai.explore = null; ai.target = null; w.attackTarget = null; ai.arrivalPending = nowA;
        S.warpCommandRequest(want); L(`nivel ${S.playerData.level}: paso a ${want === 26 ? 'Arena 4' : 'Arena 3'}`); return;
      }
      if (nowA - (C.freeAt ?? 0) > 15000 && ai.camp && ai.camp.map === w.mapIndex) {
        C.freeAt = nowA;
        const others = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== pe);
        if (others.some((e) => d(e.transform.pos, ai.camp) <= 6)) {
          const alt = (ai.campHist?.[w.mapIndex] ?? []).filter((k) => !k.seed && k.rate > 0 && d(k, ai.camp) > 10 && !others.some((e) => d(e.transform.pos, k) <= 8)).sort((a, b) => b.rate - a.rate)[0];
          // Pelear el spot de igual a igual: solo se cambia si el libre rindió más que lo que este spot
          // está dando ahora con el otro jugador (último minuto). Si no, se queda y compite.
          const nowRate = ai.expLog.filter((x) => x.t > nowA - 60000).reduce((a, x) => a + x.added, 0);
          if (alt && alt.rate <= nowRate) { if (!C.contestLogged) { C.contestLogged = true; L(`spot compartido: me quedo (${Math.round(nowRate / 1e6)}M/min acá contra ${Math.round(alt.rate / 1e6)}M del libre)`); } }
          else if (alt) { C.contestLogged = false; ai.camp = { x: alt.x, z: alt.z, map: w.mapIndex, since: nowA, lastSeen: nowA, known: true }; ai.target = null; w.attackTarget = null; ai.explore = { x: alt.x, z: alt.z, kind: 'camp' }; ai.moveTo(pe, alt); L(`spot ocupado: paso a (${alt.x},${alt.z}) ~${Math.round(alt.rate / 1e6)}M/min sin nadie`); }
        }
      }
      return;
    }
    // Cerca del reset no vale la pena volver: el camino a la esquina lleva ~1 min (a las 1:25 dejó
    // Arena 4 en nivel 385 para encontrarla llena otra vez).
    if (C.awayUntil && nowA >= C.awayUntil && S.playerData.level >= 360) C.awayUntil = nowA + 60000;
    if (C.awayUntil && nowA >= C.awayUntil) { C.awayUntil = 0; L('vuelvo a mirar la esquina'); }
    if (w.mapIndex === C.map && d(pe.transform.pos, C.home) <= C.radius + 3) {
      const rivals = [...w.byNetId.values()].filter((e) => e.heroState !== undefined && e !== pe && !C.mates.includes(e.objectNameInWorld) && d(e.transform.pos, C.home) <= 15).length;
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
    // Buff propio en la esquina: Swell Life (48, DK) o Mana Shield (16, mago: lo que usan LeanLive y
    // Yatsuky; Melu con ~5.900 de vida tomaba pociones cada segundo frente a los Drakan).
    const buffSkill = [48, 16].find((k) => (S.skills ?? []).some((x) => x.number === k));
    if (d(P, C.home) <= C.radius + 3 && now - C.swellAt > 55000 && !w.castRequest && buffSkill != null) {
      // El agente vuelve a elegir su skill cada 400 ms: se le cambia el suyo un instante para que no
      // pise a Swell Life antes de que el cliente lo tire.
      C.swellAt = now; const sk = ai.cfg.skill; ai.cfg.skill = buffSkill; S.selectSkill(buffSkill); w.castRequest = { target: pe, point: { x: P.x, y: P.z }, forced: false };
      setTimeout(() => { if (ai.cfg.skill === buffSkill) ai.cfg.skill = sk; }, 900);
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
  // Teleport de viaje (magos con skill 6, Melu): solo para pasar una pared (entrar/salir de corrales).
  if (window.__corner?.tpTimer) clearInterval(window.__corner.tpTimer);
  C.tpTimer = setInterval(() => {
    if (!C.on || !ai.on || ai.busy || ai.looting || ai.target || S.uiState !== 5 || S.sceneLoading || window.__defense?.engaged) return;
    if (!(S.skills ?? []).some((k) => k.number === 6)) return;
    const w = W(), pe = w?.playerEntity, dst = ai.explore; if (!pe || !dst || w.castRequest) return;
    const P = pe.transform.pos, dd = d(P, dst); if (dd <= 3 || Date.now() - (C.tpAt ?? 0) < 2000) return;
    // Solo para entrar o salir de los corrales (usuario: "si no, es más lento que volar"): teleport
    // únicamente si en los próximos 7 tiles en línea recta hay una pared; con camino libre, caminar.
    const blocked = (() => { for (let t = 1; t <= Math.min(7, dd); t++) { const x = Math.round(P.x + (dst.x - P.x) * t / dd), z = Math.round(P.z + (dst.z - P.z) * t / dd); if (w.isWalkable?.(x, z) === false) return true; } return false; })();
    if (!blocked) return;
    const pd = S.playerData; if ((pd.currentMana ?? 100) < 30) return;
    const k = 7 / dd, x = Math.round(P.x + (dst.x - P.x) * k), z = Math.round(P.z + (dst.z - P.z) * k);
    if (w.isWalkable?.(x, z) === false) return;
    if ([...w.byNetId.values()].filter((e) => alive(e) && d(e.transform.pos, { x, z }) <= 3).length >= 3) return; // no caer en medio de un grupo
    C.tpAt = Date.now(); const sk = ai.cfg.skill; ai.cfg.skill = 6; S.selectSkill(6); w.castRequest = { target: null, point: { x, y: z }, forced: false }; C.tps = (C.tps ?? 0) + 1;
    setTimeout(() => { if (ai.cfg.skill === 6) ai.cfg.skill = sk; }, 900);
  }, 300);
  // Quién le pega a Horaz: ObjectAnimation (C1 09 18 [atacante] [dir] [anim] [objetivo]) y
  // SkillAnimation (C3 09 19 [skill] [atacante] [objetivo]) con objetivo = este personaje.
  C.aggro = new Map();
  if (!window.__cornerAggroHooked) {
    const bytes = (raw) => (raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw.buffer ?? raw));
    const me = () => (W()?.playerEntity?.netId ?? -1) & 0x7fff;
    const mark = (id) => { const C = window.__corner; if (!C) return; for (const e of W()?.byNetId?.values?.() ?? []) if ((e.netId & 0x7fff) === id) { if (ai.isMonster(e)) C.aggro.set(e.netId, Date.now()); break; } };
    __eventBus.on('ObjectAnimation', (raw) => { try { const u = bytes(raw); if (u[2] === 0x18 && u.length >= 9 && (((u[7] << 8) | u[8]) & 0x7fff) === me()) mark(((u[3] << 8) | u[4]) & 0x7fff); } catch {} });
    for (const n of ['SkillAnimation', 'SkillAnimation075', 'SkillAnimation095']) __eventBus.on(n, (raw) => { try { const u = bytes(raw); if (u[2] === 0x19 && u.length >= 9 && (((u[7] << 8) | u[8]) & 0x7fff) === me()) mark(((u[5] << 8) | u[6]) & 0x7fff); } catch {} });
    window.__cornerAggroHooked = true;
  }
  // Personajes propios (2026-10-11, usuario: "nunca puede pasar que luchen los dos por el spot de abajo;
  // si necesitan pelear ahí, hagan party"). Cada pestaña publica su posición; si los dos están en la
  // esquina de Arena 2, el primero por orden alfabético invita y el otro acepta. No se cuentan como
  // rivales entre ellos. Si 60 s no coinciden en la esquina, el que aceptó sale del grupo (la party
  // reparte la exp: a Horaz le subió el ciclo de ~9 a ~13,6 min).
  const me = S.playerData?.name;
  C.mates = window.__cornerMates ?? ({ Horaz: ['Melu'], Melu: ['Horaz'] })[me] ?? [];
  window.__partyAllow = [...new Set([...(window.__partyAllow ?? []), ...C.mates])];
  const send = (b) => S.sendToGS(new DataView(Uint8Array.from(b).buffer));
  if (!window.__cornerPartyHooked) {
    __eventBus.on('PartyRequest', (raw) => { try {
      const u = raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw.buffer ?? raw);
      const id = ((u[3] << 8) | u[4]) & 0x7fff; let from = null; for (const e of W().byNetId.values()) if ((e.netId & 0x7fff) === id) from = e.objectNameInWorld;
      if ((window.__corner?.mates ?? []).includes(from)) setTimeout(() => send([0xc1, 0x06, 0x41, 0x01, id >> 8, id & 0xff]), 400);
    } catch {} });
    __eventBus.on('PartyList', () => { window.__inParty = true; });
    __eventBus.on('RemovePartyMember', () => { window.__inParty = false; });
    window.__cornerPartyHooked = true;
  }
  if (window.__corner?.mateTimer) clearInterval(window.__corner.mateTimer);
  C.mateTimer = setInterval(() => {
    const w = W(), pe = w?.playerEntity; if (!pe || S.uiState !== 5 || !me) return;
    const P = pe.transform.pos, now = Date.now();
    try { localStorage.setItem(`mubot:pos:${me}`, JSON.stringify({ map: w.mapIndex, x: Math.round(P.x), z: Math.round(P.z), level: S.playerData.level, resets: S.playerData.resets ?? 0, at: now })); } catch {}
    const inCorner = (q) => q && q.map === C.map && d(q, C.home) <= 20;
    // Prioridad (usuario: "por ningún spot puede luchar Melu con Horaz; Horaz por cantidad de resets
    // tiene prioridad"): el de menos resets cede. Si el otro está en su mapa a <= 20 tiles, se va 3 min
    // al mapa más alto que le dé el nivel y donde el otro no esté.
    for (const m of C.mates) {
      let q = null; try { q = JSON.parse(localStorage.getItem(`mubot:pos:${m}`) || 'null'); } catch {}
      if (!q || now - q.at > 10000 || window.__follow?.timers?.length) continue;
      const mineR = S.playerData.resets ?? 0, theirs = q.resets ?? 0;
      const iYield = theirs > mineR || (theirs === mineR && me > m);
      if (!iYield || q.map !== w.mapIndex || d(q, P) > 20 || ai.busy || (C.yieldAt && now - C.yieldAt < 15000)) continue;
      const lv = S.playerData.level, opts = [[26, 85, 300], [25, 84, 200], [24, 83, 100], [7, 2, 20], [6, 2, 20], [2, 0, 0]];
      const to = opts.find(([, mp, req]) => lv >= req && mp !== q.map);
      if (!to) continue;
      C.yieldAt = now; C.awayUntil = now + 180000; C.inCornerSince = null;
      ai.cfg.spots = [[to[0], `cedo a ${m}`, 0]]; ai.spot = to[0]; ai.lastWarp = now; ai.camp = null; ai.explore = null; ai.target = null; w.attackTarget = null; ai.arrivalPending = now;
      S.warpCommandRequest(to[0]); L(`${m} (${theirs} resets) está acá: le dejo el spot, voy al warp ${to[0]}`);
      return;
    }
    let together = false;
    for (const m of C.mates) {
      let q = null; try { q = JSON.parse(localStorage.getItem(`mubot:pos:${m}`) || 'null'); } catch {}
      if (!q || now - q.at > 10000) continue;
      if (inCorner(q) && inCorner({ map: w.mapIndex, x: P.x, z: P.z })) {
        together = true; C.togetherAt = now;
        if (!window.__inParty && me < m && now - (C.invAt ?? 0) > 20000) {
          for (const e of w.byNetId.values()) if (e.objectNameInWorld === m) { C.invAt = now; const id = e.netId & 0x7fff; send([0xc1, 0x05, 0x40, id >> 8, id & 0xff]); L(`${m} también en la esquina: party`); break; }
        }
      }
    }
    if (!together && window.__inParty && C.mates.length && me > C.mates[0] && C.togetherAt && now - C.togetherAt > 60000 && !window.__follow?.timers?.length) {
      C.togetherAt = 0; window.__inParty = false; send([0xc1, 0x04, 0x43, 0x01]); L('ya no coincidimos en la esquina: salgo de la party');
    }
  }, 1000);
  C.report = (min = 10) => {
    const since = Date.now() - min * 60000, sp = C.spawns.filter((s) => s.t >= since);
    const cells = {}; for (const s of sp) { const k = `${Math.round(s.x / 3) * 3},${Math.round(s.z / 3) * 3}`; cells[k] = (cells[k] ?? 0) + 1; }
    return { min, spawnsPerMin: +(sp.length / min).toFixed(1), top: Object.entries(cells).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  };
  C.off = () => { C.on = false; if (C.savedFallback) ai.cfg.crowdFallback = C.savedFallback; if (C.savedSpots) { ai.cfg.spots = C.savedSpots; C.savedSpots = null; } ai.camp = null; ai.explore = null; ai.lastWarp = 0; L('apagado: vuelve a la ruta normal'); };
  L('activo');
  return 'modo esquina activo: __corner.report(), __corner.off()';
})();
