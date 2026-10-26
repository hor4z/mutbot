/**
 * ¿Puede este personaje con este monstruo? Estimación con los stats reales (fuerza, agilidad,
 * vitalidad/vida, energía, clase) contra los de `data/monsters.json` (vida, daño, defensa, demora
 * entre ataques). Así la estrategia sale del personaje y no del nivel: un DK recién creado (28 de
 * fuerza) solo puede con arañas; uno con muchos puntos puede con casi todo. Lógica pura (power-tests.ts).
 *
 * Fórmulas del 0.97 (aproximadas, sin arma ni opciones: al principio el arma suma poco y la tabla
 * de ítems viene con las columnas corridas):
 *   daño     DK str/8..str/4 · mago ene/9..ene/4 · elfo agi/7+str/14..agi/4+str/8 · MG str/8..str/4 + ene/12
 *   defensa  DK agi/3 · mago agi/4 · elfo agi/10 · MG agi/4
 * Golpe real = max(daño − defensa, 10 % del daño, 1). El monstruo pega cada `Regen` ms (en la tabla
 * del cliente es la demora de ataque: Bull Fighter 1600, igual que OpenMU) y acierta ~70 %.
 */
import monstersData from './data/monsters.json';
import type { StatValues } from './farming';

type ClassFamily = 'knight' | 'wizard' | 'elf' | 'gladiator';
export type Fighter = { family: ClassFamily; stats: StatValues; maxHp: number };
type MonsterCombat = { hp: number; minDmg: number; maxDmg: number; def: number; attackDelayMs: number; level: number };

type Row = { Numb: number; HP: number; MinDmg: number; MaxDmg: number; Def: number; Regen: number; Level: number };
const COMBAT = new Map<number, MonsterCombat>(
  (monstersData as Row[]).filter((m) => m.HP > 0).map((m) => [m.Numb, {
    hp: m.HP, minDmg: m.MinDmg ?? 0, maxDmg: m.MaxDmg ?? 0, def: m.Def ?? 0, attackDelayMs: m.Regen > 0 ? m.Regen : 1600, level: m.Level,
  }]),
);

/** Lo que se acepta: matarlo en <= `maxKillSec` perdiendo <= `maxHpLoss` de la vida. */
// attackSec: un golpe cada 0,5 s (ATTACK_PACE_MS de config.ts; acá fijo para que sea puro).
const FIGHT_LIMITS: { maxKillSec: number; maxHpLoss: number; hitChance: number; attackSec: number } = { maxKillSec: 6, maxHpLoss: 0.35, hitChance: 0.7, attackSec: 0.5 };

function damageRange(f: Fighter): [number, number] {
  const { str, agi, ene } = f.stats;
  switch (f.family) {
    case 'knight': return [str / 8, str / 4];
    case 'wizard': return [ene / 9, ene / 4];
    case 'elf': return [agi / 7 + str / 14, agi / 4 + str / 8];
    case 'gladiator': return [str / 8 + ene / 12, str / 4 + ene / 12];
  }
}

function defenseOf(f: Fighter): number {
  const a = f.stats.agi;
  return f.family === 'knight' ? a / 3 : f.family === 'elf' ? a / 10 : a / 4;
}

const hit = (dmg: number, def: number) => Math.max(dmg - def, dmg * 0.1, 1);

type FightEstimate = { killSec: number; hpLoss: number; ok: boolean };

/** Segundos para matarlo y fracción de la vida que se pierde en ese tiempo. */
function estimateFight(f: Fighter, m: MonsterCombat, limits: typeof FIGHT_LIMITS = FIGHT_LIMITS): FightEstimate {
  const [lo, hi] = damageRange(f);
  const perHit = (hit(lo, m.def) + hit(hi, m.def)) / 2;
  const killSec = Math.ceil(m.hp / perHit) * limits.attackSec;
  const monHit = (hit(m.minDmg, defenseOf(f)) + hit(m.maxDmg, defenseOf(f))) / 2;
  const taken = (killSec * 1000 / m.attackDelayMs) * limits.hitChance * monHit;
  const hpLoss = f.maxHp > 0 ? taken / f.maxHp : 1;
  return { killSec, hpLoss, ok: killSec <= limits.maxKillSec && hpLoss <= limits.maxHpLoss };
}

/** ¿Lo ataco? Tipo sin datos: no. */
export function canFight(f: Fighter, type: number, limits: typeof FIGHT_LIMITS = FIGHT_LIMITS): boolean {
  const m = COMBAT.get(type);
  return !!m && estimateFight(f, m, limits).ok;
}

// El modelo ignora arma y skills, por eso el plazo de farmeo es más amplio que el de pelear una vez.
const FARM_ROUTE_LIMITS = { ...FIGHT_LIMITS, maxKillSec: 22, maxHpLoss: 0.5 };

/** ¿Puede farmear a este monstruo seguido (plazo más amplio que el de pelear)? Con skill de área (Twisting Slash) se descuenta 3×. */
export function canFarmMonster(f: Fighter, type: number, twistingSlash = false): boolean {
  const m = COMBAT.get(type);
  if (!m) return false;
  const e = estimateFight(f, m);
  // Twisting Slash golpea en área y escala con energía. El modelo base estima
  // golpes normales; 3× es un descuento conservador para el skill real, que
  // se castea más lento. El rendimiento definitivo se mide con la exp real.
  const power = twistingSlash ? 3 : 1;
  return e.killSec / power <= FARM_ROUTE_LIMITS.maxKillSec && e.hpLoss / power <= FARM_ROUTE_LIMITS.maxHpLoss;
}
