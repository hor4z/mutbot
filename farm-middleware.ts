/**
 * Qué mapa farmear, por exp medida y no por una tabla de niveles. Para el personaje que no puede con
 * la esquina de Arena 2 (no mata Drakan): Hume tras el grand reset (2 resets, nivel 300+) quedaba en
 * Devias o en Arena 1 a 1-16M/min porque el modelo de stats le negaba las Arenas, y en Arena 4 hacía
 * 157M/min.
 *
 * Cómo decide (lógica pura, farm-middleware-tests.ts):
 * - Opciones: Arena 4, 3, 2, 1 y las entradas de Devias que su nivel habilita.
 * - Cada opción tiene su exp/min neta medida (desde el warp, con la caminata) con un personaje
 *   parecido: nivel ±LEVEL_WINDOW y stats ±20 %. Lo medido con otro personaje (antes de un grand
 *   reset, o con muchos menos stats) no cuenta.
 * - Primero prueba las Arenas sin medir, de la más alta a la más baja; Arena 1 y Devias solo si las
 *   Arenas medidas rinden poco o no hay ninguna a mano. Después va a la que mejor rinde y se queda
 *   salvo que otra sea SWITCH_GAIN mejor (no salta por ruido).
 * - Una muerte saca ese mapa por 10 min; un mapa que el modelo de stats ve imposible no se prueba.
 * No manda packets ni modifica los ritmos humanos.
 */
import { canFarmMonster, canProbeArena4, estimateFight, farmRouteLevel, monsterCombat, type Fighter } from './power';

// power: suma de stats al medir. Tras un grand reset el nivel se repite con muchos menos stats
// (Hume: 63 resets → 2), y la exp/min de antes no sirve para juzgar la de ahora.
export type FarmSpotScore = { rate: number; level: number; n: number; power?: number };
export type FarmScores = Record<number, FarmSpotScore>;
/** spot: warp elegido por lo medido (null: manda la ruta fija por tramo). */
export type FarmProfile = { routeLevel: number; limited: boolean; corner: boolean; spot: number | null; why: string };

type FarmOption = { name: string; map: number; spots: readonly number[]; minLevel: number; cap: number; gate?: number; low?: boolean };
// gate: el monstruo común del mapa para el veto de supervivencia. low: solo se prueba si las Arenas
// 2-4 rinden poco (Arena 1 dio 0,9M/min y Devias 16M/min contra 157M/min de Arena 4).
export const FARM_OPTIONS: readonly FarmOption[] = [
  { name: 'Arena 4', map: 85, spots: [26], minLevel: 300, cap: Infinity, gate: 75 },
  { name: 'Arena 3', map: 84, spots: [25], minLevel: 200, cap: 299, gate: 72 },
  { name: 'Arena 2', map: 83, spots: [24], minLevel: 100, cap: 199, gate: 63 },
  { name: 'Arena 1', map: 6, spots: [1], minLevel: 50, cap: 99, low: true },
  { name: 'Devias', map: 2, spots: [7, 6, 5], minLevel: 20, cap: 99, low: true },
];

// La prueba incluye la caminata y la carga del mapa: con 90 s Arena 4 dio 11M/min recién conectado.
const TRIAL_MS = 150_000;
const SAMPLE_MS = 60_000;
const AVOID_MS = 10 * 60_000;
const MIN_RATE = 1e6;
const BEST_FRAC = 0.85;
const POWER_TOL = 0.2;
const LEVEL_WINDOW = 80;
// Otra opción tiene que rendir esto más que la actual para irse (si no, salta por ruido).
const SWITCH_GAIN = 1.15;
// Arena 1 y Devias se prueban solo si la mejor Arena medida rinde menos que esto.
const LOW_TRY_BELOW = 40e6;
// Veto: con golpes normales (Twisting Slash ~3×) matar al común del mapa le cuesta más que esto.
const VETO = { maxKillSec: 60, maxHpLoss: 1 };
// El selector manda desde este nivel; debajo, el arranque (early-step) y la ruta fija.
export const CHOOSER_MIN_LEVEL = 100;

export const statPower = (f: Fighter) => f.stats.str + f.stats.agi + f.stats.vit + f.stats.ene;

/** ¿Este puntaje se midió con un personaje parecido? Sin potencia guardada (dato viejo): no. */
export function comparableScore(v: FarmSpotScore, level: number, power: number): boolean {
  if (Math.abs(v.level - level) > LEVEL_WINDOW) return false;
  if (!(power > 0)) return true;
  return v.power != null && v.power > 0 && Math.abs(v.power - power) <= power * POWER_TOL;
}

