import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Crosshair, LocateFixed, Map as MapIcon, Maximize, Minimize, Minus, Plus, X } from "lucide-react";
import type { PanelState } from "@mubot/protocol";
import { cheb } from "./hud-logic";
import { counts, css, LAYER_META, loadLayers, saveLayers, type Info, type LayerKey, type Layers } from "./radar-model";
import { Tactical, type TacticalApi } from "./Tactical";
import { Segments } from "./Segments";
import { Button, cn } from "./components";

/**
 * El mapa táctico (2D) del bot: terreno, monstruos (los de valor resaltados), jugadores, loot, el spot donde farmea, su rastro,
 * la línea a su objetivo y el camino que recorrió (niebla: lo ya visto).
 */
// Alcance en tiles del ancho de la vista para cada preset.
const RANGE_TILES: Record<string, number> = { cam: 36, "40": 80, "90": 160, "256": 256 };
// Capas que se ofrecen (las celdas letales ya no las informa nadie).
const SHOWN_LAYERS: LayerKey[] = ["monsters", "players", "loot", "route", "fog"];

const nice = (n: number) => [1, 2, 5, 10, 20, 25, 50, 100].filter((s) => s <= n).pop() ?? 1;
const bearing = (dx: number, dy: number) => {
  const names = ["E", "NE", "N", "NO", "O", "SO", "S", "SE"];
  return names[Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8]!;
};

