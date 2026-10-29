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

export function planStats(points: number, str: number, ene: number, p: { VIT_SHARE: number; ENE_GAP: number } = STATS_PLAN): { ene: number; str: number; vit: number } {
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

// --- Qué se levanta del piso ---------------------------------------------------------------------------------------------------------------
// Solo cuatro cosas (usuario, 2026-10-26: "lo otro es basura, nos llena el inventario"): el zen, las joyas, los ítems excelentes y los que
// mejoran el equipo que ya tenemos. Todo lo demás se deja en el piso: pociones, cajas, armas y armaduras comunes, anillos, etc.
export type DropInfo = { group: number; num: number; isMoney?: boolean; excellent?: boolean; level?: number };

/** Joyas y piezas de alas: Bless 14/13, Soul 14/14, Life 14/16, Creation 14/22, Guardian 14/31 (los Cristales), Chaos 12/15 y el Broken Sword 14/24 (ítem de la quest de Sebina, lo pidió el usuario). */
const JEWELS_GROUP_14 = new Set([13, 14, 16, 22, 24, 31]);
/** Piezas de las alas: Loch's Feather 13/14 (alas de nivel 2), Flame of Condor 13/52 y Feather of Condor 13/53 (alas de nivel 3). Valen como una
 * joya: prioridad y sin reserva de casillas. (El Horn of Dinorant y el Horn of Unicorn se sacaron de la lista: ya no hace falta juntarlos.) */
const WING_PARTS_GROUP_13 = new Set([14, 52, 53]);
export const isJewel = (d: DropInfo) =>
  (d.group === 14 && JEWELS_GROUP_14.has(d.num)) || (d.group === 12 && d.num === 15) || (d.group === 13 && WING_PARTS_GROUP_13.has(d.num));

/** Orbs de skill del Dark Knight: Twisting Slash 12/7, Rageful Blow 12/12, Impale 12/13, Greater Fortitude 12/14, Fire Slash 12/16, Death Stab 12/19. */
const DK_ORBS = new Set([7, 12, 13, 14, 16, 19]);
/** Qué skill enseña cada orb (número de skill de la tabla de skills): un orb de un skill que ya se tiene es basura. */
export const ORB_SKILL: Record<number, number> = { 7: 41, 12: 42, 13: 47, 14: 48, 16: 55, 19: 43 };
export const isDkOrb = (d: DropInfo) => d.group === 12 && DK_ORBS.has(d.num);

export type LootReason = 'zen' | 'joya' | 'excelente' | 'mejora' | 'skill';
/** Lo que el loop sabe y farming.ts no: si el ítem mejora el equipo puesto y si cabe en la bolsa. */
export type LootRules = { upgrade: (d: DropInfo) => boolean; room: (d: DropInfo) => boolean; skillKnown: (skill: number) => boolean };

/** Por qué vale la pena levantar este drop (o null si es basura). Sin lugar en la bolsa solo se levanta el zen. */
export function lootReason(d: DropInfo, rules: LootRules): LootReason | null {
  if (d.isMoney) return 'zen';
  if (!rules.room(d)) return null;
  if (isDkOrb(d)) return rules.skillKnown(ORB_SKILL[d.num]!) ? null : 'skill';
  if (isJewel(d)) return 'joya';
  if (d.excellent) return 'excelente';
  if (rules.upgrade(d)) return 'mejora';
  return null;
}

/** Lo que no es zen va primero aunque haya zen hasta este número de tiles más cerca. */
const PRIORITY_BONUS = 8;

// El drop que vale la pena más cercano a <= radius (o null).
export function pickLoot<D extends DropInfo & Pos>(me: Pos, drops: Iterable<D>, radius: number, rules: LootRules): D | null {
  let best: D | null = null;
  let bd = Infinity;
  for (const d of drops) {
    const why = lootReason(d, rules);
    if (!why) continue;
    const dd = cheb(me, d);
    const score = dd - (why === 'zen' ? 0 : PRIORITY_BONUS);
    if (dd <= radius && score < bd) {
      bd = score;
      best = d;
    }
  }
  return best;
}
