/**
 * Rivales del top del ranking (tabla ranking de la base, última foto): para reaccionar cuando uno está
 * cerca. Usuario (2026-10-11), con Yatsuky (#2, Soul Master) llevándose ~73 % de las kills de nuestra
 * esquina: Melu le disputa su grupo con Decay y Horaz le toma el lugar cuando se va. Sin atacarlo.
 */
import { isMate } from './state';
import { queryDb } from './telemetry';

const REFRESH_MS = 10 * 60_000;
export const TOP_RIVALS = 20;
let cache: { at: number; pos: Map<string, number> } = { at: 0, pos: new Map() };
let loading = false;

/** Puesto en el ranking si es un rival del top (no compañero); null si no. */
export function topRank(name: string | undefined, now = Date.now()): number | null {
  if (now - cache.at > REFRESH_MS && !loading) {
    loading = true;
    void queryDb<{ name: string; pos: number }>(
      `SELECT name, argMax(pos, ts) AS pos FROM ranking WHERE ts >= (SELECT max(ts) FROM ranking) - INTERVAL 5 MINUTE GROUP BY name HAVING pos <= ${TOP_RIVALS} FORMAT JSONEachRow`,
    ).then((rows) => {
      if (rows.length || !cache.at) cache = { at: Date.now(), pos: new Map(rows.map((r) => [r.name.toLowerCase(), +r.pos])) };
      else cache.at = Date.now();
    }).finally(() => { loading = false; });
  }
  if (!name || isMate(name)) return null;
  return cache.pos.get(name.toLowerCase()) ?? null;
}
