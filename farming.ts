/**
 * Elección de objetivo por EXP POR SEGUNDO, aprendizaje por tipo de monstruo y
 * autoevaluación. Portado del agente que juega dentro del cliente web
 * (`browser-agent.js`), que es el que sube de nivel rápido: ahí está cada
 * decisión explicada con lo que se aprendió jugando con el usuario.
 *
 * Lógica PURA (sin red, sin EventBus, sin `world`): recibe posiciones, eventos y
 * reloj por parámetro, así se testea offline en `farming-tests.ts`.
 * `headless-bot.ts` la engancha en `autonomousLoop`. Ver AGENTS.md, "Farmeo
 * por exp/segundo".
 */

// ---------------------------------------------------------------------------
// Parámetros (del modelo, no del uso). Mismos valores que `ai.cfg` del agente web.
// ---------------------------------------------------------------------------
export const FARM = {
  // Segundos que cuesta caminar un tile (para el costo de ir hasta el objetivo).
  SEC_PER_TILE: 0.4,
  // Un monstruo que se estima tardar más que esto en matar solo se elige si no
  // hay ninguno más rápido ("duros" solo si no hay nada razonable).
  MAX_KILL_SEC: 8,
  // Sin medición de un tipo: vida / dps medido × esto (algo de pesimismo).
  UNKNOWN_PESSIMISM: 1.4,
  // Sin ninguna medición de dps: se asume esto.
  DEFAULT_KILL_SEC: 3,
  // Sin ninguna medición de exp: exp/sqrt(vida) por defecto.
  DEFAULT_EXP_PER_SQRT_HP: 300,
  // Densidad: otros monstruos a <= esto del objetivo suman CROWD_WEIGHT de su
  // valor (Twisting Slash es de área: pega a todos los de alrededor).
  CROWD_RADIUS: 3,
  CROWD_WEIGHT: 0.5,
  // Competencia: cada jugador a <= PLAYER_RADIUS del objetivo multiplica el
  // valor por COMPETITION_FACTOR (otro jugador nos roba el kill o el respawn).
  // 0.7 = penalización 0.3 por jugador, como `competitionPenalty` del agente web
  // (con 0.4 se iba de objetivos que igual rendían: "a veces hay competencia pero
  // no es mejor que yo").
  PLAYER_RADIUS: 5,
  COMPETITION_FACTOR: 0.7,
  // Solo se consideran monstruos a menos de esto (Chebyshev, tiles).
  SCAN: 28,
  // EMA de lo aprendido: nuevo = viejo × EMA_OLD + medido × (1 − EMA_OLD).
  EMA_OLD: 0.7,
  // Kills grandes llegan partidos en tramos de 65535 (AddedExperience es u16)
  // para el mismo KilledObjectId: tramos dentro de esta ventana se suman.
  SPLIT_WINDOW_MS: 1500,
  // Tiempos de kill fuera de (0, esto) son ruido (perseguir a uno que huye,
  // el objetivo quedó colgado): no se aprenden.
  MAX_KILL_SAMPLE_SEC: 60,
  // Tope del registro id → tipo (los ids se reciclan; se limpia entero).
  NET_INFO_MAX: 3000,
} as const;
export type FarmParams = typeof FARM;

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

const ema = (prev: number | undefined, x: number, old: number) => (prev == null ? x : prev * old + x * (1 - old));

// ---------------------------------------------------------------------------
// Aprendizaje por tipo de monstruo: exp por kill y segundos hasta matarlo.
// ---------------------------------------------------------------------------
export type TypeKnowledge = {
  expByType: Record<number, number>;
  killSecByType: Record<number, number>;
};

export class MonsterTypeStats {
  expByType: Record<number, number> = {};
  killSecByType: Record<number, number> = {};

  /**
   * @param maxHpOf vida máxima por TypeNumber. En el protocolo headless no llega
   *   (el cliente web la tiene en su attributeSystem): sale de `data/monsters.json`
   *   (`HP` por `Numb`). null = desconocida (ej. los custom >= 300 de este server).
   */
  constructor(
    private readonly maxHpOf: (type: number) => number | null,
    private readonly p: FarmParams = FARM,
    init?: Partial<TypeKnowledge>,
  ) {
    if (init?.expByType) this.expByType = { ...init.expByType };
    if (init?.killSecByType) this.killSecByType = { ...init.killSecByType };
  }

