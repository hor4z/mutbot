/**
 * Datos simulados de la vista "Comercio" (`?demo&view=comercio`): sin tocar ningún bot ni la estación.
 * Las órdenes `shops`/`commerce` se aplican a un estado local para poder probar los diálogos.
 */
import { planSales } from "../../commerce-plan";
import type { CommerceOp, PanelCommand, PanelState, ShopItemView, ShopsView, ShopView } from "../../panel-protocol";
import type { PlanItem } from "../../equip-plan";

export const isCommerceDemo = () => typeof location !== "undefined" && new URLSearchParams(location.search).has("demo") && new URLSearchParams(location.search).get("view") === "comercio";

const it = (slot: number, group: number, num: number, name: string, o: Partial<ShopItemView> = {}): ShopItemView => ({ slot, group, num, level: 0, excellent: false, name, price: null, w: 1, h: 1, ...o });

const equipped: ShopItemView[] = [
  it(0, 0, 17, "Dark Breaker", { level: 9, skill: true, w: 2, h: 3 }),
  it(2, 7, 9, "Plate Helm", { level: 4, w: 2, h: 2 }),
  it(3, 8, 9, "Plate Armor", { level: 6, luck: true, w: 2, h: 3 }),
  it(4, 9, 9, "Plate Pants", { level: 3, w: 2, h: 2 }),
  it(7, 12, 5, "Wings of Dragon", { level: 9, w: 3, h: 2 }),
];
const baseBag = (): ShopItemView[] => [
  it(12, 14, 3, "Large Healing Potion"),
  it(13, 14, 14, "Jewel of Soul"),
  it(14, 14, 13, "Jewel of Bless"),
  it(15, 14, 31, "Jewel of Guardian"),
  it(16, 14, 11, "Box of Luck", { level: 9 }),
  it(17, 14, 11, "Box of Luck", { level: 9 }),
  it(18, 14, 11, "Box of Luck", { level: 5 }),
  it(24, 8, 0, "Bronze Armor", { w: 2, h: 2 }),
  it(26, 7, 1, "Bronze Helm", { w: 2, h: 2 }),
  it(40, 8, 23, "Hurricane Armor", { level: 7, excellent: true, excFlags: 12, excCount: 2, w: 2, h: 3 }),
  it(48, 8, 21, "Great Dragon Armor", { level: 9, luck: true, option: 4, excellent: true, excFlags: 44, excCount: 3, w: 2, h: 3 }),
];

const amy: ShopView = {
  kind: "npc", id: 253, name: "Amy, Potion Girl", map: 0, x: 127, y: 86, at: Date.now() - 40_000, verified: false,
  items: [it(0, 14, 0, "Apple"), it(1, 14, 1, "Small Healing Potion"), it(2, 14, 2, "Medium Healing Potion"), it(3, 14, 3, "Large Healing Potion"), it(4, 14, 4, "Small Mana Potion"), it(5, 14, 5, "Medium Mana Potion"), it(6, 14, 6, "Large Mana Potion"), it(7, 14, 8, "Antidote")],
};
const zienna: ShopView = {
  kind: "npc", id: 246, name: "Zienna, Wea Merchant", map: 0, x: 140, y: 120, at: Date.now() - 90_000, verified: false,
  items: [it(0, 0, 1, "Kris", { w: 1, h: 2 }), it(1, 0, 5, "Short Sword", { w: 1, h: 3 }), it(2, 6, 1, "Small Shield", { w: 2, h: 2 }), it(3, 7, 1, "Bronze Helm", { w: 2, h: 2 }), it(4, 8, 1, "Bronze Armor +0", { w: 2, h: 2 })],
};
const zamu: ShopView = {
  kind: "player", id: 300, name: "Zamu", title: "Cajas y sets baratos", map: 0, x: 133, y: 130, at: Date.now() - 20_000, verified: false,
  items: [
    it(0, 14, 11, "Box of Luck", { level: 5, price: 6_000_000 }),
    it(1, 14, 11, "Box of Luck", { level: 4, price: 3_500_000 }),
    it(2, 8, 21, "Great Dragon Armor", { level: 9, luck: true, option: 4, excellent: true, excFlags: 44, excCount: 3, w: 2, h: 3, price: 90_000_000 }),
    it(3, 7, 9, "Plate Helm", { level: 9, luck: true, option: 2, w: 2, h: 2, price: 1_200_000 }),
    it(4, 14, 31, "Jewel of Guardian", { price: 250_000 }),
    it(5, 12, 5, "Wings of Dragon", { level: 5, w: 3, h: 2, price: 0 }),
  ],
};

