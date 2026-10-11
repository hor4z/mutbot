/**
 * El arranque en el loop (early.ts, como el navegador): Lorencia hasta el 20 directo al Lich con salida
 * variada; Devias 4 (o 3/2 si estaba llena) hasta el 100 con campamento en el grupo más denso junto a la
 * llegada y objetivos a <= 8 del campamento. Sin saltos por hambre ni por mapa vacío: solo Devias llena
 * (o 45 s sin nada de exp con jugadores cerca) cambia de spot.
 */
import { CORNER, type Pos } from './corner';
import { EARLY, deviasCamp, dist, lorenciaPlan } from './early';
import { bot, world, type ScopedNpc } from './state';
import { isWalkable } from './terrain';
import { log } from './util';

// Entradas de Devias de la ruta (Devias 4, 3, 2): el arranque manda ahí; en Arena 1 (plan B), no.
const DEVIAS_WARPS = [7, 6, 5];

export class EarlyPlanner {
  private arrivalAt = -1;
  private arrival: Pos | null = null;
  camp: Pos | null = null;
  private poorSince: number | null = null;
  private lorPlan: { camp: Pos; via: Pos | null } | null = null;

  /** ¿Manda el arranque ahora? */
  active(): boolean {
    if (bot.hunting || bot.pinnedSpot || world.level >= CORNER.minLevel) return false;
    if (world.map === EARLY.lorencia.map) return world.level < EARLY.lorencia.maxLevel;
    return world.map === EARLY.devias.map && bot.currentSpot != null && DEVIAS_WARPS.includes(bot.currentSpot.index);
  }

  /** En Lorencia, todavía yendo por el punto de paso (no se elige objetivo). */
  viaPending(): boolean {
    return world.map === EARLY.lorencia.map && this.lorPlan?.via != null;
  }

  /** El campamento y a dónde caminar en este tick (recalcula al llegar a un mapa). */
  goal(npcs: Iterable<ScopedNpc>): { camp: Pos; goal: Pos } {
    const now = Date.now();
    const me = { x: world.x, y: world.y };
    if (this.arrivalAt !== bot.lastArrivalAt) {
      this.arrivalAt = bot.lastArrivalAt;
      this.arrival = { ...me };
      this.camp = null;
      this.poorSince = null;
      this.lorPlan = null;
      if (world.map === EARLY.lorencia.map) {
        this.lorPlan = lorenciaPlan(Math.random, (q) => isWalkable(0, q.x, q.y));
        log(`Arranque: salida de Lorencia ${this.lorPlan.via ? `por (${this.lorPlan.via.x},${this.lorPlan.via.y})` : 'directa'} al Lich (${this.lorPlan.camp.x},${this.lorPlan.camp.y}).`);
      }
    }
    if (world.map === EARLY.lorencia.map && this.lorPlan) {
      if (this.lorPlan.via && dist(me, this.lorPlan.via) <= EARLY.viaReached) this.lorPlan.via = null;
      return { camp: this.lorPlan.camp, goal: this.lorPlan.via ?? this.lorPlan.camp };
    }
    const r = deviasCamp({ arrival: this.arrival ?? me, monsters: [...npcs], prev: this.camp, poorSince: this.poorSince, now });
    if (r.why && (!this.camp || r.camp.x !== this.camp.x || r.camp.y !== this.camp.y)) log(`Arranque: campamento (${r.camp.x},${r.camp.y}): ${r.why}.`);
    this.camp = r.camp;
    this.poorSince = r.poorSince;
    return { camp: r.camp, goal: r.camp };
  }
}
