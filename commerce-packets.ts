/**
 * Comercio: bytes del protocolo (lógica pura, sin red ni estado). Parsers de lo que manda el server y
 * armadores de lo que manda el bot. Tests en commerce-tests.ts.
 *
 * QUÉ ESTÁ VERIFICADO Y QUÉ NO (docs/comercio.md tiene las fuentes):
 *  - VERIFICADO en vivo (otros módulos del repo): ítems de 5/6 bytes, mover ítem `C3 24` entre inventario
 *    y bolsa (equip.ts), hablar con un NPC `C3 05 30 <id BE>` + `StoreItemList` + cerrar `C1 03 31`
 *    (vault.ts leyó el baúl de Baz así, 2026-10-23).
 *  - Layout de los packets generados (`packets/`): `StoreItemList` (C2, tipo @4, cuenta @5, casillas
 *    desde @6), `BuyItemFromNpcRequest` (`C3 04 32 <casilla>`), `SellItemToNpcRequest` (`C3 04 33
 *    <casilla>`), `NpcItemSellResult` (`C3 08 33 <ok> <zen u32 LE>`). Vienen del XML de OpenMU: SIN
 *    VERIFICAR EN VIVO que este server (0.97d con adaptador) los acepte tal cual; shop.ts ya los usaba así.
 *  - SIN VERIFICAR EN VIVO, de memoria del protocolo de OpenMU/Webzen (no hay clases generadas en
 *    `packets/`, solo los nombres/códigos de `routes.ts`): tienda personal (0x3F) y trade (0x36-0x3D).
 *    Los parsers de tiendas personales aceptan varias formas y devuelven null si el largo no cierra; el
 *    bot guarda el hex del primer packet de cada tipo en las notas del panel para poder verificarlos.
 */
import { decodeItemDetail, parseInventory, type ItemDetail } from './protocol097';
import type { CommerceDraft, CommerceOp } from './panel-protocol';

const u8 = (raw: Uint8Array | DataView | ArrayBuffer): Uint8Array =>
  raw instanceof Uint8Array ? raw : raw instanceof DataView ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);

/** Ítem leído de un catálogo/tienda: casilla, bytes crudos, todas sus opciones y el precio (null = el packet no lo trae). */
export type ShopRawItem = ItemDetail & { slot: number; raw: Uint8Array; price: number | null };

export const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

// ---------------------------------------------------------------------------
// Catálogo de un NPC. NpcWindowResponse (C3 len 30 <ventana>): 0 y 1 = mercader; 2 = baúl; 3 = Chaos
// Machine. Después llega StoreItemList (C2 hh ll 31 <tipo> <cuenta> [<casilla><ítem>]×n): el MISMO
// formato que el inventario, así que se reusa parseInventory. NO trae precios: el server los cobra al
// comprar (el cliente los calcula con su tabla de ítems, que acá no existe).
// ---------------------------------------------------------------------------
export type NpcWindow = 'mercader' | 'baul' | 'maquina' | 'otro';

export function parseNpcWindow(raw: Uint8Array | DataView | ArrayBuffer): NpcWindow | null {
  const b = u8(raw);
  if (b.length < 4 || b[2] !== 0x30) return null;
  return b[3] === 0 || b[3] === 1 ? 'mercader' : b[3] === 2 ? 'baul' : b[3] === 3 ? 'maquina' : 'otro';
}

export function parseStoreList(raw: Uint8Array | DataView | ArrayBuffer): { type: number; items: ShopRawItem[] } | null {
  const b = u8(raw);
  if (b.length < 6 || b[0] !== 0xc2 || b[3] !== 0x31) return null;
  const slots = parseInventory(b);
  if (!slots) return null;
  const items = slots.filter((s) => s.raw).map((s) => ({ ...decodeItemDetail(s.raw!), slot: s.slot, raw: s.raw!, price: null }));
  return { type: b[4], items };
}

/** BuyItemFromNpcRequest: C3 04 32 <casilla del catálogo>. */
export const buildBuyNpc = (slot: number): Uint8Array => Uint8Array.from([0xc3, 0x04, 0x32, slot & 0xff]);
/** SellItemToNpcRequest: C3 04 33 <casilla del inventario>. */
export const buildSellNpc = (slot: number): Uint8Array => Uint8Array.from([0xc3, 0x04, 0x33, slot & 0xff]);

