/**
 * Mezclas y máquinas del server (lógica pura, sin red): recetas, tasas, costos, qué se pierde si falla, y
 * un PLANIFICADOR que mirando lo que hay propone qué mezclas valen la pena. Cada dato cita su guía (ver
 * docs/items-y-maquinas.md). Lo que el server NO publica va como `null` + `assumed` (estimación
 * marcada), nunca como hecho.
 *
 * REGLA DURA: el planificador solo PROPONE. Toda mezcla del Chaos Goblin necesita confirmación humana
 * (una mezcla que falla puede quemar el ítem): `needsConfirmation` es siempre true y `executable` siempre
 * false. HUECO: no hay ejecución contra el NPC porque el protocolo del Chaos Goblin (NPC 238, Noria
 * 180,102) no está verificado; lo que se sabe está en docs/items-y-maquinas.md ("Protocolo: qué falta").
 */
import { scoreOf, judgeItem, type ScorableItem } from './item-score';
import { cannotUse, type Fighter } from './item-rules';
import type { PlanItem } from './equip-plan';

/** Ítems de moneda/joya por (grupo, número) en este server (data/items.json + guías). */
export const MAT = {
  chaos: { group: 12, num: 15, label: 'Jewel of Chaos' },
  bless: { group: 14, num: 13, label: 'Jewel of Bless' },
  soul: { group: 14, num: 14, label: 'Jewel of Soul' },
  life: { group: 14, num: 16, label: 'Jewel of Life' },
  creation: { group: 14, num: 22, label: 'Jewel of Creation' },
  /** "Jewel of Guardian" en items.json: en este server son los Cristales (moneda del Alquimista y el Mercado) */
  crystal: { group: 14, num: 31, label: 'Cristal' },
  talismanProt: { group: 14, num: 7, label: 'Talismán de Protección' },
  talisman14: { group: 14, num: 12, label: 'Talismán +14' },
  talisman15: { group: 14, num: 20, label: 'Talismán +15' },
  gemstone: { group: 14, num: 41, label: 'Gemstone' },
  harmony: { group: 14, num: 42, label: 'Jewel of Harmony' },
  lowerStone: { group: 14, num: 43, label: 'Lower Refine Stone' },
  higherStone: { group: 14, num: 44, label: 'Higher Refine Stone' },
  splinter: { group: 13, num: 32, label: 'Splinter of Armor' },
  blessGuardian: { group: 13, num: 33, label: 'Bless of Guardian' },
  claw: { group: 13, num: 34, label: 'Claw of Beast' },
  fragment: { group: 13, num: 35, label: 'Fragment (Piece) of Horn' },
  broken: { group: 13, num: 36, label: 'Broken Horn' },
  horn: { group: 13, num: 37, label: 'Horn of Fenrir' },
} as const;
export type MatKey = keyof typeof MAT;

export type Machine = 'Chaos Goblin' | 'Alquimista' | 'Elpis' | 'Osbourne' | 'Jerridon' | 'sobre el ítem';

export type Recipe = {
  id: string;
  name: string;
  machine: Machine;
  /** materiales por clave y cantidad (aparte del/los ítem(s) que se mejoran) */
  materials: Partial<Record<MatKey, number>>;
  /** descripción del/los ítem(s) de entrada */
  itemInput: string;
  /** null = el server no lo publica */
  zen: number | null;
  crystals: number;
  /** tasa PUBLICADA (0-1) o null */
  success: number | null;
  /** estimación usada por el planificador cuando no está publicada (marcada) */
  assumed?: { success: number; src: string };
  /** qué se pierde si falla (sin Talismán de Protección) */
  onFail: string;
  /** con Talismán de Protección en la bandeja */
  onFailProtected: string | null;
  needsConfirmation: boolean;
  /** de qué guía sale (título) */
  guide: string;
};

const G_ITEMS = 'Subir items: de +9 a +15 (2026-10-12)';
const G_ALQ = 'El Alquimista (2026-10-12)';
const G_HARM = 'Jewel of Harmony y Refine Stones (2026-10-23)';
const G_FEN = 'Cómo hacer un Fenrir (2026-10-22)';
const OPENMU_UP = 'OpenMU, browser/MANUAL-CHAOS.md (+10/+11 60 %, +12/+13 55 %, +25 con luck); el server no la publica, la ventana la muestra antes de mezclar';

