/**
 * Alas y montura de los miembros de la escuadra (lógica pura, sin red): qué alas le corresponden a
 * cada clase, cuánto valen para el plan de equipo y qué le falta a cada uno. Hechos y supuestos,
 * con fuente, en docs/escuadras.md.
 *
 * Lo medido/publicado:
 * - La 2da fase (nivel 150, quest de Sevina) habilita alas de 2da: Spirits, Soul, Dragon, Darkness
 *   (guía "Quest de evolución" y novedades 2026-10-18).
 * - Cape of Lord (Dark Lord): Chaos Machine = alas de nivel 1 + Crest of Monarch + Chaos + 5M (N-10-22).
 * - Fenrir: "la montura más rápida del juego", desde el nivel 300 (novedades 2026-10-22/23).
 * - NO PUBLICADO: cuánto suben las alas la velocidad, el daño o la defensa. `items.json` no trae esos
 *   datos y sus columnas de clase para alas están corridas (docs/items-y-maquinas.md): por eso la clase
 *   de cada ala sale del MU original (supuesto) y `equip.ts` ya recuerda lo que el server rechaza.
 * - Velocidad del BOT: caminar sale a WALK_PACE_MS (380 ms) con o sin alas; ese ritmo no se baja (anti-cheat).
 *   Ir más rápido = warps (menú 0x8E), no alas.
 *
 * Tests en `squad-tests.ts`.
 */
import type { SquadClass } from './squad';

/** Lugar de las alas en el equipo (0 mano izq., 1 der., 2-6 armadura, 7 alas, 8 mascota). */
export const WINGS_SLOT = 7;
export const WINGS_GROUP = 12;
export const FENRIR = { group: 13, num: 37, minLevel: 300 } as const;

export type WingInfo = { group: number; num: number; name: string; tier: 1 | 2 | 'cape'; classes: SquadClass[] };

/** Clases por ala según el MU original (SUPUESTO: items.json no sirve para esto). */
export const WINGS: readonly WingInfo[] = [
  { group: 12, num: 0, name: 'Wings of Fairy', tier: 1, classes: ['elf'] },
  { group: 12, num: 1, name: 'Wings of Angel', tier: 1, classes: ['dw'] },
  { group: 12, num: 2, name: 'Wings of Satan', tier: 1, classes: ['dk'] },
  { group: 12, num: 3, name: 'Wings of Spirit', tier: 2, classes: ['elf'] },
  { group: 12, num: 4, name: 'Wings of Soul', tier: 2, classes: ['dw'] },
  { group: 12, num: 5, name: 'Wings of Dragon', tier: 2, classes: ['dk'] },
  { group: 12, num: 6, name: 'Wings of Darkness', tier: 2, classes: ['mg'] },
  { group: 13, num: 30, name: 'Cape of Lord', tier: 'cape', classes: ['dl'] },
];

/** Puntos de defensa equivalentes por tier: heurística NUESTRA (como item-score.ts), no un dato del juego. */
export const WING_TIER_SCORE: Record<WingInfo['tier'], number> = { 1: 40, 2: 100, cape: 80 };

export const wingInfo = (group: number, num: number): WingInfo | undefined =>
  WINGS.find((w) => w.group === group && w.num === num);

/** Las alas que le tocan a la clase, de mejor a peor tier. */
export function wingsFor(cls: SquadClass): WingInfo[] {
  const order = (t: WingInfo['tier']) => (t === 2 ? 2 : t === 'cape' ? 1.5 : 1);
  return WINGS.filter((w) => w.classes.includes(cls)).sort((a, b) => order(b.tier) - order(a.tier));
}

/**
 * Valor de unas alas para el plan de equipo: el del tier + 4 por nivel (+N, como la armadura) +
 * 6 por opción extra + 10 si es excelente. Cero si no son alas ni de su clase (el plan no las toca).
 * Una 2da vale más que una 1ra aunque la 1ra esté +9 (40 + 36 + .. < 100): se prueba en los tests.
 */
export function wingScore(cls: SquadClass, it: { group: number; num: number; level?: number; option?: number; excellent?: boolean }): number {
  const w = wingInfo(it.group, it.num);
  if (!w || !w.classes.includes(cls)) return 0;
  return WING_TIER_SCORE[w.tier] + 4 * (it.level ?? 0) + 6 * (it.option ?? 0) + (it.excellent ? 10 : 0);
}

export type GearNote = { char: string; need: string; why: string };

/**
 * Qué le falta a cada miembro (para mostrar en la tarjeta de la escuadra; no compra ni mezcla nada).
 * `worn`: alas puestas (null = sin alas); `evolved`: ya hizo la 2da fase (nivel >= 150 en el juego; el
 * bot no lo lee todavía: se infiere del nivel, supuesto).
 */
export function gearNotes(members: readonly { char: string; cls: SquadClass | null; level: number; worn: { group: number; num: number; level?: number } | null }[]): GearNote[] {
  const out: GearNote[] = [];
  for (const m of members) {
    if (!m.cls) continue;
    const best = wingsFor(m.cls)[0];
    const have = m.worn ? wingScore(m.cls, m.worn) : 0;
    if (m.level >= 150 && best && WING_TIER_SCORE[best.tier] > have && have < WING_TIER_SCORE[2]) {
      out.push({ char: m.char, need: best.name, why: have ? 'tiene alas de una fase menor' : 'sin alas' });
    } else if (m.level < 150 && !m.worn) {
      const first = wingsFor(m.cls).find((w) => w.tier === 1);
      if (first) out.push({ char: m.char, need: first.name, why: 'alas de 1ra mientras llega la 2da fase (nivel 150)' });
    }
    if (m.level >= FENRIR.minLevel) out.push({ char: m.char, need: 'Horn of Fenrir', why: 'la montura más rápida (se usa desde el 300)' });
  }
  return out;
}