/** NpcItemSellResult (C3 08 33): ok en el bit 0 del byte 3, zen que te quedó u32 LITTLE endian desde el 4. */
export function parseSellResult(raw: Uint8Array | DataView | ArrayBuffer): { ok: boolean; zen: number } | null {
  const b = u8(raw);
  if (b.length < 8 || b[2] !== 0x33) return null;
  return { ok: (b[3] & 1) === 1, zen: (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0 };
}

/** NpcItemBuyFailed es `C1 04 32 FF`; ItemBought es `C1 .. 32 <casilla> <ítem>` (largo != 4 o byte 3 != FF). */
export const isBuyFailed = (raw: Uint8Array | DataView | ArrayBuffer): boolean => {
  const b = u8(raw);
  return b[2] === 0x32 && b[3] === 0xff;
};

// ---------------------------------------------------------------------------
// Tienda personal (0x3F). SIN VERIFICAR EN VIVO: layouts de memoria de OpenMU/Webzen.
//   pedir la lista   C1 10 3F 05 <id jugador BE> <nombre[10]>
//   comprar          C1 11 3F 06 <id BE> <nombre[10]> <casilla de la tienda>
//   cerrar el diálogo C1 10 3F 07 <id BE> <nombre[10]>
//   precio           C1 09 3F 01 <casilla> <precio u32 BE>
//   abrir mi tienda  C1 28 3F 02 <cartel[36]>
//   cerrar mi tienda C1 04 3F 03
// Mis ítems en venta viven en el inventario desde la casilla 76 (4 filas × 8: 76-107), como el área de
// tienda de OpenMU: se ponen con el mismo mover ítem `C3 24` de equip.ts (depósito 0 → casilla 76+).
// ---------------------------------------------------------------------------
export const STORE_FIRST_SLOT = 76;
export const STORE_SLOTS = 32;
export const STORE_COLS = 8;

function nameField(name: string, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  [...Buffer.from(name, 'latin1').subarray(0, n)].forEach((c, i) => (out[i] = c));
  return out;
}
const id16 = (id: number) => [(id >> 8) & 0x7f, id & 0xff];

export const buildShopListRequest = (playerId: number, name: string): Uint8Array => Uint8Array.from([0xc1, 0x10, 0x3f, 0x05, ...id16(playerId), ...nameField(name, 10)]);
export const buildShopBuy = (playerId: number, name: string, slot: number): Uint8Array => Uint8Array.from([0xc1, 0x11, 0x3f, 0x06, ...id16(playerId), ...nameField(name, 10), slot & 0xff]);
export const buildShopCloseDialog = (playerId: number, name: string): Uint8Array => Uint8Array.from([0xc1, 0x10, 0x3f, 0x07, ...id16(playerId), ...nameField(name, 10)]);
export const buildShopSetPrice = (slot: number, price: number): Uint8Array =>
  Uint8Array.from([0xc1, 0x09, 0x3f, 0x01, slot & 0xff, (price >>> 24) & 0xff, (price >>> 16) & 0xff, (price >>> 8) & 0xff, price & 0xff]);
export const buildShopOpen = (title: string): Uint8Array => Uint8Array.from([0xc1, 0x28, 0x3f, 0x02, ...nameField(title, 36)]);
export const buildShopClose = (): Uint8Array => Uint8Array.from([0xc1, 0x04, 0x3f, 0x03]);

export type PlayerShopList = { count: number; result: number; playerId: number; name: string; title: string; items: ShopRawItem[] };

function text(b: Uint8Array): string {
  const end = b.indexOf(0);
  return Buffer.from(end >= 0 ? b.subarray(0, end) : b).toString('latin1');
}

/**
 * PlayerShopItemList (S2C C2 hh ll 3F 05). Layouts probados contra el largo, en este orden:
 *   A  [cuenta@5][resultado@6][id BE@7][nombre[10]@9][cartel[36]@19] ítems@55
 *   B  [resultado@5][cuenta@6]…                                      (igual)
 *   C  [cuenta@5][resultado@6][id BE@7][nombre[10]@9]                ítems@19 (sin cartel)
 * cada ítem: [casilla][ítem de 6, 5 o 12 bytes][precio u32 BE]. null si ninguno cierra.
 */
export function parsePlayerShopList(raw: Uint8Array | DataView | ArrayBuffer): PlayerShopList | null {
  const b = u8(raw);
  if (b.length < 19 || b[0] !== 0xc2 || b[3] !== 0x3f || b[4] !== 0x05) return null;
  const layouts: { countAt: number; resultAt: number; head: number; titled: boolean }[] = [
    { countAt: 5, resultAt: 6, head: 55, titled: true },
    { countAt: 6, resultAt: 5, head: 55, titled: true },
    { countAt: 5, resultAt: 6, head: 19, titled: false },
  ];
  for (const l of layouts) {
    const count = b[l.countAt];
    if (count > STORE_SLOTS) continue;
    for (const size of [6, 5, 12] as const) {
      if (b.length !== l.head + count * (1 + size + 4)) continue;
      const items: ShopRawItem[] = [];
      for (let i = 0; i < count; i++) {
        const o = l.head + i * (1 + size + 4);
        const e = b.slice(o + 1, o + 1 + size);
        const p = o + 1 + size;
        items.push({ ...decodeItemDetail(e), slot: b[o], raw: e, price: ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0 });
      }
      return {
        count, result: b[l.resultAt], playerId: ((b[7] << 8) | b[8]) & 0x7fff, name: text(b.subarray(9, 19)),
        title: l.titled ? text(b.subarray(19, 55)) : '', items,
      };
    }
  }
  return null;
}

/** PlayerShops (S2C C2 3F 00): [cuenta@5] y por tienda [id BE][cartel[36]] (38 bytes) o [id BE][nombre[10]][cartel[36]] (48). */
export function parsePlayerShops(raw: Uint8Array | DataView | ArrayBuffer): { id: number; name: string; title: string }[] | null {
  const b = u8(raw);
  if (b.length < 6 || b[0] !== 0xc2 || b[3] !== 0x3f || b[4] !== 0x00) return null;
  const count = b[5];
  for (const stride of [38, 48]) {
    if (b.length !== 6 + count * stride) continue;
    const out: { id: number; name: string; title: string }[] = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * stride;
      out.push({ id: ((b[o] << 8) | b[o + 1]) & 0x7fff, name: stride === 48 ? text(b.subarray(o + 2, o + 12)) : '', title: text(b.subarray(o + stride - 36, o + stride)) });
    }
    return out;
  }
  return null;
}

