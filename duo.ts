/**
 * Dúo de crianza (usuario: "que Hume los ayude a crecer"): un personaje fuerte (padrino) sube a uno
 * nuevo (protegido) en la esquina de Arena 2 con party. El protegido no pelea: se para cerca y cobra.
 *
 * Reparto de exp de OpenMU (GameLogic/Party.cs, AttackableExtensions.CalculateBaseExperience):
 *   base(M, L) = ((M + 25) · M / 3 · (L > M + 10 ? (M + 10) / L : 1) + (M >= 65 ? (M − 64) · M / 4 : 0)) · 1,25
 *   pozo por kill = base(M, nivel promedio) · miembros · 1,05^(miembros − 1)
 *   a cada uno: pozo · su nivel / suma de niveles (entran el que mata y los que lo ven)
 * La base usa el nivel PROMEDIO: con un compañero bajo, el castigo por nivel alto se achica. Hume (300)
 * con Zamu (100) contra Gaint Drakan (100): Hume ~2,1× por kill que solo, y Zamu ~1/3 de eso.
 *
 * Lógica pura: se testea en `duo-tests.ts`.
 */
import { dist, type Pos } from './util';

/** Nivel del Gaint Drakan (data/monsters.json, 75): lo que se mata en la esquina. */
export const CORNER_MONSTER_LEVEL = 100;

/** Exp base de OpenMU por matar un monstruo de nivel `m` con nivel `killer` (sin multiplicadores del server). */
export function baseExp(m: number, killer: number): number {
  let e = ((m + 25) * m) / 3;
  if (killer > m + 10) e *= (m + 10) / killer;
  if (m >= 65) e += ((m - 64) * m) / 4;
  return Math.max(e, 0) * 1.25;
}

/** Exp por kill de cada miembro de la party (todos a la vista del que mata). */
export function partyShares(levels: readonly number[], m: number): number[] {
  const total = levels.reduce((a, l) => a + l, 0);
  if (!levels.length || total <= 0) return levels.map(() => 0);
  const avg = Math.floor(total / levels.length);
  const pool = baseExp(m, avg) * levels.length * 1.05 ** (levels.length - 1);
  return levels.map((l) => (pool * l) / total);
}

/**
 * Cuánto saco por kill en party con el compañero contra solo (las kills del compañero no se cuentan:
 * el protegido casi no mata). > 1: la party me suma aunque él no pegue.
 */
export function partyGain(myLevel: number, mateLevel: number, m = CORNER_MONSTER_LEVEL): number {
  const solo = baseExp(m, myLevel);
  return solo > 0 ? partyShares([myLevel, mateLevel], m)[0] / solo : 1;
}

/** Desde cuánto la party con un compañero más bajo se decide por la cuenta (y no por lo medido). */
export const PARTY_GAIN_MIN = 1.1;

export type DuoRole = 'padrino' | 'protegido' | null;

/** Por los stats (isFreshChar), no por la clase ni el nivel: el fuerte sube al nuevo. */
export function duoRole(meFresh: boolean, mateFresh: boolean | undefined): DuoRole {
  if (mateFresh == null || meFresh === mateFresh) return null;
  return meFresh ? 'protegido' : 'padrino';
}

/**
 * Dónde se para el protegido: el bolsillo de abajo de la esquina (paredes en x 10-16, y 13-17), lejos de
 * donde salen los Gaint Drakan (alrededor de (7,11)) y a <= WARD_MAX_DIST del padrino para entrar en
 * el reparto. Elige el que tiene menos monstruos a <= 4; empate: el más cerca del padrino.
 */
export const WARD_SPOTS: readonly Pos[] = [{ x: 7, y: 16 }, { x: 8, y: 15 }, { x: 6, y: 15 }, { x: 3, y: 12 }];
export const WARD_MAX_DIST = 9;

export function wardSpot(padrino: Pos, monsters: readonly Pos[]): Pos {
  const near = WARD_SPOTS.filter((s) => dist(s, padrino) <= WARD_MAX_DIST);
  const pool = near.length ? near : [padrino];
  const threat = (s: Pos) => monsters.filter((m) => dist(m, s) <= 4).length;
  return [...pool].sort((a, b) => threat(a) - threat(b) || dist(a, padrino) - dist(b, padrino))[0];
}
