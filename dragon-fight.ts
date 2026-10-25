/**
 * Registro de cada pelea con un dragón (lógica pura; farm-loop.ts lo alimenta y emite `dragon_fight` a la base):
 * cuándo se lo vio (y cuánto después del aviso), cuándo se le pegó el primer golpe, cuántos golpes, cuántos de los nuestros y
 * cuántos ajenos había cerca, y cómo terminó (`killed` por quién, o `lost`: 15 s sin verlo). Para medir si llegamos a tiempo.
 */
export type FightRec = {
  id: number; type: number; firstSeen: number; lastSeen: number; firstHit: number | null; hits: number;
  sx: number; sy: number; ex: number; ey: number; mates: number; others: number; noticeAt: number | null;
};
export type FightEnd = FightRec & { outcome: 'killed' | 'lost'; killer: string | null; mine: boolean; at: number };

export const FIGHT_LOST_MS = 15_000;

export class DragonFights {
  private recs = new Map<number, FightRec>();

  /** Un dragón a la vista ahora. `mates`/`others`: nuestros y ajenos a <= 15 tiles de él. `noticeAt`: cuándo avisó el server. */
  seen(id: number, type: number, x: number, y: number, now: number, mates: number, others: number, noticeAt: number | null) {
    const r = this.recs.get(id);
    if (!r) {
      this.recs.set(id, { id, type, firstSeen: now, lastSeen: now, firstHit: null, hits: 0, sx: x, sy: y, ex: x, ey: y, mates, others, noticeAt });
      return;
    }
    r.lastSeen = now; r.ex = x; r.ey = y;
    r.mates = Math.max(r.mates, mates); r.others = Math.max(r.others, others);
  }

  hit(id: number, now: number) {
    const r = this.recs.get(id);
    if (!r) return;
    r.hits++;
    r.firstHit ??= now;
  }

  killed(id: number, now: number, killer: string | null, mine: boolean): FightEnd | null {
    const r = this.recs.get(id);
    if (!r) return null;
    this.recs.delete(id);
    return { ...r, outcome: 'killed', killer, mine, at: now };
  }

  /** Los que llevan más de FIGHT_LOST_MS sin verse (y no murieron a la vista): se dan por perdidos. */
  expire(now: number): FightEnd[] {
    const out: FightEnd[] = [];
    for (const [id, r] of this.recs) {
      if (now - r.lastSeen < FIGHT_LOST_MS) continue;
      this.recs.delete(id);
      out.push({ ...r, outcome: 'lost', killer: null, mine: false, at: now });
    }
    return out;
  }
}

/** Los números de la pelea para la base (segundos). */
export function fightData(e: FightEnd) {
  const s = (a: number | null, b: number) => (a == null ? null : +((b - a) / 1000).toFixed(1));
  return {
    id: e.id, type: e.type, outcome: e.outcome, killer: e.killer, mine: e.mine,
    seenAfterNoticeS: s(e.noticeAt, e.firstSeen), seenToHitS: s(e.firstSeen, e.firstHit ?? NaN) ?? null, seenToEndS: s(e.firstSeen, e.outcome === 'lost' ? e.lastSeen : e.at),
    hits: e.hits, mates: e.mates, others: e.others, sx: e.sx, sy: e.sy, ex: e.ex, ey: e.ey,
  };
}
