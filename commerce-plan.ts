/**
 * Comercio: lógica pura (sin red, sin estado). Tres cosas:
 *  1. `planSales`: PROPONE qué vender y dónde. Nunca ejecuta (`executable: false`).
 *  2. `neverSell`: lo que el bot se niega a vender o regalar por una orden de venta a un NPC (cajas,
 *     Cristales, talismanes, joyas, lo puesto, lo excelente, lo que tiene armonía).
 *  3. `compareToWorn` y `opSummary`: para que la interfaz compare un ítem leído con lo que se lleva puesto
 *     y muestre el resumen (ítem, cantidad, TOTAL) que el usuario confirma antes de cada orden.
 *
 * Reglas (HANDOFF.md y docs/items-y-maquinas.md): el rol del bot es cazar y recolectar. Las cajas
 * (14/11) y los Cristales (14/31) son del usuario: NO se venden, se guardan. Las joyas "no valen nada"
 * para comerciar, pero sirven para las mezclas del Chaos Goblin: tampoco se venden por orden suelta. El
 * puntaje es una heurística nuestra (item-score.ts), no un dato del juego. Tests: commerce-tests.ts.
 */
import { SLOT_NAMES, armorSlot, type Fighter } from './item-rules';
import { crystalValue, judgeItem, scoreOf, type ScorableItem } from './item-score';
import type { PlanItem } from './equip-plan';
import type { CommerceDraft, ItemRef } from './panel-protocol';

export const BOX = { group: 14, num: 11 } as const;
export const CRYSTAL = { group: 14, num: 31 } as const;
const TALISMANS: readonly number[] = [7, 12, 20];
/** Joyas y piedras (14/13 Bless, 14/14 Soul, 14/16 Life, 14/22 Creation, 12/15 Chaos, 14/41-44 Gemstone/Armonía/Refine): sirven para mezclar. */
const isJewel = (g: number, n: number) => (g === 14 && [13, 14, 16, 22, 41, 42, 43, 44].includes(n)) || (g === 12 && n === 15);

/** ¿Una orden de venta suelta puede tocar este ítem? Devuelve el motivo por el que NO, o null si se puede vender. */
export function neverSell(it: ScorableItem & { slot?: number; name?: string }): string | null {
  if (it.slot != null && it.slot < 12) return 'está puesto';
  if (it.group === BOX.group && it.num === BOX.num) return 'es una caja: se guarda para el usuario';
  if (it.group === CRYSTAL.group && it.num === CRYSTAL.num) return 'son Cristales: la moneda del Mercado y del Alquimista, se guardan';
  if (it.group === 14 && TALISMANS.includes(it.num)) return 'es un talismán';
  if (isJewel(it.group, it.num)) return 'es una joya: sirve para las mezclas';
  if (it.harmony) return 'tiene armonía (no se puede vender)';
  if (it.group === 12 || it.group === 13) return 'alas, anillos, mascotas y partes de Fenrir no se tocan';
  if (it.group === 14) return 'es un consumible (pociones, tickets...)';
  if (it.excellent || (it.excCount ?? 0) > 0) return 'es excelente (se cristaliza o se guarda)';
  if (it.ancient) return 'es ancient';
  if (it.level >= 13) return 'es +13 o más (sirve para fusionar)';
  return null;
}

/** Para abrir mi tienda personal: lo que se niega igual (cajas y Cristales se guardan; la armonía no se vende). Lo excelente sí puede ir. */
export function neverShop(it: ScorableItem): string | null {
  if (it.group === BOX.group && it.num === BOX.num) return 'es una caja: se guarda para el usuario';
  if (it.group === CRYSTAL.group && it.num === CRYSTAL.num) return 'son Cristales: se guardan';
  if (it.harmony) return 'tiene armonía (no se puede vender)';
  return null;
}

// ---------------------------------------------------------------------------
// Planificador de ventas
// ---------------------------------------------------------------------------
export type SaleLine = { slot: number; name: string; why: string; zen: number | null; ref: ItemRef };
export type KeepLine = { slot: number; name: string; why: string };
export type CrystalLine = { slot: number; name: string; crystals: number; why: string };
export type VendorRef = { id: number; name: string; dist: number };

export type SalesPlan = {
  /** nunca true: el planificador propone, ejecutar lo hace una orden `commerce` con confirmación */
  executable: false;
  needsConfirmation: true;
  /** basura para el set: venta a un NPC (los zen salen de precios ya observados; null = no se sabe) */
  sell: SaleLine[];
  /** dónde: el vendedor a la vista más cercano (null = ninguno a la vista) */
  venue: VendorRef | null;
  /** mejor cristalizarlos que venderlos: valor en Cristales */
  crystallize: CrystalLine[];
  /** posibles para la tienda personal (valen Cristales pero no son para este personaje): precio lo fija el usuario */
  shop: CrystalLine[];
  keep: KeepLine[];
  totalZen: number | null;
  totalCrystals: number;
  notes: string[];
  summary: string;
};

