/**
 * "Crear escuadra" (cuentas nuevas), solo como PLAN y como ejecución paso a paso que el usuario dispara
 * a mano desde la interfaz (`squad-accounts` con mode start). Nada se registra solo: este módulo no
 * toca la red; la estación le pasa `register` y es ella la que llama al endpoint de registro que ya
 * usa "Nuevo personaje" (estacion.ts createChar). En los tests todo es con mocks.
 *
 * Ritmo humano (no se baja): una cuenta nueva cada 12-40 minutos (azar), a lo sumo 2 por hora y 8 por
 * día, la primera recién después de 30 s a 3 min, y si el server contesta `throttled` se frena todo
 * una hora. Un jugador real no crea cinco cuentas en un minuto.
 *
 * Una cuenta por personaje: la estación juega con un solo personaje por cuenta a la vez, y la guía del
 * server deja hasta 5 por cuenta pero no dos sesiones (docs/escuadras.md).
 *
 * Tests en `squad-tests.ts`.
 */
import { coolNames, validCharName } from './names';
import { SQUAD_MAX, type SquadClass } from './squad';

/** Clases que el server deja crear desde el bot (estacion-logic CHAR_CLASSES): DL pide desbloqueo. */
export const CREATABLE: readonly SquadClass[] = ['dk', 'dw', 'elf', 'mg'];

/** Combinaciones complementarias por tamaño: tanque, apoyo, daño de área, segundo daño/tanque. */
export const COMPLEMENTARY: Record<number, SquadClass[]> = {
  1: ['dk'],
  2: ['dk', 'elf'],
  3: ['dk', 'elf', 'dw'],
  4: ['dk', 'elf', 'dw', 'mg'],
  5: ['dk', 'elf', 'dw', 'mg', 'elf'],
};

export const ACCOUNT_PACING = {
  firstDelayMs: [30_000, 180_000] as readonly [number, number],
  gapMs: [12 * 60_000, 40 * 60_000] as readonly [number, number],
  perHour: 2,
  perDay: 8,
  throttledPauseMs: 60 * 60_000,
  /** fallos seguidos (que no sean `taken`) antes de parar del todo */
  maxFailures: 2,
};

export type AccountStep = { index: number; at: number; user: string; char: string; cls: SquadClass };
export type AccountPlan = { ok: true; steps: AccountStep[]; notes: string[] } | { ok: false; msg: string };

const between = (r: () => number, [lo, hi]: readonly [number, number]) => Math.round(lo + r() * (hi - lo));

/** Cuenta de 4 a 10 letras/números a partir de un nombre de fantasía (distinta del personaje). */
function accountName(base: string, taken: Set<string>, rand: () => number): string {
  for (let i = 0; i < 40; i++) {
    const stem = base.toLowerCase().slice(0, 7);
    const u = `${stem}${Math.floor(rand() * 900 + 100)}`.slice(0, 10);
    if (/^[a-z0-9]{4,10}$/.test(u) && !taken.has(u)) return u;
  }
  return `mu${Math.floor(rand() * 1e8)}`.slice(0, 10);
}

/**
 * Plan de `n` cuentas/personajes con las clases pedidas (o las complementarias). No registra nada.
 * `taken`: cuentas y personajes que la estación ya conoce.
 */
