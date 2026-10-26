/**
 * Lo que el bot mide y reparte, sin estado de red (lógica pura):
 *  - `ExpLog`: exp ganada por segundo; todo "exp/min" del bot sale de acá.
 *  - Reparto de puntos de atributo (`planStats` del DK, `planByClass` del resto, `capStats`).
 *  - Qué ítems del piso vale la pena levantar (`pickLoot`).
 */

export type Pos = { x: number; y: number };
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// ---------------------------------------------------------------------------
// Registro de exp por segundo. Las ventanas se promedian por la ventana REAL cubierta (si el registro empezó hace
// 2 min, "exp/min en 30 min" divide por 2 min, no por 30).
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
// Puntos de atributo
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
// Reparto por clase. El Dark Knight con Twisting Slash usa `planStats` (abajo, para Hume: energía hasta fuerza−2000 y
// solo 5 % a vitalidad). Las demás clases reparten por porcentajes: el mago, con ese plan de DK, quedaba con ~3.500 de
// vida a nivel 350 (Zamu) y moría en cualquier mapa. Los porcentajes son una estimación nuestra, no un dato del juego.
// ---------------------------------------------------------------------------
export const CLASS_STATS: Record<'knight' | 'wizard' | 'elf' | 'gladiator', Partial<StatValues>> = {
  knight: { str: 0.55, agi: 0.25, vit: 0.2 },
  wizard: { ene: 0.5, vit: 0.3, agi: 0.2 },
  elf: { agi: 0.5, vit: 0.3, str: 0.2 },
  gladiator: { str: 0.4, ene: 0.25, vit: 0.25, agi: 0.1 },
};
/** Base de la clase por `classId` del CharacterList (DarkWizard 0, DarkKnight 4, FairyElf 8, MagicGladiator 12; +1/+2 evoluciones). */
export function classFamily(classId: number | null | undefined): keyof typeof CLASS_STATS | null {
  if (classId == null) return null;
  return (['wizard', 'knight', 'elf', 'gladiator'] as const)[classId >> 2] ?? null;
}
/** Reparte `points` según los porcentajes de la clase. */
export function planByClass(points: number, family: keyof typeof CLASS_STATS): StatValues {
  const share = CLASS_STATS[family];
  const out: StatValues = { str: 0, agi: 0, vit: 0, ene: 0 };
  if (!(points > 0)) return out;
  const keys = (['str', 'agi', 'vit', 'ene'] as const).filter((k) => share[k]);
  for (const k of keys) out[k] = Math.floor(points * share[k]!);
  // lo que sobra del redondeo, a la principal (la de más peso)
  const main = keys.reduce((a, b) => (share[b]! > share[a]! ? b : a));
  out[main] += points - keys.reduce((n, k) => n + out[k], 0);
  return out;
}

// Tope del server: 65535 por stat ("Se ha alcanzado el máximo de 65535 Base Energy"). Con fuerza y
// energía al tope /add las rechaza y los puntos no bajan. Cada stat recibe como mucho lo que le falta
// para el tope; lo que no entra va a agilidad (velocidad de ataque del DK) y después a vitalidad, como
// el agente del navegador.
export const STAT_CAP = 65535;
export type StatValues = { str: number; agi: number; vit: number; ene: number };

export function capStats(plan: Partial<StatValues>, cur: StatValues, cap = STAT_CAP): StatValues {
  const out: StatValues = { str: 0, agi: 0, vit: 0, ene: 0 };
  let spill = 0;
  for (const k of ['ene', 'str', 'vit', 'agi'] as const) {
    const n = Math.max(0, Math.floor(plan[k] ?? 0));
    const fit = Math.min(n, Math.max(0, cap - cur[k]));
    out[k] += fit;
    spill += n - fit;
  }
  for (const k of ['agi', 'vit'] as const) {
    const n = Math.min(spill, Math.max(0, cap - cur[k] - out[k]));
    out[k] += n;
    spill -= n;
  }
  return out;
}