export type DemoApi = { state: PanelState; send: (c: PanelCommand) => number | null; toast: string; result: { id: number; ok: boolean } | null };

const asPlan = (xs: ShopItemView[]): PlanItem[] => xs.map((x) => ({ ...x, slot: x.slot }));

function shops(bag: ShopItemView[], extra: Partial<ShopsView>, reads: ShopView[]): ShopsView {
  const vendors = [
    { id: 253, type: 253, name: "Amy, Potion Girl", x: 127, y: 86, dist: 3 },
    { id: 246, type: 246, name: "Zienna, Wea Merchant", x: 140, y: 120, dist: 11 },
    { id: 251, type: 251, name: "Hanzo, Blacksmith", x: 120, y: 90, dist: 9 },
    { id: 240, type: 240, name: "Baz, Storage Guard", x: 132, y: 89, dist: 6 },
  ];
  return {
    at: Date.now(), vendors,
    players: [
      { id: 300, name: "Zamu", x: 133, y: 130, dist: 4, shop: "Cajas y sets baratos" },
      { id: 301, name: "Melu", x: 129, y: 128, dist: 2 },
      { id: 302, name: "Kairu", x: 140, y: 126, dist: 9 },
    ],
    shops: reads, mine: null, trade: null, equipped, bag, history: [], notes: ["PlayerShopItemList (212 bytes, SIN verificar): c2 00 d4 3f 05 …"],
    plan: planSales({ fighter: { cls: "dk", evolved: true, level: 400, stats: { str: 65535, agi: 65535 } }, equipped: asPlan(equipped), bag: asPlan(bag), vendors: vendors.map((v) => ({ id: v.id, name: v.name, dist: v.dist })), seenSellPrices: { "8/0/0": 1200 } }),
    ...extra,
  };
}

export function demoState(bag: ShopItemView[], extra: Partial<ShopsView>, reads: ShopView[], mode: PanelState["mode"], zen: number): PanelState {
  return {
    at: Date.now(), mode, doing: mode === "paused" ? "en pausa" : "farmeando en Arena 4",
    char: { name: "Hume", level: 400, resets: 45, hp: [1800, 2400], mp: [600, 900], stats: { str: 65535, agi: 65535, vit: 65535, ene: 65535 }, points: 0, zen, classId: 6 },
    where: { map: 0, mapName: "Lorencia", x: 128, y: 128 }, exp: { perMin1: 0, perMin5: 0 }, cycle: null, cycles: [], resetsPerDay: null, events: [], invasion: null, tickets: {},
    nearby: { monsters: 0, players: 3 }, shops: shops(bag, extra, reads),
  };
}