export function planSquadAccounts(opts: { n?: number; classes?: readonly SquadClass[]; takenUsers?: Iterable<string>; takenChars?: Iterable<string>; now: number; rand?: () => number }): AccountPlan {
  const rand = opts.rand ?? Math.random;
  const classes = opts.classes ? [...opts.classes] : COMPLEMENTARY[opts.n ?? 0];
  if (!classes?.length) return { ok: false, msg: 'indicá cuántos (1 a 5) o las clases' };
  if (classes.length > SQUAD_MAX) return { ok: false, msg: `hasta ${SQUAD_MAX} personajes` };
  const bad = classes.filter((c) => !CREATABLE.includes(c));
  if (bad.length) return { ok: false, msg: `no se puede crear desde el bot: ${bad.join(', ')} (Dark Lord pide desbloqueo; hacelo a mano y sumalo con "add")` };
  const users = new Set([...(opts.takenUsers ?? [])].map((u) => u.toLowerCase()));
  const chars = new Set([...(opts.takenChars ?? [])].map((u) => u.toLowerCase()));
  const names = coolNames(classes.length, chars, rand);
  if (names.length < classes.length) return { ok: false, msg: 'no pude armar nombres libres' };
  let at = opts.now + between(rand, ACCOUNT_PACING.firstDelayMs);
  const steps: AccountStep[] = classes.map((cls, index) => {
    if (index) at += between(rand, ACCOUNT_PACING.gapMs);
    const char = names[index];
    if (!validCharName(char)) throw new Error(`nombre inválido ${char}`);
    const user = accountName(char, users, rand);
    users.add(user);
    return { index, at, user, char, cls };
  });
  const hours = ((steps.at(-1)!.at - opts.now) / 3_600_000).toFixed(1);
  return { ok: true, steps, notes: [`${steps.length} cuenta(s) en ~${hours} h, espaciadas`, 'las claves se generan al registrar y quedan solo en la base de la estación'] };
}

export type RegisterResult = { ok: boolean; msg: string; code?: 'taken' | 'throttled' };

/**
 * Ejecuta el plan con el reloj que le pasan. `due(now)` devuelve el paso que toca (uno solo) o null;
 * después se informa con `report`. Respeta el tope por hora y por día contando lo ya hecho, pausa una
 * hora si el server pone `throttled`, cambia el nombre de la cuenta si estaba tomada y se detiene tras
 * `maxFailures` fallos seguidos.
 */
export class AccountRunner {
  private pending: AccountStep[];
  private doneAt: number[] = [];
  private failures = 0;
  private pausedUntil = 0;
  private inFlight: AccountStep | null = null;
  stopped = false;
  log: string[] = [];

  constructor(steps: readonly AccountStep[], private rand: () => number = Math.random) {
    this.pending = [...steps];
  }

  get remaining() { return this.pending.length + (this.inFlight ? 1 : 0); }
  get created() { return this.doneAt.length; }

  stop(why = 'detenido') { this.stopped = true; this.pending = []; this.log.push(why); }

  due(now: number): AccountStep | null {
    if (this.stopped || this.inFlight || !this.pending.length || now < this.pausedUntil) return null;
    const next = this.pending[0];
    if (now < next.at) return null;
    if (this.doneAt.filter((t) => now - t < 3_600_000).length >= ACCOUNT_PACING.perHour) return null;
    if (this.doneAt.filter((t) => now - t < 24 * 3_600_000).length >= ACCOUNT_PACING.perDay) return null;
    this.inFlight = this.pending.shift()!;
    return this.inFlight;
  }

  report(step: AccountStep, res: RegisterResult, now: number, users: Iterable<string> = []) {
    if (this.inFlight !== step) return;
    this.inFlight = null;
    if (res.ok) {
      this.doneAt.push(now);
      this.failures = 0;
      this.log.push(`${step.char} (${step.cls}) creado`);
      // El próximo no antes de un espaciado nuevo desde ahora.
      const next = this.pending[0];
      if (next) next.at = Math.max(next.at, now + between(this.rand, ACCOUNT_PACING.gapMs));
      return;
    }
    if (res.code === 'taken') {
      // Cuenta tomada: otro nombre de cuenta, mismo personaje, más tarde.
      const taken = new Set([...users].map((u) => u.toLowerCase()));
      taken.add(step.user);
      this.pending.unshift({ ...step, user: accountName(step.char, taken, this.rand), at: now + between(this.rand, ACCOUNT_PACING.gapMs) });
      this.log.push(`${step.user} ya existía: pruebo otra cuenta`);
      return;
    }
    if (res.code === 'throttled') {
      this.pausedUntil = now + ACCOUNT_PACING.throttledPauseMs;
      this.pending.unshift({ ...step, at: this.pausedUntil });
      this.log.push('el server pidió esperar: pausa de 1 h');
      return;
    }
    this.failures++;
    this.log.push(`falló ${step.char}: ${res.msg}`);
    if (this.failures >= ACCOUNT_PACING.maxFailures) this.stop(`paro tras ${this.failures} fallos seguidos`);
    else this.pending.unshift({ ...step, at: now + between(this.rand, ACCOUNT_PACING.gapMs) });
  }
}
