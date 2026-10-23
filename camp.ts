/**
 * Campamentos: cómo juega una persona. Elegir un lugar, pelear ahí mientras
 * rinde, mudarse cuando no. Portado del agente web (`browser/browser-agent.js`:
 * findCamp, pickTarget, campMem, curiosidad, correa, hambre, caster), que es el
 * que juega hoy con el usuario y aprendió cada regla en vivo.
 *
 * Lógica PURA (sin red, sin EventBus, sin `world`): recibe posiciones, eventos
 * y reloj por parámetro, así se testea offline en `camp-tests.ts`.
 * `farm-loop.ts` la engancha en `autonomousLoop`. Ver AGENTS.md,
 * "Campamentos".
 *
 * Coordenadas: (x, y) del protocolo = (x, z) del cliente web. "Arriba" en
 * pantalla es (-x, +y); "abajo" es (+x, -y).
 */
import { FARM, type Candidate, type ExpLog, type MonsterTypeStats, type Pos, targetRate } from './farming';

export const CAMP = {
  // Se pelea solo a <= RADIUS del centro del campamento.
  RADIUS: 10,
  // Tras EVAL_MS en el campamento, si rinde < MIN_FRAC de la vara del mapa, mudarse.
  EVAL_MS: 90_000,
  MIN_FRAC: 0.5,
  // Si la tasa reciente se desploma aunque el promedio histórico del mismo
  // campamento siga alto, buscar otro grupo en vez de esperar a que se vacíe.
  RECENT_WINDOW_MS: 45_000,
  RECENT_DROP_FRAC: 0.7,
  // Vacío (sin objetivo dentro del radio) durante EMPTY_MS → mudarse. El reloj
  // corre solo desde que llegó: mientras viaja no cuenta (si no, lo abandonaba a
  // mitad de camino y elegía otro: iba y venía).
  EMPTY_MS: 12_000,
  // Vara del mapa = PROMEDIO MÓVIL de lo que rindieron sus campamentos (no el
  // máximo: un campamento con suerte subía la vara y hacía abandonar spots
  // estables). nuevo = viejo × BEST_EMA_OLD + medido × (1 − BEST_EMA_OLD).
  BEST_EMA_OLD: 0.7,
  // Competencia: >= CROWD_RIVALS jugadores a <= RADIUS+2 durante CROWD_MS, Y la
  // exp del campamento < CROWD_MIN_FRAC de la vara ("a veces hay competencia pero
  // no es mejor que yo", usuario). Con 2 jugadores/10 s saltaba todo el tiempo.
  CROWD_RIVALS: 3,
  CROWD_MS: 20_000,
  CROWD_MIN_FRAC: 0.7,
  CROWD_MIN_STAY_MS: 45_000,
  // 2 campamentos abandonados por gente en 2 min = el spot entero está lleno.
  CROWD_LEAVES_WINDOW_MS: 120_000,
  CROWD_LEAVES_TO_MOVE: 2,
  // Caminar cuesta: a DIST_DECAY tiles un campamento vale la mitad.
  DIST_DECAY: 12,
  // Penalización por jugador cerca de un campamento candidato (como la de objetivo).
  COMPETITION_PENALTY: 0.3,
  // Entre objetivos/campamentos casi iguales en EXP/s, variar la elección.
  // El objetivo elegido se mantiene hasta morir; esto no provoca zigzag.
  CHOICE_NEAR_BEST_FRAC: 0.95,
  // En camino: pelear con lo que esté a <= EN_ROUTE_SCAN; si hay >= CLUSTER_STOP
  // monstruos juntos a <= EN_ROUTE_SCAN, acampar ahí mismo.
  EN_ROUTE_SCAN: 8,
  CLUSTER_STOP: 3,
  TRAVEL_FIGHT_MS: 10_000,
  // Un campamento recién dejado no se vuelve a elegir durante esto.
  LEFT_MEMORY_MS: 120_000,
  // Si no llega al centro en esto (sin contar el tiempo peleando en el camino), se abandona.
  WALK_TIMEOUT_MS: 60_000,
  // Curiosidad: probar tipos nuevos solo si su ROI se acerca al mejor objetivo.
  CURIOSITY_RADIUS: 8,
  CURIOSITY_KILLS: 3,
  CURIOSITY_MIN_RATE_FRAC: 0.7,
  // Recién llegado de un warp: no elegir campamento (el scope puede traer
  // monstruos del mapa anterior); solo pelear a <= ARRIVAL_SCAN.
  ARRIVAL_PENDING_MS: 3000,
  ARRIVAL_SCAN: 6,
  // Correa: en estos mapas, todo a <= LEASH_DIST de la llegada del último warp.
  // Devias 1-4 son el MISMO mapa (2) con entradas lejanas; saltando de campamento
  // en campamento terminaba en la zona de Devias 1. En Arena los buenos están
  // ADENTRO, lejos de la llegada: sin correa.
  LEASH_DIST: 25,
  LEASH_MAPS: [2] as readonly number[],
  // Skill de área con CUALQUIER monstruo a <= CAST_RANGE (Twisting Slash gira
  // alrededor del DK; con 6 giraba en el aire).
  CAST_RANGE: 3,
  // Memoria de campamentos.
  MEM_DIST: 40,               // sin campamento: ir al mejor conocido a <= esto
  MEM_LEVEL_WINDOW: 150,      // ... medido a nivel parecido
  MEM_ARRIVAL_LEVEL_WINDOW: 60, // al llegar a un mapa: el mejor aprendido a ±60 niveles
  MEM_MIN_MS: 45_000,         // estadías más cortas no se guardan
  MEM_EMA_OLD: 0.6,
  MEM_NEAR: 4,                // a <= esto es "el mismo" campamento
  // Exploración del personaje estricto: celdas de 12, desde 4 monstruos juntos, una vez cada 20 min.
  SCOUT_CELL: 12,
  SCOUT_MIN_DENSITY: 4,
  SCOUT_RETRY_MS: 20 * 60_000,
  MEM_MAX_PER_MAP: 20,
  MEM_LEFT_MS: 60_000,
  // Hambre: casi nada de exp en los últimos HUNGER_WINDOW_MS con jugadores cerca
  // → irse YA, sin esperar a las reglas del campamento. Pasó en vivo en Devias 3:
  // 2M exp/min con un jugador a 1 tile y no se movía.
  HUNGER_WINDOW_MS: 45_000,
  HUNGER_FRAC: 0.25,
  // Sin referencia del tramo todavía: hambre solo si no ganó NADA. Con un piso fijo (5M/min) Horaz,
  // recién reseteado en Devias (0,5-2,5M/min), se creía con hambre a los 45 s y saltaba de spot antes
  // del minuto que hace falta para aprender la referencia: Devias 3 → 4 → 2 sin parar (2026-10-11).
  HUNGER_DEFAULT_RATE: 1,
  HUNGER_RIVAL_DIST: 12,
  HUNGER_SKIP_AFTER_WARP_MS: 60_000, // la referencia no aprende del primer minuto tras un warp
  HUNGER_MIN_AFTER_WARP_MS: 45_000,
  HUNGER_EMA_OLD: 0.95,
  HUNGER_UPDATE_MS: 1000,     // la referencia se actualiza a lo sumo 1 vez/s
} as const;
export type CampParams = typeof CAMP;

