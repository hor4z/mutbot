/**
 * Lógica pura de la vista del personaje (sin React ni DOM): valor de los ítems, bolsa, alertas,
 * feed de eventos a partir de diferencias entre estados, diario en lenguaje claro y sparkline.
 * Tolera estados de bots viejos (campos que faltan → defaults).
 */
import type { EquippedItem, PanelState } from "../../panel-protocol";

// ---- Ítems ----------------------------------------------------------------------------------
export type Tier = "box" | "jewel" | "exc" | "high" | "potion" | "common";
export const TIER_LABEL: Record<Tier, string> = {
  box: "Caja",
  jewel: "Joya / cristal",
  exc: "Excelente",
  high: "+9 o más",
  potion: "Poción",
  common: "Común",
};
const JEWEL = /bless|soul|life|chaos|creation|guardian|jewel|crystal|cristal|joya/i;
const BOX = /\bbox\b|caja|kundun|heart of love/i;
/** Valor de un ítem de un vistazo: cajas y joyas arriba, excelentes, +9, el resto. */
export function itemTier(it: Pick<EquippedItem, "group" | "num" | "level" | "excellent" | "name">): Tier {
  const n = it.name ?? "";
  if (it.group === 14 && it.num === 11) return "box";
  if (BOX.test(n)) return "box";
  if ((it.group === 14 && [13, 14, 16, 22].includes(it.num)) || (it.group === 12 && it.num === 15) || JEWEL.test(n)) return "jewel";
  if (it.excellent) return "exc";
  if (it.level >= 9) return "high";
  if (it.group === 14 && it.num <= 10) return "potion";
  return "common";
}
export const itemTitle = (it: EquippedItem) =>
  `${it.name ?? `${it.group}/${it.num}`}${it.level ? ` +${it.level}` : ""}${it.excellent ? " · excelente" : ""}`;

/** Casillas ocupadas de la bolsa 8×8 (los ítems grandes ocupan w×h). */
export function bagUsage(items: EquippedItem[]): { used: number; total: 64; count: number } {
  const taken = new Set<number>();
  for (const it of items) {
    const pos = it.slot - 12;
    if (pos < 0 || pos >= 64) continue;
    const x0 = pos % 8, y0 = Math.floor(pos / 8);
    for (let dy = 0; dy < (it.h ?? 1); dy++)
      for (let dx = 0; dx < (it.w ?? 1); dx++) if (x0 + dx < 8 && y0 + dy < 8) taken.add((y0 + dy) * 8 + x0 + dx);
  }
  return { used: taken.size, total: 64, count: items.length };
}
/** Resumen de valor de la bolsa: cuántos ítems de cada categoría destacada. */
export function bagValue(items: EquippedItem[]): Record<Tier, number> {
  const out: Record<Tier, number> = { box: 0, jewel: 0, exc: 0, high: 0, potion: 0, common: 0 };
  for (const it of items) out[itemTier(it)]++;
  return out;
}

// ---- Distancias y direcciones ----------------------------------------------------------------
export const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const ARROWS = ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"];
/** Flecha hacia (dx,dy) con arriba = +y, igual que el radar. */
export const arrow = (dx: number, dy: number) =>
  dx === 0 && dy === 0 ? "•" : ARROWS[Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8]!;
export const isDragon = (type: number) => type === 44 || type === 79;

// ---- Progreso ----------------------------------------------------------------------------------
export const RESET_LEVEL = 400;
export const levelProgress = (level: number) => Math.max(0, Math.min(1, level / RESET_LEVEL));

/** Valores de sparkline → puntos de un polyline SVG (0..w, 0..h, arriba = más). */
export function sparkPoints(values: number[], w: number, h: number, pad = 2): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  return values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(" ");
}