/** PlayerShopOpenSuccessful (C1 05 3F 02 <resultado>): 1 = abrió. PlayerShopClosed (3F 03). */
export const parseShopOpenResult = (raw: Uint8Array | DataView | ArrayBuffer): boolean | null => {
  const b = u8(raw);
  return b.length >= 5 && b[2] === 0x3f && b[3] === 0x02 ? b[4] === 1 : null;
};

// ---------------------------------------------------------------------------
// Trade directo (0x36-0x3D). SIN VERIFICAR EN VIVO: de memoria de OpenMU.
//   pedir            C1 05 36 <id BE>             (S2C al otro: C3 .. 36 <nombre[10]>)
//   responder        C1 06 37 <acepta 1/0> <id BE> (S2C al que pidió: C1 .. 37 <acepta> <nombre[10]> ...)
//   poner zen        C1 07 3A <zen u32 BE>        (S2C: 3A 01 respuesta, 3B actualización del otro)
//   botón OK         C1 04 3C <1 marcado / 0 no>   (S2C: C3 estado del botón del otro)
//   cancelar         C1 03 3D                      (S2C: 3D <resultado> trade terminado)
// Los ítems se ponen con mover ítem `C3 24` al depósito 1 (STORAGE.trade); la ventana es de 8×4 casillas.
// ---------------------------------------------------------------------------
export const TRADE_COLS = 8;
export const TRADE_ROWS = 4;
export const TRADE_REQUEST_TTL_MS = 20_000;

export const buildTradeRequest = (playerId: number): Uint8Array => Uint8Array.from([0xc1, 0x05, 0x36, ...id16(playerId)]);
export const buildTradeAnswer = (playerId: number, accept: boolean): Uint8Array => Uint8Array.from([0xc1, 0x06, 0x37, accept ? 1 : 0, ...id16(playerId)]);
export const buildTradeZen = (zen: number): Uint8Array => Uint8Array.from([0xc1, 0x07, 0x3a, (zen >>> 24) & 0xff, (zen >>> 16) & 0xff, (zen >>> 8) & 0xff, zen & 0xff]);
export const buildTradeButton = (checked: boolean): Uint8Array => Uint8Array.from([0xc1, 0x04, 0x3c, checked ? 1 : 0]);
export const buildTradeCancel = (): Uint8Array => Uint8Array.from([0xc1, 0x03, 0x3d]);