const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// ---------------------------------------------------------------------------
// Reglas fijas por mapa (lo que dijo el usuario), solo si no hay nada aprendido.
// ---------------------------------------------------------------------------
// Lorencia: los esqueletos de la cripta (salida de "arriba"). Sin esto daba
// vueltas cerca del pueblo sin monstruos.
export const START_CAMPS: Record<number, Pos> = { 0: { x: 132, y: 200 } };
// Devias (2): "el spot está arriba" de la llegada. Arriba en pantalla = (-x, +y).
export const ARRIVAL_SPOT_DIR: Record<number, [number, number]> = { 2: [-1, 1] };
export const ARRIVAL_SPOT_DIST = 12; // dentro de 8-18 tiles, como el agente web
// Arenas (83/84/85 = Arena 2/3/4): la "zona de abajo" (+x, −y) está llena de
// monstruos de mucha exp (125-129). El agente web la calcula con la grilla de
// caminables del cliente (downZone); el headless no la calcula (los .att
// de estos mapas custom no están en ~/self/mu/public/game-assets), así que usa lo
// que dio el agente web en vivo: (91,13) en Arena 3 y 4. Arena 2 se asume igual
// (mismo diseño de mapa), SIN VERIFICAR.
export const DOWN_ZONE_MAPS = [83, 84, 85] as const;
export const DOWN_ZONE_DEFAULT: Record<number, Pos> = { 83: { x: 91, y: 13 }, 84: { x: 91, y: 13 }, 85: { x: 91, y: 13 } };

// ---------------------------------------------------------------------------
// Memoria de campamentos: posición + exp/min real + nivel + n, por mapa.
// Persiste en learning.json (entre resets y reinicios del bot).
// ---------------------------------------------------------------------------
// power: suma de stats con que se midió (sin ella, dato viejo: el personaje débil no lo usa).
export type KnownCamp = { map: number; x: number; y: number; rate: number; n: number; level: number; power?: number };

/** ¿Medido con stats parecidos (±20 %)? */
export const samePower = (a: number | undefined, b: number) => a != null && a > 0 && b > 0 && Math.abs(a - b) <= b * 0.2;