const fmt = (r: number) => `${Math.round(r / 1e6)}M/min`;
export const optionOfSpot = (spot: number) => FARM_OPTIONS.find((o) => o.spots.includes(spot));
export const optionOfMap = (map: number) => FARM_OPTIONS.find((o) => o.map === map);

export class FarmMiddleware {
  readonly scores: FarmScores = {};
  private readonly avoidUntil = new Map<number, number>();
  private sampledAt = 0;
  private sampledSpot = -1;
  // Spot donde se midió por última vez: la opción actual (histéresis).
  private currentSpot = -1;

  load(scores: FarmScores | undefined) {
    for (const [key, v] of Object.entries(scores ?? {})) {
      if (v && Number.isFinite(v.rate) && v.rate >= 0 && Number.isFinite(v.level) && Number.isFinite(v.n) && v.n > 0)
        this.scores[Number(key)] = { rate: v.rate, level: v.level, n: v.n, ...(Number.isFinite(v.power) ? { power: v.power } : {}) };
    }
  }

  /**
   * Lo medido en la base (ticks del mismo personaje con resets parecidos): llena los spots sin puntaje
   * comparable, así no repite la gira de pruebas en cada conexión.
   */
  seed(rows: readonly { spot: number; rate: number; level: number; n: number }[], power: number) {
    for (const r of rows) {
      if (![r.spot, r.rate, r.level, r.n].every(Number.isFinite) || r.n < 1) continue;
      const old = this.scores[r.spot];
      if (old && comparableScore(old, r.level, power) && old.n >= r.n) continue;
      this.scores[r.spot] = { rate: r.rate, level: r.level, n: r.n, power };
    }
  }

  /** ¿Elige el mapa por lo medido? El que hace la esquina (mata Drakan) sigue con la ruta y la esquina. */
  chooserOn(f: Fighter, level: number, twistingSlash: boolean): boolean {
    return level >= CHOOSER_MIN_LEVEL && f.maxHp > 0 && statPower(f) > 0 && !canFarmMonster(f, 75, twistingSlash);
  }

  profile(f: Fighter, level: number, twistingSlash: boolean, now: number): FarmProfile {
    if (this.chooserOn(f, level, twistingSlash)) {
      const c = this.choose(f, level, twistingSlash, now);
      return { routeLevel: Math.min(level, c.option?.cap ?? level), limited: true, corner: false, spot: c.spot, why: c.why };
    }
    const safeLevel = farmRouteLevel(f, level, twistingSlash);
    const routeLevel = safeLevel === 299 && level >= 300 && canProbeArena4(f, twistingSlash) ? level : safeLevel;
    return { routeLevel, limited: safeLevel < level, corner: routeLevel >= 100 && canFarmMonster(f, 75, twistingSlash), spot: null, why: '' };
  }

  /** Mejor puntaje comparable de una opción (Devias: su mejor entrada). */
  private scoreOf(o: FarmOption, level: number, power: number): { rate: number; spot: number } | null {
    let best: { rate: number; spot: number } | null = null;
    for (const s of o.spots) {
      const v = this.scores[s];
      if (v && v.n >= 1 && comparableScore(v, level, power) && (!best || v.rate > best.rate)) best = { rate: v.rate, spot: s };
    }
    return best;
  }

  private vetoed(f: Fighter, o: FarmOption, twistingSlash: boolean): boolean {
    const m = o.gate == null ? undefined : monsterCombat(o.gate);
    if (!m) return false;
    const e = estimateFight(f, m);
    const k = twistingSlash ? 3 : 1;
    return e.killSec / k > VETO.maxKillSec || e.hpLoss / k > VETO.maxHpLoss;
  }