/** Subida +9→+10 ... +12→+13 en el Chaos Goblin (guía "Subir items"). */
export function upgradeRecipe(to: 10 | 11 | 12 | 13): Recipe {
  const n = to - 9;
  return {
    id: `up${to}`, name: `ítem +${to - 1} → +${to}`, machine: 'Chaos Goblin',
    materials: { chaos: 1, soul: n, bless: n }, itemInput: `1 ítem +${to - 1}`,
    zen: null, crystals: 0, success: null,
    assumed: { success: to <= 11 ? 0.6 : 0.55, src: OPENMU_UP },
    onFail: 'la guía no lo dice; en OpenMU el ítem desaparece (MixResult.Disappear): tratar como pérdida del ítem',
    onFailProtected: 'el ítem queda como estaba; se quema el talismán; joyas y zen se pierden',
    needsConfirmation: true, guide: G_ITEMS,
  };
}

/** Fusión a +14 (45 %, 50 M) o +15 (25 %, 100 M), con 0-2 talismanes del nivel (guía "Subir items"). */
export function fusionRecipe(to: 14 | 15, talismans: 0 | 1 | 2 = 0): Recipe {
  const base = to === 14 ? 0.45 : 0.25;
  return {
    id: `fuse${to}x${talismans}`, name: `dos +${to - 1} iguales → +${to}${talismans ? ` (${talismans} talismán ${to === 14 ? '+14' : '+15'})` : ''}`,
    machine: 'Chaos Goblin',
    materials: talismans ? { [to === 14 ? 'talisman14' : 'talisman15']: talismans } : {},
    itemInput: `2 ítems iguales +${to - 1} (arma, escudo o pieza de set)`,
    zen: to === 14 ? 50_000_000 : 100_000_000, crystals: talismans * (to === 14 ? 100 : 250),
    success: base + talismans * 0.1,
    onFail: 'se queman LOS DOS ítems (y los talismanes puestos se gastan igual)',
    onFailProtected: 'los dos ítems quedan intactos; se quema el Talismán de Protección (2000 Cristales); el zen se paga igual',
    needsConfirmation: true, guide: G_ITEMS,
  };
}

/** Las 4 fases del Fenrir (guía "Cómo hacer un Fenrir"). */
export function fenrirRecipe(stage: 1 | 2 | 3 | 4): Recipe {
  const common = { machine: 'Chaos Goblin' as const, needsConfirmation: true, guide: G_FEN, crystals: 0 };
  switch (stage) {
    case 1: return { ...common, id: 'fenrir1', name: 'Fragment of Horn', materials: { splinter: 20, blessGuardian: 20, chaos: 1 }, itemInput: '—', zen: 0, success: 0.7,
      onFail: 'se pierden los materiales (sin talismán)', onFailProtected: 'se salvan Splinter/Bless of Guardian; se pierden la joya, el zen y un talismán' };
    case 2: return { ...common, id: 'fenrir2', name: 'Broken Horn', materials: { fragment: 5, claw: 10, chaos: 1 }, itemInput: '—', zen: 0, success: 0.5,
      onFail: 'se pierden los materiales (sin talismán)', onFailProtected: 'se salvan Fragment y Claw; se pierden la joya, el zen y un talismán' };
    case 3: return { ...common, id: 'fenrir3', name: 'Horn of Fenrir (rojo)', materials: { broken: 1, life: 3, chaos: 1 }, itemInput: '—', zen: 10_000_000, success: 0.3,
      onFail: 'se quema el Broken Horn y las joyas', onFailProtected: 'se salva el Broken Horn; se pierden joyas, zen y un talismán' };
    case 4: return { ...common, id: 'fenrir4', name: 'Mejora del Fenrir (negro con armas, azul con armaduras)', materials: { horn: 1, chaos: 1, life: 5 }, itemInput: 'equipo +4 o más con opción (armas O armaduras, no mezclados)', zen: 10_000_000, success: null,
      assumed: { success: 0.5, src: 'la guía dice "hasta 79 %" según el valor del equipo; sin tabla' },
      onFail: 'la guía no lo dice (sin talismán)', onFailProtected: 'se salvan el Fenrir y el arma/armadura; se pierden joyas, zen y un talismán' };
  }
}

