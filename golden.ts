/**
 * Regla fuerte de dorados (port de `browser/corner.js`, C.dragon). Usuario: "si aparece un dragón o lo
 * que sea dorado lo matás y recogés las cajas"; "si se topan con cualquier dorado lo matan igual".
 *
 * Farmeando (no cazando), cualquier dorado vivo a <= 20 tiles es el objetivo: primero Golden Dragon
 * (79) o Dragón Rojo (44) aunque haya uno chico más cerca. Uno que en 2 min no se pudo matar (pared,
 * otro lo tiene) se deja. Mientras haya uno, y 15 s después de que muera (para levantar las cajas), no
 * se cambia de mapa, no se resetea ni se vuelve a la esquina.
 *
 * Lógica PURA (posiciones y reloj por parámetro): se testea en `golden-tests.ts`.
 */
export type GoldenCandidate = { id: number; x: number; y: number; type: number };

export const GOLDEN_RULE = { range: 20, dragonBonus: 30, giveUpMs: 120_000, dragonGiveUpMs: 300_000, lootStayMs: 15_000 } as const;
// Golden Dragon de la invasión dorada (79) y Dragón Rojo de su propia invasión (44: el cliente también lo
// llama "Golden Dragon"; RedDragonInvasionPlugIn de OpenMU, ver EVENTOS.md).
export const DRAGON_TYPES: ReadonlySet<number> = new Set([44, 79]);
/** Nivel de la Box of Kundun que suelta cada dorado (guía "Invasión Dorada"; Dragón Rojo +4). */
export const GOLDEN_VALUE: ReadonlyMap<number, number> = new Map([
  [78, 1], [43, 2], [53, 2], [54, 2], [80, 3], [83, 3], [81, 4], [44, 4], [82, 5], [79, 5],
]);
// Cuántos tiles vale un nivel de caja al elegir sin objetivo: un Titan (+2) a 10 gana a un Goblin (+1) a 5.
const VALUE_TILES = 6;

/**
 * Objetivo dorado con correa (2026-10-23): el daño repartido entre dorados no mata a ninguno (la caja es
 * del que más le pegó). Se sigue con el actual mientras se vea; solo un dragón lo desplaza (si el actual
 * no es dragón). Sin actual: el dragón más cercano; si no, el dorado de mejor caja según la distancia.
 */
export function stickyGolden<M extends GoldenCandidate>(me: { x: number; y: number }, currentId: number | null, monsters: Iterable<M>, golden: (type: number) => boolean): M | null {
  let cur: M | null = null;
  let dragon: M | null = null;
  let near: M | null = null;
  let dd = Infinity;
  let nd = Infinity;
  for (const m of monsters) {
    const isDragon = DRAGON_TYPES.has(m.type);
    if (!isDragon && !golden(m.type)) continue;
    if (m.id === currentId) cur = m;
    const d = Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y));
    if (isDragon && d < dd) { dd = d; dragon = m; }
    const score = d - (GOLDEN_VALUE.get(m.type) ?? 1) * VALUE_TILES;
    if (score < nd) { nd = score; near = m; }
  }
  if (cur && (DRAGON_TYPES.has(cur.type) || !dragon)) return cur;
  return dragon ?? near;
}

/**
 * "Dragones primero" de verdad (2026-10-23: los dragones duraron ~60-70 s desde que se los vio y se los
 * llevaron otros): dentro de DRAGON_RUSH_MS del aviso del server, en el mapa del dragón y sin ninguno a la
 * vista, no se empieza un dorado común nuevo ni se va a uno recordado: se va a las zonas de dragones.
 * Solo si hay una zona sin visitar a donde ir (`hasZone`); si no, el comportamiento de siempre.
 */
export const DRAGON_RUSH_MS = 180_000;
export function dragonRush(p: { now: number; announceAt: number | null; huntMap: number; dragonMap: number | null; dragonVisible: boolean; hasZone: boolean }): boolean {
  return p.announceAt != null && p.dragonMap === p.huntMap && !p.dragonVisible && p.hasZone && p.now - p.announceAt < DRAGON_RUSH_MS && p.now >= p.announceAt;
}