  snapshot(): TypeKnowledge {
    return { expByType: { ...this.expByType }, killSecByType: { ...this.killSecByType } };
  }

  // Valor crudo (sin EMA): lo usa ExpSplitTracker para reescribir el kill partido.
  setExp(type: number, v: number) {
    this.expByType[type] = v;
  }

  recordKillSec(type: number, secs: number) {
    if (!(secs > 0 && secs < this.p.MAX_KILL_SAMPLE_SEC)) return;
    this.killSecByType[type] = ema(this.killSecByType[type], secs, this.p.EMA_OLD);
  }

  // Mediana de exp/sqrt(vida) entre los tipos medidos con vida conocida. En MU
  // la exp va con el NIVEL del monstruo, que crece mucho más lento que su vida;
  // el usuario lo confirmó jugando: con monstruos más débiles sube más rápido.
  expPerSqrtHp(): number | null {
    const xs: number[] = [];
    for (const [k, exp] of Object.entries(this.expByType)) {
      const hp = this.maxHpOf(Number(k));
      if (hp && hp > 0) xs.push(exp / Math.sqrt(hp));
    }
    return median(xs);
  }

  // Daño por segundo efectivo medido: mediana de vida/segundos-de-kill.
  dps(): number | null {
    const xs: number[] = [];
    for (const [k, secs] of Object.entries(this.killSecByType)) {
      const hp = this.maxHpOf(Number(k));
      if (hp && hp > 0 && secs > 0) xs.push(hp / secs);
    }
    return median(xs);
  }

  // Exp esperada por kill: lo medido, o sqrt(vida) × mediana(exp/sqrt(vida)).
  expOf(type: number): number {
    const known = this.expByType[type];
    if (known != null) return known;
    const k = this.expPerSqrtHp() ?? this.p.DEFAULT_EXP_PER_SQRT_HP;
    const hp = this.maxHpOf(type);
    if (hp && hp > 0) return Math.sqrt(hp) * k;
    // Vida desconocida: la mediana de lo medido (o, sin nada, el default con vida 1).
    return median(Object.values(this.expByType)) ?? k;
  }

  // Segundos esperados hasta matarlo: lo medido, o vida / dps × pesimismo.
  killSecOf(type: number): number {
    const known = this.killSecByType[type];
    if (known != null) return known;
    const dps = this.dps();
    const hp = this.maxHpOf(type);
    if (dps && hp && hp > 0) return (hp / dps) * this.p.UNKNOWN_PESSIMISM;
    return this.p.DEFAULT_KILL_SEC;
  }
}

// ---------------------------------------------------------------------------
// Exp por kill partida: ExperienceGained (C3 16) trae {KilledObjectId u16 BE @3,
// AddedExperience u16 BE @5, DamageOfLastHit @7}. Un kill de más de 65535 exp
// llega como varios packets seguidos con el mismo KilledObjectId: se suman los
// que caen dentro de SPLIT_WINDOW_MS y el EMA se recalcula sobre la suma (no
// sobre cada tramo, que daría un promedio basura).
//
// Cuando llega el evento el monstruo ya salió del scope: el tipo y la posición
// se buscan en el registro de ids vistos (`netInfo`).
// ---------------------------------------------------------------------------
export type NetInfo = { type: number; x: number; y: number; map: number };

export type ExpEvent = {
  info: NetInfo | null; // null = id que no vimos (exp sin kill nuestro identificable)
  added: number;
  sum: number;          // exp total de ese kill hasta ahora (suma de tramos)
  continuation: boolean;
};

export class ExpSplitTracker {
  readonly netInfo = new Map<number, NetInfo>();
  private last: { id: number; t: number; sum: number; prev: number | undefined } | null = null;

  constructor(private readonly stats: MonsterTypeStats, private readonly p: FarmParams = FARM) {}

  // Anotar cada monstruo visto (al entrar al scope y cuando se mueve).
  see(id: number, info: NetInfo) {
    if (this.netInfo.size >= this.p.NET_INFO_MAX && !this.netInfo.has(id)) this.netInfo.clear();
    this.netInfo.set(id, info);
  }