/** Cristalizar en el Alquimista: hasta 8 ítems excelentes por tanda, 500.000 zen la tanda (no por ítem). */
export const CRYSTALLIZE = { maxItems: 8, zenPerBatch: 500_000, machine: 'Alquimista' as const, guide: G_ALQ };
/** Re-sortear opciones excelentes: 60 Cristales + 20 M de zen por tirada, y 60 Cristales más por candado. */
export function rerollCost(locks: number): { crystals: number; zen: number } {
  if (locks < 0) throw new Error('candados negativos');
  return { crystals: 60 + 60 * locks, zen: 20_000_000 };
}
/** Talismanes del Alquimista: precio en Cristales (guía "El Alquimista"). */
export const TALISMAN_PRICE = { talisman14: 100, talisman15: 250, talismanProt: 2000 } as const;

/** Armonía (guía "Jewel of Harmony y Refine Stones"). Todo es de la cuenta: no se tradea ni se vende con armonía. */
export const HARMONY = {
  elpisRefine: 0.8, // Gemstone → Jewel of Harmony, en Elpis (Kanturu3)
  applyJewel: 0.6, // la joya sobre el ítem; si falla se gasta la joya y el ítem queda igual
  lowerStone: 0.2, higherStone: 0.8, // si fallan, la opción vuelve a su nivel más bajo
  osbourneCommon: 0.2, osbourneExcellent: 0.5, // por ítem puesto: Lower / Higher; si falla se pierden los ítems
  jerridonZen: { min: 100_000, max: 500_000 }, // según el nivel de la opción (la guía no da la tabla)
  gemstoneDrop: 0.01, // por monstruo de Kanturu
} as const;

/** Probabilidad de sacar al menos una piedra en Osbourne con estos ítems puestos. */
export function osbourneChance(common: number, excellent: number): number {
  return 1 - Math.pow(1 - HARMONY.osbourneCommon, common) * Math.pow(1 - HARMONY.osbourneExcellent, excellent);
}

// ---------------------------------------------------------------------------
// Planificador
// ---------------------------------------------------------------------------
export type Holdings = {
  zen: number;
  /** todo lo que tiene, en bolsa, baúl o puesto. `equipped` marca lo puesto. */
  items: (PlanItem & { equipped?: boolean })[];
};

/** Cantidad de un material apilado: la durabilidad del ítem es la cantidad (SUPUESTO: visto en el baúl de Hume). */
export function countMat(h: Holdings, m: { group: number; num: number }): number {
  return h.items.filter((i) => i.group === m.group && i.num === m.num).reduce((a, i) => a + Math.max(1, i.durability ?? 1), 0);
}

export type Proposal = {
  id: string;
  kind: 'upgrade' | 'fusion' | 'crystallize' | 'harmony';
  title: string;
  recipe: Recipe | null;
  items: PlanItem[];
  /** valor esperado y en qué unidad */
  ev: number;
  evUnit: 'puntos de defensa' | 'Cristales';
  /** la tasa que se usó y si está publicada */
  successUsed: number | null;
  successPublished: boolean;
  risk: string;
  verdict: 'proponer' | 'no conviene' | 'faltan materiales';
  missing: string[];
  /** SIEMPRE true: la mezcla la confirma una persona */
  needsConfirmation: true;
  /** SIEMPRE false: no hay ejecución contra el server (protocolo del NPC sin verificar) */
  executable: false;
};

const has = (h: Holdings, k: MatKey, n: number, missing: string[]) => {
  const have = countMat(h, MAT[k]);
  if (have < n) missing.push(`${MAT[k].label} ×${n - have} (tengo ${have}/${n})`);
};
const withLevel = (i: ScorableItem, level: number): ScorableItem => ({ ...i, level });
const itemLabel = (i: PlanItem) => `${i.name} +${i.level}`;

