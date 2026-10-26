/**
 * Modelo del mapa (vista táctica 2D): capas, tipos de marcador, la lista de entidades que sale del estado y su descripción para
 * tooltips. Sin DOM.
 */
import type { PanelState } from "../../panel-protocol";
import { cheb } from "./hud-logic";

/** `prize`: monstruo de mucho valor (el que el bot prefiere, ej. Giant). */
export type Kind = "self" | "monster" | "prize" | "player" | "drop" | "dropdim" | "camp";
export type LayerKey = "monsters" | "players" | "loot" | "route" | "fog";
export type Layers = Record<LayerKey, boolean>;
export const DEFAULT_LAYERS: Layers = { monsters: true, players: true, loot: true, route: true, fog: true };
export const LAYER_META: { key: LayerKey; label: string; hint: string; color: number }[] = [
  { key: "monsters", label: "Monstruos", hint: "Monstruos a la vista; los que más exp dan, con aro (no son dorados)", color: 0xe86d7b },
  { key: "players", label: "Jugadores", hint: "Otros jugadores en el scope", color: 0x77c6f1 },
  { key: "loot", label: "Loot", hint: "Objetos en el piso; los valiosos brillan", color: 0xc6a0ff },
  { key: "route", label: "Ruta", hint: "Últimos pasos, destino y línea al objetivo", color: 0x6ad7b0 },
  { key: "fog", label: "Niebla", hint: "Atenúa lo que todavía no recorriste", color: 0x55606a },
];
export const KIND_COLOR: Record<Kind, number> = {
  self: 0xffffff, monster: 0xe86d7b, prize: 0xff7a4d, player: 0x77c6f1, drop: 0xc6a0ff, dropdim: 0x8b8798, camp: 0x6ad7b0,
};
export const KIND_LABEL: Record<Kind, string> = {
  self: "Vos", monster: "Monstruo", prize: "Monstruo de valor (el que prefiere el bot)", player: "Jugador", drop: "Objeto valioso", dropdim: "Objeto", camp: "Destino",
};
export const css = (hex: number) => "#" + hex.toString(16).padStart(6, "0");

/** Exp por kill desde la que un monstruo se resalta (el bot lo prefiere: learning.ts, valueOf). */
export const PRIZE_VALUE = 10_000;

export type Ent = { key: string; kind: Kind; x: number; y: number; name: string; target?: boolean; extra?: string; };

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
    const kind: Kind = m.value >= PRIZE_VALUE ? "prize" : "monster";
    if (!L.monsters) continue;
    out.push({ key: `m${m.id}`, kind, x: m.x, y: m.y, name: m.name, target: m.target, extra: `~${Math.round(m.value / 1000)}k exp` });
  }
  if (L.players) for (const p of s.entities?.players ?? []) out.push({ key: `p${p.id}`, kind: "player", x: p.x, y: p.y, name: p.name ?? "Jugador" });
  if (L.loot)
    for (const [i, d] of (s.entities?.drops ?? []).entries())
      out.push({ key: `d${i}`, kind: d.valuable ? "drop" : "dropdim", x: d.x, y: d.y, name: d.name });
  if (L.route && s.camp) out.push({ key: "camp", kind: "camp", x: s.camp[0], y: s.camp[1], name: "Destino del personaje" });
  return out;
}
export function counts(s: PanelState | null): Record<LayerKey, number> {
  const c: Record<LayerKey, number> = { monsters: 0, players: 0, loot: 0, route: s?.trail?.length ?? 0, fog: 0 };
  if (!s) return c;
  c.monsters = s.entities?.monsters.length ?? 0;
  c.players = s.entities?.players.length ?? 0;
  c.loot = s.entities?.drops.length ?? 0;
  return c;
}

export type Info = { title: string; kind: Kind | "tile"; lines: string[]; x: number; y: number };
export function describe(e: Ent, s: PanelState): Info {
  const d = cheb(e.x, e.y, s.where.x, s.where.y);
  const lines = [`${KIND_LABEL[e.kind]}${e.extra ? ` · ${e.extra}` : ""}${e.target ? " · objetivo" : ""}`];
  if (e.kind !== "self") lines.push(`${d} tile${d === 1 ? "" : "s"} de distancia`);
  lines.push(`Posición ${e.x}, ${e.y}`);
  return { title: e.name, kind: e.kind, lines, x: e.x, y: e.y };
}