  onExp(killedId: number, added: number, now: number): ExpEvent {
    const info = this.netInfo.get(killedId) ?? null;
    if (!info || added <= 0) return { info, added, sum: added, continuation: false };
    const k = info.type;
    const last = this.last;
    if (last && last.id === killedId && now - last.t < this.p.SPLIT_WINDOW_MS) {
      last.sum += added;
      last.t = now;
      this.stats.setExp(k, ema(last.prev, last.sum, this.p.EMA_OLD));
      return { info, added, sum: last.sum, continuation: true };
    }
    const prev = this.stats.expByType[k];
    this.last = { id: killedId, t: now, sum: added, prev };
    this.stats.setExp(k, ema(prev, added, this.p.EMA_OLD));
    return { info, added, sum: added, continuation: false };
  }
}

// ---------------------------------------------------------------------------
// Elección de objetivo: exp/segundo esperada.
//   valor = (exp(tipo) + densidad) / (seg_kill(tipo) + distancia × SEC_PER_TILE)
//           × COMPETITION_FACTOR ^ (jugadores a <= PLAYER_RADIUS del objetivo)
//   densidad = Σ CROWD_WEIGHT × exp(otro) para otros a <= CROWD_RADIUS.
// Los que tardan > MAX_KILL_SEC se descartan si hay alguno más rápido.
// ---------------------------------------------------------------------------
export type Candidate = { id: number; type: number; x: number; y: number };
export type Pos = { x: number; y: number };
export type TargetPick<C extends Candidate> = { target: C; rate: number; rivals: number } | null;

const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export function targetRate(
  me: Pos, c: Candidate, pool: readonly Candidate[], players: readonly Pos[], stats: MonsterTypeStats, p: FarmParams = FARM,
): { rate: number; rivals: number } {
  let crowd = 0;
  for (const o of pool) if (o !== c && cheb(o, c) <= p.CROWD_RADIUS) crowd += stats.expOf(o.type) * p.CROWD_WEIGHT;
  const rivals = players.filter((q) => cheb(q, c) <= p.PLAYER_RADIUS).length;
  const secs = stats.killSecOf(c.type) + cheb(me, c) * p.SEC_PER_TILE;
  const rate = ((stats.expOf(c.type) + crowd) / Math.max(secs, 0.1)) * Math.pow(p.COMPETITION_FACTOR, rivals);
  return { rate, rivals };
}

