/**
 * Evaluación de ítems (lógica pura): cuánto sirve una pieza para una clase, cuántos Cristales da en el
 * Alquimista y qué hacer con un drop (levantar / guardar / basura). Los pesos son una HEURÍSTICA nuestra
 * (puntos de defensa equivalentes), no datos del juego; los datos duros (tabla de Cristales, niveles de
 * defensa) salen de las guías y de OpenMU y están citados en docs/items-y-maquinas.md.
 */
import { armorSlot, cannotUse, itemRule, type Fighter } from './item-rules';

export type ScorableItem = {
  group: number;
  num: number;
  level: number;
  excellent?: boolean;
  luck?: boolean;
  /** 0-7 (cada punto = +4 defensa en armaduras) */
  option?: number;
  /** bits 0-5 de excelentes (ver EXC_ARMOR) */
  excFlags?: number;
  excCount?: number;
  ancient?: number;
  harmony?: { option: number; level: number } | null;
  opt380?: boolean;
  durability?: number;
};

/** Bonus de defensa por nivel +0..+15 (tabla de OpenMU: 3 por nivel hasta +9, después sube más). */
export const DEFENSE_PER_LEVEL: readonly number[] = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 31, 36, 42, 49, 57, 66];

/**
 * Excelentes de armadura por bit (orden del MU original; SIN verificar en este server): 0 maná por
 * monstruo /8, 1 vida por monstruo /8, 2 zen +40 %, 3 éxito de defensa +10 %, 4 reflejo 5 %, 5 daño
 * recibido -4 %. Peso = puntos de defensa equivalentes (a ojo: el -4 % de daño es lo que más rinde).
 */
export const EXC_ARMOR: readonly { bit: number; name: string; weight: number }[] = [
  { bit: 0, name: 'maná por kill', weight: 4 },
  { bit: 1, name: 'vida por kill', weight: 6 },
  { bit: 2, name: 'zen +40%', weight: 3 },
  { bit: 3, name: 'éxito de defensa +10%', weight: 10 },
  { bit: 4, name: 'reflejo 5%', weight: 8 },
  { bit: 5, name: 'daño recibido -4%', weight: 25 },
];

export type ScoreParts = { base: number; level: number; option: number; exc: number; luck: number; ancient: number; harmony: number; total: number };

/** Puntaje de una armadura/escudo (defensa equivalente). Para otros grupos devuelve 0: no se puntúan. */
export function scoreArmor(it: ScorableItem): ScoreParts {
  const rule = itemRule(it.group, it.num);
  const base = rule?.defense ?? 0;
  const level = DEFENSE_PER_LEVEL[Math.min(15, Math.max(0, it.level))] ?? 0;
  const option = (it.option ?? 0) * 4;
  const flags = it.excFlags ?? 0;
  let exc = 0;
  if (flags) {
    for (const e of EXC_ARMOR) if (flags & (1 << e.bit)) exc += e.weight;
  } else if (it.excCount) exc = it.excCount * 10; // solo la cuenta
  else if (it.excellent) exc = 15; // sin detalle (drop/bolsa): un excelente vale ~15
  const luck = it.luck ? 4 : 0;
  const ancient = it.ancient ? 20 : 0;
  const harmony = it.harmony ? 5 + it.harmony.level : 0;
  const total = (it.durability === 0 ? 0.5 : 1) * (base + level + option + exc + luck + ancient + harmony) + (it.opt380 ? 15 : 0);
  return { base, level, option, exc, luck, ancient, harmony, total: Math.round(total * 10) / 10 };
}

export const scoreOf = (it: ScorableItem) => scoreArmor(it).total;

/** Nombre del set ("Great Dragon" de "Great Dragon Armor") para el desempate por set completo. */
export function setNameOf(name: string): string {
  return name.replace(/\s+(Helm|Armor|Pants|Gloves|Boots)$/i, '').trim();
}

// ---------------------------------------------------------------------------
// Cristales (Alquimista, guía "El Alquimista", 2026-10-12)
// ---------------------------------------------------------------------------
export const CRYSTAL_BY_EXC = [0, 1, 3, 8, 20, 50, 50] as const;
export type Grade = 'bajo' | 'normal' | 'alto' | 'top';
const GRADE_MULT: Record<Grade, number> = { bajo: 0.5, normal: 1, alto: 1.5, top: 2 };

