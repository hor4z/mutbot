/**
 * Presencia persistente cerca del personaje. No atribuye intención a nadie:
 * un jugador quieto en un paso o que permanece cerca durante el recorrido
 * puede ser un granjero normal. Solo sirve para variar el campamento si rinde mal.
 */
export type NearbyPlayer = { id: number; x: number; y: number; name?: string; mate?: boolean };
export type ObserverSignal = { id: number; name?: string; kind: 'quieto' | 'acompaña'; x: number; y: number; ms: number };
const RADIUS = 16;
const QUIET_MS = 30_000;
const FOLLOW_MS = 45_000;
const MISSING_MS = 15_000;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

type Seen = { at: number; last: number; start: { x: number; y: number }; me: { x: number; y: number }; x: number; y: number; name?: string };
export class ObserverTracker {
  private map = -1;
  private seen = new Map<number, Seen>();

  update(now: number, map: number, me: { x: number; y: number }, players: Iterable<NearbyPlayer>): ObserverSignal | null {
    if (map !== this.map) { this.map = map; this.seen.clear(); }
    let result: ObserverSignal | null = null;
    for (const p of players) {
      if (p.mate || dist(me, p) > RADIUS) continue;
      let s = this.seen.get(p.id);
      if (!s || now - s.last > MISSING_MS) {
        s = { at: now, last: now, start: { x: p.x, y: p.y }, me: { ...me }, x: p.x, y: p.y, name: p.name };
        this.seen.set(p.id, s);
      } else { s.last = now; s.x = p.x; s.y = p.y; s.name = p.name ?? s.name; }
      const ms = now - s.at;
      const quiet = ms >= QUIET_MS && dist(s.start, p) <= 2;
      const follows = ms >= FOLLOW_MS && dist(s.me, me) >= 12 && dist(s.start, p) >= 10;
      if ((quiet || follows) && (!result || ms > result.ms))
        result = { id: p.id, name: s.name, kind: quiet ? 'quieto' : 'acompaña', x: p.x, y: p.y, ms };
    }
    for (const [id, s] of this.seen) if (now - s.last > MISSING_MS) this.seen.delete(id);
    return result;
  }
}
