/**
 * Vida real (lógica pura, tests en health-tests.ts). El protocolo del 0.97d manda la vida en 16 bits: con
 * los 4 stats al tope Hume tiene un máximo apenas arriba de 65.535 y la lectura se "da vuelta" (65.682 llega
 * como 146). Medido en la base (ticks de Hume, nivel > 350, farmeando): 30 % de las lecturas en 57.344-65.535
 * y lecturas repetidas de 141-187 con más de 300M de exp/min, o sea a plena vida. El bot creía estar casi
 * muerto (pociones, huida a Lorencia por "vida < 35 %") y nunca ve el margen real.
 *
 * `HpTracker` des-envuelve por continuidad: un daño no baja la vida más de ~55.000 en un solo aviso, así que un
 * salto de casi 65.536 entre dos lecturas seguidas es el envoltorio, no un golpe. Es conservador: sin salto
 * así (o sin máximo cerca del tope) devuelve la lectura tal cual (comportamiento de siempre).
 */
export const HP_WRAP = 65_536;
/** Salto mínimo entre dos lecturas seguidas que se toma por envoltorio (un golpe real no lo hace). */
export const HP_WRAP_JUMP = 55_000;
/** Solo se des-envuelve si el máximo informado está cerca del tope de 16 bits. */
export const HP_NEAR_CAP = 60_000;

export class HpTracker {
  /** 0 = lectura directa; 1 = la lectura viene envuelta (real = lectura + 65.536). */
  wraps = 0;
  private lastRaw: number | null = null;
  /** Mayor vida real vista (sirve de máximo si el informado quedó corto). */
  maxSeen = 0;
  /** Cantidad de veces que se detectó un envoltorio (para el diario). */
  events = 0;

  /** Vida real a partir de la lectura cruda del packet y el máximo informado por el server. */
  feed(raw: number, reportedMax: number): number {
    const prev = this.lastRaw;
    this.lastRaw = raw;
    // 0 es la muerte (el server manda 0 al morir): nunca se des-envuelve.
    if (raw === 0) {
      this.wraps = 0;
      return 0;
    }
    if (reportedMax >= HP_NEAR_CAP && prev != null) {
      const prevReal = prev + this.wraps * HP_WRAP;
      if (this.wraps === 0 && prev - raw >= HP_WRAP_JUMP && prevReal >= HP_NEAR_CAP) {
        this.wraps = 1;
        this.events++;
      } else if (this.wraps === 1 && raw - prev >= HP_WRAP_JUMP) {
        this.wraps = 0;
        this.events++;
      }
    } else if (reportedMax < HP_NEAR_CAP) {
      this.wraps = 0;
    }
    const real = raw + this.wraps * HP_WRAP;
    if (real > this.maxSeen) this.maxSeen = real;
    return real;
  }

  /** Máximo a usar para el porcentaje: el informado o, si la vida real ya lo pasó, la mayor vista. */
  maxFor(reportedMax: number): number {
    return Math.max(reportedMax, this.maxSeen);
  }

  reset() {
    this.wraps = 0;
    this.lastRaw = null;
    this.maxSeen = 0;
  }
}
