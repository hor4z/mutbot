/**
 * Exploración del loop autónomo: qué es un monstruo, a dónde caminar cuando no
 * hay ninguno en scope y cuándo un mapa "no rinde".
 *
 * Lógica PURA (sin red, sin EventBus, sin `world`): recibe posición, mapa y
 * reloj por parámetro, así se testea offline en `explore-tests.ts`.
 * `headless-bot.ts` la engancha en `autonomousLoop`.
 *
 * Todo esto se aprendió jugando en vivo con un agente dentro del cliente web
 * (ver AGENTS.md, "Loop autónomo — exploración").
 */

// ---------------------------------------------------------------------------
// Parámetros (del modelo, no del uso).
// ---------------------------------------------------------------------------
export const EXPLORE = {
  // Lado de la celda de la grilla de spots calientes, en tiles.
  CELL: 12,
  // Una celda que se encontró vacía no se vuelve a probar hasta pasado esto.
  EMPTY_COOLDOWN_MS: 2 * 60_000,
  // Al llegar a una celda caliente se espera esto a que aparezca algo.
  HOT_WAIT_MS: 8_000,
  // Al llegar a una "salida" se espera esto antes de abandonar la dirección.
  EXIT_WAIT_MS: 20_000,
  // Distancia (Chebyshev) para considerar que se llegó a un objetivo.
  ARRIVE_DIST: 3,
  // Si no se llega en este tiempo (muros, camino bloqueado) se abandona.
  WALK_TIMEOUT_MS: 60_000,
  // Qué tan lejos del centro del pueblo se ponen las salidas.
  EXIT_RADIUS: 55,
  // Sin ningún monstruo en todo el mapa durante esto = el mapa no rinde.
  DRY_MAP_MS: 2 * 60_000,
} as const;
export type ExploreParams = typeof EXPLORE;

// ---------------------------------------------------------------------------
// Filtro de monstruos.
//
// Regla: monstruo = TypeNumber FUERA de 200-299 Y (está en monsters.json como
// atacable O TypeNumber >= 300).
//  - 200-299 son los NPC de pueblo/servicio del 0.97: vendedores, guardias
//    (247 Crossbow / 249 Berdysh, nivel 90, no atacables), Baz el del cofre
//    (240), Thompson (231), Lumen (244/255), etc. monsters.json trae varios con
//    atributos de combate (los guardias "pegan"), así que el set de
//    monsters.json solo no alcanza para excluirlos.
//  - >= 300: este server tiene TypeNumbers custom (vistos en vivo 690, 692)
//    que monsters.json no conoce. Con el filtro viejo (solo monsters.json) el
//    bot quedaba ciego a ellos. Nota: así también se excluyen los de Kalima
//    (260-275) y algunos de 290-295; ninguno está en WARP_SPOTS.
// ---------------------------------------------------------------------------
export const TOWN_NPC_MIN = 200;
export const TOWN_NPC_MAX = 299;
export const CUSTOM_MONSTER_MIN = 300;

export function isTownNpcType(type: number): boolean {
  return type >= TOWN_NPC_MIN && type <= TOWN_NPC_MAX;
}

export function isMonsterType(type: number, knownMonsters: ReadonlySet<number>): boolean {
  if (isTownNpcType(type)) return false;
  return knownMonsters.has(type) || type >= CUSTOM_MONSTER_MIN;
}

// ---------------------------------------------------------------------------
// Grilla de spots calientes: cada vez que se elige un objetivo se anota su
// celda (por mapa). Cuando no hay nada en scope, se va primero a la celda con
// más conteo que no haya estado vacía en los últimos EMPTY_COOLDOWN_MS.
// ---------------------------------------------------------------------------
export type HotCell = { map: number; cx: number; cy: number; count: number; emptyAt: number };

