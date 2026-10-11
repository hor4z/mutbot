/**
 * Zonas de avistamiento de dragones (v_dragon_zones en db/views.sql), por mapa. Se refrescan cada 5 min
 * desde la base: se van sumando solas con cada dragón visto (evento golden_seen). Las usan el radar
 * (PanelState.zones) y la cacería (ir primero a la zona más cercana sin visitar).
 */
import { queryDb } from './telemetry';

export type Zone = { x: number; y: number; n: number };

const REFRESH_MS = 5 * 60_000;
let cache: { at: number; byMap: Map<number, Zone[]> } = { at: 0, byMap: new Map() };
let loading = false;

/** Zonas del mapa (lo último cargado; dispara la recarga si está viejo). */
export function dragonZones(map: number, now = Date.now()): Zone[] {
  if (now - cache.at > REFRESH_MS && !loading) {
    loading = true;
    void queryDb<{ map: number; x: number; y: number; n: string }>('SELECT map, x, y, n FROM v_dragon_zones FORMAT JSONEachRow')
      .then((rows) => {
        const byMap = new Map<number, Zone[]>();
        for (const r of rows) {
          const list = byMap.get(+r.map) ?? [];
          list.push({ x: +r.x, y: +r.y, n: +r.n });
          byMap.set(+r.map, list);
        }
        if (rows.length || !cache.at) cache = { at: Date.now(), byMap };
        else cache.at = Date.now();
      })
      .finally(() => { loading = false; });
  }
  return cache.byMap.get(map) ?? [];
}

/** La zona más cercana a `me` que todavía no se visitó (visitada = pasó a <= 6 tiles). */
export function nextZone(zones: readonly Zone[], me: { x: number; y: number }, visited: ReadonlySet<string>): Zone | null {
  let best: Zone | null = null;
  let bd = Infinity;
  for (const z of zones) {
    if (visited.has(`${z.x},${z.y}`)) continue;
    const d = Math.hypot(z.x - me.x, z.y - me.y);
    if (d < bd) { bd = d; best = z; }
  }
  return best;
}
