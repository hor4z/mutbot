/**
 * Dorados que ven los demás (señales de la estación, GET /api/gold): los otros bots y el juego en el
 * navegador publican cada dorado con su posición. Cazando, el bot los anota como "recordados" para ir
 * derecho sin esperar a tenerlos en su propio scope (el usuario los veía en el mapa antes de que Hume
 * les diera foco). Solo loopback, cada FEED_POLL_MS; sin estación o con datos viejos no hace nada.
 */
import { GOLD_URL } from './panel-logic';
import { log } from './util';

export const FEED_POLL_MS = 2000;
/** Una señal más vieja que esto ya no sirve para ir (los dorados se mueven y los matan en segundos). */
export const FEED_MAX_AGE_MS = 12_000;

export type FeedGold = { from: string; map: number; x: number; y: number; name: string; id: number; at: number };
let feed: FeedGold[] = [];
let lastOkAt = 0;
let started = false;

/** Valida lo que devuelve la estación: ignora todo lo que no cierre (nunca confía en el formato). */
export function parseFeed(v: unknown): FeedGold[] {
  if (!Array.isArray(v)) return [];
  const out: FeedGold[] = [];
  for (const g of v.slice(0, 200)) {
    if (!g || typeof g !== 'object') continue;
    const r = g as Record<string, unknown>;
    const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
    if (typeof r.from !== 'string' || !n(r.map) || !n(r.x) || !n(r.y) || !n(r.id) || !n(r.at) || typeof r.name !== 'string') continue;
    out.push({ from: r.from, map: r.map as number, x: r.x as number, y: r.y as number, name: r.name, id: r.id as number, at: r.at as number });
  }
  return out;
}

/** Señales recientes de OTROS en este mapa, como pistas `{key,x,y,at}`: la clave es negativa (-1 - id) para no chocar con los ids de monstruos. */
export function feedHints(list: readonly FeedGold[], map: number, selfName: string, now: number, maxAgeMs = FEED_MAX_AGE_MS): { key: number; x: number; y: number; at: number; name: string }[] {
  return list
    .filter((g) => g.map === map && g.from !== selfName && now - g.at <= maxAgeMs && now >= g.at - 5000)
    .map((g) => ({ key: -1 - g.id, x: g.x, y: g.y, at: g.at, name: g.name }));
}

export function goldFeedHints(map: number, selfName: string, now: number) {
  return feedHints(feed, map, selfName, now);
}

export function startGoldFeed() {
  if (started) return;
  started = true;
  let u: URL;
  try { u = new URL(GOLD_URL); } catch { return; }
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return; // solo loopback
  const poll = async () => {
    try {
      const r = await fetch(GOLD_URL, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return;
      feed = parseFeed(await r.json());
      lastOkAt = Date.now();
    } catch {
      if (Date.now() - lastOkAt > 60_000) feed = [];
    }
  };
  setInterval(() => void poll(), FEED_POLL_MS);
  void poll();
  log(`Dorados de los demás: consulto ${GOLD_URL} cada ${FEED_POLL_MS / 1000} s.`);
}
