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

// Zonas de todos los dorados (no solo dragones): celdas de 15 tiles donde se vio alguno (golden_seen).
// Sin zonas, la cacería recorre el mapa a ciegas y da vueltas (Atlans, 2026-10-23: lo vio el usuario).
let goldCache: { at: number; byMap: Map<number, Zone[]> } = { at: 0, byMap: new Map() };
let goldLoading = false;
const GOLD_ZONES_SQL = `SELECT map, round(avg(JSONExtractInt(data, 'gx'))) AS x, round(avg(JSONExtractInt(data, 'gy'))) AS y, count() AS n
FROM events WHERE kind = 'golden_seen' AND JSONExtractInt(data, 'gx') > 0
GROUP BY map, intDiv(JSONExtractInt(data, 'gx'), 15), intDiv(JSONExtractInt(data, 'gy'), 15) FORMAT JSONEachRow`;

/** Zonas donde se vio cualquier dorado en el mapa (se recargan cada 5 min). */
export function goldenZones(map: number, now = Date.now()): Zone[] {
  if (now - goldCache.at > REFRESH_MS && !goldLoading) {
    goldLoading = true;
    void queryDb<{ map: number; x: number; y: number; n: string }>(GOLD_ZONES_SQL)
      .then((rows) => {
        const byMap = new Map<number, Zone[]>();
        for (const r of rows) {
          const list = byMap.get(+r.map) ?? [];
          list.push({ x: +r.x, y: +r.y, n: +r.n });
          byMap.set(+r.map, list);
        }
        if (rows.length || !goldCache.at) goldCache = { at: Date.now(), byMap };
        else goldCache.at = Date.now();
      })
      .finally(() => { goldLoading = false; });
  }
  return goldCache.byMap.get(map) ?? [];
}

// Pesos por celda del recorrido (HuntExplorer.useTerrain): dónde se vieron dorados, para recorrer primero esas
// celdas. Los dragones pesan 3×. Se recalcula solo cuando cambia la caché (la misma identidad mientras no).
const weightMemo = new Map<number, { dragonAt: number; goldAt: number; w: Map<string, number> }>();
export function zoneWeights(map: number, cell = 25, now = Date.now()): ReadonlyMap<string, number> {
  const dz = dragonZones(map, now), gz = goldenZones(map, now);
  const memo = weightMemo.get(map);
  if (memo && memo.dragonAt === cache.at && memo.goldAt === goldCache.at) return memo.w;
  const w = new Map<string, number>();
  const add = (z: Zone, k: number) => { const key = `${Math.floor(z.x / cell)},${Math.floor(z.y / cell)}`; w.set(key, (w.get(key) ?? 0) + z.n * k); };
  for (const z of gz) add(z, 1);
  for (const z of dz) add(z, 3);
  weightMemo.set(map, { dragonAt: cache.at, goldAt: goldCache.at, w });
  return w;
}

/** Mapas con zonas conocidas (al menos `min`): ahí la cacería sabe a dónde ir. */
export const KNOWN_ZONES_MIN = 3;
export function mapsWithZones(maps: readonly number[], now = Date.now()): Set<number> {
  return new Set(maps.filter((m) => goldenZones(m, now).length + dragonZones(m, now).length >= KNOWN_ZONES_MIN));
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

// Zonas con monstruos a la vista (celdas de 16 tiles con al menos 8 fotos de algún personaje con 3 o más monstruos cerca; `n` = densidad
// × raíz de la cantidad de fotos). El carreo lleva a la sombra a la mejor cercana: en la plaza de un pueblo no hay monstruos. Se aprenden
// solas de `ticks`; sin datos del mapa, el líder se queda junto a la sombra.
let lowCache: { at: number; byMap: Map<number, Zone[]> } = { at: 0, byMap: new Map() };
let lowLoading = false;
const LOW_ZONES_SQL = `SELECT map, intDiv(x, 16) * 16 + 8 AS zx, intDiv(y, 16) * 16 + 8 AS zy, round(avg(monsters_near) * sqrt(count()), 1) AS n
FROM ticks WHERE monsters_near >= 3 AND ts > now() - INTERVAL 30 DAY
GROUP BY map, zx, zy HAVING count() >= 8 FORMAT JSONEachRow`;

/** Zonas con monstruos del mapa (se recargan cada 5 min). */
export function lowLevelZones(map: number, now = Date.now()): Zone[] {
  if (now - lowCache.at > REFRESH_MS && !lowLoading) {
    lowLoading = true;
    void queryDb<{ map: number; zx: number; zy: number; n: string }>(LOW_ZONES_SQL)
      .then((rows) => {
        const byMap = new Map<number, Zone[]>();
        for (const r of rows) {
          const list = byMap.get(+r.map) ?? [];
          list.push({ x: +r.zx, y: +r.zy, n: +r.n });
          byMap.set(+r.map, list);
        }
        if (rows.length || !lowCache.at) lowCache = { at: Date.now(), byMap };
        else lowCache.at = Date.now();
      })
      .finally(() => { lowLoading = false; });
  }
  return lowCache.byMap.get(map) ?? [];
}
