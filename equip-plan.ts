/**
 * Plan de equipamiento desde el baúl (lógica pura, sin red): dado lo puesto, la bolsa, el baúl y el
 * personaje (clase, nivel, stats reales), arma los pasos para quedar con la mejor armadura posible: qué
 * sacar del baúl, a qué casilla de la bolsa, qué desvestir y qué equipar, en orden. Solo MUESTRA: ejecutar
 * es vault.ts (`runEquip`), y solo si alguien manda la orden `equip`.
 *
 * Alcance: casco, armadura, pantalones, guantes y botas (lugares 2-6). Armas, escudos, alas, anillos y
 * mascotas no se tocan (items.json no tiene clases fiables para armas y las alas ya están puestas).
 */
import { SLOT_NAMES, armorSlot, cannotUse, itemRule, type Fighter } from './item-rules';
import { scoreOf, setNameOf, type ScorableItem } from './item-score';

export type PlanItem = ScorableItem & { slot: number; name: string; raw?: Uint8Array };

export type PlanStep =
  /** del baúl (casilla del baúl) a la bolsa (casilla 12-75): el baúl tiene que estar abierto */
  | { kind: 'take'; item: PlanItem; fromVault: number; toBag: number }
  /** de un lugar del equipo a un hueco de la bolsa (para poder poner el nuevo) */
  | { kind: 'unequip'; item: PlanItem; fromSlot: number; toBag: number }
  /** de la bolsa al lugar del equipo */
  | { kind: 'equip'; item: PlanItem; fromBag: number; toSlot: number };

export type Gain = { slot: number; slotName: string; before: string | null; after: string; scoreBefore: number; scoreAfter: number; delta: number };
export type EquipPlan = { steps: PlanStep[]; gains: Gain[]; blocked: { name: string; slot: number; reason: string }[]; notes: string[] };
export type EquipPlanInput = { fighter: Fighter; equipped: PlanItem[]; bag: PlanItem[]; vault: PlanItem[] };

const ARMOR_SLOTS = [2, 3, 4, 5, 6] as const;
/** Una pieza solo reemplaza a la puesta si la supera por más de esto (puntos de defensa equivalentes). */
export const MIN_GAIN = 1;

const sizeOf = (it: { group: number; num: number }) => {
  const r = itemRule(it.group, it.num);
  return { w: r?.w ?? 1, h: r?.h ?? 1 };
};

/** Ocupación de la bolsa (8×8 desde la casilla 12). */
export class BagGrid {
  private used = new Array<boolean>(64).fill(false);
  constructor(items: Iterable<{ slot: number; group: number; num: number }> = []) {
    for (const it of items) if (it.slot >= 12 && it.slot < 76) this.mark(it.slot, it, true);
  }
  private mark(slot: number, it: { group: number; num: number }, v: boolean) {
    const { w, h } = sizeOf(it);
    const p = slot - 12;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
      const i = p + dy * 8 + dx;
      if (i >= 0 && i < 64) this.used[i] = v;
    }
  }
  /** Primer hueco donde entra el ítem (lo reserva) o null. */
  alloc(it: { group: number; num: number }): number | null {
    const { w, h } = sizeOf(it);
    for (let p = 0; p < 64; p++) {
      const x = p % 8, y = Math.floor(p / 8);
      if (x + w > 8 || y + h > 8) continue;
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) for (let dx = 0; dx < w && ok; dx++) if (this.used[p + dy * 8 + dx]) ok = false;
      if (ok) { this.mark(12 + p, it, true); return 12 + p; }
    }
    return null;
  }
  free(slot: number, it: { group: number; num: number }) { this.mark(slot, it, false); }
}

const label = (it: PlanItem) => `${it.name} +${it.level}${it.luck ? ' luck' : ''}${it.option ? ` +${it.option * 4}` : ''}${it.excCount ? ` exc×${it.excCount}` : ''}`;