  choose(f: Fighter, level: number, twistingSlash: boolean, now: number): { option: FarmOption | null; spot: number | null; why: string } {
    const power = statPower(f);
    const open = FARM_OPTIONS.filter((o) => level >= o.minLevel && (this.avoidUntil.get(o.map) ?? 0) <= now && !this.vetoed(f, o, twistingSlash));
    if (!open.length) return { option: null, spot: null, why: 'ningún mapa a mano' };
    const measured = open.map((o) => ({ o, s: this.scoreOf(o, level, power) }));
    const bestArena = Math.max(0, ...measured.filter((m) => !m.o.low && m.s).map((m) => m.s!.rate));
    const arenasLeft = measured.some((m) => !m.o.low && !m.s);
    // Explorar: la Arena más alta sin medir; Arena 1/Devias solo si las Arenas no alcanzan.
    const unmeasured = measured.find((m) => !m.s && (!m.o.low || (!arenasLeft && bestArena < LOW_TRY_BELOW)));
    if (unmeasured) return { option: unmeasured.o, spot: unmeasured.o.spots[0], why: `${unmeasured.o.name} sin medir con estos stats: la pruebo` };
    const ranked = measured.filter((m) => m.s).sort((a, b) => b.s!.rate - a.s!.rate);
    const top = ranked[0];
    if (!top) return { option: open[0], spot: open[0].spots[0], why: `${open[0].name}: nada medido` };
    const cur = ranked.find((m) => m.o.spots.includes(this.currentSpot));
    if (cur && cur !== top && top.s!.rate < cur.s!.rate * SWITCH_GAIN)
      return { option: cur.o, spot: this.currentSpot, why: `${cur.o.name} ${fmt(cur.s!.rate)}, ${top.o.name} ${fmt(top.s!.rate)}: no alcanza para cambiar` };
    const others = ranked.filter((m) => m !== top).map((m) => `${m.o.name} ${fmt(m.s!.rate)}`).join(', ');
    const spot = top.o.spots.includes(this.currentSpot) ? this.currentSpot : top.s!.spot;
    return { option: top.o, spot, why: `${top.o.name} rinde ${fmt(top.s!.rate)}${others ? ` (${others})` : ''}` };
  }

  target(f: Fighter, type: number, twistingSlash: boolean): boolean {
    return canFarmMonster(f, type, twistingSlash) || (type === 75 && canProbeArena4(f, twistingSlash));
  }

  /** Al reconectar no deshacer un campamento rentable para repetir el viaje a la esquina. */
  keepCurrentArena(map: number, level: number, minRate: number, power = 0): boolean {
    const spot = map === 84 ? 25 : map === 85 ? 26 : null;
    const score = spot == null ? null : this.scores[spot];
    return !!score && score.n >= 2 && comparableScore(score, level, power) && score.rate >= minRate;
  }

  /**
   * Mide el spot actual (una vez por minuto, pasada la prueba) y devuelve el motivo para irse cuando
   * corresponde: otro mapa elegido por el selector, u otra entrada de Devias si esta no rinde.
   */
  observe(inp: { spot: number; map: number; level: number; now: number; arrivalAt: number; rate: number; f?: Fighter; twistingSlash?: boolean }): string | null {
    const { spot, map, level, now, arrivalAt, rate, f, twistingSlash = false } = inp;
    const power = f ? statPower(f) : 0;
    this.currentSpot = spot;
    if (now - arrivalAt < TRIAL_MS) return null;
    if (this.sampledSpot === spot && now - this.sampledAt < SAMPLE_MS) return null;
    this.sampledSpot = spot;
    this.sampledAt = now;
    const old = this.scores[spot];
    // Los puntajes de otro tramo o de otra potencia no sirven: tras un reset la exp por kill
    // cambia, y tras un grand reset el mismo nivel rinde mucho menos. Con la exp de Hume de 63
    // resets (Arena 2 a 261M) descartaba Arena 3 a 100M y terminaba en Devias 2 a 5M.
    const comparable = old && comparableScore(old, level, power);
    const score = comparable ? old.rate * 0.7 + rate * 0.3 : rate;
    this.scores[spot] = { rate: score, level, n: comparable ? old.n + 1 : 1, ...(power > 0 ? { power } : {}) };
    if (f && this.chooserOn(f, level, twistingSlash)) {
      const c = this.choose(f, level, twistingSlash, now);
      if (c.spot != null && c.option && !c.option.spots.includes(spot)) return `${fmt(rate)} acá; ${c.why}`;
      if (map === 2 && rate < MIN_RATE) return `${fmt(rate)}; pruebo otra entrada de Devias`;
      return null;
    }
    // Personaje en Devias por debajo del selector: otra entrada si esta no rinde.
    if (map !== 2) return null;
    const bestOther = Math.max(0, ...Object.entries(this.scores)
      .filter(([k, v]) => Number(k) !== spot && comparableScore(v, level, power) && v.n >= 1)
      .map(([, v]) => v.rate));
    return rate >= Math.max(MIN_RATE, bestOther * BEST_FRAC) ? null : `${fmt(rate)}; pruebo otra entrada de Devias`;
  }

  /** Muerte: ese mapa queda fuera del selector por 10 min. */
  death(map: number, now: number): boolean {
    if (!optionOfMap(map)) return false;
    this.avoidUntil.set(map, now + AVOID_MS);
    return true;
  }
}

export const farmMiddleware = new FarmMiddleware();