/**
 * Grado del ítem. La guía dice "grado bajo / alto / top" pero NO publica cuál es cuál: estimación por el
 * nivel que pide (>= 80 top, >= 60 alto, >= 30 normal, el resto bajo; los sets viejos sin nivel, bajo).
 */
export function gradeOf(group: number, n: number): Grade {
  const lv = itemRule(group, n)?.reqLevel ?? 0;
  return lv >= 80 ? 'top' : lv >= 60 ? 'alto' : lv >= 30 ? 'normal' : 'bajo';
}

/** Cristales esperados de cristalizar un ítem (sin contar CRÍTICO x2 ni JACKPOT x10, cuya tasa no se publica). null = no se puede (sin excelentes). */
export function crystalValue(it: ScorableItem): number | null {
  const n = it.excCount ?? (it.excellent ? 1 : 0);
  if (n <= 0 || it.group > 11 || it.group === 12) return null;
  const lvMult = it.level >= 15 ? 15 : it.level === 14 ? 4.5 : it.level >= 9 ? 1.5 : 1;
  const v = CRYSTAL_BY_EXC[Math.min(6, n)] * GRADE_MULT[gradeOf(it.group, it.num)] * lvMult * (it.luck ? 1.25 : 1);
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Qué hacer con un ítem
// ---------------------------------------------------------------------------
export type Verdict = { action: 'equipar' | 'guardar' | 'cristalizar' | 'basura'; why: string; score: number; crystals: number | null };

/**
 * `worn`: lo que lleva puesto en ese lugar (para saber si mejora). Armadura mejor que la puesta y usable →
 * equipar; excelente con >= minCrystals → cristalizar (o guardar si no hay prisa por el lugar); resto basura.
 */
export function judgeItem(it: ScorableItem, f: Fighter, worn: ScorableItem | undefined, opts: { minCrystals?: number } = {}): Verdict {
  const score = scoreOf(it);
  const crystals = crystalValue(it);
  const slot = armorSlot(it.group);
  const blocked = slot != null ? cannotUse(it.group, it.num, f) : 'no es armadura';
  if (slot != null && !blocked && score > (worn ? scoreOf(worn) : 0) + 1) return { action: 'equipar', why: `mejora el ${worn ? 'puesto' : 'lugar vacío'} (+${(score - (worn ? scoreOf(worn) : 0)).toFixed(0)})`, score, crystals };
  if (crystals != null && crystals >= (opts.minCrystals ?? 3)) return { action: 'cristalizar', why: `${crystals} Cristales`, score, crystals };
  if (it.ancient || it.harmony || (it.level >= 13 && (it.excCount ?? 0) > 0)) return { action: 'guardar', why: it.ancient ? 'ancient' : it.harmony ? 'con armonía (no se puede vender)' : '+13 o más (sirve para fusionar)', score, crystals };
  return { action: 'basura', why: blocked ? `no la uso (${blocked})` : 'no mejora lo puesto', score, crystals };
}

/**
 * Para `isValuableDrop` (farming.ts): devuelve una función que dice true/false para el equipo (grupos
 * 0-11) o undefined si no opina. Por defecto NO se usa (loot.ts pasa null): activarla es decisión de quien
 * la conecte. Levanta lo que mejoraría el set o lo que da >= minCrystals; el resto no.
 */
export function makeDropJudge(f: Fighter, equipped: (slot: number) => ScorableItem | undefined, opts: { minCrystals?: number } = {}) {
  return (drop: Omit<ScorableItem, 'level'> & { level?: number }): boolean | undefined => {
    const d: ScorableItem = { ...drop, level: drop.level ?? 0 };
    if (d.group > 11) return undefined;
    const v = judgeItem(d, f, armorSlot(d.group) != null ? equipped(armorSlot(d.group)!) : undefined, opts);
    return v.action === 'equipar' || v.action === 'cristalizar' || v.action === 'guardar';
  };
}