export class GoldenRule {
  private firstSeen = new Map<number, number>();
  private holdUntil = 0;

  /** El dorado a atacar ahora (o null). `golden(type)` dice si un tipo es dorado. */
  pick<M extends GoldenCandidate>(me: { x: number; y: number }, monsters: Iterable<M>, golden: (type: number) => boolean, now: number, currentId: number | null = null): M | null {
    let best: M | null = null;
    let bs = Infinity;
    const seen = new Set<number>();
    for (const m of monsters) {
      const dragon = DRAGON_TYPES.has(m.type);
      if (!dragon && !golden(m.type)) continue;
      seen.add(m.id);
      // El alcance es la distancia real; el bonus de los dragones solo ordena.
      const d = Math.hypot(m.x - me.x, m.y - me.y);
      if (d > GOLDEN_RULE.range) continue;
      // El reloj de "2 min y se deja" arranca cuando entra al alcance, no cuando se lo vio de lejos.
      if (!this.firstSeen.has(m.id)) this.firstSeen.set(m.id, now);
      if (now - this.firstSeen.get(m.id)! > (dragon ? GOLDEN_RULE.dragonGiveUpMs : GOLDEN_RULE.giveUpMs)) continue;
      // Correa: el que ya tiene el golpe gana a cualquiera de su clase (un dragón sigue ganándole a un chico).
      const score = d - (dragon ? GOLDEN_RULE.dragonBonus : 0) - (m.id === currentId ? GOLDEN_RULE.range : 0);
      if (score < bs) { bs = score; best = m; }
    }
    // Los ids que ya no se ven se olvidan (el server los reusa al reaparecer).
    for (const id of this.firstSeen.keys()) if (!seen.has(id)) this.firstSeen.delete(id);
    if (best) this.holdUntil = now + GOLDEN_RULE.lootStayMs;
    return best;
  }

  /** ¿Hay que quedarse (dorado a la vista o recién muerto)? Sin cambio de mapa ni reset. */
  holding(now: number): boolean {
    return now < this.holdUntil;
  }
}

/**
 * Datos de cada pelea con un dragón (evento `dragon_fight`, 2026-10-23): el 23/10 Hume llegó a 10 tiles
 * de dos Golden Dragon y los mató otro. Para decidir con datos en la próxima invasión: cuánto tarda desde
 * el aviso del server hasta verlo y hasta el primer golpe, cuántos golpes, el daño que se VE (ObjectHit
 * 0x15 de 10 bytes, de cualquiera: no distingue quién pegó), quién más estaba y quién lo mató.
 * Lógica pura (reloj por parámetro): se testea en `golden-tests.ts`.
 */
export const DRAGON_LOST_MS = 15_000;
export type DragonFightRecord = {
  id: number; type: number; outcome: 'killed' | 'lost'; killer: string | null; mine: boolean;
  /** Segundos desde el aviso del server (null si no hubo aviso) hasta verlo y hasta nuestro primer golpe. */
  seenS: number | null; firstHitS: number | null;
  /** Segundos desde que se lo vio hasta el primer golpe, hasta el fin, y entre el primer golpe y el fin. */
  seenToHitS: number | null; seenToEndS: number; hitToEndS: number | null;
  hits: number; dmgSeen: number; hpEst: number | null; ownHits: number; ownDmgAvg: number | null; hpLeftPct: number | null; hpFirstPct: number | null; others: string[]; sx: number; sy: number; ex: number; ey: number;
};
type Fight = { id: number; type: number; seenAt: number; announceAt: number | null; firstHitAt: number | null; lastSeenAt: number; hits: number; dmg: number; ownHits: number; ownDmg: number; hsFirst: number | null; hsLast: number | null; others: Set<string>; sx: number; sy: number; ex: number; ey: number };

export class DragonFight {
  private f: Fight | null = null;
  constructor(private readonly hp: (type: number) => number | null = () => null) {}

  get current(): number | null { return this.f?.id ?? null; }

