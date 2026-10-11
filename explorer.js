/**
 * Explorador (atlas) en el navegador: recorre mapas enteros SIN pelear y anota qué monstruos salen
 * en cada zona, para encontrar spots y dónde aparecen dorados (también fuera de la invasión).
 * Pensado para Melu (Dark Wizard, nivel ~120). Se carga después de bg-timers.js y browser-agent.js
 * (usa __ai.isMonster y __ai.moveTo; el agente queda apagado: __ai.on = false).
 *
 *   __atlas.start()   arrancar (vuelve a empezar cuando termina todos los mapas)
 *   __atlas.invasionOnly (por defecto true): solo busca durante la invasión dorada, en la franja oeste;
 *                     el resto del tiempo espera en Lorencia. false = recorrido completo de mapas.
 *   __atlas.stop()
 *   __atlas.report()  resumen por mapa y dorados vistos
 *
 * Datos: localStorage `mubot-atlas:<pj>` y, cada minuto, POST al servidor local (/atlas) que lo
 * guarda en ~/.mubot/atlas-<pj>.json. Los dorados también van a /gold (el cazador de Horaz los lee).
 * Pelea (X.fight, por defecto sí): Evil Spirit contra lo que tenga a <= 5 tiles, dorados primero.
 * Seguridad: poción bajo 60 % de vida, se aleja del monstruo más cercano bajo 50 %, y bajo 30 % sin
 * pociones vuelve a Lorencia. No levanta nada.
 */