export class CampMemory {
  private byMap = new Map<number, KnownCamp[]>();

  constructor(private readonly p: CampParams = CAMP, init?: readonly KnownCamp[]) {
    if (init) for (const c of init) if ([c.map, c.x, c.y, c.rate, c.n, c.level].every(Number.isFinite)) this.list(c.map).push({ ...c });
  }

  list(map: number): KnownCamp[] {
    let l = this.byMap.get(map);
    if (!l) this.byMap.set(map, (l = []));
    return l;
  }

  dump(): KnownCamp[] {
    return [...this.byMap.values()].flat().map((c) => ({ ...c }));
  }

  record(map: number, x: number, y: number, rate: number, level: number, power = 0) {
    const l = this.list(map);
    const near = l.find((c) => cheb(c, { x, y }) <= this.p.MEM_NEAR);
    if (near && (power <= 0 || samePower(near.power, power))) {
      near.rate = near.rate * this.p.MEM_EMA_OLD + rate * (1 - this.p.MEM_EMA_OLD);
      near.n++;
      near.level = level;
    } else if (near) {
      // Medido con otros stats (antes de un grand reset): lo nuevo reemplaza a lo viejo.
      Object.assign(near, { x, y, rate, n: 1, level, power });
    } else l.push({ map, x, y, rate, n: 1, level, ...(power > 0 ? { power } : {}) });
    l.sort((a, b) => b.rate - a.rate);
    if (l.length > this.p.MEM_MAX_PER_MAP) l.length = this.p.MEM_MAX_PER_MAP;
  }

  /**
   * Campamentos medidos en la base (ClickHouse, horas de ticks por celda): pisan al aprendido
   * cercano (la base promedia más tiempo que el EMA local) o se agregan.
   */
  seed(camps: readonly KnownCamp[]) {
    for (const c of camps) {
      if (![c.map, c.x, c.y, c.rate, c.n, c.level].every(Number.isFinite) || c.n < 1) continue;
      const l = this.list(c.map);
      const near = l.find((k) => cheb(k, c) <= this.p.MEM_NEAR && Math.abs(k.level - c.level) <= this.p.MEM_ARRIVAL_LEVEL_WINDOW);
      if (near) Object.assign(near, { rate: c.rate, level: c.level, n: Math.max(near.n, c.n) });
      else l.push({ ...c });
    }
    for (const l of this.byMap.values()) {
      l.sort((a, b) => b.rate - a.rate);
      if (l.length > this.p.MEM_MAX_PER_MAP) l.length = this.p.MEM_MAX_PER_MAP;
    }
  }

  // Al llegar a un mapa: el mejor aprendido a nivel parecido (±60) que cumpla `accept`.
  bestForArrival(map: number, level: number, accept: (p: KnownCamp) => boolean): KnownCamp | null {
    return (
      this.list(map)
        .filter((k) => Math.abs(k.level - level) <= this.p.MEM_ARRIVAL_LEVEL_WINDOW && k.n >= 1 && accept(k))
        .sort((a, b) => b.rate - a.rate)[0] ?? null
    );
  }

  // Sin campamento: el mejor conocido cerca (rate / (1 + d/12)).
  nearBest(map: number, me: Pos, level: number, accept: (p: KnownCamp) => boolean): KnownCamp | null {
    const score = (c: KnownCamp) => c.rate / (1 + cheb(c, me) / this.p.DIST_DECAY);
    return (
      this.list(map)
        .filter((c) => cheb(c, me) <= this.p.MEM_DIST && Math.abs(c.level - level) < this.p.MEM_LEVEL_WINDOW && accept(c))
        .sort((a, b) => score(b) - score(a))[0] ?? null
    );
  }
}

// ---------------------------------------------------------------------------
// Hambre (punto 15): referencia de exp/min por tramo de la ruta (promedio
// móvil 0.95/0.05, sin contar el primer minuto tras un warp). Si en los últimos
// 45 s la exp/min es < 25% de la referencia (o < 5M/min sin referencia) y hay
// >= 1 jugador a <= 12 tiles, hay que irse YA.
// ---------------------------------------------------------------------------
export class Hunger {
  readonly ref: Record<string, number>;
  private lastUpdate = -Infinity;

  constructor(private readonly p: CampParams = CAMP, init?: Record<string, number>) {
    this.ref = { ...(init ?? {}) };
  }