export function planEquip(input: EquipPlanInput): EquipPlan {
  const { fighter } = input;
  const plan: EquipPlan = { steps: [], gains: [], blocked: [], notes: [] };
  const grid = new BagGrid(input.bag);
  const wornAt = (slot: number) => input.equipped.find((e) => e.slot === slot);

  type Pick = { slot: number; cand: PlanItem; from: 'baúl' | 'bolsa'; cur?: PlanItem };
  const picks: Pick[] = [];
  const takes: Extract<PlanStep, { kind: 'take' }>[] = [];

  for (const slot of ARMOR_SLOTS) {
    const cur = wornAt(slot);
    const curScore = cur ? scoreOf(cur) : 0;
    const pool: { it: PlanItem; from: 'baúl' | 'bolsa' }[] = [
      ...input.bag.filter((i) => armorSlot(i.group) === slot).map((it) => ({ it, from: 'bolsa' as const })),
      ...input.vault.filter((i) => armorSlot(i.group) === slot).map((it) => ({ it, from: 'baúl' as const })),
    ];
    const ranked: { it: PlanItem; from: 'baúl' | 'bolsa'; s: number }[] = [];
    for (const p of pool) {
      const why = cannotUse(p.it.group, p.it.num, fighter);
      if (why) {
        // Solo se avisa de lo que tiene chances reales (excelente o +N alto): el baúl tiene piezas de todas las clases.
        if (scoreOf(p.it) > curScore + MIN_GAIN && why.startsWith('pide')) plan.blocked.push({ name: label(p.it), slot, reason: why });
        continue;
      }
      if ((p.it.durability ?? 1) <= 0) continue;
      ranked.push({ ...p, s: scoreOf(p.it) });
    }
    ranked.sort((a, b) => b.s - a.s || (a.from === 'bolsa' ? -1 : 1));
    let chosen: Pick | null = null;
    for (const r of ranked) {
      if (r.s <= curScore + MIN_GAIN) break;
      if (r.from === 'baúl') {
        const to = grid.alloc(r.it);
        if (to == null) { plan.blocked.push({ name: label(r.it), slot, reason: 'no entra en la bolsa' }); continue; }
        takes.push({ kind: 'take', item: r.it, fromVault: r.it.slot, toBag: to });
        chosen = { slot, cand: { ...r.it, slot: to }, from: 'baúl', cur };
      } else {
        chosen = { slot, cand: r.it, from: 'bolsa', cur };
      }
      break;
    }
    if (chosen) picks.push(chosen);
    else plan.gains.push({ slot, slotName: SLOT_NAMES[slot], before: cur ? label(cur) : null, after: cur ? label(cur) : '(vacío)', scoreBefore: curScore, scoreAfter: curScore, delta: 0 });
  }

  plan.steps.push(...takes);
  for (const p of picks) {
    const curScore = p.cur ? scoreOf(p.cur) : 0;
    if (p.cur) {
      const to = grid.alloc(p.cur);
      if (to == null) {
        plan.blocked.push({ name: label(p.cand), slot: p.slot, reason: 'no hay hueco en la bolsa para sacar lo puesto' });
        continue;
      }
      plan.steps.push({ kind: 'unequip', item: p.cur, fromSlot: p.slot, toBag: to });
    }
    if (p.from === 'bolsa') grid.free(p.cand.slot, p.cand);
    plan.steps.push({ kind: 'equip', item: p.cand, fromBag: p.cand.slot, toSlot: p.slot });
    const s = scoreOf(p.cand);
    plan.gains.push({ slot: p.slot, slotName: SLOT_NAMES[p.slot], before: p.cur ? label(p.cur) : null, after: label(p.cand), scoreBefore: curScore, scoreAfter: s, delta: Math.round((s - curScore) * 10) / 10 });
  }
  plan.gains.sort((a, b) => a.slot - b.slot);

  // Set: ¿cuántas piezas del mismo set quedan? (no es bono del juego: los sets no ancient no dan efecto de set)
  const finalNames = ARMOR_SLOTS.map((slot) => plan.gains.find((g) => g.slot === slot)?.after.replace(/ \+\d+.*$/, '')).filter((n): n is string => !!n && n !== '(vacío)');
  const bySet = new Map<string, number>();
  for (const n of finalNames) bySet.set(setNameOf(n), (bySet.get(setNameOf(n)) ?? 0) + 1);
  const top = [...bySet.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) plan.notes.push(`set resultante: ${top[1]}/5 de ${top[0]}${top[1] === 5 ? ' (completo)' : ''}`);
  plan.notes.push('armas, escudo, alas y bijouterie no se tocan');
  return plan;
}

/** Texto corto de cada paso (log del panel y orden `equipplan`). */
export function describeStep(s: PlanStep, n: number): string {
  switch (s.kind) {
    case 'take': return `${n}. Sacar del baúl [${s.fromVault}] ${label(s.item)} → bolsa casilla ${s.toBag}`;
    case 'unequip': return `${n}. Sacarme ${label(s.item)} (${SLOT_NAMES[s.fromSlot]}) → bolsa casilla ${s.toBag}`;
    case 'equip': return `${n}. Ponerme ${label(s.item)} (bolsa ${s.fromBag}) → ${SLOT_NAMES[s.toSlot]}`;
  }
}

/** Resumen de una línea. */
export function summarizePlan(p: EquipPlan): string {
  const changed = p.gains.filter((g) => g.delta > 0);
  if (!changed.length) return 'no hay nada mejor para ponerme en el baúl ni en la bolsa';
  const total = changed.reduce((a, g) => a + g.delta, 0);
  return `${changed.length} pieza(s) mejores (+${total.toFixed(0)} de puntaje de defensa): ${changed.map((g) => g.after).join(', ')}; ${p.steps.length} pasos`;
}
