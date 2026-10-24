import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Compass as CompassIcon,
  Copy,
  Crosshair,
  LocateFixed,
  Map as MapIcon,
  Maximize,
  Minimize,
  Minus,
  Plane,
  Plus,
  RotateCcw,
  RotateCw,
  Trees,
  X,
} from "lucide-react";
import type { PanelState } from "../../panel-protocol";
import { cheb } from "./hud-logic";
import { counts, css, LAYER_META, loadLayers, saveLayers, type Info, type LayerKey, type Layers } from "./radar-model";
import { makeRadar, type RadarApi } from "./radar-engine";
import { Tactical, type TacticalApi } from "./Tactical";
import { Segments } from "./Segments";

type View = "3d" | "2d";
// Alcance en tiles del ancho de la vista 2D para cada preset (el 3D usa su propio encuadre).
const RANGE_TILES: Record<string, number> = { cam: 36, "40": 80, "90": 160, "256": 256 };

function readView(): View {
  try {
    return localStorage.getItem("mubot.radar.view") === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}
const nice = (n: number) => {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100];
  return steps.filter((s) => s <= n).pop() ?? 1;
};
const bearing = (dx: number, dy: number) => {
  const names = ["E", "NE", "N", "NO", "O", "SO", "S", "SE"];
  return names[Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8]!;
};

// Capas que se ofrecen: las que se usan. Zonas, celdas letales y niebla siguen existiendo pero no se listan.
const SHOWN_LAYERS: string[] = ["monsters", "golds", "players", "squad", "loot", "route"];

