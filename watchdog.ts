/**
 * Vigía de trabas (lógica pura, tests en watchdog-tests.ts): si no hay progreso (exp, kills, nivel,
 * movimiento, cambio de objetivo o de mapa) por STUCK.stepMs, diagnostica por qué y propone el remedio
 * más seguro; si sigue sin progreso escala (2.º y 3.er escalón). El loop (farm-loop.ts) aplica el
 * remedio y deja traza en el diario (journal) y en la base (evento `stuck`).
 *
 * Es una red de seguridad ADEMÁS de lo que ya hay (ceguera de 3 min, hambre, objetivo inalcanzable):
 * los umbrales son largos a propósito para no pisar las esperas normales (respawn en la esquina).
 */

export const STUCK = {
  /** Sin progreso este tiempo = escalón 1; el 2.º y el 3.º a 2× y 3×. */
  stepMs: 4 * 60_000,
  /** Moverse esto (en tiles, chebyshev) desde el ancla cuenta como progreso. */
  moveTiles: 3,
  /** Sin ningún packet del server este tiempo = el server no responde. */
  silentMs: 45_000,
  /** Con la vida por debajo de esto y sin pociones, retirarse. */
  lowHpPct: 30,
  /** Pasos seguidos contra una pared (walkTowards.walkStuck) que lo hacen sospechoso. */
  wallSteps: 4,
} as const;

export type Diagnosis = 'pk' | 'no_response' | 'bag_full' | 'no_potion' | 'wall' | 'dry_map' | 'idle';
export type Remedy = 'pkclear' | 'drop_target' | 'leave_camp' | 'ignore_loot' | 'rewarp' | 'warp_town' | 'reconnect' | 'log_only';

/** Modos en los que no se espera progreso (el vigía se apaga y vuelve a empezar al salir). */
const EXEMPT_MODES = new Set(['paused', 'resetting', 'connecting', 'dead']);

export type WatchInput = {
  now: number;
  mode: string;
  map: number;
  x: number;
  y: number;
  level: number;
  /** Exp total y kills acumulados (siempre crecientes). */
  expTotal: number;
  kills: number;
  /** Objetivo actual (id) o null. */
  target: number | null;
  // Contexto para el diagnóstico:
  pk: boolean;
  /** Casillas libres del inventario, null si no se sabe. */
  freeSlots: number | null;
  /** Pociones de curación en el inventario. */
  potions: number;
  hpPct: number;
  /** Monstruos atacables a la vista. */
  monsters: number;
  walkStuck: number;
  /** Hay un drop valioso que se está intentando levantar hace rato. */
  lootingLong: boolean;
  /** ms desde el último packet del server (null = no se sabe). */
  silentMs: number | null;
  hunting: boolean;
};

export type Verdict = {
  diagnosis: Diagnosis;
  remedy: Remedy;
  /** 1, 2 o 3. */
  step: 1 | 2 | 3;
  idleMs: number;
  /** Frase para el diario. */
  why: string;
};