export type SalesInput = {
  fighter: Fighter | null;
  equipped: PlanItem[];
  bag: PlanItem[];
  vendors?: VendorRef[];
  /** zen que pagó un NPC por una casilla ya vendida (observado): clave `group/num/level` */
  seenSellPrices?: Record<string, number>;
  minCrystals?: number;
};

export const itemKey = (it: { group: number; num: number; level: number }) => `${it.group}/${it.num}/${it.level}`;
const refOf = (it: PlanItem): ItemRef => ({ slot: it.slot, group: it.group, num: it.num, level: it.level });
const label = (it: PlanItem) => `${it.name}${it.level ? ` +${it.level}` : ''}`;

export function planSales(input: SalesInput): SalesPlan {
  const { fighter, equipped, bag } = input;
  const notes: string[] = [
    'Esto solo PROPONE. Vender es una orden `commerce` aparte, con confirmación (ítems, cantidad y total).',
    'El server no publica cuánto paga un NPC: los zen salen de ventas que ya se hicieron (null = no se sabe).',
  ];
  const sell: SaleLine[] = [];
  const keep: KeepLine[] = [];
  const crystallize: CrystalLine[] = [];
  const shop: CrystalLine[] = [];
  if (!fighter) notes.push('No sé la clase del personaje todavía (classId): no propongo vender armaduras.');
  const wornAt = (group: number) => {
    const s = armorSlot(group);
    return s == null ? undefined : equipped.find((e) => e.slot === s);
  };
  for (const it of [...bag].sort((a, b) => a.slot - b.slot)) {
    const never = neverSell(it);
    if (never) {
      if (never.startsWith('es excelente') || never.startsWith('es +13') || never.startsWith('es ancient')) {
        // Pasa por el juez abajo para decir si conviene cristalizar o guardar.
      } else {
        keep.push({ slot: it.slot, name: label(it), why: never });
        continue;
      }
    }
    if (!fighter) {
      keep.push({ slot: it.slot, name: label(it), why: 'sin clase conocida no juzgo' });
      continue;
    }
    const v = judgeItem(it, fighter, wornAt(it.group), { minCrystals: input.minCrystals });
    if (v.action === 'equipar') keep.push({ slot: it.slot, name: label(it), why: `mejora el set: ${v.why} (equipar, no vender)` });
    else if (v.action === 'cristalizar') {
      const c = v.crystals ?? 0;
      crystallize.push({ slot: it.slot, name: label(it), crystals: c, why: `${c} Cristales en el Alquimista` });
      // Otro jugador podría pagarlo: si no lo puedo usar y vale, queda como candidato de tienda.
      if (it.group <= 11 && c >= 8) shop.push({ slot: it.slot, name: label(it), crystals: c, why: 'no es para este personaje: precio a fijar por el usuario' });
    } else if (v.action === 'guardar') keep.push({ slot: it.slot, name: label(it), why: v.why });
    else if (never) keep.push({ slot: it.slot, name: label(it), why: never });
    else {
      const zen = input.seenSellPrices?.[itemKey(it)] ?? null;
      sell.push({ slot: it.slot, name: label(it), why: `basura: ${v.why}`, zen, ref: refOf(it) });
    }
  }
  const known = sell.filter((s) => s.zen != null);
  const totalZen = sell.length > 0 && known.length === sell.length ? known.reduce((a, s) => a + (s.zen ?? 0), 0) : null;
  const totalCrystals = crystallize.reduce((a, c) => a + c.crystals, 0);
  const vendors = [...(input.vendors ?? [])].sort((a, b) => a.dist - b.dist);
  const venue = vendors[0] ?? null;
  if (sell.length > 0 && !venue) notes.push('No hay un NPC vendedor a la vista: caminá hasta uno (p. ej. Amy en Lorencia) antes de vender.');
  if (sell.length > 8) notes.push('Una orden de venta lleva hasta 8 ítems: hacelo en tandas.');
  const summary = [
    sell.length ? `${sell.length} para vender al NPC${totalZen != null ? ` (~${totalZen.toLocaleString('es-AR')} zen)` : ''}` : 'nada para vender',
    crystallize.length ? `${crystallize.length} para cristalizar (${totalCrystals} Cristales)` : '',
    `${keep.length} para guardar`,
  ].filter(Boolean).join(' · ');
  return { executable: false, needsConfirmation: true, sell, venue, crystallize, shop, keep, totalZen, totalCrystals, notes, summary };
}

// ---------------------------------------------------------------------------
// Comparar con lo puesto (interfaz): ¿este ítem leído mejora lo que llevo?
// ---------------------------------------------------------------------------
export type WornCompare = { slotName: string | null; worn: string | null; score: number; wornScore: number; delta: number; crystals: number | null };

