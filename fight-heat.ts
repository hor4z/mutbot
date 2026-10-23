/**
 * "Oír la pelea" (idea del usuario, 2026-10-23: los sonidos de pelea o de dragones lo llevan al lugar): varios
 * jugadores pegando juntos en un punto suelen ser un dorado o un dragón que se está matando. El cliente suena
 * con lo que está a su alcance; el bot ve lo mismo en los packets de ataque (0x18 y 0x19) de los jugadores en
 * su scope. Acá se agrupan por lugar y tiempo; si hay una pelea de >= MIN_ATTACKERS jugadores distintos, se
 * puede ir hacia ella cuando no hay un dorado propio a la vista. Lógica pura (reloj por parámetro).
 */
import { FRIENDLY_SKILLS } from './protocol097';

export const HEAT_WINDOW_MS = 8000;
export const HEAT_MIN_ATTACKERS = 3;
export const HEAT_RADIUS = 8;

const u8 = (raw: Uint8Array | DataView | ArrayBuffer): Uint8Array =>
  raw instanceof Uint8Array ? raw : raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);

/** Atacante y objetivo de un golpe (0x18) o skill dirigido (0x19) de cualquiera; null si no es un ataque. */
export function parseFight(raw: Uint8Array | DataView | ArrayBuffer): { attacker: number; target: number } | null {
  const b = u8(raw);
  const u16 = (i: number) => ((b[i] << 8) | b[i + 1]) & 0x7fff;
  if (b[2] === 0x18 && b.length >= 9) return { attacker: u16(3), target: u16(7) };
  if (b[2] === 0x19 && b.length === 8 && !FRIENDLY_SKILLS.has(b[3])) return { attacker: u16(4), target: u16(6) };
  if (b[2] === 0x19 && b.length >= 9 && !FRIENDLY_SKILLS.has(u16(3))) return { attacker: u16(5), target: u16(7) };
  return null;
}

type Hit = { id: number; x: number; y: number; at: number };
export type Hotspot = { x: number; y: number; attackers: number };

export class FightHeat {
  private hits: Hit[] = [];

  /** Un ataque de un jugador (que no sea yo ni un compañero) en (x, y). */
  record(id: number, x: number, y: number, now: number) {
    this.hits.push({ id, x, y, at: now });
    if (this.hits.length > 400) this.hits.splice(0, this.hits.length - 400);
  }

  /** La pelea más concurrida de la ventana (jugadores distintos a <= HEAT_RADIUS entre sí), o null. */
  hotspot(now: number): Hotspot | null {
    this.hits = this.hits.filter((h) => now - h.at <= HEAT_WINDOW_MS);
    let best: Hotspot | null = null;
    for (const c of this.hits) {
      const near = this.hits.filter((h) => Math.max(Math.abs(h.x - c.x), Math.abs(h.y - c.y)) <= HEAT_RADIUS);
      const ids = new Set(near.map((h) => h.id));
      if (ids.size < HEAT_MIN_ATTACKERS) continue;
      if (!best || ids.size > best.attackers) {
        const x = Math.round(near.reduce((s, h) => s + h.x, 0) / near.length);
        const y = Math.round(near.reduce((s, h) => s + h.y, 0) / near.length);
        best = { x, y, attackers: ids.size };
      }
    }
    return best;
  }

  clear() { this.hits = []; }
}