  check(inp: { now: number; tier: number; recentRate: number; lastWarpAt: number; rivalsNear: number }): { starving: boolean; ref: number | null } {
    const key = `t${inp.tier}`;
    const sinceWarp = inp.now - inp.lastWarpAt;
    if (sinceWarp > this.p.HUNGER_SKIP_AFTER_WARP_MS && inp.recentRate > 0 && inp.now - this.lastUpdate >= this.p.HUNGER_UPDATE_MS) {
      this.lastUpdate = inp.now;
      const prev = this.ref[key];
      this.ref[key] = prev == null ? inp.recentRate : prev * this.p.HUNGER_EMA_OLD + inp.recentRate * (1 - this.p.HUNGER_EMA_OLD);
    }
    const ref = this.ref[key] ?? null;
    const floor = ref != null ? ref * this.p.HUNGER_FRAC : this.p.HUNGER_DEFAULT_RATE;
    const starving = sinceWarp > this.p.HUNGER_MIN_AFTER_WARP_MS && inp.rivalsNear >= 1 && inp.recentRate < floor;
    return { starving, ref };
  }
}

// ---------------------------------------------------------------------------
// Skill de área "en el camino": el objetivo si está a <= range, si no el
// monstruo más cercano a <= range (tenga objetivo o no, aunque esté caminando).
// ---------------------------------------------------------------------------
export function castCandidate<C extends Pos>(me: Pos, monsters: Iterable<C>, target: C | null, range: number = CAMP.CAST_RANGE): C | null {
  if (target && cheb(me, target) <= range) return target;
  let best: C | null = null;
  let bd = Infinity;
  for (const m of monsters) {
    const d = cheb(me, m);
    if (d <= range && d < bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// El manager de campamentos.
// ---------------------------------------------------------------------------
export type Camp = {
  map: number;
  x: number;
  y: number;
  since: number;
  arrivedAt: number | null; // primera vez a <= RADIUS
  lastSeen: number;         // último objetivo dentro del radio (o mientras viaja)
  walkSince: number;        // para WALK_TIMEOUT_MS: se reinicia al pelear en el camino
  crowdSince: number | null;
  counted: boolean;         // ya aportó a la vara del mapa
  why: string;
  // Elegido por lo medido (memoria, base o zona conocida): en camino no se cambia por
  // 3 monstruos juntos. Hume en Arena 3/4 acampaba junto a la llegada (73-245M/min)
  // en vez de ir a (80,64) (554M/min).
  planned?: boolean;
};
export type Arrival = { map: number; x: number; y: number };
export type CampGoal = { x: number; y: number; kind: 'camp' | 'llegada' };

export type PickInput<C extends Candidate> = {
  now: number;
  map: number;
  me: Pos;
  level: number;
  monsters: readonly C[];
  players: readonly Pos[];
  stats: MonsterTypeStats;
  exp: ExpLog;
  typeKills: Readonly<Record<number, number>>;
};

export class CampManager {
  camp: Camp | null = null;
  arrival: Arrival | null = null;
  arrivalPendingUntil = 0;
  // Vara por mapa (promedio móvil de lo que rindieron sus campamentos). Se
  // reinicia en cada reset (depende del nivel).
  readonly best: Record<number, number> = {};
  readonly left: Array<{ map: number; x: number; y: number; at: number }> = [];
  crowdLeaves: number[] = [];
  readonly memory: CampMemory;
  // Lo que pasó en la última llamada (para loguear en el bot).
  events: string[] = [];

  constructor(private readonly p: CampParams = CAMP, memory?: CampMemory, private readonly rand: () => number = () => 0) {
    this.memory = memory ?? new CampMemory(p);
  }

  // --- Potencia y exploración ---------------------------------------------
  // strict: personaje que elige mapa por lo medido (farm-middleware.ts). Solo usa campamentos medidos
  // con sus stats y explora los grupos densos de monstruos del mapa en vez de quedarse junto a la
  // llegada (Hume tras el grand reset: siempre "arriba" de la Arena).
  private power = 0;
  private strict = false;
  // Densidad vista por celda: monstruos atacables a la vista (en vivo o de la base, de cualquier personaje).
  private readonly density = new Map<number, Map<number, { x: number; y: number; d: number }>>();
  // Celdas exploradas (y cuándo): no se repiten hasta SCOUT_RETRY_MS.
  private readonly scouted = new Map<string, number>();

  setPower(power: number, strict: boolean) {
    this.power = power;
    this.strict = strict;
  }

  private fits = (k: KnownCamp) => !this.strict || samePower(k.power, this.power);

  private densityOf(map: number) {
    let m = this.density.get(map);
    if (!m) this.density.set(map, (m = new Map()));
    return m;
  }

  /** Densidad en vivo: cuántos monstruos atacables hay juntos en cada celda de SCOUT_CELL. */
  observeDensity(map: number, monsters: readonly Pos[]) {
    const cells = new Map<number, { n: number; sx: number; sy: number }>();
    const C = this.p.SCOUT_CELL;
    for (const m of monsters) {
      const k = Math.floor(m.y / C) * 64 + Math.floor(m.x / C);
      const c = cells.get(k) ?? { n: 0, sx: 0, sy: 0 };
      c.n++; c.sx += m.x; c.sy += m.y;
      cells.set(k, c);
    }
    const dm = this.densityOf(map);
    for (const [k, c] of cells) {
      const prev = dm.get(k);
      const at = { x: Math.round(c.sx / c.n), y: Math.round(c.sy / c.n), d: c.n };
      if (!prev || c.n >= prev.d) dm.set(k, at);
      else prev.d = prev.d * 0.9 + c.n * 0.1;
    }
  }

  /** Densidad medida en la base (promedio de monstruos cerca por celda). */
  seedDensity(cells: readonly { map: number; x: number; y: number; d: number }[]) {
    const C = this.p.SCOUT_CELL;
    for (const c of cells) {
      if (![c.map, c.x, c.y, c.d].every(Number.isFinite)) continue;
      const dm = this.densityOf(c.map);
      const k = Math.floor(c.y / C) * 64 + Math.floor(c.x / C);
      if (!dm.has(k) || dm.get(k)!.d < c.d) dm.set(k, { x: c.x, y: c.y, d: c.d });
    }
  }

  /** Próxima celda densa sin medir con estos stats (solo el personaje estricto). */
  scoutTarget(map: number, me: Pos, level: number, now: number): (Pos & { d: number }) | null {
    if (!this.strict) return null;
    const measured = this.memory.list(map).filter((k) => this.fits(k) && Math.abs(k.level - level) <= this.p.MEM_LEVEL_WINDOW);
    const cands = [...this.densityOf(map).values()].filter((c) =>
      c.d >= this.p.SCOUT_MIN_DENSITY && this.inLeash(map, c) &&
      now - (this.scouted.get(`${map}:${Math.floor(c.x / this.p.SCOUT_CELL)}:${Math.floor(c.y / this.p.SCOUT_CELL)}`) ?? -Infinity) > this.p.SCOUT_RETRY_MS &&
      !measured.some((k) => cheb(k, c) <= this.p.SCOUT_CELL / 2) &&
      !this.recentlyLeft(map, c, now, this.p.MEM_LEFT_MS, this.p.RADIUS));
    const score = (c: { x: number; y: number; d: number }) => c.d / (1 + cheb(c, me) / 40);
    return cands.sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  private setScout(map: number, t: Pos & { d: number }, now: number) {
    this.scouted.set(`${map}:${Math.floor(t.x / this.p.SCOUT_CELL)}:${Math.floor(t.y / this.p.SCOUT_CELL)}`, now);
    this.setCamp(map, t.x, t.y, now, `exploro un grupo de ~${Math.round(t.d)} monstruos sin medir con estos stats`, true);
  }

  // --- Correa -------------------------------------------------------------
  leashFor(map: number): { x: number; y: number; r: number } | null {
    if (!this.arrival || this.arrival.map !== map || !this.p.LEASH_MAPS.includes(map)) return null;
    return { x: this.arrival.x, y: this.arrival.y, r: this.p.LEASH_DIST };
  }

  inLeash(map: number, p: Pos): boolean {
    const l = this.leashFor(map);
    return !l || cheb(p, l) <= l.r;
  }

  // --- Ciclo de vida ------------------------------------------------------
  // Un warp terminó (MapChanged): registrar la llegada y elegir el primer
  // campamento: lo aprendido primero; si no conoce nada, la regla del usuario.
  onArrival(map: number, x: number, y: number, now: number, level: number, localOnly = false, preferred?: Pos) {
    this.events = [];
    this.arrival = { map, x, y };
    this.arrivalPendingUntil = now + this.p.ARRIVAL_PENDING_MS;
    // Un campamento de otro mapa (o fuera de la correa) se descarta.
    if (this.camp && (this.camp.map !== map || !this.inLeash(map, this.camp))) this.leave(now, level, `descarto campamento (${this.camp.x},${this.camp.y}): lejos de la llegada`, false);
    if (this.camp) return;
    // El estricto usa lo medido con sus stats en cualquier parte del mapa; lo demás, cerca de la llegada.
    const known = this.memory.bestForArrival(map, level, (k) => this.inLeash(map, k) && this.fits(k) && (this.strict || !localOnly || cheb(k, { x, y }) <= 40));
    const scout = this.scoutTarget(map, { x, y }, level, now);
    if (scout) {
      this.setScout(map, scout, now);
      return;
    }
    if (known) {
      this.setCamp(map, known.x, known.y, now, `mejor spot aprendido (${known.x},${known.y}) ~${Math.round(known.rate / 1e6)}M exp/min (n=${known.n})`, true);
      return;
    }
    if (preferred && !localOnly) {
      this.setCamp(map, preferred.x, preferred.y, now, `zona medida (${preferred.x},${preferred.y})`, true);
      return;
    }
    const dir = ARRIVAL_SPOT_DIR[map];
    if (dir) {
      const clamp = (v: number) => Math.max(8, Math.min(247, Math.round(v)));
      this.setCamp(map, clamp(x + dir[0] * ARRIVAL_SPOT_DIST), clamp(y + dir[1] * ARRIVAL_SPOT_DIST), now, 'spot de llegada (arriba)');
      return;
    }
    // Un personaje que no puede con los Drakan no cruza toda la Arena hacia
    // una zona pensada para Horaz: primero busca monstruos atacables cerca.
    const down = localOnly ? undefined : DOWN_ZONE_DEFAULT[map];
    if (down) this.setCamp(map, down.x, down.y, now, 'zona de abajo', true);
  }

  // Reset hecho: la vara por mapa depende del nivel, se vuelve a medir.
  onReset() {
    for (const k of Object.keys(this.best)) delete this.best[Number(k)];
    this.camp = null;
    this.crowdLeaves = [];
  }

  private setCamp(map: number, x: number, y: number, now: number, why: string, planned = false) {
    this.camp = { map, x, y, since: now, arrivedAt: null, lastSeen: now, walkSince: now, crowdSince: null, counted: false, why, planned };
    this.events.push(`campamento en (${x},${y}): ${why}`);
  }

  // Deja el campamento actual; si estuvo lo suficiente, lo guarda en la memoria
  // con la exp/min REAL desde que llegó.
  leave(now: number, level: number, why: string, remember = true, exp?: ExpLog) {
    const cp = this.camp;
    if (!cp) return;
    if (remember && exp && cp.arrivedAt != null && now - cp.arrivedAt >= this.p.MEM_MIN_MS) {
      this.memory.record(cp.map, cp.x, cp.y, exp.rateSince(cp.arrivedAt, now), level, this.power);
    }
    this.left.push({ map: cp.map, x: cp.x, y: cp.y, at: now });
    if (this.left.length > 7) this.left.shift();
    this.events.push(`dejo el campamento (${cp.x},${cp.y}): ${why}`);
    this.camp = null;
  }

  private recentlyLeft(map: number, p: Pos, now: number, ms: number, dist: number) {
    return this.left.some((l) => l.map === map && now - l.at < ms && cheb(l, p) <= dist);
  }

  // 2 campamentos abandonados por gente en 2 min = el spot entero está lleno.
  crowdedSpot(now: number): boolean {
    this.crowdLeaves = this.crowdLeaves.filter((t) => now - t < this.p.CROWD_LEAVES_WINDOW_MS);
    return this.crowdLeaves.length >= this.p.CROWD_LEAVES_TO_MOVE;
  }

  // --- Elección de objetivo -----------------------------------------------
  private campRate(cp: Camp, now: number, exp: ExpLog): number {
    return cp.arrivedAt != null ? exp.rateSince(cp.arrivedAt, now) : 0;
  }

  // Al mejor exp/s (farming.ts) entre los monstruos a < scan de `from`, dentro de la correa.
  freePick<C extends Candidate>(inp: PickInput<C>, from: Pos, scan: number): C | null {
    const inRange = inp.monsters.filter((m) => cheb(from, m) < scan && this.inLeash(inp.map, m));
    const easy = inRange.filter((m) => inp.stats.killSecOf(m.type) <= FARM.MAX_KILL_SEC);
    const pool = easy.length ? easy : inRange;
    const ranked: { monster: C; rate: number }[] = [];
    // La distancia se mide desde donde estoy (lo que cuesta llegar), no desde el centro.
    for (const m of pool) {
      const r = targetRate(inp.me, m, pool, inp.players, inp.stats);
      if (r.rate > 0) ranked.push({ monster: m, rate: r.rate });
    }
    if (!ranked.length) return null;
    const bestRate = Math.max(...ranked.map((r) => r.rate));
    const peers = ranked.filter((r) => r.rate >= bestRate * this.p.CHOICE_NEAR_BEST_FRAC);
    return peers[Math.min(peers.length - 1, Math.floor(this.rand() * peers.length))].monster;
  }

  // Centro con más exp/s a <= RADIUS, penalizado por jugadores y por distancia.
  findCamp<C extends Candidate>(inp: PickInput<C>): Pos | null {
    const ms = inp.monsters.filter((m) => inp.stats.killSecOf(m.type) <= FARM.MAX_KILL_SEC && this.inLeash(inp.map, m));
    const ranked: { at: Pos; rate: number }[] = [];
    for (const e of ms) {
      // Después de abandonar un grupo de bajo rendimiento, probar otro grupo
      // visible; si no se excluye el centro anterior, lo reelige enseguida.
      if (this.recentlyLeft(inp.map, e, inp.now, this.p.LEFT_MEMORY_MS, 6)) continue;
      let v = 0;
      for (const o of ms) if (cheb(o, e) <= this.p.RADIUS) v += inp.stats.expOf(o.type) / Math.max(inp.stats.killSecOf(o.type), 0.1);
      v *= Math.pow(1 - this.p.COMPETITION_PENALTY, inp.players.filter((q) => cheb(q, e) <= this.p.RADIUS).length);
      v /= 1 + cheb(inp.me, e) / this.p.DIST_DECAY;
      if (v > 0) ranked.push({ at: { x: e.x, y: e.y }, rate: v });
    }
    if (!ranked.length) return null;
    const bestRate = Math.max(...ranked.map((r) => r.rate));
    const peers = ranked.filter((r) => r.rate >= bestRate * this.p.CHOICE_NEAR_BEST_FRAC);
    return peers[Math.min(peers.length - 1, Math.floor(this.rand() * peers.length))].at;
  }

  /** Sin objetivo: a quién atacar (o null). */
  pick<C extends Candidate>(inp: PickInput<C>): C | null {
    this.events = [];
    const { now, map, me } = inp;
    if (this.strict) this.observeDensity(map, inp.monsters.filter((m) => inp.stats.killSecOf(m.type) <= FARM.MAX_KILL_SEC));
    // Curiosidad acotada por ROI: antes perseguía monstruos débiles aislados
    // solo porque todavía no tenía tres muestras de ese tipo.
    let cur: C | null = null;
    let cr = 0;
    const benchmark = this.freePick(inp, me, FARM.SCAN);
    const pool = inp.monsters.filter((m) => cheb(me, m) < FARM.SCAN && this.inLeash(map, m));
    for (const m of inp.monsters) {
      if ((inp.typeKills[m.type] ?? 0) >= this.p.CURIOSITY_KILLS || !this.inLeash(map, m) || inp.stats.killSecOf(m.type) > FARM.MAX_KILL_SEC) continue;
      const d = cheb(me, m);
      if (d > this.p.CURIOSITY_RADIUS || (this.camp?.map === map && cheb(this.camp, m) > this.p.RADIUS)) continue;
      const rate = targetRate(me, m, pool, inp.players, inp.stats).rate;
      if (rate > cr) { cr = rate; cur = m; }
    }
    if (cur && (!benchmark || cr >= targetRate(me, benchmark, pool, inp.players, inp.stats).rate * this.p.CURIOSITY_MIN_RATE_FRAC)) return cur;

    if (this.camp && this.camp.map !== map) this.camp = null;
    const cp0 = this.camp;
    if (cp0) {
      // Mientras viaja, los relojes de "vacío" y "competencia" no corren.
      if (cheb(me, cp0) > this.p.RADIUS) {
        cp0.lastSeen = now;
        cp0.crowdSince = null;
      } else if (cp0.arrivedAt == null) {
        cp0.arrivedAt = now;
        cp0.lastSeen = now;
      }
      // Hay monstruos dentro del radio ahora mismo: no está vacío (aunque
      // haya pasado un rato peleando sin volver a elegir objetivo).
      if (inp.monsters.some((m) => cheb(m, cp0) <= this.p.RADIUS)) cp0.lastSeen = now;
      const rate = this.campRate(cp0, now, inp.exp);
      const stay = cp0.arrivedAt != null ? now - cp0.arrivedAt : 0;
      const recentRate = inp.exp.perMin(now, this.p.RECENT_WINDOW_MS);
      if (stay > this.p.EVAL_MS && !cp0.counted) {
        cp0.counted = true;
        const prev = this.best[map];
        this.best[map] = prev == null ? rate : prev * this.p.BEST_EMA_OLD + rate * (1 - this.p.BEST_EMA_OLD);
      }
      const poor = stay > this.p.EVAL_MS && rate < (this.best[map] ?? 0) * this.p.MIN_FRAC;
      const fading = stay > this.p.EVAL_MS && rate > 0 && recentRate < rate * this.p.RECENT_DROP_FRAC;
      const empty = cp0.arrivedAt != null && now - cp0.lastSeen > this.p.EMPTY_MS;
      const rivalsHere = inp.players.filter((q) => cheb(q, cp0) <= this.p.RADIUS + 2).length;
      if (rivalsHere >= this.p.CROWD_RIVALS) cp0.crowdSince ??= now;
      else cp0.crowdSince = null;
      const crowded =
        cp0.crowdSince != null && now - cp0.crowdSince > this.p.CROWD_MS && stay > this.p.CROWD_MIN_STAY_MS &&
        rate < (this.best[map] ?? Infinity) * this.p.CROWD_MIN_FRAC;
      if (crowded) this.crowdLeaves.push(now);
      if (poor || fading || empty || crowded) {
        this.leave(now, inp.level, poor ? `rinde ${Math.round(rate)} exp/min` : fading ? `exp reciente cayó a ${Math.round(recentRate)} exp/min` : crowded ? `${rivalsHere} jugadores cerca` : 'sin monstruos', true, inp.exp);
      }
    }
    if (!this.camp && now < this.arrivalPendingUntil) return this.freePick(inp, me, this.p.ARRIVAL_SCAN);
    if (!this.camp) {
      const found = this.findCamp(inp);
      if (found && !this.recentlyLeft(map, found, now, this.p.LEFT_MEMORY_MS, this.p.RADIUS)) this.setCamp(map, found.x, found.y, now, 'el mejor exp/s a la vista');
      else return this.freePick(inp, me, FARM.SCAN);
    }
    const cp = this.camp!;
    if (cheb(me, cp) > this.p.RADIUS) {
      // En camino: si hay un montón de monstruos juntos, quedarse ahí.
      const canPause = now - cp.since < this.p.TRAVEL_FIGHT_MS;
      const n = inp.monsters.filter((m) => inp.stats.killSecOf(m.type) <= FARM.MAX_KILL_SEC && cheb(m, me) <= this.p.EN_ROUTE_SCAN && this.inLeash(map, m)).length;
      if (canPause && !cp.planned && n >= this.p.CLUSTER_STOP) {
        this.camp = null;
        this.setCamp(map, me.x, me.y, now, `me quedo: ${n} monstruos juntos`);
        this.camp!.arrivedAt = now;
      } else {
        const near = canPause ? this.freePick(inp, me, this.p.EN_ROUTE_SCAN + 1) : null;
        if (near) {
          cp.walkSince = now; // pelear en el camino no consume el plazo de caminata
          return near;
        }
      }
    }
    const c = this.camp!;
    const t = this.freePick({ ...inp, monsters: inp.monsters.filter((m) => cheb(m, c) <= this.p.RADIUS) }, me, Infinity);
    if (t) c.lastSeen = now;
    return t;
  }

  /** Sin objetivo: a dónde caminar (o null = que decida el explorador). */
  goal(now: number, map: number, me: Pos, level: number, exp: ExpLog): CampGoal | null {
    this.events = [];
    if (this.camp && this.camp.map !== map) this.camp = null;
    if (this.camp) {
      const cp = this.camp;
      if (cp.arrivedAt == null && cheb(me, cp) <= this.p.RADIUS) cp.arrivedAt = cp.lastSeen = now;
      if (cp.arrivedAt == null && now - cp.walkSince > this.p.WALK_TIMEOUT_MS) {
        this.leave(now, level, 'no llego (¿muros?)', false);
      } else {
        // Ya en el campamento sin nada que pelear: el reloj de vacío sigue (pick()).
        if (cp.arrivedAt != null && now - cp.lastSeen > this.p.EMPTY_MS) this.leave(now, level, 'sin monstruos', true, exp);
        else return { x: cp.x, y: cp.y, kind: 'camp' };
      }
    }
    if (now < this.arrivalPendingUntil) return null;
    // Memoria: el mejor campamento conocido cerca.
    const scout = this.scoutTarget(map, me, level, now);
    if (scout) {
      this.setScout(map, scout, now);
      return { x: scout.x, y: scout.y, kind: 'camp' };
    }
    const known = this.memory.nearBest(map, me, level, (c) => this.inLeash(map, c) && this.fits(c) && !this.recentlyLeft(map, c, now, this.p.MEM_LEFT_MS, this.p.MEM_NEAR));
    if (known) {
      this.setCamp(map, known.x, known.y, now, `campamento conocido ~${Math.round(known.rate / 1e6)}M exp/min`, true);
      return { x: known.x, y: known.y, kind: 'camp' };
    }
    const sc = START_CAMPS[map];
    if (sc && cheb(sc, me) > this.p.RADIUS && !this.recentlyLeft(map, sc, now, this.p.LEFT_MEMORY_MS, this.p.RADIUS)) {
      this.setCamp(map, sc.x, sc.y, now, 'campamento de arranque');
      return { x: sc.x, y: sc.y, kind: 'camp' };
    }
    // Fuera de la correa (llegó lejos de la llegada): volver a la llegada.
    if (!this.inLeash(map, me) && this.arrival) return { x: this.arrival.x, y: this.arrival.y, kind: 'llegada' };
    return null;
  }
}
