/**
 * Lo aprendido de los datos (scripts/aprender.ts → ~/.mubot/knowledge.json) y las perillas que el
 * bot ajusta solo con eso. Lista cerrada de perillas; hoy: party sí/no en el dúo de la esquina.
 *
 * Cada perilla tiene un experimento: ~10 % del tiempo (bloques de 30 min) se prueba la otra opción
 * para seguir midiendo. Sin datos suficientes o sin archivo, queda lo de siempre. Borrar el archivo
 * vuelve todo atrás.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setPolicy } from './telemetry';

export const KNOWLEDGE_PATH = process.env.MUBOT_KNOWLEDGE ?? join(homedir(), '.mubot', 'knowledge.json');

export type PartyRow = { char: string; in_party: number; ticks: number; exp_min: number };
export type PartyKnob = { use: boolean; reason: string; on?: number; off?: number; ticksOn?: number; ticksOff?: number };
export type Knowledge = { at: string; party?: PartyKnob };

/** Mínimo medido de cada lado (12 ticks = 1 min): 30 min con party y 30 sin. */
export const PARTY_MIN_TICKS = 360;
/** Diferencia que hace falta para cambiar (si no, se queda con party: lo de siempre). */
export const PARTY_MARGIN = 0.05;

/**
 * Personaje prioritario (usuario: "el foco está en subir a Horaz para que sea top ten"): las perillas
 * se deciden por SU exp/min, no por la suma del dúo. MUBOT_PRIORITY cambia cuál es.
 */
export const PRIORITY_CHAR = process.env.MUBOT_PRIORITY ?? 'Horaz';

/** ¿Party sí o no? Por la exp/min del prioritario con y sin party (si no hay datos de él, la del dúo). */
export function decideParty(all: readonly PartyRow[], priority = PRIORITY_CHAR): PartyKnob {
  const mine = all.filter((x) => x.char.toLowerCase() === priority.toLowerCase());
  const rows = mine.length ? mine : all;
  const side = (p: number) => {
    const r = rows.filter((x) => x.in_party === p);
    const ticks = Math.min(...r.map((x) => x.ticks), Infinity);
    return { ticks: r.length ? ticks : 0, exp: r.reduce((a, x) => a + x.exp_min, 0), chars: r.length };
  };
  const on = side(1), off = side(0);
  if (on.ticks < PARTY_MIN_TICKS || off.ticks < PARTY_MIN_TICKS || on.chars !== off.chars)
    return { use: true, reason: `faltan datos (con party ${on.ticks} ticks, sin party ${off.ticks}; hacen falta ${PARTY_MIN_TICKS})`, ticksOn: on.ticks, ticksOff: off.ticks };
  const m = (n: number) => `${Math.round(n / 1e6)}M/min`;
  const use = !(off.exp > on.exp * (1 + PARTY_MARGIN));
  return {
    use, on: on.exp, off: off.exp, ticksOn: on.ticks, ticksOff: off.ticks,
    reason: use ? `con party ${m(on.exp)} contra ${m(off.exp)} sin party` : `sin party ${m(off.exp)} contra ${m(on.exp)} con party`,
  };
}

/** ¿Este bloque de 30 min es de experimento (~10 %)? Igual para todos los bots a la misma hora. */
export function experimentSlot(now: number, salt = 0): boolean {
  const slot = Math.floor(now / 1_800_000) + salt * 7919;
  return ((slot * 2654435761) >>> 0) % 10 === 0;
}

let cache: { at: number; k: Knowledge | null } = { at: 0, k: null };

/** knowledge.json (releído cada 10 min); null si no hay. */
export function knowledge(now = Date.now()): Knowledge | null {
  if (now - cache.at < 600_000 && cache.at) return cache.k;
  let k: Knowledge | null = null;
  try { k = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8')) as Knowledge; } catch {}
  cache = { at: now, k };
  return k;
}

/**
 * Carrera de resets del prioritario (usuario: "necesitamos alcanzar el top 10 ya, en 1 o 2 días"):
 * sin cacerías, sin frenarse por invasiones y sin party (salvo que los datos digan que la party le suma).
 */
export const isPriorityChar = (name: string) => name.toLowerCase() === PRIORITY_CHAR.toLowerCase();

/** Party en el dúo: lo aprendido, o lo contrario en un bloque de experimento. */
export function partyWanted(now = Date.now()): { use: boolean; why: string } {
  const p = knowledge(now)?.party;
  // Carrera: sin party por defecto (la exp se reparte: en el navegador los ciclos de Horaz pasaron de
  // ~9 a ~13,6 min) y sin experimentos; solo con datos que digan que le suma a Horaz.
  if (!p?.on || !p.off) {
    setPolicy('party=no (carrera)');
    return { use: false, why: 'carrera de resets de Horaz: sin party hasta tener datos de que le suma' };
  }
  const base = p.use;
  const exp = experimentSlot(now, 1);
  setPolicy(`party=${(exp ? !base : base) ? 'si' : 'no'}${exp ? ' (experimento)' : ''}`);
  if (exp) return { use: !base, why: `experimento: pruebo ${base ? 'sin' : 'con'} party 30 min` };
  return { use: base, why: p ? `datos: ${p.reason}` : 'sin datos todavía: con party' };
}
