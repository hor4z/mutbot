/**
 * Reglas de ítems sacadas de `data/items.json` (lógica pura, sin red): clase, requisitos, tamaño,
 * defensa base. OJO: las columnas del JSON están corridas y no de la misma forma en todas las filas
 * (por eso equip.ts decía "no se usan"). Mirando las filas de armaduras (grupos 6-11) hay DOS formatos:
 *
 *   "nuevo"  (Def > 0, p. ej. Great Dragon): defensa = Def; clases en las columnas
 *            [DK/BK, Elf/ME, MG, DL, SUM] = [DW, DK, Elf, MG, DL] (corrida 1); fuerza pedida = Agi,
 *            agilidad pedida = Ene (la columna Str trae 0 o 380, que es otra cosa); nivel = ReqLvl.
 *   "viejo"  (Def = 0, p. ej. Plate): defensa = DefRate; clases en [Elf/ME, MG, DL, SUM] = [DW, DK, Elf,
 *            MG] (corrida 2, DL no figura); fuerza pedida = Ene, agilidad pedida = Vit.
 *
 * Se dedujo cruzando conjuntos conocidos (Great Dragon = DK, Hurricane/Storm Crow = MG, Grand Soul = DW,
 * Plate = DK+MG, Vine = Elf, Dark Master/Light Plate = DL) y los tests lo fijan. NO está verificado contra
 * el server: manda siempre el server (si rechaza un ítem, equip.ts no lo vuelve a probar). Armas, alas,
 * anillos y mascotas: sin lógica de clase fiable acá (otras columnas corridas), no se tocan.
 */
import itemsData from './data/items.json';

export type ClassKey = 'dw' | 'dk' | 'elf' | 'mg' | 'dl';
type Row = Record<string, number | string>;

export type ItemRule = {
  group: number;
  num: number;
  name: string;
  w: number;
  h: number;
  /** formato de las columnas (ver arriba); 'otro' = no se interpreta */
  layout: 'nuevo' | 'viejo' | 'otro';
  /** defensa base (0 si no es armadura/escudo) */
  defense: number;
  reqLevel: number;
  reqStr: number;
  reqAgi: number;
  /** por clase: 0 = no puede, 1 = clase base y evolucionadas, 2 = solo evolucionada, 3 = tercera. null = no se sabe */
  classes: Record<ClassKey, number> | null;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const RULES = new Map<number, ItemRule>();

function build(r: Row): ItemRule {
  const group = num(r.Group), index = num(r.Index);
  const base = { group, num: index, name: String(r.ItemName ?? `ítem ${group}/${index}`), w: num(r.X) || 1, h: num(r.Y) || 1 };
  if (group < 6 || group > 11) {
    return { ...base, layout: 'otro', defense: 0, reqLevel: num(r.ReqLvl ?? r.RequiredLvl), reqStr: 0, reqAgi: 0, classes: null };
  }
  const nuevo = num(r.Def) > 0;
  const c = (k: string) => num(r[k]);
  if (nuevo) {
    return {
      ...base, layout: 'nuevo', defense: num(r.Def), reqLevel: c('ReqLvl'), reqStr: c('Agi'), reqAgi: c('Ene'),
      classes: { dw: c('DK/BK'), dk: c('Elf/ME'), elf: c('MG'), mg: c('DL'), dl: c('SUM') },
    };
  }
  return {
    ...base, layout: 'viejo', defense: num(r.DefRate), reqLevel: c('ReqLvl'), reqStr: c('Ene'), reqAgi: c('Vit'),
    classes: { dw: c('Elf/ME'), dk: c('MG'), elf: c('DL'), mg: c('SUM'), dl: 0 },
  };
}
for (const r of itemsData as unknown as Row[]) RULES.set(num(r.Group) * 512 + num(r.Index), build(r));

export function itemRule(group: number, n: number): ItemRule | null {
  return RULES.get(group * 512 + n) ?? null;
}

/** Lugar del equipo por grupo (como equip.ts): 6 escudo→1, 7 casco→2, 8 armadura→3, 9 pantalón→4, 10 guantes→5, 11 botas→6. */
export function armorSlot(group: number): number | null {
  return group >= 7 && group <= 11 ? group - 5 : null;
}
export const SLOT_NAMES: Record<number, string> = { 0: 'mano derecha', 1: 'mano izquierda', 2: 'casco', 3: 'armadura', 4: 'pantalones', 5: 'guantes', 6: 'botas', 7: 'alas' };

export type Fighter = {
  cls: ClassKey;
  /** ya evolucionado (BK, SM, ME...): puede usar lo que pide 2.ª clase */
  evolved: boolean;
  level: number;
  stats: { str: number; agi: number; vit?: number; ene?: number };
};

/** Por qué NO puede usar el ítem (null = puede, según items.json; el server tiene la última palabra). */
export function cannotUse(group: number, n: number, f: Fighter): string | null {
  const r = itemRule(group, n);
  if (!r) return 'ítem desconocido en items.json';
  if (!r.classes) return 'no sé las reglas de clase de este tipo de ítem';
  const v = r.classes[f.cls];
  if (!v) return `no es de la clase (${f.cls.toUpperCase()})`;
  if (v >= 2 && !f.evolved) return 'pide clase evolucionada';
  if (f.level < r.reqLevel) return `pide nivel ${r.reqLevel} (tengo ${f.level})`;
  if (f.stats.str < r.reqStr) return `pide fuerza ${r.reqStr} (tengo ${f.stats.str})`;
  if (f.stats.agi < r.reqAgi) return `pide agilidad ${r.reqAgi} (tengo ${f.stats.agi})`;
  return null;
}

/** De `classFamily` (farming.ts) a la clave de acá. */
export function classKeyOf(family: 'knight' | 'wizard' | 'elf' | 'gladiator'): ClassKey {
  return family === 'knight' ? 'dk' : family === 'wizard' ? 'dw' : family === 'gladiator' ? 'mg' : 'elf';
}