export function Radar({ state, onRequestWarp }: { state: PanelState | null; onRequestWarp?: () => void }) {
  const host = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    api = useRef<RadarApi | null>(null),
    tac = useRef<TacticalApi>(null),
    latest = useRef(state);
  latest.current = state;
  const [view, setViewState] = useState<View>(readView),
    [range, setRange] = useState("40"),
    [follow, setFollowState] = useState(true),
    [layers, setLayers] = useState<Layers>(loadLayers),
    [showObjects, setShowObjects] = useState(true),
    [legend, setLegend] = useState(false),
    [status, setStatus] = useState("Esperando posición"),
    [error, setError] = useState(false),
    [hover, setHover] = useState<{ i: Info; px: number; py: number } | null>(null),
    [pick, setPick] = useState<{ i: Info; px: number; py: number } | null>(null),
    [needle, setNeedle] = useState(45),
    [tiles, setTiles] = useState(60),
    [fs, setFs] = useState(false),
    [copied, setCopied] = useState(false),
    [fogV, setFogV] = useState(0);
  const discovered = useRef(new Map<number, Uint8Array>());
  const tilesRef = useRef(60);
  const viewRef = useRef(view);
  viewRef.current = view;

  const setView = (v: View) => {
    setViewState(v);
    setPick(null);
    setHover(null);
    try {
      localStorage.setItem("mubot.radar.view", v);
    } catch {
      /* ignorar */
    }
  };
  const setFollow = useCallback((on: boolean) => {
    setFollowState(on);
    api.current?.setFollow(on);
  }, []);

  useEffect(() => {
    try {
      api.current = makeRadar(host.current!, {
        terrain: setStatus,
        hover: (i, px, py) => setHover(i ? { i, px, py } : null),
        pick: (i, px, py) => setPick({ i, px, py }),
        view: (n, t) => {
          setNeedle(n);
          setTiles(t);
        },
        free: () => setFollow(false),
      });
      api.current.setLayers(layers);
      api.current.zoom(range);
      if (latest.current) api.current.update(latest.current);
    } catch {
      setError(true);
    }
    return () => {
      api.current?.dispose();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!state) return;
    api.current?.update(state);
    // Niebla: lo recorrido (un círculo de ~14 tiles alrededor de cada posición).
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
  useEffect(() => {
    api.current?.setLayers(layers);
    saveLayers(layers);
  }, [layers]);
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
    api.current?.zoom(v);
    tac.current?.fit(RANGE_TILES[v] ?? 80);
    if (!follow) setFollow(true);
  };
  const zoom = (f: number) => {
    if (viewRef.current === "3d") api.current?.dolly(f);
    else tac.current?.zoomBy(1 / f);
  };
  const center = useCallback(() => {
    setFollow(true);
    if (viewRef.current === "3d") api.current?.reset();
    else tac.current?.recenter();
  }, [setFollow]);
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen().catch(() => {});
  };

  // Atajos del mapa (no se activan escribiendo en un campo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "m") setView(viewRef.current === "3d" ? "2d" : "3d");
      else if (k === "f") setFollowState((f) => { api.current?.setFollow(!f); return !f; });
      else if (k === "c") center();
      else if (k === "n") api.current?.northUp();
      else if (k === "q") api.current?.rotate(0.26);
      else if (k === "e") api.current?.rotate(-0.26);
      else if (k === "+" || k === "=") zoom(0.8);
      else if (k === "-") zoom(1.25);
      else if (k === "g") setShowObjects((v) => { api.current?.setObjects(!v); return !v; });
      else if (k === "l") setLegend((v) => !v);
      else if (k === "escape") setPick(null);
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <section className="hud-map" aria-label="Mapa del personaje">
      <div className="hud-map-head">
        <div className="hud-map-title">
          <h2>
            <MapIcon size={16} aria-hidden /> {state?.where.mapName ?? "Esperando al personaje"}
          </h2>
          <span className="coordinates" aria-live="off">
            {me ? `${me.x}, ${me.y}` : ""}
          </span>
        </div>
        <div className="hud-map-controls">
          <Segments
            label="Tipo de vista"
            value={view}
            onChange={(v) => setView(v as View)}
            items={[
              { value: "3d", label: "3D", icon: <Box size={13} /> },
              { value: "2d", label: "Táctico", icon: <MapIcon size={13} /> },
            ]}
          />
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
      </div>
      <div className={`hud-stage${fs ? " fs" : ""}`} ref={stage} data-view={view}>
        <div className="hud-pane" hidden={view !== "3d"}>
          <div ref={host} className="three-host" />
        </div>
        <div className="hud-pane" hidden={view !== "2d"}>
          <Tactical
            ref={tac}
            state={state}
            layers={layers}
            discovered={me ? (discovered.current.get(me.map) ?? null) : null}
            fogVersion={fogV}
            active={view === "2d"}
            follow={follow}
            onFollow={setFollow}
            onScale={(t) => viewRef.current === "2d" && Math.abs(t - tilesRef.current) > 0.5 && ((tilesRef.current = t), setTiles(t))}
            onHover={(i, px, py) => setHover(i ? { i, px, py } : null)}
            onPick={(i, px, py) => setPick({ i, px, py })}
          />
        </div>

        {!state && !error && (
          <div className="hud-empty" role="status">
            <span className="hud-spinner" aria-hidden />
            Esperando datos del mundo…
          </div>
        )}
        {error && view === "3d" && (
          <div className="hud-empty">
            <strong>No se pudo iniciar el radar 3D.</strong>
            <small>Activá la aceleración gráfica del navegador y recargá.</small>
            <button className="hud-btn" onClick={() => setView("2d")}>
              Usar la vista táctica
            </button>
          </div>
        )}

        {/* Brújula + escala + posición: siempre visibles */}
        <div className="hud-compass" role="img" aria-label="Brújula: el norte es +y">
          <button className="hud-compass-dial" onClick={() => api.current?.northUp()} title="Norte arriba (N)" aria-label="Poner el norte arriba" disabled={view === "2d"}>
            <i style={{ transform: `rotate(${view === "2d" ? 0 : needle}deg)` }}>
              <b>N</b>
            </i>
          </button>
          <div className="hud-scale" aria-label={`Escala: ${scaleTiles} tiles`}>
            <span style={{ width: Math.max(18, scalePx) }} />
            <small>{scaleTiles} tiles</small>
          </div>
        </div>
        <div className="hud-readout" aria-live="off">
          <span className="hud-live" aria-hidden />
          <span>{status}</span>
        </div>

        <div className="hud-toolbar" role="toolbar" aria-label="Controles del mapa">
          <button className="hud-tool" aria-pressed={follow} onClick={() => setFollow(!follow)} title="Seguir al personaje (F)" aria-label="Seguir al personaje">
            <LocateFixed size={15} />
          </button>
          <button className="hud-tool" onClick={center} title="Centrar en el personaje (C)" aria-label="Centrar">
            <Crosshair size={15} />
          </button>
          <button className="hud-tool" onClick={() => zoom(0.8)} title="Acercar (+)" aria-label="Acercar">
            <Plus size={15} />
          </button>
          <button className="hud-tool" onClick={() => zoom(1.25)} title="Alejar (-)" aria-label="Alejar">
            <Minus size={15} />
          </button>
          {view === "3d" && (
            <>
              <button className="hud-tool" onClick={() => api.current?.rotate(0.26)} title="Girar a la izquierda (Q)" aria-label="Girar a la izquierda">
                <RotateCcw size={15} />
              </button>
              <button className="hud-tool" onClick={() => api.current?.rotate(-0.26)} title="Girar a la derecha (E)" aria-label="Girar a la derecha">
                <RotateCw size={15} />
              </button>
              <button className="hud-tool" onClick={() => api.current?.northUp()} title="Norte arriba (N)" aria-label="Norte arriba">
                <CompassIcon size={15} />
              </button>
              <button
                className="hud-tool"
                aria-pressed={showObjects}
                onClick={() => {
                  setShowObjects(!showObjects);
                  api.current?.setObjects(!showObjects);
                }}
                title="Edificios y árboles del escenario (G)"
                aria-label="Mostrar el escenario"
              >
                <Trees size={15} />
              </button>
            </>
          )}
          {onRequestWarp && (
            <button className="hud-tool" onClick={onRequestWarp} title="Viajar a un spot (pide confirmación)" aria-label="Viajar a un spot">
              <Plane size={15} />
            </button>
          )}
          <button className="hud-tool" onClick={toggleFs} title="Pantalla completa" aria-label={fs ? "Salir de pantalla completa" : "Pantalla completa"}>
            {fs ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>

        {/* Minimapa dentro de la vista 3D: un clic lo agranda */}
        {view === "3d" && state && (
          <button className="hud-mini" onClick={() => setView("2d")} aria-label="Abrir el mapa táctico" title="Mapa táctico (M)">
            <Tactical
              state={state}
              layers={layers}
              discovered={me ? (discovered.current.get(me.map) ?? null) : null}
              fogVersion={fogV}
              active={view === "3d"}
              mini
              follow
              onFollow={() => {}}
            />
          </button>
        )}

        {view === "3d" && range === "cam" && state && <div className="hud-doing">{state.doing}</div>}

        {hover && !pick && (
          <div className="hud-tip" style={clampPos(hover, 200, 90)} role="tooltip">
            <strong>{hover.i.title}</strong>
            {hover.i.lines.map((l, i) => (
              <small key={i}>{l}</small>
            ))}
            {me && hover.i.kind !== "self" && hover.i.kind !== "tile" && <small>{cheb(hover.i.x, hover.i.y, me.x, me.y)} tiles de vos</small>}
          </div>
        )}
        {pick && me && (
          <div className="hud-pick" style={clampPos(pick, 230, 170)} role="dialog" aria-label="Detalle del punto">
            <button className="hud-x" onClick={() => setPick(null)} aria-label="Cerrar">
              <X size={13} />
            </button>
            <strong>{pick.i.title}</strong>
            <div className="hud-pick-coords">
              <span className="coordinates">
                {pick.i.x}, {pick.i.y}
              </span>
              <small>
                {cheb(pick.i.x, pick.i.y, me.x, me.y)} tiles al {bearing(pick.i.x - me.x, pick.i.y - me.y)}
              </small>
            </div>
            {pick.i.lines.map((l, i) => (
              <small key={i}>{l}</small>
            ))}
            <div className="hud-pick-actions">
              <button
                className="hud-btn"
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
              </button>
              <button
                className="hud-btn"
                onClick={() => {
                  if (viewRef.current === "3d") {
                    api.current?.centerOn(pick.i.x, pick.i.y);
                    setFollow(false);
                  } else tac.current?.centerOn(pick.i.x, pick.i.y);
                  setPick(null);
                }}
              >
                <Crosshair size={12} /> Centrar acá
              </button>
              {onRequestWarp && (
                <button
                  className="hud-btn warn"
                  onClick={() => {
                    setPick(null);
                    onRequestWarp();
                  }}
                  title="El bot viaja a spots fijos, no a coordenadas: se elige el spot y se confirma"
                >
                  <Plane size={12} /> Viajar…
                </button>
              )}
            </div>
          </div>
        )}

        <div className={`hud-legend${legend ? "" : " collapsed"}`} role="group" aria-label="Capas del mapa">
          <button className="hud-legend-toggle" onClick={() => setLegend(!legend)} aria-expanded={legend} title="Capas (L)">
            Capas
          </button>
          {legend &&
            LAYER_META.filter((l) => SHOWN_LAYERS.includes(l.key)).map((l) => (
              <button key={l.key} className="hud-chip" aria-pressed={layers[l.key]} onClick={() => toggle(l.key)} title={l.hint}>
                <i style={{ background: css(l.color) }} />
                {l.label}
                {l.key !== "fog" && <b>{n[l.key]}</b>}
              </button>
            ))}
        </div>
      </div>
    </section>
  );
}
