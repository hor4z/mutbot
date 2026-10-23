/**
 * Remate del golpe final (2026-10-23): la caja es de QUIEN DA EL GOLPE FINAL (y su party) los primeros 10 s
 * (AttackableNpcBase / DroppedItem de OpenMU). Con un dragón a la vista que OTROS están pegando, se espera a
 * rango de cast sin pegar y se ataca cuando lo que falta, estimado, es <= FINISHER_HITS golpes propios.
 * Seguro: sin otros atacantes en los últimos 3 s, sin HP conocido, sin muestra del golpe propio o con lecturas
 * inconsistentes (daño visto > HP) se ataca como siempre. Tope: FINISHER_MAX_WAIT_MS sin que baje lo estimado.
 * Lógica pura (reloj por parámetro): se testea en `golden-tests.ts`. MUBOT_FINISHER=0 la apaga.
 */
export const FINISHER_HITS = 3;
export const FINISHER_OTHERS_MS = 3000;
export const FINISHER_MAX_WAIT_MS = 25_000;
// Un daño leído hasta este tiempo después de nuestro cast cuenta como golpe propio (muestra del daño típico).
export const FINISHER_OWN_WINDOW_MS = 1500;
export const finisherOn = () => process.env.MUBOT_FINISHER !== '0';
export type FinisherVerdict = 'wait' | 'strike' | 'none';

type T = { dmg: number; others: Map<number, number>; waitingSince: number | null; lastRemaining: number | null; progressAt: number; gaveUp: boolean };

export class Finisher {
  private t = new Map<number, T>();
  private own: number[] = [];
  private lastCast: { id: number; at: number } | null = null;
  constructor(private readonly hits = FINISHER_HITS) {}

  private get(id: number, now: number): T {
    let x = this.t.get(id);
    if (!x) { x = { dmg: 0, others: new Map(), waitingSince: null, lastRemaining: null, progressAt: now, gaveUp: false }; this.t.set(id, x); }
    return x;
  }
  /** Un jugador (no compañero, no yo) ataca a `target` (parseFight). */
  other(target: number, attacker: number, now: number) { this.get(target, now).others.set(attacker, now); }
  /** Daño visto sobre `id` (ObjectHit 0x15), de cualquiera. */
  damage(id: number, dmg: number, now: number) {
    if (!(dmg > 0 && dmg < 60_000)) return;
    this.get(id, now).dmg += dmg;
    if (this.lastCast && this.lastCast.id === id && now - this.lastCast.at <= FINISHER_OWN_WINDOW_MS && this.own.length < 50) this.own.push(dmg);
  }
  /** Pegué (cast o golpe) a `id`. */
  cast(id: number, now: number) { this.lastCast = { id, at: now }; }
  /** Mediana del daño propio visto, o null sin muestras. */
  ownHit(): number | null {
    if (this.own.length < 2) return null;
    const s = [...this.own].sort((a, b) => a - b);
    return s[s.length >> 1];
  }
  forget(id: number) { this.t.delete(id); }

  decide(id: number, hp: number | null, now: number): { verdict: FinisherVerdict; remaining: number | null; why: string } {
    const x = this.t.get(id);
    const own = this.ownHit();
    if (!x || hp == null || own == null) return { verdict: 'none', remaining: null, why: 'sin datos' };
    if (x.gaveUp) return { verdict: 'strike', remaining: null, why: 'espera agotada' };
    const remaining = hp - x.dmg;
    if (remaining <= 0) return { verdict: 'none', remaining, why: 'lectura inconsistente' };
    const active = [...x.others.values()].some((at) => now - at <= FINISHER_OTHERS_MS);
    if (!active) { x.waitingSince = null; return { verdict: 'none', remaining, why: 'nadie más pega' }; }
    if (remaining <= this.hits * own) return { verdict: 'strike', remaining, why: `faltan ~${remaining}, <= ${this.hits} golpes de ~${own}` };
    if (x.waitingSince == null) { x.waitingSince = now; x.progressAt = now; x.lastRemaining = remaining; }
    else if (x.lastRemaining != null && remaining < x.lastRemaining) { x.lastRemaining = remaining; x.progressAt = now; }
    if (now - x.progressAt > FINISHER_MAX_WAIT_MS) { x.gaveUp = true; return { verdict: 'strike', remaining, why: 'la vida no baja hace 25 s' }; }
    return { verdict: 'wait', remaining, why: `faltan ~${remaining}` };
  }
  /** ¿Se estaba esperando este objetivo? (para el diario cuando muere) */
  waited(id: number): boolean { return this.t.get(id)?.waitingSince != null; }
}
