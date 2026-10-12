/**
 * El arranque en el loop (early.ts, como el navegador): Lorencia hasta el 20 directo al Lich con salida
 * variada; Devias 4 (o 3/2 si estaba llena) hasta el 100 con campamento en el grupo más denso junto a la
 * llegada y objetivos a <= 8 del campamento. Sin saltos por hambre: en Devias cambia de spot solo si
 * está llena (3+ jugadores en el campamento 20 s) o si pasan 60 s en el mapa sin nada de exp (con
 * jugadores cerca cuenta como llena, sin nadie como mapa vacío).
 */
import { decide } from './journal';
import { CORNER, type Pos } from './corner';
import { EARLY, INITIAL, deviasCamp, dist, fieldFor, initialCamp, lorenciaPlan, type Field } from './early';
import { canFight, type Fighter } from './power';
import { bot, monsterLevel, world, type ScopedNpc } from './state';
import { classFamily, isFreshChar } from './farming';
import { isWalkable } from './terrain';

// Entradas de Devias de la ruta (Devias 4, 3, 2): el arranque manda ahí; en Arena 1 (plan B), no.
const DEVIAS_WARPS = [7, 6, 5];
// Donde deja el warp a Devias 4.
const DEVIAS4_ARRIVAL: Pos = { x: 70, y: 180 };
const LICH_EMPTY_MS = 20_000;

export class EarlyPlanner {
  private arrivalAt = -1;
  private arrival: Pos | null = null;
  camp: Pos | null = null;
  private poorSince: number | null = null;
  private lorPlan: { camp: Pos; via: Pos | null } | null = null;
  // Lich vaciado (21 jugadores, ni un monstruo a la vista): tras LICH_EMPTY_MS en el campamento sin
  // monstruos se deja el plan del Lich por esta llegada y manda la lógica general (campamentos,
  // exploración) hasta el 20.
  private lichEmptySince: number | null = null;
  private lichOffFor = -1;

  /** ¿Farmeo inicial? (personaje nuevo en Lorencia por debajo de INITIAL.untilLevel). */
  initial(): boolean {
    return world.map === EARLY.lorencia.map && isFreshChar(world.resets, world.stats) && !this.readyToLeave();
  }

  /**
   * ¿Puede dejar Lorencia? Nivel >= untilLevel, zen para el warp a Devias (sin eso el warp falla: Hume
   * en el 27 con 0 zen) y que pueda con el Lich (lo más fuerte del mapa). Sus stats deciden, no el nivel.
   */
  readyToLeave(): boolean {
    return world.level >= INITIAL.untilLevel && bot.lastMoney >= INITIAL.leaveZen && canFight(this.fighter(), INITIAL.lichType);
  }

  /** El personaje como lo ve power.ts (stats reales, vida máxima, clase). */
  private fighter(): Fighter {
    return { family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp };
  }

  /** Los atacables en este tick: en el farmeo inicial, solo con los que puede según sus stats. */
  targets<N extends ScopedNpc>(npcs: Iterable<N>): N[] {
    const all = [...npcs];
    if (!this.initial()) return all;
    const f = this.fighter();
    return all.filter((n) => canFight(f, n.type));
  }

  /** El campo que le toca según sus stats (power.ts), no según el nivel. */
  private field(): Field {
    const f = this.fighter();
    return fieldFor((t) => canFight(f, t), monsterLevel);
  }
  private lastField: Field | null = null;

  private initialPrev: Pos | null = null;
  private initialLogged = false;

  /** ¿Manda el arranque ahora? */
  active(): boolean {
    if (bot.hunting || bot.pinnedSpot || world.level >= CORNER.minLevel) return false;
    // Personaje nuevo sin terminar el farmeo inicial: manda el arranque aunque pase el 20 (Hume en el 27
    // caía al farmeo de siempre, iba al Lich por la cripta y lo mataba un Skeleton).
    if (world.map === EARLY.lorencia.map) return this.initial() || (world.level < EARLY.lorencia.maxLevel && this.lichOffFor !== bot.lastArrivalAt);
    return world.map === EARLY.devias.map && bot.currentSpot != null && DEVIAS_WARPS.includes(bot.currentSpot.index);
  }

  /** En Lorencia, todavía yendo por el punto de paso (no se elige objetivo). */
  viaPending(): boolean {
    return world.map === EARLY.lorencia.map && this.lorPlan?.via != null;
  }

  private tickAt = -1;
  private last: { camp: Pos; goal: Pos } | null = null;

  /**
   * El campamento y a dónde caminar en este tick (recalcula al llegar a un mapa). `npcs` = los
   * atacables (sin los inalcanzables). Se calcula una vez por tick (`tick`).
   */
  goal(npcs: Iterable<ScopedNpc>, tick: number): { camp: Pos; goal: Pos } {
    if (tick === this.tickAt && this.last) return this.last;
    this.tickAt = tick;
    this.last = this.compute(npcs);
    return this.last;
  }

