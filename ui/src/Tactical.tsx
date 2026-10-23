import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { PanelState } from "../../panel-protocol";
import { cheb, tileKind, TILE_LABEL } from "./hud-logic";
import { getTerrain } from "./map-assets";
import { KIND_COLOR, css, describe, entities, type Ent, type Info, type Layers } from "./radar-model";

export type TacticalApi = {
  zoomBy: (f: number) => void;
  fit: (tiles: number) => void;
  recenter: () => void;
  centerOn: (x: number, y: number) => void;
};
type Props = {
  state: PanelState | null;
  layers: Layers;
  /** celdas ya recorridas del mapa actual (256×256, 1 = vista) y un contador que sube al cambiar */
  discovered: Uint8Array | null;
  fogVersion: number;
  active: boolean;
  mini?: boolean;
  follow: boolean;
  onFollow: (on: boolean) => void;
  onHover?: (i: Info | null, px: number, py: number) => void;
  onPick?: (i: Info, px: number, py: number) => void;
  onScale?: (tilesAcross: number) => void;
};

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const TILE_COLOR: Record<ReturnType<typeof tileKind>, [number, number, number]> = {
  walk: [27, 38, 45], blocked: [58, 71, 79], safe: [30, 66, 58], water: [28, 72, 94],
};