const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export class StuckWatch {
  private lastProgress: number | null = null;
  private anchor = { x: 0, y: 0, map: -1 };
  private last: { expTotal: number; kills: number; level: number; target: number | null } | null = null;
  private fired = 0;

  constructor(readonly cfg: typeof STUCK = STUCK) {}

  /** Cuánto hace que no hay progreso (0 si el vigía está apagado). */
  idleMs(now: number) {
    return this.lastProgress == null ? 0 : now - this.lastProgress;
  }

  private reset(i: WatchInput) {
    this.lastProgress = i.now;
    this.anchor = { x: i.x, y: i.y, map: i.map };
    this.last = { expTotal: i.expTotal, kills: i.kills, level: i.level, target: i.target };
    this.fired = 0;
  }

  /** Alimentar con el estado de cada tick (alcanza cada ~1 s). Devuelve el veredicto cuando toca actuar. */
  feed(i: WatchInput): Verdict | null {
    if (EXEMPT_MODES.has(i.mode)) {
      this.lastProgress = null;
      this.last = null;
      return null;
    }
    if (this.lastProgress == null || this.last == null) {
      this.reset(i);
      return null;
    }
    const l = this.last;
    const moved = i.map !== this.anchor.map || cheb(i.x, i.y, this.anchor.x, this.anchor.y) >= this.cfg.moveTiles;
    const targetChanged = i.target != null && i.target !== l.target;
    if (i.expTotal > l.expTotal || i.kills > l.kills || i.level !== l.level || moved || targetChanged) {
      this.reset(i);
      return null;
    }
    l.target = i.target ?? l.target;
    const idle = i.now - this.lastProgress;
    const step = idle >= 3 * this.cfg.stepMs ? 3 : idle >= 2 * this.cfg.stepMs ? 2 : idle >= this.cfg.stepMs ? 1 : 0;
    // Cada escalón se dispara una sola vez por episodio.
    if (step === 0 || step <= this.fired) return null;
    this.fired = step;
    return { ...diagnose(i, step as 1 | 2 | 3, this.cfg), step: step as 1 | 2 | 3, idleMs: idle };
  }
}

/** Diagnóstico y remedio seguro para el escalón dado. */
export function diagnose(i: WatchInput, step: 1 | 2 | 3, cfg: typeof STUCK = STUCK): { diagnosis: Diagnosis; remedy: Remedy; why: string } {
  const min = (n: number) => Math.round(n / 60_000);
  if (i.silentMs != null && i.silentMs > cfg.silentMs)
    return { diagnosis: 'no_response', remedy: 'reconnect', why: `el server no manda nada hace ${Math.round(i.silentMs / 1000)} s: reconecto` };
  if (i.pk) {
    // Reconectar o warpear no sirve con PK: /pkclear (tope y enfriamiento en recovery.ts); después, esperar.
    return { diagnosis: 'pk', remedy: step === 1 ? 'pkclear' : 'log_only', why: 'soy PK (no puede usar /move): pido /pkclear' };
  }
  if (i.freeSlots === 0 && i.lootingLong)
    return { diagnosis: 'bag_full', remedy: 'ignore_loot', why: 'bolsa llena y el loot no entra: lo dejo de intentar' };
  if (i.hpPct < cfg.lowHpPct && i.potions === 0)
    return { diagnosis: 'no_potion', remedy: step === 1 ? 'warp_town' : 'log_only', why: `vida ${Math.round(i.hpPct)} % sin pociones: me retiro a Lorencia` };
  if (i.walkStuck >= cfg.wallSteps)
    return step === 1
      ? { diagnosis: 'wall', remedy: 'drop_target', why: 'camino contra un muro sin avanzar: suelto el objetivo y cambio de campamento' }
      : step === 2
        ? { diagnosis: 'wall', remedy: 'rewarp', why: 'sigo contra el muro: vuelvo a entrar al mapa' }
        : { diagnosis: 'wall', remedy: 'reconnect', why: 'sigo trabado contra el muro: reconecto' };
  if (i.monsters === 0 && !i.hunting)
    return step === 3
      ? { diagnosis: 'dry_map', remedy: 'reconnect', why: 'mapa sin monstruos hace mucho: reconecto' }
      : { diagnosis: 'dry_map', remedy: 'rewarp', why: `mapa seco hace ${min(cfg.stepMs * step)} min sin monstruos a la vista: cambio de spot` };
  if (step === 1) return { diagnosis: 'idle', remedy: 'leave_camp', why: 'sin progreso: suelto objetivo y campamento' };
  if (step === 2) return { diagnosis: 'idle', remedy: 'rewarp', why: 'sigo sin progreso: vuelvo a entrar al mapa' };
  return { diagnosis: 'idle', remedy: 'reconnect', why: 'sin progreso hace rato: reconecto' };
}