/** Estado local del demo + `send` que lo modifica como lo haría el bot (sin red). */
export function createDemo(): { initial: () => { bag: ShopItemView[]; reads: ShopView[]; extra: Partial<ShopsView>; mode: PanelState["mode"]; zen: number }; apply: (cur: { bag: ShopItemView[]; reads: ShopView[]; extra: Partial<ShopsView>; mode: PanelState["mode"]; zen: number }, c: PanelCommand) => { next: typeof cur; msg: string; ok: boolean } } {
  type S = ReturnType<ReturnType<typeof createDemo>["initial"]>;
  const hist = (s: S, text: string, ok = true): S["extra"] => ({ ...s.extra, history: [{ at: Date.now(), text, ok }, ...(s.extra.history ?? [])].slice(0, 12) });
  return {
    initial: () => ({ bag: baseBag(), reads: [amy, zamu], extra: {}, mode: "paused", zen: 12_500_000 }),
    apply: (s, c) => {
      if (c.cmd === "pause") return { next: { ...s, mode: "paused" }, msg: "en pausa (demo)", ok: true };
      if (c.cmd === "resume") return { next: { ...s, mode: "farm" }, msg: "sigo (demo)", ok: true };
      if (c.cmd === "shops") {
        if (c.npc === 246) return { next: { ...s, reads: [...s.reads.filter((r) => r.id !== 246), { ...zienna, at: Date.now() }] }, msg: "Zienna: 5 ítem(s) en el catálogo (demo)", ok: true };
        if (c.player === 300) return { next: { ...s, reads: [...s.reads.filter((r) => r.id !== 300), { ...zamu, at: Date.now() }] }, msg: "tienda de Zamu (demo)", ok: true };
        return { next: s, msg: "refrescado (demo)", ok: true };
      }
      if (c.cmd !== "commerce") return { next: s, msg: "orden ignorada en la demo", ok: false };
      const op: CommerceOp = c.op;
      if (s.mode !== "paused" && op.kind !== "trade-cancel" && op.kind !== "shop-close") return { next: s, msg: "pausame primero (orden pause)", ok: false };
      switch (op.kind) {
        case "sell": {
          const gone = new Set(op.items.map((i) => i.slot));
          return { next: { ...s, bag: s.bag.filter((b) => !gone.has(b.slot)), zen: s.zen + 1200 * gone.size, extra: hist(s, `vender: vendí ${gone.size}/${gone.size} (demo)`) }, msg: `vendí ${gone.size}; cobré ${(1200 * gone.size).toLocaleString("es-AR")} zen (demo)`, ok: true };
        }
        case "buy": return { next: { ...s, zen: s.zen - 150 * op.qty, extra: hist(s, `comprar: compré ${op.qty} (demo)`) }, msg: `compré ${op.qty}; gasté ${(150 * op.qty).toLocaleString("es-AR")} zen (demo)`, ok: true };
        case "shop-open": return { next: { ...s, extra: { ...hist(s, `shop-open: tienda "${op.title}" abierta (demo)`), mine: { open: true, title: op.title, at: Date.now(), items: op.items.map((i) => ({ slot: 76 + i.slot % 32, price: i.price, name: s.bag.find((b) => b.slot === i.slot)?.name ?? "?" })) } } }, msg: `tienda "${op.title}" abierta (demo)`, ok: true };
        case "shop-close": return { next: { ...s, extra: { ...hist(s, "tienda cerrada (demo)"), mine: s.extra.mine ? { ...s.extra.mine, open: false } : null } }, msg: "tienda cerrada (demo)", ok: true };
        case "shop-buy": return { next: { ...s, zen: s.zen - op.price, extra: hist(s, `shop-buy: compré en la tienda de ${op.player} por ${op.price} (demo)`) }, msg: `compré por ${op.price.toLocaleString("es-AR")} zen (demo)`, ok: true };
        case "trade": return { next: { ...s, extra: { ...hist(s, "trade: esperando OK del otro (demo)"), trade: { with: "Melu", withId: op.player, state: "open", at: Date.now(), mine: op.items.map((i) => s.bag.find((b) => b.slot === i.slot)!).filter(Boolean), theirs: [], mineZen: op.zen, theirsZen: 0, note: "marqué OK: espero que el otro marque OK" } } }, msg: "trade abierto (demo)", ok: true };
        case "trade-cancel": return { next: { ...s, extra: { ...s.extra, trade: s.extra.trade ? { ...s.extra.trade, state: "cancelled", note: "cancelado" } : null } }, msg: "trade cancelado (demo)", ok: true };
        case "trade-accept": case "trade-ok": return { next: s, msg: "ok (demo)", ok: true };
      }
    },
  };
}