// ---- Alertas --------------------------------------------------------------------------------
export type Alert = { id: string; level: "bad" | "warn" | "info"; text: string };
export type AlertCtx = {
  now: number;
  /** ms desde que la posición dejó de cambiar */
  stillMs: number;
  online: boolean;
};
export function computeAlerts(s: PanelState | null, c: AlertCtx): Alert[] {
  const out: Alert[] = [];
  if (!s) return out;
  const hp = s.char.hp, mp = s.char.mp;
  if (s.mode === "dead") out.push({ id: "dead", level: "bad", text: "El personaje está muerto." });
  else if (hp[1] && hp[0] / hp[1] < 0.3) out.push({ id: "hp", level: "bad", text: `Vida baja: ${hp[0]} de ${hp[1]}.` });
  if (mp[1] && mp[0] / mp[1] < 0.12 && s.mode !== "dead") out.push({ id: "mp", level: "warn", text: "Maná casi vacío." });
  const ses = s.session;
  if (s.mode === "farm" && s.exp.perMin5 === 0 && ses && c.now - ses.since > 300000)
    out.push({ id: "exp", level: "warn", text: "5 minutos sin ganar experiencia." });
  if ((s.mode === "farm" || s.mode === "hunt") && c.stillMs > 90_000 && s.nearby.monsters === 0)
    out.push({ id: "stuck", level: "warn", text: `Quieto hace ${Math.round(c.stillMs / 1000)} s sin monstruos cerca: posible traba.` });
  const bag = bagUsage(s.inventory ?? []);
  if (s.inventory && bag.used >= 62) out.push({ id: "bag", level: "bad", text: "Bolsa llena." });
  else if (s.inventory && bag.used >= 54) out.push({ id: "bag", level: "warn", text: `Bolsa casi llena (${bag.used}/64).` });
  const strangers = (s.entities?.players ?? []).filter((p) => !p.mate);
  if (strangers.length) out.push({ id: "pk", level: "info", text: `${strangers.length} jugador${strangers.length > 1 ? "es" : ""} ajeno${strangers.length > 1 ? "s" : ""} a la vista.` });
  if (s.mode === "paused") out.push({ id: "paused", level: "info", text: "En pausa: no camina ni pelea." });
  return out;
}

// ---- Feed en vivo (diferencias entre estados) -------------------------------------------------
export type FeedKind = "kill" | "gold" | "loot" | "level" | "death" | "map" | "reset";
export type FeedItem = { at: number; kind: FeedKind; text: string; n: number; tier?: Tier };
const MERGE_MS = 12_000;
/** Compara dos estados seguidos y devuelve lo nuevo que merece una línea. */
export function diffFeed(prev: PanelState | null, next: PanelState): Omit<FeedItem, "at" | "n">[] {
  if (!prev) return [];
  const out: Omit<FeedItem, "at" | "n">[] = [];
  const ps = prev.session, ns = next.session;
  if (next.where.map !== prev.where.map) out.push({ kind: "map", text: `Viaje a ${next.where.mapName}` });
  if (next.char.level < prev.char.level && next.char.level <= 5 && prev.char.level >= 100)
    out.push({ kind: "reset", text: `Reset: vuelve a nivel ${next.char.level}` });
  else if (next.char.level > prev.char.level) out.push({ kind: "level", text: `Nivel ${next.char.level}` });
  if (ps && ns) {
    if (ns.deaths > ps.deaths) out.push({ kind: "death", text: `Murió en ${next.where.mapName} (${next.where.x}, ${next.where.y})` });
    const dk = ns.kills - ps.kills;
    if (dk > 0) {
      const gone = (prev.entities?.monsters ?? []).find((m) => m.target && !(next.entities?.monsters ?? []).some((n) => n.id === m.id));
      if (gone?.gold) out.push({ kind: "gold", text: `Derrotó a ${gone.name}` });
      else out.push({ kind: "kill", text: dk > 1 ? `${dk} monstruos` : (gone?.name ?? "Monstruo") });
    }
  }
  // Ítems nuevos en la bolsa (por posición y tipo).
  if (prev.inventory && next.inventory) {
    const had = new Set(prev.inventory.map((i) => `${i.slot}:${i.group}/${i.num}:${i.level}`));
    for (const it of next.inventory) {
      if (had.has(`${it.slot}:${it.group}/${it.num}:${it.level}`)) continue;
      const t = itemTier(it);
      if (t === "potion" && !it.excellent) continue;
      out.push({ kind: "loot", text: itemTitle(it), tier: t });
    }
  }
  return out;
}
/** Agrega líneas al feed; los kills comunes seguidos se juntan en una sola línea (×n). */
export function pushFeed(feed: FeedItem[], add: Omit<FeedItem, "at" | "n">[], at: number, max = 60): FeedItem[] {
  let out = feed;
  for (const a of add) {
    const last = out[out.length - 1];
    if (last && a.kind === "kill" && last.kind === "kill" && at - last.at < MERGE_MS) {
      const total = (last.n || 1) + (parseInt(a.text, 10) || 1);
      out = [...out.slice(0, -1), { ...last, at, n: total, text: `${total} monstruos` }];
    } else out = [...out, { ...a, at, n: 1 }];
  }
  return out.length > max ? out.slice(-max) : out;
}