export type DropInfo = { group: number; num: number; isMoney?: boolean; excellent?: boolean };

// Lo que vale en este server (2026-10-23): las cajas (14/11, Box of Kundun) y los Cristales (14/31): la
// moneda de la tienda del creador (el Mercado cobra en Cristales) y del Alquimista; también los
// talismanes (14/7 Protección, 14/12 +14, 14/20 +15). Siempre, con o sin lugar (son de 1x1 y se apilan).
// Con lugar en la bolsa (`gear`), los excelentes: el Alquimista los cristaliza en Cristales. Las joyas no
// valen nada para comerciar (usuario: "las joyas no valen nada"): no se levantan.
/**
 * `fresh` (personaje nuevo): además el zen (en este server llega como ítem 14/15), las
 * pociones (manzana y pociones de vida, 14/0-3), las joyas y, si `gear`, el equipo (grupos 0-11: armas,
 * escudos, armaduras) para equiparse o venderlo. Sin zen no paga el warp a Devias (2.500) ni compra
 * nada: Hume llegó a nivel 27 con 0.
 */
export const JEWELS = new Set([13, 14, 16, 22, 31]);
/**
 * Opinión opcional sobre el equipo (grupos 0-11) que cae, p. ej. `makeDropJudge` de item-score.ts: true =
 * levantarlo, false = dejarlo, undefined = no opina (rige la regla de siempre). Solo se consulta con lugar
 * en la bolsa (`gear`). Sin juez (el default) el comportamiento no cambia.
 */
export type DropJudge = (d: DropInfo & { level?: number }) => boolean | undefined;
/** Joyas siempre y con prioridad: en el Slow son lo más valioso. */
export const lootPolicy = { jewels: true };
/** En el Slow casi todo vale: grupo 12 (alas, orbes, Chaos), 13 (anillos, colgantes, mascotas), 14 (joyas, cajas, pociones) y cualquier excelente. */
export const isSlowValuable = (d: DropInfo) => d.group === 12 || d.group === 13 || d.group === 14 || !!d.excellent;
export const isJewel = (d: DropInfo) => (d.group === 14 && JEWELS.has(d.num)) || (d.group === 12 && d.num === 15);
export function isValuableDrop(d: DropInfo, fresh = false, gear = false, judge?: DropJudge): boolean {
  if (d.isMoney) return fresh;
  if (lootPolicy.jewels && isSlowValuable(d)) return true;
  if (judge && gear && d.group <= 11) {
    const j = judge(d);
    if (j !== undefined) return j;
  }
  if (fresh && d.group === 14 && (d.num <= 3 || d.num === 15 || JEWELS.has(d.num))) return true;
  if (fresh && d.group === 12 && d.num === 15) return true; // Jewel of Chaos
  if (fresh && gear && d.group <= 11) return true;
  if (d.group === 14 && CURRENCY_ITEMS.has(d.num)) return true;
  return gear && !!d.excellent && d.group <= 11;
}

/** Cajas, Cristales y talismanes (grupo 14): ver isValuableDrop. */
export const CURRENCY_ITEMS: ReadonlySet<number> = new Set([11, 31, 7, 12, 20]);

/** Orden de recolección: la caja primero aunque una joya esté hasta LOOT_BOX_FIRST tiles más cerca. */
const LOOT_BOX_FIRST = 8;

// El drop valioso más cercano a <= radius (o null).
export function pickLoot<D extends DropInfo & Pos>(me: Pos, drops: Iterable<D>, radius = 12, fresh = false, gear = false, judge?: DropJudge): D | null {
  let best: D | null = null;
  let bd = Infinity;
  for (const d of drops) {
    if (!isValuableDrop(d, fresh, gear, judge)) continue;
    const dd = cheb(me, d);
    const score = dd - ((d.group === 14 && d.num === 11) || (lootPolicy.jewels && isSlowValuable(d)) ? LOOT_BOX_FIRST : 0);
    if (dd <= radius && score < bd) {
      bd = score;
      best = d;
    }
  }
  return best;
}