(() => {
  const S = __store, W = () => __world, ai = window.__ai;
  if (!ai) return 'primero browser-agent.js';
  ai.on = false; W().attackTarget = null; W().castRequest = null;
  const me = S.playerData?.name ?? 'pj';
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const cellOf = (x, z) => `${Math.floor(x / 25)},${Math.floor(z / 25)}`;
  const KEY = `mubot-atlas:${me}`;
  const atlas = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') ?? { maps: {}, goldens: [] }; } catch { return { maps: {}, goldens: [] }; } })();
  // Limpiar lo anotado antes del filtro de NPCs.
  for (const cells of Object.values(atlas.maps)) for (const c of Object.values(cells)) for (const [t, v] of Object.entries(c)) if (/VIP Seller|Battle Royale|Alquimista/i.test(v.name)) delete c[t];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(atlas)); } catch {} };
  // Mapas a recorrer: [warp, índice de mapa, nombre, nivel]. Lista de warps del cliente.
  const ROUTE = [[2, 0, 'Lorencia', 10], [3, 3, 'Noria', 10], [6, 2, 'Devias', 20], [8, 1, 'Dungeon', 30], [14, 4, 'Lost Tower', 50], [11, 7, 'Atlans', 70], [21, 8, 'Tarkan', 140]];
  const MINUTES_PER_MAP = 12;
  if (window.__atlas?.timer) window.clearInterval(window.__atlas.timer);
  const X = (window.__atlas = { invasionOnly: true, startAlive: 25, stopAlive: 20, band: [0, 128], fight: true, fightRange: 5, skill: 9, on: false, idx: 0, mapSince: 0, visited: new Set(), goal: null, goalSince: 0, seenIds: new Set(), lastPot: 0, lastWarp: 0, lastPost: 0, timer: null });

  const potion = () => { const it = S.playerData.items || []; let best = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { best = i; bn = x.num; } }); return best; };
  const record = (w) => {
    const m = (atlas.maps[w.mapIndex] ??= {});
    for (const e of w.byNetId.values()) {
      // Los NPCs propios del server (VIP Seller, Battle Royale Guard, Alquimista: tipo 692…) tienen 0 de vida.
      if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue;
      const id = `${w.mapIndex}:${e.netId}`, p = e.transform.pos, name = String(e.objectNameInWorld ?? '').trim();
      const c = (m[cellOf(p.x, p.z)] ??= {}), t = (c[e.npcType] ??= { name, seen: 0, last: 0, xy: [Math.round(p.x), Math.round(p.z)] });
      t.last = Date.now();
      if (!X.seenIds.has(id)) {
        X.seenIds.add(id); t.seen++;
        if (/gold/i.test(name)) {
          const inv = window.__invasion; const g = { map: w.mapIndex, x: Math.round(p.x), y: Math.round(p.z), type: e.npcType, name, at: Date.now(), duringInvasion: inv?.status === 1 && Date.now() - inv.at < 120000 };
          atlas.goldens.push(g); ai.L(`ATLAS: ${name} en ${ROUTE.find((r) => r[1] === w.mapIndex)?.[2] ?? w.mapIndex} (${g.x},${g.y})`);
          fetch('http://127.0.0.1:8788/gold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: me, map: g.map, x: g.x, y: g.y, name, id: e.netId & 0xffff, at: g.at }) }).catch(() => {});
        }
      }
    }
  };
  // Cierra la pelea en curso: si el objetivo murió, anota la kill en atlas.fights[mapa][tipo].
  const closeFight = () => {
    const f = X.fightWith; X.fightWith = null; if (!f) return;
    const dead = f.e.dying || (f.e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0;
    const secs = (Date.now() - f.since) / 1000; if (!dead || secs > 120) return;
    const pd = S.playerData, exp = Math.max(0, (pd.exp ?? 0) - f.exp0), lost = Math.max(0, f.hp0 - pd.currentHP);
    const r = ((atlas.fights ??= {})[f.map] ??= {})[f.type] ??= { name: f.name, kills: 0, secs: 0, exp: 0, hpLost: 0 };
    r.kills++; r.secs += secs; r.exp += exp; r.hpLost += lost;
  };
  const nextCell = (w, P) => {
    X.visited.add(cellOf(P.x, P.z));
    const walk = (x, z) => { for (let r = 0; r < 10; r++) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) if (w.isWalkable(x + dx, z + dz)) return { x: x + dx, z: z + dz }; return null; };
    let best = null, bd = 1e9;
    for (let x = 12; x < 250; x += 25) for (let z = 12; z < 250; z += 25) {
      if (X.visited.has(cellOf(x, z)) || (X.invasionOnly && (x < X.band[0] || x >= X.band[1]))) continue;
      const p = walk(x, z); if (!p) { X.visited.add(cellOf(x, z)); continue; }
      const d = dist(P, p); if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const route = () => ROUTE.filter((r) => S.playerData.level >= r[3]);
  const nextMap = (why) => { X.idx = (X.idx + 1) % route().length; X.mapSince = 0; X.visited.clear(); X.goal = null; ai.L(`ATLAS: siguiente mapa (${why})`); };

  // Solo con invasión (usuario: "si no hay dorados, ¿para qué vamos a buscar?"): fuera de la invasión
  // espera en Lorencia; a los :50, si un mapa al alcance tiene > startAlive vivos (0xFD), va ahí y
  // barre su franja (oeste; Horaz el este); con <= stopAlive vuelve a Lorencia.
  const INV_MAPS = ROUTE.filter((r) => [0, 3, 2, 7, 8].includes(r[1]));
  const aliveIn = (m) => window.__invasion?.maps?.find((x) => x.map === m)?.alive ?? 0;
  const invActive = () => window.__invasion?.status === 1 && Date.now() - window.__invasion.at < 120000;
  X.invasionTick = () => {
    if (!X.invasionOnly) return false;
    const w = W(), pd = S.playerData, now = Date.now();
    if (X.on && (!invActive() || aliveIn(route()[X.idx % route().length][1]) <= X.stopAlive)) { X.on = false; closeFight(); save(); ai.L('ATLAS: sin dorados que buscar → Lorencia a esperar'); }
    if (!X.on) {
      const best = INV_MAPS.filter((r) => pd.level >= r[3] && aliveIn(r[1]) > X.startAlive).sort((a, b) => aliveIn(b[1]) - aliveIn(a[1]))[0];
      if (invActive() && best) { X.idx = route().findIndex((r) => r[1] === best[1]); X.on = true; X.mapSince = 0; X.visited.clear(); X.goal = null; ai.L(`ATLAS: invasión con ${aliveIn(best[1])} dorados en ${best[2]} → busco (franja oeste)`); }
      else if (w.mapIndex !== 0 && now - X.lastWarp > 20000 && S.uiState === 5) { X.lastWarp = now; S.warpCommandRequest(2); }
    }
    return true;
  };
  X.tick = () => {
    X.invasionTick();
    if (!X.on || S.uiState !== 5 || S.sceneLoading) return;
    const w = W(), pe = w?.playerEntity, pd = S.playerData; if (!pe) return;
    const now = Date.now(), P = pe.transform.pos, hp = pd.currentHP / pd.maxHP;
    if (hp < 0.6 && now - X.lastPot > 500) { const s = potion(); if (s >= 0) { S.consumeItemRequest(s); X.lastPot = now; } }
    if (hp < 0.3 && potion() < 0) { if (w.mapIndex !== 0 && now - X.lastWarp > 20000) { X.lastWarp = now; S.warpCommandRequest(2); ai.L('ATLAS: poca vida y sin pociones → Lorencia'); } return; }
    const [warp, map, name] = route()[X.idx % route().length];
    if (w.mapIndex !== map) { if (now - X.lastWarp > 15000) { X.lastWarp = now; S.warpCommandRequest(warp); ai.L(`ATLAS: voy a ${name}`); } return; }
    X.mapSince ||= now;
    record(w);
    if (!X.invasionOnly && now - X.mapSince > MINUTES_PER_MAP * 60000) return nextMap(`${MINUTES_PER_MAP} min en ${name}`);
    // Pelear lo que tenga cerca (usuario: "hacé que ataque"): Evil Spirit (área) contra el monstruo más
    // cercano a <= fightRange, dorados primero. Mientras pelea no camina; después sigue el recorrido.
    if (X.fight && hp >= 0.5 && pd.currentMP / pd.maxMP > 0.1) {
      let tgt = null, td = 99;
      for (const e of w.byNetId.values()) { if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue; const d = dist(P, e.transform.pos) - (/gold/i.test(String(e.objectNameInWorld ?? '')) ? 3 : 0); if (d < td) { td = d; tgt = e; } }
      if (tgt && td <= X.fightRange) {
        // Prueba de daño: cuánto tarda en matar cada tipo, la exp que da y la vida que pierde.
        if (X.fightWith?.e !== tgt) { closeFight(); X.fightWith = { e: tgt, type: tgt.npcType, name: String(tgt.objectNameInWorld ?? '').trim(), map: w.mapIndex, since: now, hp0: pd.currentHP, exp0: pd.exp ?? 0 }; }
        if (!w.castRequest) { if (S.currentSkill !== X.skill) S.selectSkill(X.skill); const tp = tgt.transform.pos; w.castRequest = { target: tgt, point: { x: tp.x, y: tp.z }, forced: false }; }
        return;
      }
    }
    closeFight();
    // Alejarse si está perdiendo vida con un monstruo encima.
    if (hp < 0.5) { let near = null, nd = 99; for (const e of w.byNetId.values()) if (ai.isMonster(e) && !e.dying) { const d = dist(P, e.transform.pos); if (d < nd) { nd = d; near = e; } } if (near && nd <= 6) { const q = near.transform.pos, ax = Math.sign(P.x - q.x) || 1, az = Math.sign(P.z - q.z) || 1; ai.moveTo(pe, { x: Math.round(P.x + ax * 6), z: Math.round(P.z + az * 6) }); return; } }
    if (!X.goal || dist(P, X.goal) < 4 || now - X.goalSince > 45000) {
      if (X.goal) X.visited.add(cellOf(X.goal.x, X.goal.z));
      X.goal = nextCell(w, P); X.goalSince = now;
      if (!X.goal) { if (X.invasionOnly) { X.visited.clear(); return; } return nextMap(`recorrí todo ${name}`); }
    }
    const m = pe.playerMoveTo; if (m.handled || m.point.x !== X.goal.x || m.point.y !== X.goal.z) ai.moveTo(pe, X.goal);
    if (now - X.lastPost > 60000) { X.lastPost = now; save(); fetch('http://127.0.0.1:8788/atlas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: me, atlas }) }).catch(() => {}); }
  };
  X.start = () => { X.on = true; X.mapSince = 0; X.visited.clear(); X.goal = null; ai.on = false; ai.L(`ATLAS: arranco (${route().map((r) => r[2]).join(' → ')})`); };
  X.stop = () => { X.on = false; save(); ai.L('ATLAS: paro'); };
  X.report = () => Object.fromEntries(Object.entries(atlas.maps).map(([map, cells]) => {
    const tot = {}; for (const c of Object.values(cells)) for (const [t, v] of Object.entries(c)) { tot[t] ??= { name: v.name, seen: 0 }; tot[t].seen += v.seen; }
    return [ROUTE.find((r) => r[1] === +map)?.[2] ?? map, Object.values(tot).sort((a, b) => b.seen - a.seen).slice(0, 8).map((v) => `${v.name}×${v.seen}`)];
  }));
  X.goldens = () => atlas.goldens.slice(-20);
  // Rendimiento por tipo: segundos por kill, exp por kill y por minuto, vida perdida por kill.
  X.fights = () => Object.fromEntries(Object.entries(atlas.fights ?? {}).map(([map, types]) => [ROUTE.find((r) => r[1] === +map)?.[2] ?? map,
    Object.values(types).map((v) => ({ name: v.name, kills: v.kills, segPorKill: +(v.secs / v.kills).toFixed(1), expPorKill: Math.round(v.exp / v.kills), expPorMin: Math.round((v.exp / v.secs) * 60), vidaPorKill: Math.round(v.hpLost / v.kills) })).sort((a, b) => b.expPorMin - a.expPorMin)]));
  X.timer = window.setInterval(X.tick, 400);
  (window.__mubotTimers ??= []).push(X.timer);
  return `explorador cargado (${route().map((r) => r[2]).join(', ')}): __atlas.start()`;
})();