// ---- Diario en lenguaje claro ------------------------------------------------------------------
export type Decision = { at: number; kind: string; what: string; n: number };
export const DECISION_KINDS = new Set(["decide", "travel", "reset", "mode", "command"]);
const MODE_WORD: Record<string, string> = {
  farm: "farmear", hunt: "cazar dorados", paused: "pausa", resetting: "resetear", connecting: "conectar", dead: "muerto",
};
export const KIND_LABEL: Record<string, string> = {
  decide: "Decisión", travel: "Viaje", reset: "Reset", mode: "Modo", command: "Orden",
};
/** `what` del diario → frase principal y detalle (el porqué), sin tocar el texto original. */
export function humanize(d: Decision): { title: string; detail?: string } {
  const m = /^(\w+) → (\w+)$/.exec(d.what);
  if (d.kind === "mode" && m) return { title: `Pasó de ${MODE_WORD[m[1]!] ?? m[1]} a ${MODE_WORD[m[2]!] ?? m[2]}` };
  if (d.kind === "command") {
    const i = d.what.indexOf(": ");
    if (i > 0) return { title: `Orden "${d.what.slice(0, i)}"`, detail: d.what.slice(i + 2) };
  }
  const p = /^(.*?)\s*[—→]\s*(.+)$/.exec(d.what);
  if (p && p[1]) return d.kind === "travel" ? { title: p[2]!, detail: p[1] } : { title: p[1], detail: p[2] };
  const par = /^(.*?)\s*\((.+)\)\s*\.?$/.exec(d.what);
  if (par && par[1]) return { title: par[1], detail: par[2] };
  return { title: d.what };
}
/** Agrega decisiones seguidas iguales como ×n (igual que el panel viejo). */
export function addDecisions(old: Decision[], list: { at: string | number; kind: string; what: string }[], max = 120): Decision[] {
  let out = old;
  for (const d of list) {
    if (!DECISION_KINDS.has(d.kind)) continue;
    const at = typeof d.at === "number" ? d.at : Date.parse(d.at) || Date.now();
    const last = out[out.length - 1];
    out = last && last.what === d.what ? [...out.slice(0, -1), { ...last, at, n: last.n + 1 }] : [...out, { at, kind: d.kind, what: d.what, n: 1 }];
  }
  return out.length > max ? out.slice(-max) : out;
}

// ---- Warp spots (copia del lado cliente de route.ts: índice, nombre, nivel mínimo) ---------------
export const SPOTS: { value: string; label: string; level: number }[] = [
  { value: "2", label: "Lorencia", level: 10 },
  { value: "5", label: "Devias 2", level: 20 },
  { value: "6", label: "Devias 3", level: 20 },
  { value: "7", label: "Devias 4", level: 20 },
  { value: "27", label: "Aida", level: 140 },
  { value: "28", label: "Aida 2", level: 170 },
  { value: "24", label: "Arena 2", level: 100 },
  { value: "25", label: "Arena 3", level: 200 },
  { value: "26", label: "Arena 4", level: 300 },
];
export const MAP_NAMES: Record<number, string> = { 0: "Lorencia", 1: "Dungeon", 2: "Devias", 3: "Noria", 4: "Lost Tower", 7: "Atlans", 8: "Tarkan", 10: "Icarus", 33: "Aida", 83: "Arena 2", 84: "Arena 3", 85: "Arena 4" };

// ---- Terreno ---------------------------------------------------------------------------------------
/** Atributos de una celda del .att: 1 zona segura, 4 no transitable, 8 pared, 16 agua/decorado. */
export function tileKind(v: number): "safe" | "blocked" | "water" | "walk" {
  return v & 12 ? "blocked" : v & 1 ? "safe" : v & 16 ? "water" : "walk";
}
export const TILE_LABEL = { safe: "Zona segura", blocked: "No transitable", water: "Agua / decorado", walk: "Transitable" } as const;