export function pickTarget<C extends Candidate>(
  me: Pos, monsters: readonly C[], players: readonly Pos[], stats: MonsterTypeStats, p: FarmParams = FARM,
): TargetPick<C> {
  const inRange = monsters.filter((m) => cheb(me, m) < p.SCAN);
  const easy = inRange.filter((m) => stats.killSecOf(m.type) <= p.MAX_KILL_SEC);
  const pool = easy.length ? easy : inRange;
  let best: TargetPick<C> = null;
  for (const m of pool) {
    const r = targetRate(me, m, pool, players, stats, p);
    if (!best || r.rate > best.rate) best = { target: m, rate: r.rate, rivals: r.rivals };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Registro de exp POR SEGUNDO (un bucket por segundo).
//
// Los kills grandes llegan partidos en tramos de 65535 (~60 ExperienceGained
// por kill a nivel alto). El agente web guardaba un registro por evento con
// tope fijo (5000): cubría ~30 s de juego, así que toda medición de 1-3 min
// (spots, campamentos, autoajuste) salía truncada. Con un bucket por segundo,
// MAX_BUCKETS segundos cubren horas sin importar cuántos tramos lleguen.
//
// Todas las mediciones de exp/min por ventana del bot salen de acá y dividen
// por la ventana REAL cubierta (si el registro empezó hace 2 min, "exp/min en
// 30 min" divide por 2 min, no por 30).
// ---------------------------------------------------------------------------
export class ExpLog {
  private buckets: Array<{ t: number; n: number }> = [];
  readonly startedAt: number;

  constructor(now: number, private readonly maxBuckets = 6 * 3600) {
    this.startedAt = now;
  }

  get size(): number {
    return this.buckets.length;
  }

  add(n: number, now: number) {
    if (!(n > 0)) return;
    const t = Math.floor(now / 1000) * 1000;
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.t === t) last.n += n;
    else {
      this.buckets.push({ t, n });
      if (this.buckets.length > this.maxBuckets) this.buckets.shift();
    }
  }

  // Exp ganada desde `t` (inclusive, al segundo) hasta ahora.
  sumSince(t: number): number {
    const from = Math.floor(t / 1000) * 1000;
    let s = 0;
    for (let i = this.buckets.length - 1; i >= 0 && this.buckets[i].t >= from; i--) s += this.buckets[i].n;
    return s;
  }

  // Exp/min desde `since` hasta `now` (ventana real; 0 si todavía no pasó tiempo).
  rateSince(since: number, now: number): number {
    const ms = now - Math.max(since, this.startedAt);
    return ms > 0 ? this.sumSince(Math.max(since, this.startedAt)) / (ms / 60_000) : 0;
  }

  // Exp/min en la ventana [now − ms, now], recortada a lo que el registro cubre.
  perMin(now: number, ms: number): number {
    return this.rateSince(now - ms, now);
  }
}

// ---------------------------------------------------------------------------
// Autoevaluación: exp/min reciente y en qué se va el tiempo.
// ---------------------------------------------------------------------------
export type TimeKind = 'fight' | 'walk' | 'wait' | 'other';

export class SelfReport {
  readonly exp: ExpLog;
  readonly time: Record<TimeKind, number> = { fight: 0, walk: 0, wait: 0, other: 0 };
  readonly cyclesMin: number[] = [];
  cycleStart: number;

  constructor(now: number, exp?: ExpLog) {
    this.cycleStart = now;
    this.exp = exp ?? new ExpLog(now);
  }

  addExp(n: number, now: number) {
    this.exp.add(n, now);
  }

  addTime(kind: TimeKind, ms: number) {
    if (ms > 0) this.time[kind] += ms;
  }

  // Exp por minuto en la ventana [now − ms, now] (ventana real, ver ExpLog).
  expPerMin(now: number, ms: number): number {
    return this.exp.perMin(now, ms);
  }

  // Terminó un ciclo de reset: guarda su duración y arranca otro.
  cycleDone(now: number) {
    this.cyclesMin.push(Math.round((now - this.cycleStart) / 60_000));
    this.cycleStart = now;
  }

  timePct(): Record<TimeKind, number> {
    const tot = this.time.fight + this.time.walk + this.time.wait + this.time.other || 1;
    const out = {} as Record<TimeKind, number>;
    for (const k of Object.keys(this.time) as TimeKind[]) out[k] = Math.round((100 * this.time[k]) / tot);
    return out;
  }

  format(now: number, level: number, resets: number, extra = ''): string {
    const pct = this.timePct();
    const cycles = this.cyclesMin.length ? this.cyclesMin.map((m) => `${m} min`).join(', ') : 'ninguno completo';
    return [
      `Autoevaluación: nivel ${level}, resets ${resets}${extra ? `, ${extra}` : ''}`,
      `  exp/min: ${Math.round(this.expPerMin(now, 5 * 60_000))} (5 min), ${Math.round(this.expPerMin(now, 30 * 60_000))} (30 min)`,
      `  tiempo: peleando ${pct.fight}%, caminando ${pct.walk}%, esperando ${pct.wait}%, otro ${pct.other}%`,
      `  ciclos de reset: ${cycles} (actual: ${Math.round((now - this.cycleStart) / 60_000)} min)`,
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Registro de tramos por ciclo: minuto (desde el inicio del ciclo) en que se
// llegó a cada nivel hito. Persiste en learning.json para comparar ciclos y
// proyectar resets/día (como `ai.cycleLog` del agente web).
// ---------------------------------------------------------------------------
export const CYCLE_MARKS = [20, 50, 100, 200, 300, 350, 400] as const;
export type CycleRecord = { start: number; end?: number; min?: number; marks: Record<number, number> };

export class CycleLog {
  cur: CycleRecord;
  readonly done: CycleRecord[];

  constructor(now: number, init?: { cur?: CycleRecord | null; done?: CycleRecord[] }, private readonly keep = 200) {
    this.done = [...(init?.done ?? [])];
    this.cur = init?.cur ? { start: init.cur.start, marks: { ...init.cur.marks } } : { start: now, marks: {} };
  }

  // Devuelve los hitos nuevos alcanzados (para loguearlos).
  observe(level: number, now: number): number[] {
    const out: number[] = [];
    for (const m of CYCLE_MARKS) {
      if (level >= m && this.cur.marks[m] == null) {
        this.cur.marks[m] = +((now - this.cur.start) / 60_000).toFixed(1);
        out.push(m);
      }
    }
    return out;
  }

  // Reset hecho: cierra el ciclo (solo se guarda si llegó al 400: un ciclo
  // empezado a la mitad, p.ej. al arrancar el bot en nivel 250, no compara).
  reset(now: number): CycleRecord | null {
    let closed: CycleRecord | null = null;
    if (this.cur.marks[400] != null) {
      closed = { ...this.cur, end: now, min: +((now - this.cur.start) / 60_000).toFixed(1) };
      this.done.push(closed);
      if (this.done.length > this.keep) this.done.splice(0, this.done.length - this.keep);
    }
    this.cur = { start: now, marks: {} };
    return closed;
  }

  // Promedio de minutos por ciclo de los últimos `n` y resets/día proyectados.
  projection(n = 5): { cycles: number; avgMin: number | null; perDay: number | null } {
    const last = this.done.slice(-n).filter((c) => c.min && c.min > 0);
    if (!last.length) return { cycles: 0, avgMin: null, perDay: null };
    const avg = last.reduce((a, c) => a + c.min!, 0) / last.length;
    return { cycles: last.length, avgMin: +avg.toFixed(1), perDay: Math.round(1440 / avg) };
  }

  format(n = 5): string {
    const p = this.projection(n);
    const marks = (c: CycleRecord) => CYCLE_MARKS.filter((m) => c.marks[m] != null).map((m) => `${m}@${c.marks[m]}`).join(' ') || '-';
    const lines = [`  ciclo actual: ${marks(this.cur)}`];
    for (const c of this.done.slice(-n)) lines.push(`  ciclo ${c.min} min (${Math.round(1440 / (c.min || 1))}/día): ${marks(c)}`);
    lines.push(p.perDay != null ? `  proyección: ${p.perDay} resets/día (promedio ${p.avgMin} min, ${p.cycles} ciclo(s))` : '  proyección: sin ciclos completos todavía');
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Reparto de puntos del Dark Knight con Twisting Slash (agente web, planStats):
//   daño del skill ≈ (fuerza/4) × (2 + energía/1000)
//   rinden igual cuando energía ≈ fuerza − 2000: debajo, todo a energía;
//   arriba, mitad y mitad. Vitalidad: VIT_SHARE (con 15% la vida y el maná
//   quedaban siempre llenos en Arena 4; el usuario bajó a 5%).
// ---------------------------------------------------------------------------
export const STATS_PLAN = { VIT_SHARE: 0.05, ENE_GAP: 2000 } as const;

export function planStats(points: number, str: number, ene: number, p = STATS_PLAN): { ene: number; str: number; vit: number } {
  if (!(points > 0)) return { ene: 0, str: 0, vit: 0 };
  const vit = Math.floor(points * p.VIT_SHARE);
  let left = points - vit;
  const gap = Math.max(0, str - p.ENE_GAP - ene);
  const toEne = Math.min(left, gap);
  left -= toEne;
  const half = Math.floor(left / 2);
  return { ene: toEne + half, str: left - half, vit };
}

// ---------------------------------------------------------------------------
// Loot valioso (agente web, isValuable): cajas (Box of Kundun 14/11), joyas
// (Bless 14/13, Soul 14/14, Life 14/16, Creation 14/22, Guardian 14/31, Chaos
// 12/15), ítems excelentes y los guantes 10/1 (le faltan al set de Horaz). El
// zen y el equipo común NO se levantan: cada viaje a levantar es tiempo sin pelear.
// ---------------------------------------------------------------------------
export const VALUABLE_JEWELS_14 = new Set([11, 13, 14, 16, 22, 31]);
export type DropInfo = { group: number; num: number; isMoney?: boolean; excellent?: boolean };

// Solo cajas (14/11: Box of Luck / de Kundun). Usuario 2026-10-11: las joyas se compran en Lorencia y
// llenaban el inventario; los excelentes que caen no sirven (y al tirarlos se volvían a levantar).
export function isValuableDrop(d: DropInfo): boolean {
  if (d.isMoney) return false;
  return d.group === 14 && d.num === 11;
}

// El drop valioso más cercano a <= radius (o null).
export function pickLoot<D extends DropInfo & Pos>(me: Pos, drops: Iterable<D>, radius = 12): D | null {
  let best: D | null = null;
  let bd = Infinity;
  for (const d of drops) {
    if (!isValuableDrop(d)) continue;
    const dd = cheb(me, d);
    if (dd <= radius && dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}