const chebyshev = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export class HotSpotGrid {
  private cells = new Map<string, HotCell>();

  constructor(private readonly p: Pick<ExploreParams, 'CELL' | 'EMPTY_COOLDOWN_MS'> = EXPLORE) {}

  private key(map: number, cx: number, cy: number) {
    return `${map}:${cx}:${cy}`;
  }

  cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x / this.p.CELL), Math.floor(y / this.p.CELL)];
  }

  // Centro de la celda en tiles (a donde se camina).
  center(c: Pick<HotCell, 'cx' | 'cy'>): { x: number; y: number } {
    const half = Math.floor(this.p.CELL / 2);
    return { x: c.cx * this.p.CELL + half, y: c.cy * this.p.CELL + half };
  }

  record(map: number, x: number, y: number) {
    const [cx, cy] = this.cellOf(x, y);
    const k = this.key(map, cx, cy);
    const c = this.cells.get(k) ?? { map, cx, cy, count: 0, emptyAt: -Infinity };
    c.count++;
    this.cells.set(k, c);
  }

  markEmpty(map: number, cx: number, cy: number, now: number) {
    const c = this.cells.get(this.key(map, cx, cy));
    if (c) c.emptyAt = now;
  }

  get(map: number, cx: number, cy: number): HotCell | undefined {
    return this.cells.get(this.key(map, cx, cy));
  }

  // La celda con más conteo del mapa que no esté "vacía" recientemente.
  // Desempate: la más cercana a (fromX, fromY).
  pick(map: number, now: number, fromX = 0, fromY = 0): HotCell | null {
    let best: HotCell | null = null;
    let bestDist = Infinity;
    for (const c of this.cells.values()) {
      if (c.map !== map || now - c.emptyAt < this.p.EMPTY_COOLDOWN_MS) continue;
      const ctr = this.center(c);
      const d = chebyshev(fromX, fromY, ctr.x, ctr.y);
      if (!best || c.count > best.count || (c.count === best.count && d < bestDist)) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Salidas: si no hay spots calientes, caminar alejándose del centro del pueblo
// del mapa, probando direcciones en orden.
// ---------------------------------------------------------------------------
export type Point = { x: number; y: number };

// Centro del pueblo por mapa (tiles). Solo Lorencia está confirmado.
export const TOWN_CENTERS: Record<number, Point> = {
  0: { x: 135, y: 128 },
};

// Primera salida conocida por mapa. Lorencia: el usuario confirmó que los
// monstruos están por la salida que en pantalla se ve "arriba"; en
// coordenadas del mundo es (-x, +y) del centro: la zona de la cripta,
// ~(90-130, 170-190).
export const FIRST_EXITS: Record<number, Point> = {
  0: { x: 110, y: 180 },
};

// Las 8 direcciones (mismo orden que DIR_DELTA de headless-bot.ts).
const DIRS: Array<[number, number]> = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

const clamp = (v: number) => Math.max(8, Math.min(247, Math.round(v)));

/**
 * Objetivos de exploración "hacia afuera" para un mapa, en el orden en que se
 * prueban. Primero la salida conocida (si hay), después las 8 direcciones
 * desde el centro a EXIT_RADIUS, empezando por la más parecida a la primera
 * salida (o a `prefDir`, o hacia el medio del mapa si el centro está lejos de
 * él) y alternando vecinas: así se barre en abanico y no se cruza el mapa.
 */
export function exitTargets(map: number, center: Point, prefDir: number | null = null, p: Pick<ExploreParams, 'EXIT_RADIUS'> = EXPLORE): Point[] {
  const out: Point[] = [];
  const first = FIRST_EXITS[map];
  if (first) out.push(first);
  let start: number;
  if (prefDir != null) start = ((prefDir % 8) + 8) % 8;
  else {
    const ref = first ?? (chebyshev(center.x, center.y, 128, 128) > 30 ? { x: 128, y: 128 } : null);
    start = ref ? nearestDir(ref.x - center.x, ref.y - center.y) : 0;
  }
  const order = [start];
  for (let k = 1; k <= 4; k++) {
    order.push((start + k) % 8);
    if (k < 4) order.push((start - k + 8) % 8);
  }
  for (const d of order) {
    const [dx, dy] = DIRS[d];
    // Diagonales: misma distancia euclídea aprox. que las rectas.
    const r = dx && dy ? p.EXIT_RADIUS * 0.75 : p.EXIT_RADIUS;
    const t = { x: clamp(center.x + dx * r), y: clamp(center.y + dy * r) };
    if (!out.some((o) => chebyshev(o.x, o.y, t.x, t.y) < 10)) out.push(t);
  }
  return out;
}

export function nearestDir(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  let best = 0;
  let bestDot = -Infinity;
  const len = Math.hypot(dx, dy);
  DIRS.forEach(([ux, uy], i) => {
    const dot = (ux * dx + uy * dy) / (Math.hypot(ux, uy) * len);
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Explorer: decide a dónde caminar cuando no hay objetivo, y detecta el mapa
// seco. Se llama una vez por tick del loop.
// ---------------------------------------------------------------------------
export type ExploreGoal =
  | { kind: 'hot'; x: number; y: number; cx: number; cy: number; since: number; arrivedAt: number | null }
  | { kind: 'exit'; x: number; y: number; index: number; since: number; arrivedAt: number | null };

export type ExploreAction =
  | { action: 'walk'; x: number; y: number; goal: ExploreGoal }
  | { action: 'wait'; goal: ExploreGoal };

export type ExploreEvent = { kind: 'hot-empty' | 'hot-timeout' | 'exit-abandoned' | 'exit-timeout'; goal: ExploreGoal };

export class Explorer {
  readonly hot: HotSpotGrid;
  private map: number | null = null;
  private center: Point = { x: 128, y: 128 };
  private exits: Point[] = [];
  private exitIdx = 0;
  private goal: ExploreGoal | null = null;
  private lastMonsterAt = 0;
  private mapSince = 0;
  // Eventos de la última llamada (para loguear en el bot).
  events: ExploreEvent[] = [];

  constructor(
    private readonly prefDir: number | null = null,
    private readonly p: ExploreParams = EXPLORE,
    hot?: HotSpotGrid,
  ) {
    this.hot = hot ?? new HotSpotGrid(p);
  }

  get currentGoal(): ExploreGoal | null {
    return this.goal;
  }

  get exitList(): readonly Point[] {
    return this.exits;
  }

  // Entrar a un mapa (o primer tick): centro = pueblo conocido, o la posición
  // de llegada si no se conoce (el warp suele dejar en el pueblo).
  enterMap(map: number, x: number, y: number, now: number) {
    this.map = map;
    this.center = TOWN_CENTERS[map] ?? { x, y };
    this.exits = exitTargets(map, this.center, this.prefDir, this.p);
    this.exitIdx = 0;
    this.goal = null;
    this.mapSince = now;
    this.lastMonsterAt = now;
  }

  // Se eligió un objetivo: anota el spot caliente y "hay monstruos".
  onTarget(map: number, x: number, y: number, now: number) {
    this.hot.record(map, x, y);
    this.sawMonster(now);
  }

  // Hay al menos un monstruo atacable en scope.
  sawMonster(now: number) {
    this.lastMonsterAt = now;
    // Una salida que dio monstruos sigue sirviendo: el plazo corre de nuevo.
    // Y si todavía caminaba hacia ella, el tiempo peleando no cuenta para el
    // timeout de caminata.
    if (this.goal) {
      if (this.goal.arrivedAt != null) this.goal.arrivedAt = now;
      else this.goal.since = now;
    }
  }

  // ¿Pasaron DRY_MAP_MS sin ningún monstruo en todo el mapa?
  isDry(now: number): boolean {
    return this.map != null && now - Math.max(this.lastMonsterAt, this.mapSince) >= this.p.DRY_MAP_MS;
  }

  // Reinicia el reloj de mapa seco (p.ej. tras decidir no moverse).
  resetDry(now: number) {
    this.lastMonsterAt = now;
  }

  /** Sin objetivo en scope: a dónde caminar (o esperar). */
  tick(map: number, x: number, y: number, now: number): ExploreAction {
    this.events = [];
    if (this.map !== map) this.enterMap(map, x, y, now);
    for (let guard = 0; guard < 3; guard++) {
      if (!this.goal) this.goal = this.nextGoal(map, x, y, now);
      const g = this.goal;
      const d = chebyshev(x, y, g.x, g.y);
      if (g.arrivedAt == null && d <= this.p.ARRIVE_DIST) g.arrivedAt = now;
      if (g.arrivedAt == null) {
        if (now - g.since < this.p.WALK_TIMEOUT_MS) return { action: 'walk', x: g.x, y: g.y, goal: g };
        this.abandon(g, now, true);
        continue;
      }
      const wait = g.kind === 'hot' ? this.p.HOT_WAIT_MS : this.p.EXIT_WAIT_MS;
      if (now - g.arrivedAt < wait) return { action: 'wait', goal: g };
      this.abandon(g, now, false);
    }
    // No debería pasar (siempre hay una salida), pero por las dudas: esperar.
    return { action: 'wait', goal: this.goal! };
  }

  private abandon(g: ExploreGoal, now: number, timeout: boolean) {
    if (g.kind === 'hot') {
      // Un spot inalcanzable también se marca vacío: si no, se insiste para siempre.
      this.hot.markEmpty(this.map!, g.cx, g.cy, now);
      this.events.push({ kind: timeout ? 'hot-timeout' : 'hot-empty', goal: g });
    } else {
      this.exitIdx = (g.index + 1) % this.exits.length;
      this.events.push({ kind: timeout ? 'exit-timeout' : 'exit-abandoned', goal: g });
    }
    this.goal = null;
  }

  private nextGoal(map: number, x: number, y: number, now: number): ExploreGoal {
    const cell = this.hot.pick(map, now, x, y);
    if (cell) {
      const c = this.hot.center(cell);
      return { kind: 'hot', x: c.x, y: c.y, cx: cell.cx, cy: cell.cy, since: now, arrivedAt: null };
    }
    const index = this.exitIdx % this.exits.length;
    const t = this.exits[index];
    return { kind: 'exit', x: t.x, y: t.y, index, since: now, arrivedAt: null };
  }
}