  private compute(npcs: Iterable<ScopedNpc>): { camp: Pos; goal: Pos } {
    const now = Date.now();
    const me = { x: world.x, y: world.y };
    if (this.arrivalAt !== bot.lastArrivalAt) {
      this.arrivalAt = bot.lastArrivalAt;
      // Reconectando el bot aparece donde quedó (Horaz entró en (181,72)): si eso está lejos de la
      // llegada de Devias 4, los grupos se buscan alrededor de la llegada, no de ahí.
      // (solo si el spot es Devias 4 o todavía no hay spot, al reconectar: tras un warp a Devias 3 o 2
      // vale la llegada real).
      this.arrival = world.map === EARLY.devias.map && (bot.currentSpot == null || bot.currentSpot.index === 7) && dist(me, DEVIAS4_ARRIVAL) > 30 ? { ...DEVIAS4_ARRIVAL } : { ...me };
      this.camp = null;
      this.poorSince = null;
      this.lorPlan = null;
      if (world.map === EARLY.lorencia.map && !this.initial()) {
        this.lorPlan = lorenciaPlan(Math.random, (q) => isWalkable(0, q.x, q.y));
        decide(`Arranque: salida de Lorencia ${this.lorPlan.via ? `por (${this.lorPlan.via.x},${this.lorPlan.via.y})` : 'directa'} al Lich (${this.lorPlan.camp.x},${this.lorPlan.camp.y}).`);
      }
    }
    if (this.initial()) {
      const field = this.field();
      if (field !== this.lastField) {
        decide(`Farmeo inicial: con fuerza ${world.stats.str}, agilidad ${world.stats.agi} y ${world.maxHp} de vida me toca ${field.name}.`);
        // Subió de campo: el campamento viejo (del campo anterior) se suelta.
        if (this.lastField) this.initialPrev = null;
        this.lastField = field;
      }
      const r = initialCamp({ me, field, monsters: this.targets(npcs), prev: this.initialPrev, rand: Math.random, walkable: (q) => isWalkable(0, q.x, q.y) });
      if (!this.initialPrev || r.camp.x !== this.initialPrev.x || r.camp.y !== this.initialPrev.y) decide(`Farmeo inicial (nivel ${world.level}): campamento (${r.camp.x},${r.camp.y}): ${r.why}.`);
      // Sin monstruos de su nivel: el punto de paseo se suelta al llegar, para elegir otro.
      this.initialPrev = r.why.startsWith('sin monstruos') && dist(me, r.camp) <= 2 ? null : r.camp;
      this.camp = r.camp;
      this.initialLogged = true;
      return { camp: r.camp, goal: r.camp };
    }
    if (world.map === EARLY.lorencia.map && this.initialLogged) {
      // Fin del farmeo inicial: plan del Lich desde donde está (pasa al farmeo avanzado).
      this.initialLogged = false;
      this.initialPrev = null;
      this.lorPlan = lorenciaPlan(Math.random, (q) => isWalkable(0, q.x, q.y));
      decide(`Farmeo inicial terminado (nivel ${world.level}): paso al farmeo avanzado, al Lich (${this.lorPlan.camp.x},${this.lorPlan.camp.y}).`);
    }
    if (world.map === EARLY.lorencia.map && this.lorPlan) {
      if (this.lorPlan.via && dist(me, this.lorPlan.via) <= EARLY.viaReached) this.lorPlan.via = null;
      const atCamp = !this.lorPlan.via && dist(me, this.lorPlan.camp) <= 3;
      const any = [...npcs].some((n) => dist(n, this.lorPlan!.camp) <= 15);
      this.lichEmptySince = atCamp && !any ? (this.lichEmptySince ?? now) : null;
      if (this.lichEmptySince != null && now - this.lichEmptySince > LICH_EMPTY_MS) {
        this.lichOffFor = bot.lastArrivalAt;
        this.lichEmptySince = null;
        decide(`Arranque: el Lich está vacío hace ${LICH_EMPTY_MS / 1000} s: busco monstruos por Lorencia.`);
      }
      return { camp: this.lorPlan.camp, goal: this.lorPlan.via ?? this.lorPlan.camp };
    }
    const r = deviasCamp({ arrival: this.arrival ?? me, monsters: [...npcs], prev: this.camp, poorSince: this.poorSince, now });
    if (r.why && (!this.camp || r.camp.x !== this.camp.x || r.camp.y !== this.camp.y)) decide(`Arranque: campamento (${r.camp.x},${r.camp.y}): ${r.why}.`);
    this.camp = r.camp;
    this.poorSince = r.poorSince;
    return { camp: r.camp, goal: r.camp };
  }
}