/** Propuestas de subida +9→+13 para armaduras usables. */
function upgradeProposals(h: Holdings, f: Fighter, usable: (i: PlanItem) => boolean): Proposal[] {
  const out: Proposal[] = [];
  for (const it of h.items) {
    if (it.group < 7 || it.group > 11 || it.level < 9 || it.level > 12 || !usable(it)) continue;
    const to = (it.level + 1) as 10 | 11 | 12 | 13;
    const r = upgradeRecipe(to);
    const p = r.assumed!.success + (it.luck ? 0.25 : 0);
    const cur = scoreOf(it);
    const gain = scoreOf(withLevel(it, it.level + 1)) - cur;
    const prot = countMat(h, MAT.talismanProt) > 0;
    const ev = p * gain - (prot ? 0 : (1 - p) * cur);
    const missing: string[] = [];
    for (const [k, n] of Object.entries(r.materials)) has(h, k as MatKey, n as number, missing);
    out.push({
      id: `${r.id}:${it.slot}`, kind: 'upgrade', title: `${itemLabel(it)} → +${to}`, recipe: r, items: [it],
      ev: Math.round(ev * 10) / 10, evUnit: 'puntos de defensa', successUsed: Math.min(0.95, p), successPublished: false,
      risk: prot ? `con Talismán de Protección: si falla el ítem queda; se gasta el talismán` : `si falla puede perder el ítem (vale ${cur.toFixed(0)} puntos); la subida da +${gain.toFixed(0)}`,
      verdict: missing.length ? 'faltan materiales' : ev > 0 ? 'proponer' : 'no conviene', missing, needsConfirmation: true, executable: false,
    });
  }
  return out;
}

/** Fusiones: pares de ítems iguales +13 / +14 (mismo grupo/número). */
function fusionProposals(h: Holdings, usable: (i: PlanItem) => boolean): Proposal[] {
  const out: Proposal[] = [];
  const byKey = new Map<string, PlanItem[]>();
  for (const it of h.items) {
    if (it.level !== 13 && it.level !== 14) continue;
    if (it.group > 11) continue;
    const k = `${it.group}/${it.num}/${it.level}`;
    byKey.set(k, [...(byKey.get(k) ?? []), it]);
  }
  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => scoreOf(b) - scoreOf(a));
    const [a, b] = sorted;
    const to = (a.level + 1) as 14 | 15;
    const nTal = Math.min(2, countMat(h, to === 14 ? MAT.talisman14 : MAT.talisman15)) as 0 | 1 | 2;
    const r = fusionRecipe(to, nTal);
    const prot = countMat(h, MAT.talismanProt) > 0;
    const p = r.success!;
    const gain = scoreOf(withLevel(a, to)) - scoreOf(a);
    const loss = scoreOf(a) + scoreOf(b);
    const ev = p * (gain - scoreOf(b)) - (prot ? 0 : (1 - p) * loss);
    const missing: string[] = [];
    if (h.zen < (r.zen ?? 0)) missing.push(`zen ${(r.zen! - h.zen).toLocaleString('es-AR')} más`);
    out.push({
      id: `fuse:${k}`, kind: 'fusion', title: `${itemLabel(a)} + ${itemLabel(b)} → +${to}`, recipe: r, items: [a, b],
      ev: Math.round(ev * 10) / 10, evUnit: 'puntos de defensa', successUsed: p, successPublished: true,
      risk: prot ? 'con Talismán de Protección los dos ítems quedan si falla' : `si falla se queman LOS DOS (${loss.toFixed(0)} puntos); éxito ${(p * 100).toFixed(0)} %`,
      verdict: missing.length ? 'faltan materiales' : ev > 0 ? 'proponer' : 'no conviene', missing, needsConfirmation: true, executable: false,
    });
    void usable;
  }
  return out;
}

