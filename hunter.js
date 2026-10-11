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
  // Solo Horaz busca, sin compañero (usuario 2026-10-11: "programá búsquedas para mi personaje solo
  // por ahora"): barre el mapa entero (sin la franja oeste de Melu) y, a las :49:20, espera en Devias
  // y gira por Lorencia y Noria si en tourSec no ve dorados (el Golden Dragon sale al azar en esos 3).
  // En las demás pestañas el cazador queda apagado salvo que se prenda a mano (__hunt.setAuto(true)).
  const SOLO = { Horaz: { map: 2, tour: [0, 3] } };
  const CFG = { huntMaxLevel: 401, huntStopLevel: 401, huntMinAlive: 25, huntStopAlive: 20, huntMaxMin: 15, huntWindowMin: 3, tourSec: 12, huntBand: SOLO[S.playerData?.name] ? [0, 256] : [128, 256] };
  const gold = jget(`mubot-gold:${me}`, {});      // { map: { "cx,cz": vistos } }
  const hunts = jget(`mubot-hunts:${me}`, []);     // historial de cacerías
  if (window.__hunt?.timer) window.clearInterval(window.__hunt.timer);
  if (window.__hunt?.pollTimer) window.clearInterval(window.__hunt.pollTimer);
  if (window.__hunt?.lingerTimer) window.clearInterval(window.__hunt.lingerTimer);
  const h = (window.__hunt = { on: false, auto: SOLO[me] ? true : jget(`mubot-hunt-auto-manual:${me}`, false), map: null, visited: new Set(), seen: new Set(), saved: null, startedAt: null, timer: null });

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
  // Invasión del Dragón Rojo (RedDragonInvasionPlugIn de OpenMU): ~5 dragones en UNO de Lorencia /
  // Noria / Devias al azar. El monstruo es el tipo 44, que el cliente llama "Golden Dragon" (entra en
  // isGold con prioridad 3). Para saber en qué mapa:
  //  - MapEventState `C1 05 0B <on> <tipo>` (tipo 1 = Dragón Rojo): el server lo manda al arrancar y al
  //    terminar a los que están en el mapa elegido, y a cada uno que entra a ese mapa mientras dura.
  //    Medido el 2026-10-10 23:23: Melu entró a Lorencia y llegó `c1 05 0b 01 01`.
  //  - El anuncio en el centro (ServerMessage 0x0D) avisa que empezó, sin el mapa: entonces se recorren
  //    los 3 mapas (un warp cada pocos segundos) hasta que en uno llegue el MapEventState.
  // Se comparte entre pestañas por localStorage (`mubot:red`).
  const RED_MAPS = [0, 3, 2];
  const red = () => jget('mubot:red', null);
  if (!window.__redHooked) {
    const bytes = (raw) => (raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw.buffer ?? raw));
    __eventBus.on('MapEventState', (raw) => {
      try {
        const u = bytes(raw); if (u[2] !== 0x0b || u[4] !== 1) return;
        const map = W()?.mapIndex, on = u[3] === 1;
        if (on) jset('mubot:red', { map, on: true, at: Date.now(), by: S.playerData?.name });
        else if (red()?.map === map) jset('mubot:red', { ...red(), on: false, endedAt: Date.now() });
        window.__ai?.L?.(`HUNTER: Dragón Rojo ${on ? 'en' : 'terminó en'} mapa ${map}`);
      } catch {}
    });
    __eventBus.on('ServerMessage', (raw) => {
      try {
        const txt = new TextDecoder('latin1').decode(bytes(raw).slice(4));
        // Mensajes por defecto de OpenMU: "[{mapName}] Red Dragon invasion!" / "... has ended." (30 min).
        const named = { lorencia: 0, noria: 3, devias: 2 }[(txt.match(/\[(\w+)\]/)?.[1] ?? '').toLowerCase()];
        if (/drag[oó]n rojo|red dragon/i.test(txt) && named != null) jset('mubot:red', /ended|termin/i.test(txt) ? { map: named, on: false, endedAt: Date.now() } : { map: named, on: true, at: Date.now(), by: 'anuncio' });
        if (/drag[oó]n rojo|red dragon/i.test(txt)) { localStorage.setItem('mubot:red-announced', String(Date.now())); window.__ai?.L?.(`HUNTER: anuncio "${txt.replace(/\0/g, '').trim().slice(0, 80)}"`); }
      } catch {}
    });
    window.__redHooked = true;
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
      // Punto exacto de cada Golden Dragon (tipo 79), compartido entre pestañas: el buscador los revisa primero.
      if (b.npcType === 79) { const ds = jget('mubot-dragon-spots', {}); (ds[w.mapIndex] ??= []).push([Math.round(p.x), Math.round(p.z)]); ds[w.mapIndex] = ds[w.mapIndex].slice(-30); jset('mubot-dragon-spots', ds); }
      ai.L(`HUNTER: ${String(b.objectNameInWorld).trim()} en (${Math.round(p.x)},${Math.round(p.z)})${b.npcType === 44 ? ' (Dragón Rojo, tipo 44)' : ''}`);
    }
    // Un dragón a la vista se avisa al compañero (antes solo avisaba el explorador de Melu).
    if (b && prio(String(b.objectNameInWorld ?? '')) === 3 && Date.now() - (h.lastPost ?? 0) > 3000) {
      h.lastPost = Date.now(); const p = b.transform.pos;
      fetch('http://127.0.0.1:8788/gold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: me, map: w.mapIndex, x: Math.round(p.x), y: Math.round(p.z), name: String(b.objectNameInWorld ?? '').trim(), id: b.netId & 0xffff, at: Date.now() }) }).catch(() => {});
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
  const DRAGON_SPOTS = { 0: [[149, 168]], 2: [[110, 161], [214, 227]], 3: [] };
  const nextCell = (P, w) => {
    h.visited.add(cellOf(P.x, P.z));
    const walk = (x, z) => { for (let r = 0; r < 10; r++) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) if (w.isWalkable(x + dx, z + dz)) return { x: x + dx, z: z + dz }; return null; };
    // Franja: la del CFG solo si hay un buscador activo (h.band la pisa; sin buscador, el mapa entero).
    const band = h.band ?? CFG.huntBand;
    const inBand = (x) => x >= band[0] && x < band[1];
    // Primero los puntos donde ya salió un Golden Dragon (usuario: "aparecen en las entradas o salidas
    // de los spots que usamos", radios cortos). Registrados: Lorencia (149,168) a la salida sur del
    // pueblo; Devias (110,161) cerca de la entrada 7 y (214,227) junto a la espera (225,225).
    // Noria ("a la salida") se aprende con `mubot-dragon-spots` cuando aparezca uno.
    const ds = [...(DRAGON_SPOTS[w.mapIndex] ?? []), ...(jget('mubot-dragon-spots', {})[w.mapIndex] ?? [])];
    const hot = ds.filter(([x, z]) => !h.visited.has(cellOf(x, z)) && inBand(x)).map(([x, z]) => walk(x, z)).filter(Boolean);
    if (hot.length) { hot.sort((a, b) => dist(a, P) - dist(b, P)); return { ...hot[0], kind: 'hunter:dragón' }; }
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
    ai.nextGoal = (P, w) => (h.on && w.mapIndex === h.map ? reportGoal(P, w) ?? (h.pre && h.waitAt ? { ...h.waitAt, kind: 'hunter:espera' } : nextCell(P, w)) : null) ?? ng(P, w);
    ai.huntWrapped = true;
  }

  h.start = (map = bestMap(), byReport = false, pre = false) => {
    if (map == null || !MAPS[map]) { ai.L('HUNTER: no hay mapa con dorados al alcance'); return false; }
    if (pre && SOLO[me]) h.tour = [...SOLO[me].tour];
    Object.assign(h, { on: true, map, byReport, pre, hops: map === 2 ? [6, 7, 5, 4] : [], lastHop: 0, lastGoldAt: Date.now(), startedAt: Date.now(), lvl0: S.playerData.level, golds0: h.seen.size });
    h.visited.clear();
    // allSpots: con el dúo "juntos" cfg.spots es un getter filtrado por el nivel del compañero; se guarda
    // la lista completa para devolverla al terminar.
    h.saved = { spots: ai.cfg.allSpots ?? ai.cfg.spots, leash: ai.cfg.leashMaps, roam: ai.cfg.roam };
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
    h.on = false; h.redHunt = false;
    if (h.saved) { ai.cfg.spots = h.saved.spots; ai.cfg.leashMaps = h.saved.leash; ai.cfg.roam = h.saved.roam; h.saved = null; }
    ai.lastWarp = 0; ai.tierSeen = 0; ai.camp = null; ai.explore = null;
    ai.L(`HUNTER: fin (${why}): ${min.toFixed(1)} min, ${kills} dorados vistos, nivel ${h.lvl0} → ${S.playerData.level}`);
  };
  h.history = () => hunts.slice(-10);
  // Mapa de espera, punto exacto (x, z) y gira de dragón (mapas a revisar si en tourSec no aparece
  // nada en el actual). Usuario: "los dragones salen cerca" (Lorencia 149,168 a las 21:50; en Devias
  // junto a la llegada de Devias 3 a las 19:50).
  h.setPrepos = (map, x = null, z = null, tour = []) => { h.prepos = map; h.waitAt = x != null ? { x, z } : null; h.tour = tour; jset(`mubot-hunt-prepos:${me}`, { map, x, z, tour }); return { map, x, z, tour }; };
  { const pp = jget(`mubot-hunt-prepos:${me}`, null); if (pp && typeof pp === 'object') { h.prepos = pp.map; h.waitAt = pp.x != null ? { x: pp.x, z: pp.z } : null; h.tour = pp.tour ?? []; } else h.prepos = pp; }
  h.setBand = (from, to) => { h.band = [from, to]; jset(`mubot-hunt-band:${me}`, h.band); return h.band; };
  h.band = SOLO[me] ? null : jget(`mubot-hunt-band:${me}`, null);
  if (SOLO[me]) { h.prepos = SOLO[me].map; h.waitAt = null; h.tour = [...SOLO[me].tour]; }
  h.setAuto = (v) => { h.auto = !!v; jset(`mubot-hunt-auto-manual:${me}`, h.auto); return h.auto; };

  // Cada 2 s: leer avisos; si hay uno nuevo y no estamos peleando un dorado, ir ya (no esperar a
  // terminar de caminar hacia la celda actual).
  // Al llegar a una zona del barrido sin dorados, seguir YA: el agente espera 20 s en cada destino
  // (sirve en un campamento para el respawn; cazando, Horaz "se movía y paraba").
  h.lingerTimer = window.setInterval(() => {
    const pe = W()?.playerEntity; if (!h.on || !pe || !ai.explore?.kind?.startsWith('hunter') || ai.target) return;
    if (dist(pe.transform.pos, ai.explore) < 4) { ai.explore = null; ai.arrivedAt = 0; }
  }, 500);
  (window.__mubotTimers ??= []).push(h.lingerTimer);
  // Cajas en el piso: nada de saltar de entrada, girar de mapa ni cortar la cacería hasta levantarlas.
  // 2026-10-11 00:50: mató un Golden Dragon en Devias y saltó a la entrada 5 con dos Cajas de Kundun
  // (+5 y +2) todavía en el piso; se perdieron.
  const lootPending = () => {
    if (ai.looting) return true;
    const w = W(), pe = w?.playerEntity; if (!pe || !ai.isValuable) return false;
    for (const e of w.byNetId.values()) if (e.droppedItem && ai.isValuable(e.droppedItem) && !ai.lootSkip?.has(e.netId) && dist(pe.transform.pos, e.transform.pos) <= (ai.cfg.lootRadius ?? 10) + 4) return true;
    return false;
  };
  h.lootPending = lootPending;
  h.pollTimer = window.setInterval(() => {
    if (!h.on && !h.auto) return; pollGold(); if (!h.on) return;
    if (lootPending()) return;
    // Gira de dragón: arrancada la invasión, si en CFG.tourSec no hay dorados a la vista, saltar al
    // siguiente mapa de h.tour (Melu: Lorencia → Noria). Se vuelve a medir en cada mapa.
    { const w = W(); let inView = false; if (w) for (const e of w.byNetId.values()) if (isGold(e)) { inView = true; break; }
      if (inView) h.lastSeenGold = Date.now();
      if (!h.pre && h.tour?.length && h.invStart && w?.mapIndex === h.map && !inView && Date.now() - Math.max(h.startedAt, h.lastSeenGold ?? 0, h.invStart) > CFG.tourSec * 1000) {
        let next = h.tour.shift(); while (next === h.map && h.tour.length) next = h.tour.shift(); // no "saltar" al mismo mapa
        if (next !== h.map && MAPS[next] && S.playerData.level >= MAPS[next].lvl) { ai.L(`HUNTER: nada en ${MAPS[h.map].name} en ${CFG.tourSec} s → ${MAPS[next].name}`); const t = h.tour; h.stop('gira'); h.start(next); h.tour = t; return; } } }
    // Devias: saltar entre sus 4 entradas (warps 6, 7, 5, 4) mira 4 zonas lejanas en segundos;
    // en cada una se queda 6 s si no hay dorados a la vista.
    { const w = W(); let inView = false; if (w) for (const e of w.byNetId.values()) if (isGold(e)) { inView = true; break; }
      if (!h.pre && h.map === 2 && w?.mapIndex === 2 && h.hops?.length && !inView && !ai.target && Date.now() - h.lastHop > 6000) { const wp = h.hops.shift(); h.lastHop = Date.now(); S.warpCommandRequest(wp); ai.explore = null; ai.L(`HUNTER: salto a la entrada ${wp} de Devias`); return; } }
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
    if (lootPending()) return;
    const inv = window.__invasion, active = inv?.status === 1 && Date.now() - inv.at < 120000, lvl = S.playerData.level;
    // Aviso de un buscador (usuario: "si Melu detecta algo, mandá a Horaz al instante"): con o sin
    // invasión, si el mapa está al alcance. Corta cuando ese dorado ya no aparece (45 s sin avisos ni
    // dorados a la vista) o a los 6 min.
    // Organización de la búsqueda (2026-10-10, tras una invasión mala: llegábamos tarde y a ciegas):
    //  - a las hh:49:20 cada personaje se para en SU mapa de espera (h.prepos: Horaz Devias, Melu
    //    Lorencia; el Golden Dragon sale al azar en Lorencia/Noria/Devias) y espera la invasión ahí;
    //  - se busca solo los primeros CFG.huntWindowMin minutos desde que arranca (salvo un dragón
    //    avisado o a la vista); los grandes duran menos de un minuto y a los 2-3 min no queda casi nada.
    const nowD = new Date();
    if (active && !h.invStart) h.invStart = Date.now(); if (!active) h.invStart = null;
    if (h.on && h.pre) { if (active) h.pre = false; else if (![49, 50].includes(nowD.getMinutes())) { h.stop('no hubo invasión'); return; } else return; }
    if (!h.on && h.auto && h.prepos && !active && nowD.getMinutes() === 49 && nowD.getSeconds() >= 20 && lvl >= (MAPS[h.prepos]?.lvl ?? 0)) { h.start(h.prepos, false, true); ai.L(`HUNTER: me paro en ${MAPS[h.prepos].name} a esperar la invasión`); return; }
    // Dragón Rojo: con el mapa conocido, cazar ahí hasta que el server diga que terminó (o 12 min).
    // Con solo el anuncio, recorrer los 3 mapas (un warp cada 7 s, cada pestaña en otro orden) hasta
    // que llegue el MapEventState.
    const R = red(), redLive = R?.on && Date.now() - R.at < 12 * 60000 && MAPS[R.map] && lvl >= MAPS[R.map].lvl;
    if (h.on && h.redHunt) {
      const why = !redLive ? 'terminó el Dragón Rojo' : R.map !== h.map ? null : (Date.now() - h.startedAt) / 60000 > 12 ? '12 min' : null;
      if (why) { h.stop(why); h.redHunt = false; return; }
      if (R.map !== h.map) { h.stop(`Dragón Rojo en ${MAPS[R.map].name}`); h.start(R.map, false); h.redHunt = true; }
      return;
    }
    if (h.auto && redLive && (!h.on || h.pre)) { if (h.on) h.stop('Dragón Rojo'); h.start(R.map, false); h.redHunt = true; ai.L(`HUNTER: Dragón Rojo en ${MAPS[R.map].name} → a cazar`); return; }
    const ann = Number(localStorage.getItem('mubot:red-announced') || 0);
    if (h.auto && !h.on && !redLive && Date.now() - ann < 90000 && Date.now() - (h.redProbeAt ?? 0) > 7000) {
      const order = me === 'Melu' ? RED_MAPS : [...RED_MAPS].reverse(); h.redProbeIdx = ((h.redProbeIdx ?? -1) + 1) % order.length;
      const m = order[h.redProbeIdx]; if (MAPS[m] && lvl >= MAPS[m].lvl) { h.redProbeAt = Date.now(); S.warpCommandRequest(MAPS[m].warp); ai.spot = MAPS[m].warp; ai.lastWarp = Date.now(); ai.L(`HUNTER: busco dónde invade el Dragón Rojo: ${MAPS[m].name}`); }
      return;
    }
    const fresh = h.reports.filter((g) => Date.now() - g.at < 30000 && MAPS[g.map] && lvl >= MAPS[g.map].lvl);
    if (h.on && h.byReport) {
      const w = W(); let inView = false; if (w) for (const e of w.byNetId.values()) if (isGold(e)) { inView = true; break; }
      if (inView || fresh.some((g) => g.map === h.map)) h.lastGoldAt = Date.now();
      const why = Date.now() - h.lastGoldAt > 45000 ? 'el dorado avisado ya no está' : (Date.now() - h.startedAt) / 60000 > 6 ? '6 min' : null;
      if (why) h.stop(why);
      return;
    }
    if (!h.on && h.auto && fresh.length) { h.start(fresh[0].map, true); return; }
    // Dragón (prioridad 3) avisado en OTRO mapa al alcance: ir ya (el 9:50 Melu vio uno en Lorencia
    // y Horaz seguía en Devias, porque solo miraba avisos de su mapa).
    const dragon = fresh.filter((g) => prio(g.name ?? '') === 3 && g.map !== h.map).sort((a, b) => b.at - a.at)[0];
    if (h.on && dragon && !(ai.target && prio(String(ai.target.objectNameInWorld ?? '')) === 3)) { h.stop(`dragón avisado en ${MAPS[dragon.map].name}`); h.start(dragon.map, h.byReport); return; }
    if (h.on) {
      let inView = false; { const w = W(); if (w) for (const e of w.byNetId.values()) if (isGold(e)) { inView = true; break; } }
      const dragonNow = inView || h.reports.some((g) => Date.now() - g.at < 30000 && prio(g.name ?? '') === 3);
      const why = !active ? 'terminó la invasión' : h.invStart && Date.now() - h.invStart > CFG.huntWindowMin * 60000 && !dragonNow ? `pasaron ${CFG.huntWindowMin} min de invasión` : aliveIn(h.map) <= CFG.huntStopAlive ? `quedan ${aliveIn(h.map)} en ${MAPS[h.map].name}: no vale la pena` : (Date.now() - h.startedAt) / 60000 > CFG.huntMaxMin ? '15 min' : lvl >= CFG.huntStopLevel ? `nivel ${lvl}` : null;
      if (why) h.stop(why);
      return;
    }
    if (h.auto && active && lvl < CFG.huntMaxLevel) { const m = bestMap(); if (m != null) h.start(m); }
  }, 5000);
  (window.__mubotTimers ??= []).push(h.timer);
  return `modo cazador cargado (auto ${h.auto ? 'sí' : 'no'}): __hunt.start() / __hunt.stop()`;
})();