/** Mapa táctico 2D (arriba = +y, como el radar): terreno por atributos, niebla, capas y marcadores. */
export const Tactical = forwardRef<TacticalApi, Props>(function Tactical(props, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const P = useRef(props);
  P.current = props;
  const cam = useRef({ x: 128, y: 128, k: 4, kt: 4, free: false });
  const world = useRef<{ map: number; img: HTMLCanvasElement | null; fog: HTMLCanvasElement | null; fogV: number; terrain: Uint8Array | null }>({ map: -1, img: null, fog: null, fogV: -1, terrain: null });
  const shown = useRef(new Map<string, { x: number; y: number }>());
  const drawn = useRef<{ e: Ent; sx: number; sy: number }[]>([]);
  const dirty = useRef(true);
  const heading = useRef<{ x: number; y: number; a: number | null }>({ x: 0, y: 0, a: null });
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; cx: number; cy: number } | null>(null);
  const size = useRef({ w: 1, h: 1, dpr: 1 });

  const api: TacticalApi = {
    zoomBy: (f) => {
      cam.current.kt = Math.max(minK(), Math.min(40, cam.current.kt * f));
      dirty.current = true;
    },
    fit: (tiles) => {
      cam.current.kt = Math.max(minK(), Math.min(40, Math.min(size.current.w, size.current.h) / tiles));
      dirty.current = true;
    },
    recenter: () => {
      cam.current.free = false;
      P.current.onFollow(true);
      dirty.current = true;
    },
    centerOn: (x, y) => {
      cam.current.free = true;
      cam.current.x = x;
      cam.current.y = y;
      P.current.onFollow(false);
      dirty.current = true;
    },
  };
  useImperativeHandle(ref, () => api);
  const minK = () => Math.max(1.2, Math.min(size.current.w, size.current.h) / 256);

  // Terreno del mapa actual: se baja una vez (getTerrain lo comparte con el radar 3D) y se hornea a una imagen 256×256.
  const map = props.state?.where.map ?? -1;
  useEffect(() => {
    if (map < 0) return;
    const ctl = new AbortController();
    const w = world.current;
    w.map = map;
    w.img = null;
    w.terrain = null;
    w.fogV = -1;
    dirty.current = true;
    getTerrain(map, ctl.signal)
      .then((t) => {
        if (ctl.signal.aborted || !t) return;
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const cx = c.getContext("2d")!;
        const img = cx.createImageData(256, 256);
        for (let i = 0; i < 65536; i++) {
          const col = TILE_COLOR[tileKind(t[i]!)];
          img.data[i * 4] = col[0];
          img.data[i * 4 + 1] = col[1];
          img.data[i * 4 + 2] = col[2];
          img.data[i * 4 + 3] = 255;
        }
        cx.putImageData(img, 0, 0);
        w.img = c;
        w.terrain = t;
        dirty.current = true;
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [map]);

  useEffect(() => {
    dirty.current = true;
  }, [props.state, props.layers, props.fogVersion, props.active, props.follow]);

  useEffect(() => {
    const el = canvas.current!;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      size.current = { w, h, dpr };
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      dirty.current = true;
    });
    ro.observe(el);
    let raf = 0, last = 0, lastDrawT = 0, firstFit = true;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const p = P.current;
      if (!p.active || document.hidden) return;
      const s = p.state;
      const dt = Math.min(200, t - last || 16);
      last = t;
      const c = cam.current, snap = reduced();
      if (firstFit && s && size.current.w > 1) {
        c.kt = c.k = Math.min(size.current.w, size.current.h) / (p.mini ? 56 : 80);
        c.x = s.where.x + 0.5;
        c.y = s.where.y + 0.5;
        firstFit = false;
      }
      // Entidades: se deslizan hacia su posición (el estado llega una vez por segundo).
      let moving = false;
      const kk = snap ? 1 : 1 - Math.exp(-dt / 280);
      if (s) {
        const ents = entities(s, p.layers);
        const alive = new Set<string>();
        for (const e of ents) {
          alive.add(e.key);
          const cur = shown.current.get(e.key);
          if (!cur) shown.current.set(e.key, { x: e.x, y: e.y });
          else {
            const dx = e.x - cur.x, dy = e.y - cur.y;
            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
              moving = true;
              cur.x += dx * kk;
              cur.y += dy * kk;
            }
          }
        }
        for (const k of shown.current.keys()) if (!alive.has(k)) shown.current.delete(k);
        const me = shown.current.get("self");
        if (me && (heading.current.x !== s.where.x || heading.current.y !== s.where.y)) {
          const dx = s.where.x - heading.current.x, dy = s.where.y - heading.current.y;
          if (heading.current.x && (dx || dy) && Math.abs(dx) + Math.abs(dy) < 10) heading.current.a = Math.atan2(dy, dx);
          heading.current.x = s.where.x;
          heading.current.y = s.where.y;
        }
        if (p.follow && !c.free && me) {
          const tx = me.x + 0.5, ty = me.y + 0.5;
          if (Math.abs(tx - c.x) > 0.005 || Math.abs(ty - c.y) > 0.005) {
            c.x += (tx - c.x) * (snap ? 1 : 1 - Math.exp(-dt / 220));
            c.y += (ty - c.y) * (snap ? 1 : 1 - Math.exp(-dt / 220));
            moving = true;
          }
        }
      }
      if (Math.abs(c.kt - c.k) > 0.002) {
        c.k += (c.kt - c.k) * (snap ? 1 : 1 - Math.exp(-dt / 140));
        moving = true;
      }
      // Con objetivo pulsando se redibuja siempre (a ~20 fps); si no, solo cuando algo cambió.
      const pulse = !snap && !!s?.entities?.monsters.some((m) => m.target);
      if (!dirty.current && !moving && !(pulse && t - lastDrawT > 50)) return;
      lastDrawT = t;
      dirty.current = false;
      draw(t);
    };
    const draw = (t: number) => {
      const p = P.current, s = p.state;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const { w, h, dpr } = size.current;
      const c = cam.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0c1013";
      ctx.fillRect(0, 0, w, h);
      if (!s) return;
      const W = world.current;
      const sx = (x: number) => w / 2 + (x - c.x) * c.k;
      const sy = (y: number) => h / 2 - (y - c.y) * c.k;
      // Terreno (y invertido: arriba = +y).
      ctx.imageSmoothingEnabled = c.k < 3;
      if (W.img) {
        ctx.setTransform(dpr * c.k, 0, 0, -dpr * c.k, dpr * (w / 2 - c.x * c.k), dpr * (h / 2 + c.y * c.k));
        ctx.drawImage(W.img, 0, 0, 256, 256);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Niebla: lo no recorrido, atenuado.
      if (p.layers.fog && p.discovered && W.img) {
        if (W.fogV !== p.fogVersion || !W.fog) {
          const f = W.fog ?? document.createElement("canvas");
          f.width = f.height = 256;
          const fx = f.getContext("2d")!;
          const im = fx.createImageData(256, 256);
          for (let i = 0; i < 65536; i++) if (!p.discovered[i]) {
            im.data[i * 4] = 7; im.data[i * 4 + 1] = 10; im.data[i * 4 + 2] = 12; im.data[i * 4 + 3] = 150;
          }
          fx.putImageData(im, 0, 0);
          W.fog = f;
          W.fogV = p.fogVersion;
        }
        ctx.setTransform(dpr * c.k, 0, 0, -dpr * c.k, dpr * (w / 2 - c.x * c.k), dpr * (h / 2 + c.y * c.k));
        ctx.drawImage(W.fog, 0, 0, 256, 256);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // Cuadrícula cada 16 tiles (más fina al acercar), con números en el borde.
      const step = c.k > 8 ? 8 : 16;
      ctx.strokeStyle = "rgba(160,190,200,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.floor((c.x - w / 2 / c.k) / step) * step, x1 = c.x + w / 2 / c.k;
      const y0 = Math.floor((c.y - h / 2 / c.k) / step) * step, y1 = c.y + h / 2 / c.k;
      for (let x = x0; x <= x1; x += step) { ctx.moveTo(Math.round(sx(x)) + 0.5, 0); ctx.lineTo(Math.round(sx(x)) + 0.5, h); }
      for (let y = y0; y <= y1; y += step) { ctx.moveTo(0, Math.round(sy(y)) + 0.5); ctx.lineTo(w, Math.round(sy(y)) + 0.5); }
      ctx.stroke();
      if (!p.mini && c.k > 2.4) {
        ctx.fillStyle = "rgba(180,200,208,0.38)";
        ctx.font = "10px 'Geist Mono', monospace";
        for (let x = x0; x <= x1; x += step * 2) if (x >= 0 && x < 256) ctx.fillText(String(x), sx(x) + 3, h - 5);
        for (let y = y0; y <= y1; y += step * 2) if (y >= 0 && y < 256) ctx.fillText(String(y), 4, sy(y) - 3);
      }
      const L = p.layers;
      // Zonas de dorados y celdas letales.
      if (L.zones)
        for (const z of s.zones ?? []) {
          const r = 6 * c.k, cx = sx(z.x + 0.5), cy = sy(z.y + 0.5);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, "rgba(255,211,97,0.28)");
          g.addColorStop(1, "rgba(255,211,97,0.05)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
          ctx.strokeStyle = "rgba(255,211,97,0.55)"; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
          if (!p.mini && c.k > 2) { ctx.fillStyle = "#ffd361"; ctx.font = "600 10px Geist, sans-serif"; ctx.fillText(`Dragones ×${z.n}`, cx - 28, cy + 3); }
        }
      if (L.hazards)
        for (const z of s.hazards ?? []) {
          const r = Math.max(3, (1.5 + Math.min(z.n, 6) * 0.6) * c.k), cx = sx(z.x + 0.5), cy = sy(z.y + 0.5);
          ctx.fillStyle = "rgba(255,77,77,0.22)";
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
          ctx.strokeStyle = "rgba(255,77,77,0.8)"; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(cx - 4, cy - 4); ctx.lineTo(cx + 4, cy + 4); ctx.moveTo(cx + 4, cy - 4); ctx.lineTo(cx - 4, cy + 4); ctx.stroke();
          ctx.lineWidth = 1;
        }
      // Ruta.
      if (L.route && s.trail && s.trail.length > 1) {
        ctx.strokeStyle = "rgba(228,195,138,0.7)"; ctx.lineWidth = 1.6;
        ctx.beginPath();
        s.trail.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x + 0.5), sy(y + 0.5)) : ctx.moveTo(sx(x + 0.5), sy(y + 0.5))));
        ctx.stroke(); ctx.lineWidth = 1;
      }
      // Entidades, de atrás para adelante.
      const order: Record<string, number> = { dropdim: 0, drop: 1, camp: 1, monster: 2, player: 3, squad: 3, mate: 3, gold: 4, dragon: 5, red: 5, self: 6 };
      const list = entities(s, L).sort((a, b) => order[a.kind]! - order[b.kind]!);
      drawn.current = [];
      for (const e of list) {
        const pos = shown.current.get(e.key) ?? e;
        const px = sx(pos.x + 0.5), py = sy(pos.y + 0.5);
        if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
        drawn.current.push({ e: { ...e, x: e.x, y: e.y }, sx: px, sy: py });
        marker(ctx, e, px, py, c.k, p.mini ?? false, t, heading.current.a);
      }
      // Escala del mapa visible (tiles de ancho) hacia afuera, para la regla.
      p.onScale?.(w / c.k);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // Interacción: arrastrar = mover (suelta el seguimiento), rueda = zoom, clic = coordenadas.
  const toWorld = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const c = cam.current;
    return { px, py, x: Math.floor(c.x + (px - r.width / 2) / c.k), y: Math.floor(c.y - (py - r.height / 2) / c.k) };
  };
  const nearest = (px: number, py: number) => {
    let best: (typeof drawn.current)[number] | null = null, bd = 144;
    for (const d of drawn.current) {
      const dd = (d.sx - px) ** 2 + (d.sy - py) ** 2;
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  };
  const tileInfo = (x: number, y: number): Info => {
    const v = world.current.terrain?.[y * 256 + x];
    return { title: `Tile ${x}, ${y}`, kind: "tile", x, y, lines: [v == null ? "Terreno sin datos" : TILE_LABEL[tileKind(v)]] };
  };
  return (
    <canvas
      ref={canvas}
      className={`hud-tactical${props.mini ? " mini" : ""}`}
      tabIndex={props.mini ? -1 : 0}
      role="img"
      aria-label="Mapa táctico 2D. Arrastrá para mover, rueda para zoom, clic para ver coordenadas. Flechas mueven, más y menos acercan, Home vuelve al personaje."
      onPointerDown={(e) => {
        if (props.mini) return;
        (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, cx: cam.current.x, cy: cam.current.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && e.pointerId === d.id) {
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) > 4) {
            d.moved = true;
            cam.current.free = true;
            props.onFollow(false);
            props.onHover?.(null, 0, 0);
          }
          if (d.moved) {
            cam.current.x = d.cx - dx / cam.current.k;
            cam.current.y = d.cy + dy / cam.current.k;
            dirty.current = true;
          }
          return;
        }
        if (props.mini || !props.state) return;
        const w = toWorld(e);
        const n = nearest(w.px, w.py);
        props.onHover?.(n ? describe(n.e, props.state) : w.x >= 0 && w.y >= 0 && w.x < 256 && w.y < 256 ? tileInfo(w.x, w.y) : null, w.px, w.py);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved || !props.state) return;
        const w = toWorld(e);
        if (w.x < 0 || w.y < 0 || w.x > 255 || w.y > 255) return;
        const n = nearest(w.px, w.py);
        const base = n ? describe(n.e, props.state) : tileInfo(w.x, w.y);
        const dist = cheb(w.x, w.y, props.state.where.x, props.state.where.y);
        props.onPick?.(n ? base : { ...base, lines: [...base.lines, `${dist} tiles de vos`] }, w.px, w.py);
      }}
      onPointerLeave={() => props.onHover?.(null, 0, 0)}
      onWheel={(e) => {
        if (props.mini) return;
        e.preventDefault();
        api.zoomBy(Math.exp(-e.deltaY * 0.0016));
      }}
      onKeyDown={(e) => {
        const c = cam.current, step = 8 / c.k * 4;
        const mv = (dx: number, dy: number) => {
          c.free = true; c.x += dx; c.y += dy; props.onFollow(false); dirty.current = true; e.preventDefault();
        };
        if (e.key === "ArrowLeft") mv(-step, 0);
        else if (e.key === "ArrowRight") mv(step, 0);
        else if (e.key === "ArrowUp") mv(0, step);
        else if (e.key === "ArrowDown") mv(0, -step);
        else if (e.key === "+" || e.key === "=") { api.zoomBy(1.25); e.preventDefault(); }
        else if (e.key === "-") { api.zoomBy(0.8); e.preventDefault(); }
        else if (e.key === "Home") { api.recenter(); e.preventDefault(); }
      }}
    />
  );
});