/** TradeRequest S2C (C3 len 36 <nombre[10]>): quién pide trade. */
export function parseTradeRequest(raw: Uint8Array | DataView | ArrayBuffer): string | null {
  const b = u8(raw);
  return b.length >= 13 && b[2] === 0x36 ? text(b.subarray(3, 13)) : null;
}
/** TradeRequestAnswer S2C (C1 len 37 <acepta> ...). */
export function parseTradeAnswer(raw: Uint8Array | DataView | ArrayBuffer): boolean | null {
  const b = u8(raw);
  return b.length >= 4 && b[2] === 0x37 ? b[3] === 1 : null;
}
/** TradeItemAdded S2C (C1 len 39 <casilla> <ítem>): lo que el otro puso en la ventana. */
export function parseTradeItemAdded(raw: Uint8Array | DataView | ArrayBuffer): ShopRawItem | null {
  const b = u8(raw);
  if (b.length < 4 + 5 || b[2] !== 0x39) return null;
  const e = b.slice(4, b.length);
  if (e.length !== 5 && e.length !== 6) return null;
  return { ...decodeItemDetail(e), slot: b[3], raw: e, price: null };
}
/** TradeMoneyUpdate S2C (C1 len 3B ... <zen u32 BE al final>). */
export function parseTradeMoney(raw: Uint8Array | DataView | ArrayBuffer): number | null {
  const b = u8(raw);
  if (b.length < 7 || b[2] !== 0x3b) return null;
  const n = b.length;
  return ((b[n - 4] << 24) | (b[n - 3] << 16) | (b[n - 2] << 8) | b[n - 1]) >>> 0;
}
/** TradeFinished S2C (C1 len 3D <resultado>): 1 = se hizo; otro = cancelado/falló (OpenMU: 0 cancelado, 1 éxito, 2 inventario lleno...). */
export function parseTradeFinished(raw: Uint8Array | DataView | ArrayBuffer): number | null {
  const b = u8(raw);
  return b.length >= 4 && b[2] === 0x3d ? b[3] : null;
}

/** Primera posición libre (de a casillas w×h) en una grilla de `cols`×`rows` dada la lista de ocupadas [pos, w, h]. */
export function firstFit(occupied: { pos: number; w: number; h: number }[], w: number, h: number, cols: number, rows: number): number | null {
  const used = new Set<number>();
  for (const o of occupied) for (let dy = 0; dy < o.h; dy++) for (let dx = 0; dx < o.w; dx++) used.add(o.pos + dy * cols + dx);
  for (let p = 0; p < cols * rows; p++) {
    const x = p % cols, y = Math.floor(p / cols);
    if (x + w > cols || y + h > rows) continue;
    let ok = true;
    for (let dy = 0; dy < h && ok; dy++) for (let dx = 0; dx < w && ok; dx++) if (used.has(p + dy * cols + dx)) ok = false;
    if (ok) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confirmación: el panel arma `commerceToken(op)` al confirmar el resumen y el bot lo exige igual. No es
// criptografía: es para que una orden mal armada o suelta no mueva nada. Incluye lo que el usuario vio
// (ítems, cantidad, precios, total), así que un cambio de cualquier campo invalida la confirmación.
// ---------------------------------------------------------------------------
const refs = (items: { slot: number; group: number; num: number; level: number; price?: number }[]) =>
  items.map((i) => `${i.slot}:${i.group}/${i.num}+${i.level}${i.price !== undefined ? `@${i.price}` : ''}`).join(',');

export function commerceToken(op: CommerceDraft): string {
  switch (op.kind) {
    case 'buy': return `COMPRAR npc=${op.npc} casilla=${op.slot} x${op.qty} tope=${op.maxZen}`;
    case 'sell': return `VENDER npc=${op.npc} ${refs(op.items)}`;
    case 'shop-open': return `ABRIR-TIENDA "${op.title}" ${refs(op.items)}`;
    case 'shop-buy': return `COMPRAR-TIENDA jugador=${op.player} casilla=${op.slot} precio=${op.price}`;
    case 'trade': return `TRADE jugador=${op.player} ${refs(op.items)} zen=${op.zen}`;
    case 'trade-accept': return `ACEPTAR-TRADE jugador=${op.player}`;
    case 'trade-ok': return 'TRADE-OK';
    case 'shop-close': return 'CERRAR-TIENDA';
    case 'trade-cancel': return 'CANCELAR-TRADE';
  }
}

/** ¿La orden trae la confirmación que corresponde a sus campos? */
export function hasValidConfirm(op: CommerceOp): boolean {
  if (op.kind === 'shop-close' || op.kind === 'trade-cancel') return true;
  const { confirm, ...rest } = op;
  return confirm === commerceToken(rest as CommerceDraft);
}
