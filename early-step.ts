/**
 * El arranque en el loop (early.ts, como el navegador): Lorencia hasta el 20 directo al Lich con salida
 * variada; Devias 4 (o 3/2 si estaba llena) hasta el 100 con campamento en el grupo más denso junto a la
 * llegada y objetivos a <= 8 del campamento. Sin saltos por hambre: en Devias cambia de spot solo si
 * está llena (3+ jugadores en el campamento 20 s) o si pasan 60 s en el mapa sin nada de exp (con
 * jugadores cerca cuenta como llena, sin nadie como mapa vacío).
 */
import { decide } from './journal';
import { CORNER, type Pos } from './corner';
import { EARLY, INITIAL, deviasCamp, dist, fieldFor, inField, initialCamp, lorenciaPlan, type Field, type LorenciaPlan } from './early';
import { FIGHT_LIMITS, canFight, type Fighter } from './power';
import { bot, isMate, learned, monsterLevel, world, type ScopedNpc } from './state';
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
  private lorPlan: LorenciaPlan | null = null;
  private detourArrival = -1;
  // Lich vaciado (21 jugadores, ni un monstruo a la vista): tras LICH_EMPTY_MS en el campamento sin
  // monstruos se deja el plan del Lich por esta llegada y manda la lógica general (campamentos,
  // exploración) hasta el 20.
  private lichEmptySince: number | null = null;
  private lichOffFor = -1;

  /** ¿Farmeo inicial? (personaje nuevo en Lorencia por debajo de INITIAL.untilLevel). */
  initial(): boolean {
    return world.map === EARLY.lorencia.map && isFreshChar(world.resets, world.stats) && !this.readyToLeave();
  }

  /** Si el Lich está ocupado, farmear otra puerta hasta poder warpear. */
  private detour(): boolean {
    // Solo el personaje débil (no le disputa monstruos a nadie). Con stats completos mata todo al
    // instante: va al Lich igual. Hume (40 resets) se iba a recorrer el campo de Hound en el oeste.
    if (world.map !== 0 || this.readyToLeave() || !isFreshChar(world.resets, world.stats)) return false;
    // Solo cuenta el destino: el paso (133,166) y el camino son de pasada, y un jugador cruzando
    // la puerta mandaba a Hume al desvío casi en cada ciclo (4-17 min en Lorencia en vez de ~1).
    const camp = this.lorPlan?.camp ?? EARLY.lorencia.lich;
    const occupied = [...world.players.values()].some((p) =>
      (!p.name || !isMate(p.name)) && dist(p, camp) <= 10);
    if (occupied && this.detourArrival !== bot.lastArrivalAt) {
      this.detourArrival = bot.lastArrivalAt;
      this.initialPrev = null;
      decide('Lorencia: hay un jugador en la salida prevista; sigo por otro campo hasta poder ir a Devias.');
    }
    return this.detourArrival === bot.lastArrivalAt;
  }


  /**
   * ¿Puede dejar Lorencia? Nivel >= untilLevel, zen para el warp a Devias (sin eso el warp falla: Hume
   * en el 27 con 0 zen) y que pueda con el Lich (lo más fuerte del mapa). Sus stats deciden, no el nivel.
   */
  readyToLeave(): boolean {
    return world.level >= INITIAL.untilLevel && bot.lastMoney >= INITIAL.leaveZen && canFight(this.fighter(), INITIAL.lichType, { ...FIGHT_LIMITS, maxKillSec: INITIAL.leaveKillSec });
  }

  /** El personaje como lo ve power.ts (stats reales, vida máxima, clase). */
  private fighter(): Fighter {
    return { family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp };
  }

  /**
   * Los atacables en este tick: en el farmeo inicial, solo con los que puede según sus stats, más los
   * que le pegaron en los últimos 5 s (`hitMe`: id → cuándo, ctx.aggro). Zamu (mago nivel 1) se quedaba
   * quieto en el campamento mientras un Budge Dragon lo mataba: no "podía" con él y no contestaba.
   */
  targets<N extends ScopedNpc>(npcs: Iterable<N>, hitMe?: ReadonlyMap<number, number>, now = Date.now()): N[] {
    const all = [...npcs];
    if (!this.initial() && !this.detour()) return all;
    const f = this.fighter();
    // Sin disputarle a otro jugador el monstruo que está peleando (a <= 2 de él).
    const busy = (n: N) => [...world.players.values()].some((p) => Math.max(Math.abs(p.x - n.x), Math.abs(p.y - n.y)) <= 2);
    const hit = (n: N) => now - (hitMe?.get(n.id) ?? -Infinity) <= 5000;
    return all.filter((n) => hit(n) || (canFight(f, n.type) && !busy(n)));
  }

  /** Campos que se dejan un rato (ocupados por otros jugadores y sin rendir). */
  private avoid = new Map<Field, number>();
  /** Deja el campo actual por `ms` (estaba ocupado y no rendía): elige otro con el que pueda. */
  leaveField(ms: number): string | null {
    if (!this.lastField) return null;
    this.avoid.set(this.lastField, Date.now() + ms);
    this.initialPrev = null;
    return this.lastField.name;
  }

  /** El campo que le toca según sus stats (power.ts), no según el nivel. */
  private field(): Field {
    const f = this.fighter();
    const now = Date.now();
    if (this.detour()) {
      // Se elige una vez por llegada: re-evaluar los jugadores en cada tick la hacía ir y venir
      // entre Hound y Bull Fighter cada 4 s sin llegar a ninguno (Hume, 2026-10-19).
      if (this.detourFieldFor !== bot.lastArrivalAt || !this.detourField || (this.avoid.get(this.detourField) ?? 0) > now) {
        this.detourFieldFor = bot.lastArrivalAt;
        this.detourField = fieldFor((t) => canFight(f, t), monsterLevel,
          (x) => x === INITIAL.fields[3] || (this.avoid.get(x) ?? 0) > now ||
            [...world.players.values()].some((p) => (!p.name || !isMate(p.name)) && dist(p, x.entry) <= 15));
      }
      return this.detourField;
    }
    return fieldFor((t) => canFight(f, t), monsterLevel, (x) => (this.avoid.get(x) ?? 0) > now);
  }
  private lastField: Field | null = null;
  private detourField: Field | null = null;
  private detourFieldFor = -1;

  private initialPrev: Pos | null = null;
  private initialLogged = false;

  /** ¿Manda el arranque ahora? */
  active(): boolean {
    if (bot.hunting || bot.pinnedSpot || world.level >= CORNER.minLevel) return false;
    // Personaje nuevo sin terminar el farmeo inicial: manda el arranque aunque pase el 20 (Hume en el 27
    // caía al farmeo de siempre, iba al Lich por la cripta y lo mataba un Skeleton).
    if (world.map === EARLY.lorencia.map) return this.initial() || this.detour() || (world.level < EARLY.lorencia.maxLevel && this.lichOffFor !== bot.lastArrivalAt);
    return world.map === EARLY.devias.map && bot.currentSpot != null && DEVIAS_WARPS.includes(bot.currentSpot.index);
  }

  /** En Lorencia, todavía yendo por el punto de paso (no se elige objetivo). */
  viaPending(): boolean {
    return world.map === EARLY.lorencia.map && (this.lorPlan?.vias.length ?? 0) > 0;
  }

  private chooseLorenciaPlan() {
    const history = learned.char.lorenciaRoutes ?? [];
    this.lorPlan = lorenciaPlan(Math.random, (q) => isWalkable(0, q.x, q.y), history);
    learned.char.lorenciaRoutes = [...history, this.lorPlan.variant].slice(-2);
    decide(`Arranque: ruta ${this.lorPlan.variant + 1} de Lorencia por ${this.lorPlan.vias.length} punto(s) al Lich (${this.lorPlan.camp.x},${this.lorPlan.camp.y}).`);
    return this.lorPlan;
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
      if (world.map === EARLY.lorencia.map && !this.initial() && !this.detour()) {
        this.chooseLorenciaPlan();
      }
    }
    if (this.initial() || this.detour()) {
      const field = this.field();
      if (field !== this.lastField) {
        decide(`Farmeo inicial: con fuerza ${world.stats.str}, agilidad ${world.stats.agi} y ${world.maxHp} de vida me toca ${field.name}.`);
        // Subió de campo: el campamento viejo (del campo anterior) se suelta.
        if (this.lastField) this.initialPrev = null;
        this.lastField = field;
      }
      // Fuera de su campo: va hacia él y solo pelea con lo que tenga pegado en el camino. Antes se quedaba
      // con lo que viera (Bull Fighter, nivel 6) disputándolo con otros, ya pudiendo con Hound y Elite Bull
      // del campo oeste (Hume en el 51; usuario: "le conviene ir a buscar enemigos y avanzar").
      const here = inField(me, field);
      if (!here && this.initialPrev && !inField(this.initialPrev, field)) this.initialPrev = null;
      const pool = this.targets(npcs).filter((n) => here ? true : inField(n, field) || dist(n, me) <= 3);
      const r = initialCamp({ me, field, monsters: pool, prev: this.initialPrev, rand: Math.random, walkable: (q) => isWalkable(0, q.x, q.y) });
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
      const plan = this.chooseLorenciaPlan();
      decide(`Farmeo inicial terminado (nivel ${world.level}): paso al farmeo avanzado, al Lich (${plan.camp.x},${plan.camp.y}).`);
    }
    if (world.map === EARLY.lorencia.map && this.lorPlan) {
      const plan = this.lorPlan;
      while (plan.vias.length && dist(me, plan.vias[0]) <= EARLY.viaReached) plan.vias.shift();
      const atCamp = !plan.vias.length && dist(me, plan.camp) <= 3;
      const any = [...npcs].some((n) => dist(n, plan.camp) <= 15);
      this.lichEmptySince = atCamp && !any ? (this.lichEmptySince ?? now) : null;
      if (this.lichEmptySince != null && now - this.lichEmptySince > LICH_EMPTY_MS) {
        this.lichOffFor = bot.lastArrivalAt;
        this.lichEmptySince = null;
        decide(`Arranque: el Lich está vacío hace ${LICH_EMPTY_MS / 1000} s: busco monstruos por Lorencia.`);
      }
      return { camp: plan.camp, goal: plan.vias[0] ?? plan.camp };
    }
    const r = deviasCamp({ arrival: this.arrival ?? me, monsters: [...npcs], prev: this.camp, poorSince: this.poorSince, now });
    if (r.why && (!this.camp || r.camp.x !== this.camp.x || r.camp.y !== this.camp.y)) decide(`Arranque: campamento (${r.camp.x},${r.camp.y}): ${r.why}.`);
    this.camp = r.camp;
    this.poorSince = r.poorSince;
    return { camp: r.camp, goal: r.camp };
  }
}
