/**
 * Modo cazador (usuario, 2026-10-10: "modo hunter", invasión dorada).
 * El cliente muestra la invasión en un widget ("Invasión Dorada · Noria: 7 vivos"), sin
 * posiciones: hay que ir al mapa y recorrerlo. Uso, después de browser-agent.js (y duo.js):
 *   __hunt.start(3)   // warp de Noria; recorre el mapa en celdas de 25 tiles y ataca primero
 *                     // cualquier monstruo dorado ("Golden …"/"Dorado") que vea
 *   __hunt.stop()     // vuelve a la ruta de farmeo normal
 * En dúo: si el compañero queda a > 8 tiles, primero vuelve a buscarlo (Melu murió sola).
 * Las cajas que tiran los dorados las levanta el looter de siempre.
 */
(() => {
  const ai = window.__ai, S = __store, W = () => __world;
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const isGold = (e) => ai.isMonster(e) && /gold|dorad/i.test(String(e.objectNameInWorld ?? '')) && !e.dying && (e.attributeSystem?.getValue?.('currentHealth') ?? 1) > 0;
  const cell = (x, z) => `${Math.floor(x / 25)},${Math.floor(z / 25)}`;
  const h = (window.__hunt = { on: false, warp: null, map: null, visited: new Set(), seen: new Set(), saved: null, roam: null });
  if (!ai.huntWrapped) {
    const ip = ai.pickTarget;
    ai.pickTarget = (w, P, c) => {
      if (h.on) {
        let b = null, bd = 1e9;
        for (const e of w.byNetId.values()) if (isGold(e)) { const d = dist(P, e.transform.pos); if (d < bd) { bd = d; b = e; } }
        if (b) { if (!h.seen.has(b.netId)) { h.seen.add(b.netId); ai.L(`HUNTER: ${String(b.objectNameInWorld).trim()} a ${bd} tiles`); } return b; }
      }
      return ip(w, P, c);
    };
    const ng = ai.nextGoal;
    ai.nextGoal = (P, w) => {
      if (window.__partyWith) { try { const f = JSON.parse(localStorage.getItem('mubot:follow:' + window.__partyWith) || 'null'); if (f && Date.now() - f.at < 20000 && f.map === w.mapIndex && dist(P, f) > 8) return { x: f.x, z: f.z, kind: 'compañero' }; } catch {} }
      if (!h.on || w.mapIndex !== h.map) return ng(P, w);
      h.visited.add(cell(P.x, P.z));
      let best = null, bd = 1e9;
      for (let x = 12; x < 250; x += 25) for (let z = 12; z < 250; z += 25) {
        if (h.visited.has(cell(x, z))) continue;
        let p = null;
        for (let r = 0; r < 10 && !p; r++) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) if (w.isWalkable(x + dx, z + dz)) { p = { x: x + dx, z: z + dz }; break; }
        if (!p) { h.visited.add(cell(x, z)); continue; }
        const d = dist(P, p); if (d < bd) { bd = d; best = p; }
      }
      if (!best) { h.visited.clear(); return ng(P, w); }
      return { x: best.x, z: best.z, kind: 'hunter' };
    };
    ai.huntWrapped = true;
  }
  h.start = (warp, map = warp) => {
    Object.assign(h, { on: true, warp, map, saved: h.saved ?? ai.cfg.spots, roam: h.roam ?? ai.cfg.roam }); h.visited.clear();
    ai.cfg.spots = [[warp, 'cacería', 0]]; ai.cfg.roam = 1;
    if (W().mapIndex !== map) { S.warpCommandRequest(warp); ai.spot = warp; ai.lastWarp = Date.now(); ai.camp = null; ai.explore = null; ai.target = null; W().attackTarget = null; }
    ai.L(`HUNTER: voy a cazar dorados (warp ${warp})`);
  };
  h.stop = () => { h.on = false; if (h.saved) ai.cfg.spots = h.saved; if (h.roam != null) ai.cfg.roam = h.roam; h.saved = h.roam = null; ai.lastWarp = 0; ai.L('HUNTER: fin de la cacería, vuelvo a farmear'); };
  return 'modo cazador cargado: __hunt.start(warp) / __hunt.stop()';
})();
