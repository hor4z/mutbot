/**
 * Modo cazador: invasión dorada (todas las horas a los :50, 15 min).
 * Se carga después de browser-agent.js y tuner.js. Con `auto` (por defecto) caza solo:
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
  const MAPS = { 0: { warp: 2, lvl: 0, name: 'Lorencia' }, 3: { warp: 3, lvl: 10, name: 'Noria' }, 2: { warp: 6, lvl: 20, name: 'Devias' } };
  const CFG = { huntMaxLevel: 250, huntStopLevel: 300, huntMinAlive: 3, huntMaxMin: 15 };
  const gold = jget(`mubot-gold:${me}`, {});      // { map: { "cx,cz": vistos } }
  const hunts = jget(`mubot-hunts:${me}`, []);     // historial de cacerías
  if (window.__hunt?.timer) window.clearInterval(window.__hunt.timer);
  const h = (window.__hunt = { on: false, auto: window.__hunt?.auto ?? true, map: null, visited: new Set(), seen: new Set(), saved: null, start: null, timer: null });

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
  const bestMap = () => Object.keys(MAPS).map(Number).filter((m) => S.playerData.level >= MAPS[m].lvl && aliveIn(m) >= CFG.huntMinAlive).sort((a, b) => mapScore(b) - mapScore(a))[0];

  // Dorado a la vista: atacarlo primero y recordar dónde estaba.
  const sighting = (w, P) => {
    let b = null, bd = 1e9;
    for (const e of w.byNetId.values()) if (isGold(e)) { const d = dist(P, e.transform.pos); if (d < bd) { bd = d; b = e; } }
    if (b && !h.seen.has(b.netId)) {
      h.seen.add(b.netId); const p = b.transform.pos, k = cellOf(p.x, p.z);
      const g = (gold[w.mapIndex] ??= {}); g[k] = (g[k] ?? 0) + 1; jset(`mubot-gold:${me}`, gold);
      ai.L(`HUNTER: ${String(b.objectNameInWorld).trim()} en (${Math.round(p.x)},${Math.round(p.z)})`);
    }
    return b;
  };
  // Próxima celda: primero donde ya aparecieron dorados (más vistas, más cerca), después el resto.
  const nextCell = (P, w) => {
    h.visited.add(cellOf(P.x, P.z));
    const walk = (x, z) => { for (let r = 0; r < 10; r++) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) if (w.isWalkable(x + dx, z + dz)) return { x: x + dx, z: z + dz }; return null; };
    const known = Object.entries(gold[w.mapIndex] ?? {}).filter(([k]) => !h.visited.has(k)).map(([k, n]) => { const [cx, cz] = k.split(',').map(Number); return { n, p: walk(cx * 25 + 12, cz * 25 + 12) }; }).filter((x) => x.p);
    if (known.length) { known.sort((a, b) => b.n / (1 + dist(b.p, P) / 40) - a.n / (1 + dist(a.p, P) / 40)); return { ...known[0].p, kind: 'hunter:conocido' }; }
    let best = null, bd = 1e9;
    for (let x = 12; x < 250; x += 25) for (let z = 12; z < 250; z += 25) {
      if (h.visited.has(cellOf(x, z))) continue;
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
    ai.nextGoal = (P, w) => (h.on && w.mapIndex === h.map ? nextCell(P, w) : null) ?? ng(P, w);
    ai.huntWrapped = true;
  }

  h.start = (map = bestMap()) => {
    if (map == null || !MAPS[map]) { ai.L('HUNTER: no hay mapa con dorados al alcance'); return false; }
    Object.assign(h, { on: true, map, start: Date.now(), lvl0: S.playerData.level, golds0: h.seen.size });
    h.visited.clear();
    h.saved = { spots: ai.cfg.spots, leash: ai.cfg.leashMaps, roam: ai.cfg.roam };
    ai.cfg.spots = [[MAPS[map].warp, `cacería ${MAPS[map].name}`, 0]];
    ai.cfg.leashMaps = ai.cfg.leashMaps.filter((m) => m !== map);
    ai.camp = null; ai.explore = null; ai.target = null; W().attackTarget = null;
    if (W().mapIndex !== map) { S.warpCommandRequest(MAPS[map].warp); ai.spot = MAPS[map].warp; ai.lastWarp = Date.now(); ai.arrival = null; }
    if (ai.cur) ai.cur.tag = 'cacería dorada';
    ai.L(`HUNTER: invasión con ${aliveIn(map)} dorados en ${MAPS[map].name} → a cazar (nivel ${S.playerData.level})`);
    return true;
  };
  h.stop = (why = 'a mano') => {
    if (!h.on) return;
    const min = (Date.now() - h.start) / 60000, kills = h.seen.size - (h.golds0 ?? 0);
    hunts.push({ at: h.start, map: h.map, min: +min.toFixed(1), kills, lvl0: h.lvl0, lvl1: S.playerData.level, why }); jset(`mubot-hunts:${me}`, hunts.slice(-50));
    h.on = false;
    if (h.saved) { ai.cfg.spots = h.saved.spots; ai.cfg.leashMaps = h.saved.leash; ai.cfg.roam = h.saved.roam; h.saved = null; }
    ai.lastWarp = 0; ai.tierSeen = 0; ai.camp = null; ai.explore = null;
    ai.L(`HUNTER: fin (${why}): ${min.toFixed(1)} min, ${kills} dorados vistos, nivel ${h.lvl0} → ${S.playerData.level}`);
  };
  h.history = () => hunts.slice(-10);

  // Cada 5 s: arrancar sola con la invasión y cortar cuando no queda nada que cazar.
  h.timer = window.setInterval(() => {
    if (!ai.on || ai.busy || S.uiState !== 5) return;
    const inv = window.__invasion, active = inv?.status === 1 && Date.now() - inv.at < 120000, lvl = S.playerData.level;
    if (h.on) {
      const why = !active ? 'terminó la invasión' : aliveIn(h.map) === 0 ? `no quedan dorados en ${MAPS[h.map].name}` : (Date.now() - h.start) / 60000 > CFG.huntMaxMin ? '15 min' : lvl >= CFG.huntStopLevel ? `nivel ${lvl}` : null;
      if (why) h.stop(why);
      return;
    }
    if (h.auto && active && lvl < CFG.huntMaxLevel) { const m = bestMap(); if (m != null) h.start(m); }
  }, 5000);
  (window.__mubotTimers ??= []).push(h.timer);
  return `modo cazador cargado (auto ${h.auto ? 'sí' : 'no'}): __hunt.start() / __hunt.stop()`;
})();
