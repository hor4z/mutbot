/**
 * Party de la escuadra (lógica pura): a quién se le acepta, quién invita a quién y cada cuánto, y la
 * lista de miembros que manda el server. Los bytes salen de protocol097.ts (`buildPartyInvite`,
 * `buildPartyAccept`, `buildPartyDecline`, `buildPartyKick`); acá solo se decide.
 *
 * Reglas (pedido del usuario: "nunca de extraños"):
 * - Con una escuadra activa, la invitación se acepta SOLO si el que invita es miembro de la escuadra
 *   que firmó la estación (ver squad.ts: `verifyAssignment`). Sin escuadra, queda lo de siempre (world.ts).
 * - Invitar lo hace un solo miembro por vez (el líder), con espera larga entre invitaciones y
 *   reintentos espaciados: nada de ráfagas.
 *
 * Packets: C1 05 40 (invitar), C1 06 41 (responder), C1 04 43 (kick/salir) y el eco C1 .. 42 01
 * (lista) están en protocol097.ts y packets/routes.ts. Aceptar/rechazar e invitar ya corrieron en
 * vivo en el dúo de la esquina (AGENTS.md); la LISTA (`parsePartyList`) y salir de la party con el
 * propio índice están SIN VERIFICAR en vivo.
 */

/** Party de hasta 5 (guía "Primeros pasos en MuWeb", 2026-10-12). */
export const PARTY_MAX = 5;

export type PartyDecision = { accept: boolean; why: string };

/**
 * ¿Aceptar la invitación de `from`? `squadMembers` es la lista firmada (null = sin escuadra activa,
 * decide `fallback`: lo que ya hacía world.ts). Nombre desconocido (no está en scope) = rechazar.
 */
export function decideInvite(from: string | null | undefined, squadMembers: readonly string[] | null, fallback: boolean): PartyDecision {
  if (squadMembers == null) return { accept: fallback, why: fallback ? 'compañero (sin escuadra)' : 'sin escuadra: regla de siempre' };
  if (!from) return { accept: false, why: 'no sé quién invita' };
  const ok = squadMembers.some((m) => m.toLowerCase() === from.toLowerCase());
  return { accept: ok, why: ok ? 'miembro de la escuadra' : 'no es de la escuadra' };
}

/**
 * Lista de la party (C1 len 42 01 ...). Layout de OpenMU para PartyList: count en [4], después
 * entradas de stride fijo que empiezan con el nombre (10 bytes, ASCII, terminado en 0). El stride se
 * deduce del largo (no se asume): si no cierra, devuelve null y el bot ignora el packet.
 * SIN VERIFICAR en vivo.
 */
export function parsePartyList(raw: Uint8Array): string[] | null {
  if (raw.length < 5) return null;
  const count = raw[4];
  if (count === 0) return [];
  if (count > PARTY_MAX) return null;
  const body = raw.length - 5;
  if (body <= 0 || body % count !== 0) return null;
  const stride = body / count;
  if (stride < 10) return null;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = 5 + i * stride;
    let s = '';
    for (let j = 0; j < 10 && raw[at + j]; j++) s += String.fromCharCode(raw[at + j]);
    if (!/^[A-Za-z0-9]{1,10}$/.test(s)) return null;
    out.push(s);
  }
  return out;
}

/** Humano: espera entre invitaciones propias (ms) y antes de reintentar al mismo. */
export const INVITE_GAP_MS: readonly [number, number] = [6_000, 14_000];
export const INVITE_RETRY_MS = 90_000;
export const INVITE_MAX_TRIES = 4;

/**
 * Quién falta invitar. El líder invita a los que no están en la party y están a la vista (`visible`:
 * nombre → id en scope); uno por vez, con espera aleatoria entre uno y otro. Estado interno: último
 * intento por nombre. `rand` entra por parámetro (tests).
 */
export class InviteScheduler {
  private lastAt = 0;
  private nextGap = 0;
  private tries = new Map<string, { at: number; n: number }>();

  /**
   * `members`: la escuadra; `inParty`: nombres que la party ya tiene (propios incluidos); `visible`:
   * nombre en minúsculas → id de scope. Devuelve el id a invitar ahora, o null.
   */
  next(now: number, me: string, leader: string, members: readonly string[], inParty: readonly string[], visible: ReadonlyMap<string, number>, rand: () => number = Math.random): { name: string; id: number } | null {
    if (me.toLowerCase() !== leader.toLowerCase()) return null;
    const have = new Set(inParty.map((n) => n.toLowerCase()));
    if (have.size >= PARTY_MAX) return null;
    if (now - this.lastAt < this.nextGap) return null;
    for (const m of members) {
      const k = m.toLowerCase();
      if (k === me.toLowerCase() || have.has(k)) { this.tries.delete(k); continue; }
      const id = visible.get(k);
      if (id == null) continue;
      const t = this.tries.get(k);
      if (t && (t.n >= INVITE_MAX_TRIES || now - t.at < INVITE_RETRY_MS)) continue;
      this.tries.set(k, { at: now, n: (t?.n ?? 0) + 1 });
      this.lastAt = now;
      const [lo, hi] = INVITE_GAP_MS;
      this.nextGap = lo + rand() * (hi - lo);
      return { name: m, id };
    }
    return null;
  }

  /** Nombres a los que ya no insiste (agotó los intentos): la estación los ve como "no se unió". */
  gaveUp(): string[] {
    return [...this.tries].filter(([, t]) => t.n >= INVITE_MAX_TRIES).map(([k]) => k);
  }
  reset() { this.tries.clear(); this.lastAt = 0; this.nextGap = 0; }
}