  /** Un dragón a la vista (se llama cada vuelta). `announceAt`: cuándo avisó el server el mapa. Devuelve la pelea anterior si se perdió. */
  see(d: { id: number; type: number; x: number; y: number }, now: number, announceAt: number | null): DragonFightRecord | null {
    let prev: DragonFightRecord | null = null;
    if (this.f && this.f.id !== d.id && now - this.f.lastSeenAt > DRAGON_LOST_MS) prev = this.lost();
    if (!this.f) this.f = { id: d.id, type: d.type, seenAt: now, announceAt, firstHitAt: null, lastSeenAt: now, hits: 0, dmg: 0, ownHits: 0, ownDmg: 0, hsFirst: null, hsLast: null, others: new Set(), sx: d.x, sy: d.y, ex: d.x, ey: d.y };
    if (this.f.id === d.id) { this.f.lastSeenAt = now; this.f.ex = d.x; this.f.ey = d.y; }
    return prev;
  }
  /** Un golpe nuestro al dragón actual. */
  hit(id: number, now: number) {
    if (!this.f || this.f.id !== id) return;
    this.f.hits++;
    this.f.firstHitAt ??= now;
  }
  /** Daño visto sobre el dragón actual (ObjectHit). */
  damage(id: number, dmg: number) {
    if (this.f && this.f.id === id && dmg > 0 && dmg < 60_000) this.f.dmg += dmg;
  }
  /** Un golpe NUESTRO confirmado por el server (ObjectHitExtended): daño real y vida que le queda al blanco (1/250). */
  ownHit(id: number, dmg: number, healthStatus: number) {
    if (!this.f || this.f.id !== id) return;
    this.f.ownHits++;
    this.f.ownDmg += dmg;
    this.f.hsFirst ??= healthStatus;
    this.f.hsLast = healthStatus;
  }
  /** Vida que le queda al dragón actual según el último golpe nuestro (0-1), o null. */
  leftFraction(id: number): number | null {
    return this.f && this.f.id === id && this.f.hsLast != null ? this.f.hsLast / 250 : null;
  }
  /** Jugadores a la vista (nombres) mientras dura la pelea. */
  players(names: Iterable<string | undefined>) {
    if (!this.f) return;
    for (const n of names) if (n && this.f.others.size < 12) this.f.others.add(n);
  }
  /** Murió `id`: registro de la pelea, o null si no era la actual. */
  killed(id: number, now: number, killer: string | null, mine: boolean): DragonFightRecord | null {
    if (!this.f || this.f.id !== id) return null;
    return this.close(now, 'killed', killer, mine);
  }
  /** Dejó de verse hace más de DRAGON_LOST_MS: pelea perdida (registro con el último instante visto). */
  lost(): DragonFightRecord | null {
    return this.f ? this.close(this.f.lastSeenAt, 'lost', null, false) : null;
  }
  expired(now: number): boolean { return !!this.f && now - this.f.lastSeenAt > DRAGON_LOST_MS; }

  private close(end: number, outcome: 'killed' | 'lost', killer: string | null, mine: boolean): DragonFightRecord {
    const f = this.f!;
    this.f = null;
    const s = (a: number | null, b: number | null) => (a == null || b == null ? null : +((b - a) / 1000).toFixed(1));
    const hp = this.hp(f.type);
    return {
      id: f.id, type: f.type, outcome, killer, mine,
      seenS: s(f.announceAt, f.seenAt), firstHitS: s(f.announceAt, f.firstHitAt),
      seenToHitS: s(f.seenAt, f.firstHitAt), seenToEndS: +((end - f.seenAt) / 1000).toFixed(1), hitToEndS: s(f.firstHitAt, end),
      hits: f.hits, dmgSeen: f.dmg, hpEst: hp == null ? null : Math.max(0, hp - f.dmg),
      ownHits: f.ownHits, ownDmgAvg: f.ownHits ? Math.round(f.ownDmg / f.ownHits) : null,
      hpLeftPct: f.hsLast == null ? null : Math.round((f.hsLast / 250) * 100), hpFirstPct: f.hsFirst == null ? null : Math.round((f.hsFirst / 250) * 100),
      others: [...f.others], sx: f.sx, sy: f.sy, ex: f.ex, ey: f.ey,
    };
  }
}
