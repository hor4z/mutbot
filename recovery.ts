/**
 * Auto-recuperación del PK (lógica pura, tests en recovery-tests.ts).
 *
 * Caso real (Hume, 2026-10-23): quedó PK ("PK: 2 kills, 10% probabilidad de drop.") y el server
 * contestaba "Un PK no puede usar /move." a cada warp: el bot reintentaba el warp cada 15 s durante
 * más de una hora, sin salida. El server limpia el PK con `/pkclear` ("[/pkclear] <char> kills have
 * been cleaned."). Acá se decide CUÁNDO mandarlo, con tope de reintentos y un enfriamiento largo para
 * no repetirlo sin fin si el server dice que no.
 *
 * El loop (farm-loop.ts) alimenta `onServerMessage` / `onWarp` y pregunta `next(now)`; el chat lo manda
 * chat.ts (respeta el gap de 2 s) y cada decisión sale por journal().
 */

/** Lo que nos dice el server sobre el PK. */
export type PkSignal = { kind: 'pk-move' } | { kind: 'pk-info'; kills: number } | { kind: 'pk-cleared' };

/** Texto de ServerMessage → señal de PK (o null). Los textos son los del server real (tabla `events`, server_msg). */
export function classifyServerMessage(text: string): PkSignal | null {
  const t = text.trim();
  if (/\bPK no puede usar \/move/i.test(t)) return { kind: 'pk-move' };
  const m = /^PK:\s*(\d+)\s*kills?/i.exec(t);
  if (m) return { kind: 'pk-info', kills: +m[1] };
  if (/^\[\/pkclear\].*cleaned/i.test(t)) return { kind: 'pk-cleared' };
  return null;
}

export const PK_RECOVERY = {
  /** Comando del server (está en SAY_COMMANDS de panel-protocol.ts). */
  command: '/pkclear',
  /** Intentos por episodio; si el server no lo limpia, se rinde y descansa cooldownMs. */
  maxTries: 3,
  /** Espera entre intentos (más que el gap de chat de 2 s: da tiempo a que llegue la respuesta). */
  retryMs: 20_000,
  /** Antes del primer intento: que el chat no pise lo que se mandó recién y llegue el resto de los avisos. */
  firstDelayMs: 3_000,
  /** Enfriamiento largo tras agotar los intentos. */
  cooldownMs: 30 * 60_000,
  /** Warps seguidos sin respuesta que alcanzan para probar /pkclear aunque no haya llegado el aviso de PK. */
  warpFailsToTry: 3,
} as const;

export type PkAction = { send: string; why: string; tryNo: number } | { giveUp: string } | null;

export class PkRecovery {
  /** Desde cuándo sabemos que somos PK (null = no). */
  pkSince: number | null = null;
  kills = 0;
  tries = 0;
  lastTryAt = -Infinity;
  cooldownUntil = 0;
  warpFails = 0;
  /** Motivo del episodio actual (para el diario). */
  reason = '';

  constructor(readonly cfg: typeof PK_RECOVERY = PK_RECOVERY) {}

  /** ¿Estamos en un episodio de PK sin resolver? */
  get active() {
    return this.pkSince != null;
  }

  onServerMessage(text: string, now: number): PkSignal | null {
    const s = classifyServerMessage(text);
    if (!s) return null;
    if (s.kind === 'pk-cleared') this.clear();
    else if (s.kind === 'pk-info' && s.kills <= 0) this.clear();
    else {
      if (s.kind === 'pk-info') this.kills = s.kills;
      this.begin(now, s.kind === 'pk-move' ? 'el server dice que un PK no puede usar /move' : `el server avisa PK: ${s.kills} kills`);
    }
    return s;
  }

  /** Resultado de un warp (hubo MapChanged o no). Varios sin respuesta seguidos hacen sospechar PK. */
  onWarp(ok: boolean, now: number) {
    if (ok) {
      this.warpFails = 0;
      return;
    }
    this.warpFails++;
    if (this.warpFails >= this.cfg.warpFailsToTry) this.begin(now, `${this.warpFails} warps seguidos sin respuesta`);
  }

  /** El vigía de trabas pide probar /pkclear (diagnosticó PK). */
  force(now: number, why: string) {
    this.begin(now, why);
  }

  private begin(now: number, why: string) {
    if (this.pkSince == null) {
      this.pkSince = now;
      this.reason = why;
    }
  }

  private clear() {
    this.pkSince = null;
    this.tries = 0;
    this.warpFails = 0;
    this.kills = 0;
    this.lastTryAt = -Infinity;
  }

  /** Qué hacer ahora: mandar /pkclear, rendirse un rato, o nada. */
  next(now: number): PkAction {
    if (this.pkSince == null) return null;
    if (now < this.cooldownUntil) return null;
    if (this.tries >= this.cfg.maxTries) {
      if (now - this.lastTryAt < this.cfg.retryMs) return null; // da tiempo a que llegue la respuesta del último
      // Agotados: descanso largo y se olvida el episodio (si el aviso vuelve a llegar, vuelve a empezar).
      const n = this.tries;
      this.cooldownUntil = now + this.cfg.cooldownMs;
      this.clear();
      return { giveUp: `${n} /pkclear sin efecto: descanso ${Math.round(this.cfg.cooldownMs / 60_000)} min` };
    }
    const wait = this.tries === 0 ? Math.max(0, this.pkSince + this.cfg.firstDelayMs - now) : Math.max(0, this.lastTryAt + this.cfg.retryMs - now);
    if (wait > 0) return null;
    return { send: this.cfg.command, why: this.reason, tryNo: this.tries + 1 };
  }

  /** El chat salió: cuenta el intento. (Si no salió por el gap, no se llama y se reintenta en el próximo tick.) */
  sent(now: number) {
    this.tries++;
    this.lastTryAt = now;
  }
}
