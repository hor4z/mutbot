/**
 * Modo cazador: invasión dorada (todas las horas a los :50, 15 min).
 * Se carga después de browser-agent.js y tuner.js. Con `__hunt.auto = true` caza solo (por defecto
 * NO: el usuario quiere practicar búsqueda y caza supervisadas antes de meterla en la rutina):
 *
 *  - Lee el paquete propio 0xFD (InvasionMonsters): estado, total y vivos POR MAPA. Así sabe a qué
 *    mapa ir y cuándo cortar, sin depender del panel (que mostró "Noria" con los dragones en Devias).
 *  - Arranca si hay invasión, Horaz está en la parte baja del ciclo (nivel < huntMaxLevel, donde un
 *    Golden Goblin vale muchísimo: 18 → 90 en 5 min el 2026-10-10) y algún mapa al alcance tiene
 *    >= huntMinAlive vivos. Elige el mapa por vivos × lo que aprendió de cada mapa (en Noria casi
 *    nadie caza; en Devias los matan en minutos).
 *  - Barre el mapa en celdas de 25 tiles, empezando por donde YA vio dorados (memoria
 *    `mubot-gold:<pj>`, por mapa y celda), y ataca primero cualquier dorado a la vista.
 *    Pelea los comunes a <= 3 tiles (si los ignora lo rodean: Assassins en Devias).
 *  - Corta cuando 0xFD dice 0 vivos en ese mapa, la invasión termina, pasan 15 min o llega a
 *    huntStopLevel. Anota cada cacería (mapa, minutos, niveles, dorados) en `mubot-hunts:<pj>`.
 *
 * Primera prueba a ciegas (sin 0xFD ni memoria): funcionó mal (lento, mapa equivocado). Con 0xFD y
 * en Noria: 18 → 90 en 5 min y 2 Box of Luck. Pendiente (roadmap): dividir la búsqueda en dúo.
 *
 *   __hunt.start(map?)   cazar ya (sin mapa: el mejor según 0xFD)
 *   __hunt.stop()        volver a farmear
 *   __hunt.auto = false  no cazar solo
 *   __hunt.history()     últimas cacerías
 */