function marker(ctx: CanvasRenderingContext2D, e: Ent, x: number, y: number, k: number, mini: boolean, t: number, heading: number | null) {
  const col = css(KIND_COLOR[e.kind]);
  const base = mini ? 2 : Math.max(2.4, Math.min(5, k * 0.5));
  ctx.lineWidth = 1;
  switch (e.kind) {
    case "self": {
      const r = (mini ? 4 : 6.5);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#0b0f12"; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (heading != null) {
        const a = -heading; // eje y de pantalla invertido
        ctx.moveTo(x + Math.cos(a) * r * 1.3, y + Math.sin(a) * r * 1.3);
        ctx.lineTo(x + Math.cos(a + 2.5) * r, y + Math.sin(a + 2.5) * r);
        ctx.lineTo(x + Math.cos(a - 2.5) * r, y + Math.sin(a - 2.5) * r);
        ctx.closePath();
      } else ctx.arc(x, y, r * 0.8, 0, 7);
      ctx.fill(); ctx.stroke();
      break;
    }
    case "monster":
      ctx.fillStyle = col; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(x, y, base * 0.8, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      break;
    case "gold": case "dragon": case "red": {
      const r = (e.kind === "gold" ? 5.5 : 8) * (mini ? 0.7 : 1);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6);
      g.addColorStop(0, col + "88"); g.addColorStop(1, col + "00");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 7); ctx.fill();
      ctx.fillStyle = col; ctx.strokeStyle = "#0b0f12"; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4 - Math.PI / 2, rr = i % 2 ? r * 0.5 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if (!mini && k > 1.6) { ctx.fillStyle = col; ctx.font = "600 10px Geist, sans-serif"; ctx.textAlign = "center"; ctx.fillText(e.name, x, y - r - 5); ctx.textAlign = "left"; }
      break;
    }
    case "player": case "mate": case "squad": {
      ctx.fillStyle = col; ctx.strokeStyle = "#0b0f12"; ctx.lineWidth = 1.2;
      const r = base * 1.15;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (!mini && k > 2.2) { ctx.fillStyle = col; ctx.font = "500 10px Geist, sans-serif"; ctx.textAlign = "center"; ctx.fillText(e.name, x, y - r - 4); ctx.textAlign = "left"; }
      break;
    }
    case "drop": {
      const r = base * 1.2 + 1;
      ctx.fillStyle = col; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.strokeRect(x - r, y - r, r * 2, r * 2);
      if (!mini && k > 2) { ctx.fillStyle = "#e1d1ff"; ctx.font = "500 10px Geist, sans-serif"; ctx.textAlign = "center"; ctx.fillText(e.name, x, y - r - 4); ctx.textAlign = "left"; }
      break;
    }
    case "dropdim":
      ctx.fillStyle = col; ctx.globalAlpha = 0.8; ctx.fillRect(x - 1.5, y - 1.5, 3, 3); ctx.globalAlpha = 1;
      break;
    case "camp": {
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
      break;
    }
  }
  if (e.target) {
    const pulse = reduced() ? 1 : 1 + 0.22 * Math.sin(t / 150);
    ctx.strokeStyle = "#ff6b7d"; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(x, y, (e.kind === "monster" ? 7 : 12) * pulse, 0, 7); ctx.stroke();
  }
  ctx.lineWidth = 1;
}