/** Cristalizar lo que sobra: tandas de hasta 8 ítems excelentes que no sirven (ni se usan ni sirven para fusionar). */
function crystallizeProposals(h: Holdings, f: Fighter, minCrystals: number, others: Fighter[]): Proposal[] {
  const worn = (slot: number) => h.items.find((i) => i.equipped && i.slot === slot);
  const cands: { it: PlanItem; v: number }[] = [];
  for (const it of h.items) {
    if (it.equipped || it.harmony || it.ancient || it.group > 11) continue;
    // Otro personaje de la cuenta puede usarla: no se quema (el baúl es de la cuenta).
    if (others.some((o) => cannotUse(it.group, it.num, o) === null)) continue;
    const v = judgeItem(it, f, worn(it.group - 5), { minCrystals });
    if (v.action === 'cristalizar' && v.crystals != null) cands.push({ it, v: v.crystals });
  }
  cands.sort((a, b) => b.v - a.v);
  const out: Proposal[] = [];
  for (let i = 0; i < cands.length; i += CRYSTALLIZE.maxItems) {
    const batch = cands.slice(i, i + CRYSTALLIZE.maxItems);
    const total = batch.reduce((a, c) => a + c.v, 0);
    const missing = h.zen < CRYSTALLIZE.zenPerBatch ? [`zen ${(CRYSTALLIZE.zenPerBatch - h.zen).toLocaleString('es-AR')} más`] : [];
    out.push({
      id: `crystal:${i / CRYSTALLIZE.maxItems}`, kind: 'crystallize', title: `cristalizar ${batch.length} ítem(s): ${batch.map((c) => c.it.name).slice(0, 4).join(', ')}${batch.length > 4 ? '…' : ''}`,
      recipe: null, items: batch.map((c) => c.it), ev: Math.round(total * 10) / 10, evUnit: 'Cristales', successUsed: 1, successPublished: true,
      risk: 'irreversible: los ítems se queman a cambio de Cristales (CRÍTICO x2 / JACKPOT x10 sin tasa publicada: el número es el piso); 500.000 zen la tanda',
      verdict: missing.length ? 'faltan materiales' : 'proponer', missing, needsConfirmation: true, executable: false,
    });
  }
  return out;
}

/** Jewel of Harmony sobre una armadura puesta sin armonía: si falla se gasta solo la joya. */
function harmonyProposals(h: Holdings): Proposal[] {
  const n = countMat(h, MAT.harmony);
  if (!n) return [];
  return h.items.filter((i) => i.equipped && i.group >= 7 && i.group <= 11 && !i.harmony && !i.ancient).map((it) => ({
    id: `harmony:${it.slot}`, kind: 'harmony' as const, title: `Jewel of Harmony sobre ${itemLabel(it)}`, recipe: null, items: [it],
    ev: Math.round(HARMONY.applyJewel * 10) / 10, evUnit: 'puntos de defensa' as const, successUsed: HARMONY.applyJewel, successPublished: true,
    risk: 'si falla se gasta la joya y el ítem queda igual (no se rompe); la opción sale al azar y se saca con Jerridon (100.000-500.000 zen)',
    verdict: 'proponer' as const, missing: [], needsConfirmation: true as const, executable: false as const,
  }));
}

/**
 * Propone mezclas ordenadas por valor esperado (las que conviene primero, las que no conviene o faltan
 * materiales al final). `fighter` decide qué piezas son usables; `minCrystals` el piso para cristalizar.
 */
export function planCrafts(h: Holdings, f: Fighter, opts: { minCrystals?: number; usable?: (i: PlanItem) => boolean; /** otros personajes de la cuenta: lo que ellos pueden usar no se cristaliza */ others?: Fighter[] } = {}): Proposal[] {
  const usable = opts.usable ?? ((i: PlanItem) => cannotUse(i.group, i.num, f) === null);
  const all = [
    ...upgradeProposals(h, f, usable),
    ...fusionProposals(h, usable),
    ...crystallizeProposals(h, f, opts.minCrystals ?? 3, opts.others ?? []),
    ...harmonyProposals(h),
  ];
  const rank = { proponer: 0, 'no conviene': 1, 'faltan materiales': 2 } as const;
  return all.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.ev - a.ev);
}

/** Texto corto de una propuesta. */
export function describeProposal(p: Proposal): string {
  const miss = p.missing.length ? ` — faltan: ${p.missing.join(', ')}` : '';
  return `[${p.verdict}] ${p.title}: EV ${p.ev} ${p.evUnit}${miss}. Riesgo: ${p.risk}. (necesita confirmación humana)`;
}