export function Radar({ state }: { state: PanelState | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const tac = useRef<TacticalApi>(null);
  const [range, setRange] = useState("40");
  const [follow, setFollow] = useState(true);
  const [layers, setLayers] = useState<Layers>(loadLayers);
  const [legend, setLegend] = useState(false);
  const [hover, setHover] = useState<{ i: Info; px: number; py: number } | null>(null);
  const [pick, setPick] = useState<{ i: Info; px: number; py: number } | null>(null);
  const [tiles, setTiles] = useState(60);
  const [fs, setFs] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fogV, setFogV] = useState(0);
  const discovered = useRef(new Map<number, Uint8Array>());
  const tilesRef = useRef(60);

  // Niebla: lo recorrido (un círculo de ~14 tiles alrededor de cada posición).
  useEffect(() => {
    if (!state) return;
    let grid = discovered.current.get(state.where.map);
    if (!grid) discovered.current.set(state.where.map, (grid = new Uint8Array(65536)));
    let changed = false;
    const mark = (cx: number, cy: number, r: number) => {
      for (let y = Math.max(0, cy - r); y <= Math.min(255, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(255, cx + r); x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && !grid![y * 256 + x]) {
            grid![y * 256 + x] = 1;
            changed = true;
          }
    };
    mark(state.where.x, state.where.y, 14);
    for (const [x, y] of state.trail ?? []) mark(x, y, 8);
    if (changed) setFogV((v) => v + 1);
  }, [state]);
  useEffect(() => saveLayers(layers), [layers]);
  useEffect(() => {
    const on = () => setFs(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  // Al cambiar de mapa se cierra lo que apuntaba al anterior.
  const mapId = state?.where.map;
  useEffect(() => {
    setPick(null);
    setHover(null);
  }, [mapId]);

  const applyRange = (v: string) => {
    setRange(v);
    tac.current?.fit(RANGE_TILES[v] ?? 80);
    setFollow(true);
  };
  const zoom = (f: number) => tac.current?.zoomBy(1 / f);
  const center = useCallback(() => {
    setFollow(true);
    tac.current?.recenter();
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen().catch(() => {});
  };

  // Atajos del mapa (no se activan escribiendo en un campo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") setFollow((f) => !f);
      else if (k === "c") center();
      else if (k === "+" || k === "=") zoom(0.8);
      else if (k === "-") zoom(1.25);
      else if (k === "l") setLegend((v) => !v);
      else if (k === "escape") setPick(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [center]);

  const n = useMemo(() => counts(state), [state]);
  const toggle = (k: LayerKey) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const me = state?.where;
  const stageW = stage.current?.clientWidth ?? 600;
  const scaleTiles = nice(Math.max(1, tiles / 5));
  const scalePx = Math.round((scaleTiles / Math.max(1, tiles)) * stageW);
  const clampPos = (p: { px: number; py: number }, w: number, h: number) => ({
    left: Math.max(8, Math.min(stageW - w - 8, p.px + 12)),
    top: Math.max(8, Math.min((stage.current?.clientHeight ?? 400) - h - 8, p.py + 12)),
  });

  const tool = "grid size-8 place-items-center rounded-md border-0 bg-transparent text-ink/80 hover:bg-white/10 hover:text-white aria-pressed:bg-accent/25 aria-pressed:text-accent";
  const card = "absolute z-[6] grid gap-0.5 rounded-lg border border-strong bg-raised/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm";
  return (
    <section className="flex h-full flex-col" aria-label="Mapa del personaje">
      <div className="flex flex-wrap items-center justify-between gap-2.5 px-3 py-2">
        <div className="flex items-baseline gap-2.5">
          <h2 className="flex items-center gap-1.5 text-lg font-semibold">
            <MapIcon size={16} aria-hidden className="text-accent" /> {state?.char.name ? <strong>{state.char.name}</strong> : null}
            {state?.char.name ? " · " : ""}
            {state?.where.mapName ?? "Esperando al personaje"}
          </h2>
          <span className="font-mono text-sm text-muted" aria-live="off">
            {me ? `${me.x}, ${me.y}` : ""}
          </span>
        </div>
        <Segments
          label="Alcance del mapa"
          value={range}
          onChange={applyRange}
          items={[
            { value: "cam", label: "Cámara" },
            { value: "40", label: "Cerca" },
            { value: "90", label: "Zona" },
            { value: "256", label: "Mapa" },
          ]}
        />
      </div>
      <div className="relative isolate min-h-0 flex-1 overflow-hidden bg-[#0c1013]" ref={stage} data-view="2d">
        <div className="absolute inset-0 z-0 isolate">
          <Tactical
            ref={tac}
            state={state}
            layers={layers}
            discovered={me ? (discovered.current.get(me.map) ?? null) : null}
            fogVersion={fogV}
            active
            follow={follow}
            onFollow={setFollow}
            onScale={(t) => Math.abs(t - tilesRef.current) > 0.5 && ((tilesRef.current = t), setTiles(t))}
            onHover={(i, px, py) => setHover(i ? { i, px, py } : null)}
            onPick={(i, px, py) => setPick({ i, px, py })}
          />
        </div>

        {!state && (
          <div className="absolute inset-0 z-[5] grid place-content-center justify-items-center gap-2 bg-[#0c1013]/80 text-center text-muted" role="status">
            <span className="size-5 animate-spin rounded-full border-2 border-strong border-t-accent" aria-hidden />
            Esperando datos del mundo…
          </div>
        )}

        <div className="pointer-events-none absolute top-2.5 left-2.5 z-[3] grid gap-0.5 text-2xs text-white/80 [text-shadow:0_1px_2px_#000]" role="img" aria-label={`Escala: ${scaleTiles} tiles`}>
          <span className="block h-[5px] border-[1.5px] border-t-0 border-white/90" style={{ width: Math.max(18, scalePx) }} />
          <small className="text-2xs text-white/80">{scaleTiles} tiles</small>
        </div>

        <div className="absolute top-2.5 right-2.5 z-[4] grid gap-1 rounded-xl border border-strong bg-paper/80 p-1 backdrop-blur-sm" role="toolbar" aria-label="Controles del mapa">
          <button className={tool} aria-pressed={follow} onClick={() => setFollow(!follow)} title="Seguir al personaje (F)" aria-label="Seguir al personaje">
            <LocateFixed size={15} />
          </button>
          <button className={tool} onClick={center} title="Centrar en el personaje (C)" aria-label="Centrar">
            <Crosshair size={15} />
          </button>
          <button className={tool} onClick={() => zoom(0.8)} title="Acercar (+)" aria-label="Acercar">
            <Plus size={15} />
          </button>
          <button className={tool} onClick={() => zoom(1.25)} title="Alejar (-)" aria-label="Alejar">
            <Minus size={15} />
          </button>
          <button className={tool} onClick={toggleFs} title="Pantalla completa" aria-label={fs ? "Salir de pantalla completa" : "Pantalla completa"}>
            {fs ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>

        {hover && !pick && (
          <div className={`${card} pointer-events-none max-w-60`} style={clampPos(hover, 200, 90)} role="tooltip">
            <strong className="pr-4 text-sm">{hover.i.title}</strong>
            {hover.i.lines.map((l, i) => (
              <small key={i}>{l}</small>
            ))}
            {me && hover.i.kind !== "self" && hover.i.kind !== "tile" && <small>{cheb(hover.i.x, hover.i.y, me.x, me.y)} tiles de vos</small>}
          </div>
        )}
        {pick && me && (
          <div className={`${card} max-w-60 gap-1 p-3`} style={clampPos(pick, 230, 150)} role="dialog" aria-label="Detalle del punto">
            <button className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-sm border-0 bg-transparent text-muted hover:bg-hover hover:text-ink" onClick={() => setPick(null)} aria-label="Cerrar">
              <X size={13} />
            </button>
            <strong className="pr-4 text-sm">{pick.i.title}</strong>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xl text-accent">
                {pick.i.x}, {pick.i.y}
              </span>
              <small>
                {cheb(pick.i.x, pick.i.y, me.x, me.y)} tiles al {bearing(pick.i.x - me.x, pick.i.y - me.y)}
              </small>
            </div>
            {pick.i.lines.map((l, i) => (
              <small key={i}>{l}</small>
            ))}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Button
                onClick={() => {
                  try {
                    void navigator.clipboard.writeText(`${pick.i.x}, ${pick.i.y}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  } catch {
                    /* sin portapapeles */
                  }
                }}
              >
                <Copy size={12} /> {copied ? "Copiado" : "Copiar"}
              </Button>
              <Button
                onClick={() => {
                  tac.current?.centerOn(pick.i.x, pick.i.y);
                  setPick(null);
                }}
              >
                <Crosshair size={12} /> Centrar acá
              </Button>
            </div>
          </div>
        )}

        <div className={cn("absolute inset-x-0 bottom-0 z-[3] flex flex-wrap items-center gap-1.5 bg-gradient-to-t from-[#0c1013]/90 to-transparent px-2.5 py-2", !legend && "pointer-events-none")} role="group" aria-label="Capas del mapa">
          <button className="pointer-events-auto h-7 shrink-0 rounded-full border border-strong bg-paper/85 px-2.5 text-xs text-muted" onClick={() => setLegend(!legend)} aria-expanded={legend} title="Capas (L)">
            Capas
          </button>
          {legend &&
            LAYER_META.filter((l) => SHOWN_LAYERS.includes(l.key)).map((l) => (
              <button
                key={l.key}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-strong bg-paper/85 px-2.5 text-xs text-muted aria-pressed:text-ink not-aria-pressed:opacity-50"
                aria-pressed={layers[l.key]}
                onClick={() => toggle(l.key)}
                title={l.hint}
              >
                <i className="size-2 rounded-full" style={{ background: css(l.color) }} />
                {l.label}
                {l.key !== "fog" && <b className="font-mono font-medium text-faint">{n[l.key]}</b>}
              </button>
            ))}
        </div>
      </div>
    </section>
  );
}
