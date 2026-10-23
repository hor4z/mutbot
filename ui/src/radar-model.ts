/**
 * Modelo común del mapa (radar 3D y vista táctica 2D): capas, tipos de marcador, la lista de entidades
 * que sale del estado y su descripción para tooltips. Sin DOM ni Three.
 */
import type { PanelState } from "../../panel-protocol";
import { cheb } from "./hud-logic";

export type Kind = "self" | "monster" | "gold" | "dragon" | "red" | "player" | "mate" | "squad" | "drop" | "dropdim" | "camp";
export type LayerKey = "monsters" | "golds" | "players" | "squad" | "loot" | "route" | "zones" | "hazards" | "fog";
export type Layers = Record<LayerKey, boolean>;
export const DEFAULT_LAYERS: Layers = { monsters: true, golds: true, players: true, squad: true, loot: true, route: true, zones: true, hazards: true, fog: true };
export const LAYER_META: { key: LayerKey; label: string; hint: string; color: number }[] = [
  { key: "monsters", label: "Monstruos", hint: "Monstruos comunes a la vista", color: 0xe86d7b },
  { key: "golds", label: "Dorados", hint: "Dorados, Golden Dragon y Dragón Rojo", color: 0xffc533 },
  { key: "players", label: "Jugadores", hint: "Otros jugadores en el scope", color: 0x77c6f1 },
  { key: "squad", label: "Escuadra", hint: "Compañeros y scouts", color: 0x7be0a8 },
  { key: "loot", label: "Loot y cajas", hint: "Objetos en el piso; los valiosos brillan", color: 0xc6a0ff },
  { key: "route", label: "Ruta", hint: "Últimos pasos y destino del bot", color: 0x6ad7b0 },
  { key: "zones", label: "Zonas de dorados", hint: "Donde se vieron dragones (base de datos)", color: 0xffd361 },
  { key: "hazards", label: "Celdas letales", hint: "Donde murió el personaje (si el bot lo informa)", color: 0xff4d4d },
  { key: "fog", label: "Niebla", hint: "Atenúa lo que todavía no recorriste (vista 2D)", color: 0x55606a },
];
export const KIND_COLOR: Record<Kind, number> = {
  self: 0xffffff, monster: 0xe86d7b, gold: 0xffc533, dragon: 0xff8c1a, red: 0xff3b3b, player: 0x77c6f1,
  mate: 0x7be0a8, squad: 0x7be0a8, drop: 0xc6a0ff, dropdim: 0x8b8798, camp: 0x6ad7b0,
};
export const KIND_LABEL: Record<Kind, string> = {
  self: "Vos", monster: "Monstruo", gold: "Dorado", dragon: "Golden Dragon", red: "Dragón Rojo", player: "Jugador",
  mate: "Compañero", squad: "Escuadra", drop: "Objeto valioso", dropdim: "Objeto", camp: "Destino",
};
export const css = (hex: number) => "#" + hex.toString(16).padStart(6, "0");

export type Ent = { key: string; kind: Kind; x: number; y: number; name: string; target?: boolean; extra?: string };

export function loadLayers(): Layers {
  try {
    const raw = JSON.parse(localStorage.getItem("mubot.radar.layers") ?? "null");
    if (raw && typeof raw === "object")
      return { ...DEFAULT_LAYERS, ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => k in DEFAULT_LAYERS && typeof v === "boolean")) };
  } catch {
    /* sin almacenamiento: defaults */
  }
  return DEFAULT_LAYERS;
}
export function saveLayers(l: Layers) {
  try {
    localStorage.setItem("mubot.radar.layers", JSON.stringify(l));
  } catch {
    /* ignorar */
  }
}

/** Todo lo que se dibuja como marcador, ya filtrado por capas. */
export function entities(s: PanelState, L: Layers): Ent[] {
  const out: Ent[] = [{ key: "self", kind: "self", x: s.where.x, y: s.where.y, name: s.char.name }];
  for (const m of s.entities?.monsters ?? []) {
    const kind: Kind = m.type === 44 ? "red" : m.type === 79 ? "dragon" : m.gold ? "gold" : "monster";
    if (kind === "monster" ? !L.monsters : !L.golds) continue;
    out.push({ key: `m${m.id}`, kind, x: m.x, y: m.y, name: m.name, target: m.target });
  }
  const mates = new Set<string>();
  for (const p of s.entities?.players ?? []) {
    if (p.mate) {
      mates.add(p.name ?? "");
      if (L.squad) out.push({ key: `p${p.id}`, kind: "mate", x: p.x, y: p.y, name: p.name ?? "Compañero" });
    } else if (L.players) out.push({ key: `p${p.id}`, kind: "player", x: p.x, y: p.y, name: p.name ?? "Jugador" });
  }
  if (L.squad)
    for (const q of s.squad ?? []) {
      if (q.map !== s.where.map || mates.has(q.name)) continue;
      out.push({ key: `q${q.name}`, kind: "squad", x: q.x, y: q.y, name: q.name, extra: q.role });
    }
  if (L.loot)
    for (const [i, d] of (s.entities?.drops ?? []).entries())
      out.push({ key: `d${i}`, kind: d.valuable ? "drop" : "dropdim", x: d.x, y: d.y, name: d.name });
  if (L.route && s.camp) out.push({ key: "camp", kind: "camp", x: s.camp[0], y: s.camp[1], name: "Destino del personaje" });
  return out;
}
export function counts(s: PanelState | null): Record<LayerKey, number> {
  const c: Record<LayerKey, number> = { monsters: 0, golds: 0, players: 0, squad: 0, loot: 0, route: s?.trail?.length ?? 0, zones: s?.zones?.length ?? 0, hazards: s?.hazards?.length ?? 0, fog: 0 };
  if (!s) return c;
  for (const m of s.entities?.monsters ?? []) m.gold ? c.golds++ : c.monsters++;
  for (const p of s.entities?.players ?? []) p.mate ? c.squad++ : c.players++;
  c.squad += (s.squad ?? []).filter((q) => q.map === s.where.map && !(s.entities?.players ?? []).some((p) => p.name === q.name)).length;
  c.loot = s.entities?.drops.length ?? 0;
  return c;
}

export type Info = { title: string; kind: Kind | "tile" | "zone" | "hazard"; lines: string[]; x: number; y: number };
export function describe(e: Ent, s: PanelState): Info {
  const d = cheb(e.x, e.y, s.where.x, s.where.y);
  const lines = [`${KIND_LABEL[e.kind]}${e.extra ? ` · ${e.extra}` : ""}${e.target ? " · objetivo" : ""}`];
  if (e.kind !== "self") lines.push(`${d} tile${d === 1 ? "" : "s"} de distancia`);
  lines.push(`Posición ${e.x}, ${e.y}`);
  return { title: e.name, kind: e.kind, lines, x: e.x, y: e.y };
}