(() => {
  const ai = window.__ai, S = __store, W = () => __world;
  if (!ai) return 'primero browser-agent.js';
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const isGold = (e) => ai.isMonster(e) && /gold/i.test(String(e.objectNameInWorld ?? '')) && !e.dying && (e.attributeSystem?.getValue?.('currentHealth') ?? 1) > 0;
  const cellOf = (x, z) => `${Math.floor(x / 25)},${Math.floor(z / 25)}`;
  const me = S.playerData?.name ?? 'pj';
  const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  // Mapa → warp y nivel mínimo: los de la invasión que Horaz puede entrar a nivel bajo.
  // Según GoldenInvasionPlugIn (OpenMU): Lorencia Budge Dragon, Noria Goblin, Devias Soldier/Titan,
  // Atlans Vepar/Lizard King, Tarkan Wheel/Tantallos, y Golden Dragon al azar en Lorencia/Noria/Devias.
  // Icarus no entra. Warps y niveles: lista del cliente (Atlans 11 nivel 70, Tarkan 21 nivel 140).
  const MAPS = { 0: { warp: 2, lvl: 0, name: 'Lorencia' }, 3: { warp: 3, lvl: 10, name: 'Noria' }, 2: { warp: 6, lvl: 20, name: 'Devias' }, 7: { warp: 11, lvl: 70, name: 'Atlans' }, 8: { warp: 21, lvl: 140, name: 'Tarkan' } };
  // Práctica de búsqueda en cada invasión, a cualquier nivel (usuario: "entrenar la búsqueda para ir
  // teniendo referencias, aunque no mejore los tiempos"). Se corta con 20 o menos vivos en el mapa
  // (usuario: "seguir buscando tanto tiempo no es bueno") y se arranca solo con más de 25.
  // huntBand: Horaz barre la mitad este (x >= 128); la oeste la barre Melu (headless --scout, franja 1/2)
  // y avisa por /gold. Los dorados avisados se persiguen en cualquier mitad.
  const CFG = { huntMaxLevel: 401, huntStopLevel: 401, huntMinAlive: 25, huntStopAlive: 20, huntMaxMin: 15, huntBand: [128, 256] };
  const gold = jget(`mubot-gold:${me}`, {});      // { map: { "cx,cz": vistos } }
  const hunts = jget(`mubot-hunts:${me}`, []);     // historial de cacerías
  if (window.__hunt?.timer) window.clearInterval(window.__hunt.timer);
  if (window.__hunt?.pollTimer) window.clearInterval(window.__hunt.pollTimer);
  if (window.__hunt?.lingerTimer) window.clearInterval(window.__hunt.lingerTimer);
  const h = (window.__hunt = { on: false, auto: window.__hunt?.auto ?? jget(`mubot-hunt-auto:${me}`, false), map: null, visited: new Set(), seen: new Set(), saved: null, startedAt: null, timer: null });

  // 0xFD: estado de la invasión por mapa.
  if (!window.__invHooked) {
    __eventBus.on('InvasionMonsters', (raw) => {
      try {
        const e = raw instanceof DataView ? raw : new DataView(raw.buffer ?? raw);
        const maps = []; const n = e.getUint8(6);
        for (let i = 0; i < n; i++) { const r = 7 + i * 3; if (r + 3 > e.byteLength) break; maps.push({ map: e.getUint8(r), alive: e.getUint16(r + 1, false) }); }
        window.__invasion = { status: e.getUint8(3), total: e.getUint16(4, false), maps, at: Date.now() };
      } catch {}
    });
    window.__invHooked = true;
  }
  const aliveIn = (map) => window.__invasion?.maps?.find((m) => m.map === map)?.alive ?? 0;
  // Qué tan bien rindió cada mapa en cacerías anteriores (dorados por minuto); sin datos, Noria primero.
  const mapScore = (map) => {
    const past = hunts.filter((x) => x.map === map && x.min > 0.5);
    const kpm = past.length ? past.reduce((a, x) => a + x.kills / x.min, 0) / past.length : ({ 3: 1, 0: 0.6, 2: 0.4 })[map] ?? 0.5;
    return aliveIn(map) * (0.5 + kpm);
  };
  // Mismo criterio que el buscador (más vivos al alcance) para que los dos vayan al mismo mapa.
  const bestMap = () => Object.keys(MAPS).map(Number).filter((m) => S.playerData.level >= MAPS[m].lvl && aliveIn(m) >= CFG.huntMinAlive).sort((a, b) => aliveIn(b) - aliveIn(a) || mapScore(b) - mapScore(a))[0];

  // Prioridad (usuario: "los dragones son el objetivo número 1, después los grandes, lo que tire cosas
  // relevantes"): Golden Dragon 3 > grandes (Titan, Lizard King, Tantallos) 2 > el resto 1.
  const prio = (name) => (/Golden Dragon/i.test(name) ? 3 : /Titan|Lizard|Tantal/i.test(name) ? 2 : 1);
  // Dorado a la vista: atacarlo primero y recordar dónde estaba.
  const sighting = (w, P) => {
    let b = null, bd = 1e9;
    for (const e of w.byNetId.values()) if (isGold(e)) { const d = dist(P, e.transform.pos) - prio(String(e.objectNameInWorld ?? '')) * 40; if (d < bd) { bd = d; b = e; } }
    if (b && !h.seen.has(b.netId)) {
      h.seen.add(b.netId); const p = b.transform.pos, k = cellOf(p.x, p.z);
      const g = (gold[w.mapIndex] ??= {}); g[k] = (g[k] ?? 0) + 1; jset(`mubot-gold:${me}`, gold);
      ai.L(`HUNTER: ${String(b.objectNameInWorld).trim()} en (${Math.round(p.x)},${Math.round(p.z)})`);
    }
    return b;
  };
  // Avisos de los buscadores (headless-bot.ts --scout → POST /gold en el servidor local): cada 2 s.
  h.reports = [];
  const pollGold = () => fetch('http://127.0.0.1:8788/gold?' + Date.now()).then((r) => r.json()).then((list) => { h.reports = Array.isArray(list) ? list.filter((g) => g.from !== me) : []; }).catch(() => {});
  const reportGoal = (P, w) => {
    const near = h.reports.filter((g) => g.map === w.mapIndex && Date.now() - g.at < 30000).map((g) => ({ ...g, z: g.y, d: dist(P, { x: g.x, z: g.y }), p: prio(g.name ?? '') })).sort((a, b) => b.p - a.p || a.d - b.d)[0];
    if (!near || near.d < 4) return null;
    if (h.lastReport !== near.id) { h.lastReport = near.id; ai.L(`HUNTER: ${near.from} vio ${near.name || 'un dorado'} en (${near.x},${near.y}) a ${near.d} tiles: voy`); }
    return { x: near.x, z: near.y, kind: 'hunter:aviso', name: near.name };
  };
  // Próxima celda: primero donde ya aparecieron dorados (más vistas, más cerca), después el resto.
  const nextCell = (P, w) => {
    h.visited.add(cellOf(P.x, P.z));
    const walk = (x, z) => { for (let r = 0; r < 10; r++) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) if (w.isWalkable(x + dx, z + dz)) return { x: x + dx, z: z + dz }; return null; };
    // Franja: la del CFG solo si hay un buscador activo (h.band la pisa; sin buscador, el mapa entero).
    const band = h.band ?? CFG.huntBand;
    const inBand = (x) => x >= band[0] && x < band[1];
    const known = Object.entries(gold[w.mapIndex] ?? {}).filter(([k]) => !h.visited.has(k) && inBand(Number(k.split(',')[0]) * 25 + 12)).map(([k, n]) => { const [cx, cz] = k.split(',').map(Number); return { n, p: walk(cx * 25 + 12, cz * 25 + 12) }; }).filter((x) => x.p);
    if (known.length) { known.sort((a, b) => b.n / (1 + dist(b.p, P) / 40) - a.n / (1 + dist(a.p, P) / 40)); return { ...known[0].p, kind: 'hunter:conocido' }; }
    let best = null, bd = 1e9;
    for (let x = 12; x < 250; x += 25) for (let z = 12; z < 250; z += 25) {
      if (h.visited.has(cellOf(x, z)) || !inBand(x)) continue;
      const p = walk(x, z); if (!p) { h.visited.add(cellOf(x, z)); continue; }
      const d = dist(P, p); if (d < bd) { bd = d; best = p; }
    }
    if (!best) { h.visited.clear(); return null; }
    return { ...best, kind: 'hunter' };
  };

  if (!ai.huntWrapped) {
    const ip = ai.pickTarget;
    ai.pickTarget = (w, P, c) => {
      if (h.on && w.mapIndex === h.map) {
        const b = sighting(w, P); if (b) return b;
        const t = ip(w, P, c); return t && dist(P, t.transform.pos) <= 3 ? t : null;
      }
      return ip(w, P, c);
    };
    const ng = ai.nextGoal;
    ai.nextGoal = (P, w) => (h.on && w.mapIndex === h.map ? reportGoal(P, w) ?? nextCell(P, w) : null) ?? ng(P, w);
    ai.huntWrapped = true;
  }

  h.start = (map = bestMap(), byReport = false) => {
    if (map == null || !MAPS[map]) { ai.L('HUNTER: no hay mapa con dorados al alcance'); return false; }
    Object.assign(h, { on: true, map, byReport, lastGoldAt: Date.now(), startedAt: Date.now(), lvl0: S.playerData.level, golds0: h.seen.size });
    h.visited.clear();
    h.saved = { spots: ai.cfg.spots, leash: ai.cfg.leashMaps, roam: ai.cfg.roam };
    ai.cfg.spots = [[MAPS[map].warp, `cacería ${MAPS[map].name}`, 0]];
    ai.cfg.leashMaps = ai.cfg.leashMaps.filter((m) => m !== map);
    ai.camp = null; ai.explore = null; ai.target = null; W().attackTarget = null;
    if (W().mapIndex !== map) { S.warpCommandRequest(MAPS[map].warp); ai.spot = MAPS[map].warp; ai.lastWarp = Date.now(); ai.arrival = null; }
    if (ai.cur) ai.cur.tag = 'cacería dorada';
    ai.L(byReport ? `HUNTER: aviso de un buscador en ${MAPS[map].name} → voy ya (nivel ${S.playerData.level})` : `HUNTER: invasión con ${aliveIn(map)} dorados en ${MAPS[map].name} → a cazar (nivel ${S.playerData.level})`);
    return true;
  };
  h.stop = (why = 'a mano') => {
    if (!h.on) return;
    const min = (Date.now() - h.startedAt) / 60000, kills = h.seen.size - (h.golds0 ?? 0);
    hunts.push({ at: h.startedAt, map: h.map, min: +min.toFixed(1), kills, lvl0: h.lvl0, lvl1: S.playerData.level, why }); jset(`mubot-hunts:${me}`, hunts.slice(-50));
    h.on = false;
    if (h.saved) { ai.cfg.spots = h.saved.spots; ai.cfg.leashMaps = h.saved.leash; ai.cfg.roam = h.saved.roam; h.saved = null; }
    ai.lastWarp = 0; ai.tierSeen = 0; ai.camp = null; ai.explore = null;
    ai.L(`HUNTER: fin (${why}): ${min.toFixed(1)} min, ${kills} dorados vistos, nivel ${h.lvl0} → ${S.playerData.level}`);
  };
  h.history = () => hunts.slice(-10);
  h.setBand = (from, to) => { h.band = [from, to]; jset(`mubot-hunt-band:${me}`, h.band); return h.band; };
  h.band = jget(`mubot-hunt-band:${me}`, null);
  h.setAuto = (v) => { h.auto = !!v; jset(`mubot-hunt-auto:${me}`, h.auto); return h.auto; };

  // Cada 2 s: leer avisos; si hay uno nuevo y no estamos peleando un dorado, ir ya (no esperar a
  // terminar de caminar hacia la celda actual).
  // Al llegar a una zona del barrido sin dorados, seguir YA: el agente espera 20 s en cada destino
  // (sirve en un campamento para el respawn; cazando, Horaz "se movía y paraba").
  h.lingerTimer = window.setInterval(() => {
    const pe = W()?.playerEntity; if (!h.on || !pe || !ai.explore?.kind?.startsWith('hunter') || ai.target) return;
    if (dist(pe.transform.pos, ai.explore) < 4) { ai.explore = null; ai.arrivedAt = 0; }
  }, 500);
  (window.__mubotTimers ??= []).push(h.lingerTimer);
  h.pollTimer = window.setInterval(() => {
    if (!h.on && !h.auto) return; pollGold(); if (!h.on) return;
    const w = W(), pe = w?.playerEntity; if (!pe) return;
    const g = reportGoal(pe.transform.pos, w);
    // Peleando un dorado: solo se cambia si el aviso es de mayor prioridad (un dragón).
    if (ai.target && isGold(ai.target) && !(g && prio(g.name ?? '') > prio(String(ai.target.objectNameInWorld ?? '')))) return;
    if (g && ai.target && isGold(ai.target)) { ai.target = null; W().attackTarget = null; }
    if (g && (ai.explore?.kind !== 'hunter:aviso' || dist(ai.explore, g) > 4)) { ai.explore = g; ai.moveTo(pe, g); }
  }, 2000);
  (window.__mubotTimers ??= []).push(h.pollTimer);
  // Cada 5 s: arrancar sola con la invasión y cortar cuando no queda nada que cazar.
  h.timer = window.setInterval(() => {
    if (!ai.on || ai.busy || S.uiState !== 5) return;
    const inv = window.__invasion, active = inv?.status === 1 && Date.now() - inv.at < 120000, lvl = S.playerData.level;
    // Aviso de un buscador (usuario: "si Melu detecta algo, mandá a Horaz al instante"): con o sin
    // invasión, si el mapa está al alcance. Corta cuando ese dorado ya no aparece (45 s sin avisos ni
    // dorados a la vista) o a los 6 min.
    const fresh = h.reports.filter((g) => Date.now() - g.at < 30000 && MAPS[g.map] && lvl >= MAPS[g.map].lvl);
    if (h.on && h.byReport) {
      const w = W(); let inView = false; if (w) for (const e of w.byNetId.values()) if (isGold(e)) { inView = true; break; }
      if (inView || fresh.some((g) => g.map === h.map)) h.lastGoldAt = Date.now();
      const why = Date.now() - h.lastGoldAt > 45000 ? 'el dorado avisado ya no está' : (Date.now() - h.startedAt) / 60000 > 6 ? '6 min' : null;
      if (why) h.stop(why);
      return;
    }
    if (!h.on && h.auto && fresh.length) { h.start(fresh[0].map, true); return; }
    if (h.on) {
      const why = !active ? 'terminó la invasión' : aliveIn(h.map) <= CFG.huntStopAlive ? `quedan ${aliveIn(h.map)} en ${MAPS[h.map].name}: no vale la pena` : (Date.now() - h.startedAt) / 60000 > CFG.huntMaxMin ? '15 min' : lvl >= CFG.huntStopLevel ? `nivel ${lvl}` : null;
      if (why) h.stop(why);
      return;
    }
    if (h.auto && active && lvl < CFG.huntMaxLevel) { const m = bestMap(); if (m != null) h.start(m); }
  }, 5000);
  (window.__mubotTimers ??= []).push(h.timer);
  return `modo cazador cargado (auto ${h.auto ? 'sí' : 'no'}): __hunt.start() / __hunt.stop()`;
})();