export function compareToWorn(it: ScorableItem, equipped: (ScorableItem & { slot: number; name?: string })[]): WornCompare {
  const s = armorSlot(it.group);
  const worn = s == null ? undefined : equipped.find((e) => e.slot === s);
  const score = scoreOf(it);
  const wornScore = worn ? scoreOf(worn) : 0;
  return {
    slotName: s == null ? null : (SLOT_NAMES[s] ?? `casilla ${s}`),
    worn: worn ? `${worn.name ?? `${worn.group}/${worn.num}`}${worn.level ? ` +${worn.level}` : ''}` : null,
    score, wornScore, delta: Math.round((score - wornScore) * 10) / 10, crystals: crystalValue(it),
  };
}

// ---------------------------------------------------------------------------
// Resumen de una orden (lo que se le muestra al usuario antes de confirmar)
// ---------------------------------------------------------------------------
export type SummaryCtx = {
  /** nombre de un ítem por casilla del inventario o del catálogo/tienda, según la orden */
  name: (slot: number, from: 'bag' | 'shop') => string;
  /** zen del personaje, para avisar si no alcanza */
  zen?: number | null;
  /** precio conocido del catálogo/tienda de una casilla (null = no se sabe) */
  price?: (slot: number) => number | null;
};
export type OpSummary = { title: string; lines: string[]; total: string; danger: boolean };

const zen = (n: number) => `${n.toLocaleString('es-AR')} zen`;

export function opSummary(op: CommerceDraft, ctx: SummaryCtx): OpSummary {
  switch (op.kind) {
    case 'buy': {
      const p = ctx.price?.(op.slot) ?? null;
      return {
        title: 'Comprar a un NPC',
        lines: [`${op.qty} × ${ctx.name(op.slot, 'shop')} (casilla ${op.slot})`, p != null ? `Precio por unidad: ${zen(p)}` : 'El NPC no publica el precio: lo cobra el server.', `Tope de gasto: ${zen(op.maxZen)}; corta si se pasa.`],
        total: p != null ? `Total: ${zen(p * op.qty)} (tope ${zen(op.maxZen)})` : `Total: hasta ${zen(op.maxZen)}`,
        danger: false,
      };
    }
    case 'sell':
      return {
        title: 'Vender a un NPC',
        lines: op.items.map((i) => `1 × ${ctx.name(i.slot, 'bag')} (casilla ${i.slot})`),
        total: `Total: ${op.items.length} ítem${op.items.length === 1 ? '' : 's'}; el zen lo fija el NPC (no se publica) y los ítems no vuelven`,
        danger: true,
      };
    case 'shop-open': {
      const sum = op.items.reduce((a, i) => a + i.price, 0);
      return {
        title: `Abrir mi tienda "${op.title}"`,
        lines: op.items.map((i) => `1 × ${ctx.name(i.slot, 'bag')} a ${i.price === 0 ? 'precio 0 (de muestra, no se vende)' : zen(i.price)}`),
        total: `Total si se vende todo: ${zen(sum)} (${op.items.length} ítem${op.items.length === 1 ? '' : 's'})`,
        danger: true,
      };
    }
    case 'shop-close': return { title: 'Cerrar mi tienda', lines: [], total: 'Los ítems vuelven a la bolsa', danger: false };
    case 'shop-buy': {
      const short = ctx.zen != null && ctx.zen < op.price;
      return {
        title: 'Comprar en una tienda personal',
        lines: [`1 × ${ctx.name(op.slot, 'shop')} (casilla ${op.slot} de la tienda)`, short ? `OJO: tenés ${zen(ctx.zen ?? 0)}, no alcanza` : ''].filter(Boolean),
        total: `Total: ${zen(op.price)}`,
        danger: true,
      };
    }
    case 'trade':
      return {
        title: 'Trade directo',
        lines: [...op.items.map((i) => `1 × ${ctx.name(i.slot, 'bag')} (casilla ${i.slot})`), op.zen > 0 ? `${zen(op.zen)}` : ''].filter(Boolean),
        total: `Total: ${op.items.length} ítem${op.items.length === 1 ? '' : 's'}${op.zen > 0 ? ` + ${zen(op.zen)}` : ''} al jugador ${op.player}; el otro tiene que aceptar`,
        danger: true,
      };
    case 'trade-accept': return { title: 'Aceptar el trade', lines: [`Pedido del jugador ${op.player}`], total: 'Abre la ventana de trade; no pongo nada', danger: false };
    case 'trade-ok': return { title: 'Marcar OK en el trade', lines: ['Lo del otro lado ya lo revisé'], total: 'Si el otro también marca OK, se hace el cambio', danger: true };
    case 'trade-cancel': return { title: 'Cancelar el trade', lines: [], total: 'Vuelve todo a su dueño', danger: false };
  }
}
