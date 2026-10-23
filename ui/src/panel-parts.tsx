import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Switch } from "@base-ui/react/switch";
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  ChevronDown,
  CircleAlert,
  Clock,
  Crosshair,
  Flag,
  Gem,
  Info as InfoIcon,
  Pause,
  Play,
  Plane,
  Route,
  Send,
  Skull,
  Sparkles,
  Swords,
  Terminal,
  TrendingUp,
  Trophy,
  Zap,
} from "lucide-react";
import type { EquippedItem, PanelCommand, PanelState } from "../../panel-protocol";
import { Action, Badge, Choice, fmt, compact } from "./components";
import {
  KIND_LABEL,
  TIER_LABEL,
  arrow,
  bagUsage,
  bagValue,
  cheb,
  humanize,
  isDragon,
  itemTier,
  itemTitle,
  levelProgress,
  sparkPoints,
  type Alert,
  type Decision,
  type FeedItem,
  type Tier,
} from "./hud-logic";
import type { Chat, Log, Sample } from "./useBot";
import knight from "../../assets/ui/knight-alpha.webp";

export const clock = (t: number) => new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
export const countdown = (t: number, now: number) => {
  const sec = Math.max(0, Math.round((t - now) / 1000));
  const h = Math.floor(sec / 3600);
  return `${h ? h + ":" : ""}${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};
const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.floor(s / 60)} min` : `hace ${Math.floor(s / 3600)} h`;
};

export const classes: Record<number, string> = {
  0: "Dark Wizard", 1: "Soul Master", 2: "Soul Master", 4: "Dark Knight", 5: "Blade Knight", 6: "Blade Knight",
  8: "Fairy Elf", 9: "Muse Elf", 10: "Muse Elf", 12: "Magic Gladiator", 16: "Dark Lord",
};

// ---- Bloques base ----------------------------------------------------------------------------------
/** Tarjeta con título y, opcionalmente, un pliegue: lo más importante arriba, el detalle al expandir. */
export function Card({
  title,
  icon,
  extra,
  children,
  className = "",
  fold,
  foldLabel = "Ver más",
}: {
  title: string;
  icon?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  fold?: ReactNode;
  foldLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`hud-card ${className}`}>
      <header>
        <h3>
          {icon}
          {title}
        </h3>
        {extra}
      </header>
      {children}
      {fold && (
        <>
          <button className="hud-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Ver menos" : foldLabel}
            <ChevronDown size={13} className={open ? "up" : ""} />
          </button>
          {open && <div className="hud-foldbody">{fold}</div>}
        </>
      )}
    </section>
  );
}
export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="hud-emptycopy">
      {icon}
      {children}
    </p>
  );
}
function Bar({ label, value, max, tone, hint }: { label: string; value: number; max: number; tone: "hp" | "mp" | "xp"; hint?: ReactNode }) {
  const p = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`hud-bar ${tone}${tone === "hp" && p < 30 ? " low" : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)}>
      <div className="hud-bar-top">
        <span>{label}</span>
        <b>{hint ?? `${fmt(Math.round(value))} / ${fmt(max)}`}</b>
      </div>
      <div className="hud-bar-track">
        <i style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

// ---- Cabecera ----------------------------------------------------------------------------------------
const MODE_HINT: Record<string, string> = {
  farm: "farmeando", hunt: "cazando dorados", paused: "en pausa", resetting: "reseteando", connecting: "conectando", dead: "muerto",
};
export function Header({ s, online, label, eta }: { s: PanelState | null; online: boolean; label?: string; eta: number | null }) {
  const cls = s ? (classes[s.char.classId ?? -1] ?? s.char.cls ?? "Personaje") : "";
  const hpLow = !!s && s.char.hp[1] > 0 && s.char.hp[0] / s.char.hp[1] < 0.3;
  return (
    <header className={`hud-header${s ? "" : " loading"}${online ? "" : " offline"}`}>
      <img className="hud-art" src={knight} alt="" />
      <div className="hud-id">
        <div className="hud-id-line">
          <h1>{s?.char.name ?? "Conectando…"}</h1>
          <Badge state={online ? (s?.mode ?? "connecting") : "off"}>{online ? undefined : label}</Badge>
        </div>
        <p>
          {s ? (
            <>
              <span>{cls}</span>
              <i aria-hidden>·</i>
              <span>
                Nivel <b>{fmt(s.char.level)}</b>
              </span>
              <i aria-hidden>·</i>
              <span>
                <b>{fmt(s.char.resets)}</b> resets
              </span>
              <i aria-hidden>·</i>
              <span>{s.where.mapName}</span>
            </>
          ) : (
            "Esperando datos del personaje"
          )}
        </p>
        <p className="hud-doing-line" title={s?.doing}>
          <span className={`hud-pulse ${online ? s?.mode ?? "" : "off"}`} aria-hidden />
          {s ? `${s.mode === "paused" ? "En pausa" : MODE_HINT[s.mode] ? MODE_HINT[s.mode]![0]!.toUpperCase() + MODE_HINT[s.mode]!.slice(1) : s.mode}: ${s.doing}` : "Conectando con el mundo…"}
        </p>
      </div>
      <div className="hud-vitals">
        <Bar label="Vida" tone="hp" value={s?.char.hp[0] ?? 0} max={s?.char.hp[1] ?? 0} hint={hpLow ? <em>{fmt(s?.char.hp[0])} / {fmt(s?.char.hp[1])}</em> : undefined} />
        <Bar label="Maná" tone="mp" value={s?.char.mp[0] ?? 0} max={s?.char.mp[1] ?? 0} />
        <Bar
          label="Hacia el reset"
          tone="xp"
          value={(s?.char.level ?? 0) * 1}
          max={400}
          hint={s ? `Nv ${s.char.level} / 400${eta !== null ? ` · ~${eta} min` : ""}` : "—"}
        />
      </div>
    </header>
  );
}

export function AlertStrip({ alerts, offline }: { alerts: Alert[]; offline?: ReactNode }) {
  if (!alerts.length && !offline) return null;
  return (
    <div className="hud-alerts" role="status" aria-live="polite">
      {offline}
      {alerts.map((a) => (
        <span key={a.id} className={`hud-alert ${a.level}`}>
          {a.level === "bad" ? <Skull size={14} /> : a.level === "warn" ? <AlertTriangle size={14} /> : <InfoIcon size={14} />}
          {a.text}
        </span>
      ))}
    </div>
  );
}

// ---- Acciones rápidas ---------------------------------------------------------------------------------
export type Dialogs = "warp" | "hunt" | "farm" | null;
export function QuickActions({ s, send, disabled, open }: { s: PanelState | null; send: (c: PanelCommand) => void; disabled: boolean; open: (d: Dialogs) => void }) {
  const paused = s?.mode === "paused";
  const onRoute = !(s?.mode === "hunt" || s?.where.pinned);
  return (
    <div className="hud-actions" role="group" aria-label="Acciones rápidas">
      <Action className={paused ? "primary" : ""} disabled={disabled} onClick={() => send({ cmd: paused ? "resume" : "pause" })} title="Pausar o continuar (P)">
        {paused ? <Play size={15} /> : <Pause size={15} />}
        {paused ? "Continuar" : "Pausar"}
        <kbd>P</kbd>
      </Action>
      <Action disabled={disabled || (onRoute && !paused)} onClick={() => open("farm")} title="Volver a la ruta normal (R)">
        <Route size={15} />
        {s?.mode === "hunt" ? "Dejar de cazar" : "Ruta"}
        <kbd>R</kbd>
      </Action>
      <Action disabled={disabled} onClick={() => open("hunt")} title="Cazar dorados (H)">
        <Crosshair size={15} />
        Cazar
        <kbd>H</kbd>
      </Action>
      <Action disabled={disabled} onClick={() => open("warp")} title="Viajar a un spot (W)">
        <Plane size={15} />
        Viajar
        <kbd>W</kbd>
      </Action>
    </div>
  );
}

// ---- Ítems ---------------------------------------------------------------------------------------------
const SLOT_NAMES = ["Arma", "Escudo", "Casco", "Armadura", "Pantalón", "Guantes", "Botas", "Alas", "Mascota", "Collar", "Anillo", "Anillo"];
const ICON_TIERS = [15, 13, 11, 9, 7, 5, 3, 0];
function iconSources(it: EquippedItem): string[] {
  const tier = ICON_TIERS.find((t) => it.level >= t) ?? 0;
  const base = (lv: number, e: boolean) => `/radar-assets/items/item_${it.group}_${it.num}_${lv}${e ? "_e" : ""}.png`;
  return [...new Set([base(it.level, it.excellent), base(tier, it.excellent), base(0, it.excellent), base(it.level, false), base(tier, false), base(0, false)])];
}
const initials = (n: string) =>
  n.replace(/\+\d+/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
export function ItemIcon({ it }: { it: EquippedItem }) {
  const sources = iconSources(it);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [sources[0]]);
  if (i >= sources.length) return <span className="item-fallback" aria-hidden>{initials(it.name ?? `${it.group}/${it.num}`)}</span>;
  return <img className="item-icon" src={sources[i]} alt="" draggable={false} onError={() => setI(i + 1)} />;
}

/** Muñeco de equipo: cada pieza en su lugar (casco arriba, alas y armas a los lados). */
const DOLL: { slot: number; area: string }[] = [
  { slot: 2, area: "helm" }, { slot: 7, area: "wings" }, { slot: 0, area: "wl" }, { slot: 3, area: "armor" }, { slot: 1, area: "wr" },
  { slot: 9, area: "pend" }, { slot: 4, area: "pants" }, { slot: 8, area: "pet" }, { slot: 5, area: "gloves" }, { slot: 6, area: "boots" },
  { slot: 10, area: "ringl" }, { slot: 11, area: "ringr" },
];
export function Paperdoll({ items }: { items: EquippedItem[] }) {
  const [sel, setSel] = useState<number | null>(null);
  const picked = items.find((i) => i.slot === sel);
  return (
    <div className="hud-doll-wrap">
      <div className="hud-doll">
        {DOLL.map(({ slot, area }) => {
          const it = items.find((x) => x.slot === slot);
          const tier = it ? itemTier(it) : null;
          return (
            <button
              key={slot}
              type="button"
              className={`hud-slot ${it ? "filled" : ""} t-${tier ?? "none"}`}
              style={{ gridArea: area }}
              aria-label={`${SLOT_NAMES[slot]}: ${it ? itemTitle(it) : "vacío"}`}
              aria-pressed={sel === slot}
              title={it ? itemTitle(it) : SLOT_NAMES[slot]}
              onClick={() => setSel(sel === slot ? null : slot)}
            >
              {it ? <ItemIcon it={it} /> : <small>{SLOT_NAMES[slot]}</small>}
              {it && it.level > 0 && <b className="lv">+{it.level}</b>}
            </button>
          );
        })}
      </div>
      <p className="hud-doll-sel" aria-live="polite">
        {picked ? (
          <>
            <b>{itemTitle(picked)}</b> <small>{SLOT_NAMES[picked.slot]} · {TIER_LABEL[itemTier(picked)]}</small>
          </>
        ) : (
          <small>Tocá una pieza para ver el detalle.</small>
        )}
      </p>
    </div>
  );
}

/** Bolsa 8×8: cada ítem ocupa su tamaño real y se pinta por valor (cajas, joyas, excelentes, +9). */
export function BagGrid({ items }: { items: EquippedItem[] }) {
  const [sel, setSel] = useState<number | null>(null);
  const picked = items.find((i) => i.slot === sel);
  return (
    <div>
      <div className="hud-bag" role="grid" aria-label="Bolsa, 8 por 8">
        {Array.from({ length: 64 }, (_, i) => (
          <div key={i} className="hud-bag-cell" style={{ gridColumn: (i % 8) + 1, gridRow: Math.floor(i / 8) + 1 }} />
        ))}
        {items.map((it) => {
          const pos = it.slot - 12;
          if (pos < 0 || pos > 63) return null;
          return (
            <button
              key={it.slot}
              type="button"
              className={`hud-bag-item t-${itemTier(it)}${sel === it.slot ? " sel" : ""}`}
              style={{ gridColumn: `${(pos % 8) + 1} / span ${Math.min(it.w ?? 1, 8 - (pos % 8))}`, gridRow: `${Math.floor(pos / 8) + 1} / span ${it.h ?? 1}` }}
              title={itemTitle(it)}
              aria-label={itemTitle(it)}
              onClick={() => setSel(sel === it.slot ? null : it.slot)}
            >
              <ItemIcon it={it} />
              {it.level > 0 && <b className="lv">+{it.level}</b>}
            </button>
          );
        })}
      </div>
      <p className="hud-doll-sel" aria-live="polite">
        {picked ? (
          <>
            <b>{itemTitle(picked)}</b> <small>{TIER_LABEL[itemTier(picked)]} · casilla {picked.slot - 11}</small>
          </>
        ) : (
          <small>Tocá un ítem para ver el detalle.</small>
        )}
      </p>
    </div>
  );
}
export function BagSummary({ items }: { items: EquippedItem[] }) {
  const u = bagUsage(items);
  const v = bagValue(items);
  const order: Tier[] = ["box", "jewel", "exc", "high", "potion", "common"];
  return (
    <div className="hud-bagsum">
      <div className={`hud-bagfill${u.used >= 54 ? " full" : ""}`}>
        <div>
          <b>{u.used}</b>/64 casillas · {u.count} ítems
        </div>
        <div className="hud-bar-track">
          <i style={{ width: `${(u.used / 64) * 100}%` }} />
        </div>
      </div>
      <div className="hud-tiers">
        {order.map((t) => (
          <span key={t} className={`t-${t}${v[t] ? "" : " zero"}`}>
            <i />
            {TIER_LABEL[t]} <b>{v[t]}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Exp / sparkline -----------------------------------------------------------------------------------
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 240, h = 52;
  const pts = sparkPoints(values, w, h, 3);
  if (!pts) return <div className="hud-spark empty">Midiendo… (hacen falta unos segundos)</div>;
  const last = pts.split(" ").pop()!.split(",");
  return (
    <svg className="hud-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <polyline className="area" points={`0,${h} ${pts} ${w},${h}`} />
      <polyline className="line" points={pts} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="3" />
    </svg>
  );
}
export function ExpCard({ s, samples, eta, now }: { s: PanelState | null; samples: Sample[]; eta: number | null; now: number }) {
  const vals = samples.map((x) => x.exp);
  const best = Math.max(0, ...vals);
  const cycles = (s?.cycles ?? []).filter((c) => c.min != null).slice(-8);
  const maxCycle = Math.max(1, ...cycles.map((c) => c.min ?? 0));
  const ses = s?.session;
  return (
    <Card
      title="Experiencia por minuto"
      icon={<TrendingUp size={14} />}
      className="hud-exp"
      extra={s?.resetsPerDay ? <small>{s.resetsPerDay.toFixed(1)} resets/día</small> : undefined}
      fold={
        <div className="hud-cycles">
          <small>Últimos ciclos de reset (minutos)</small>
          {cycles.length ? (
            <div className="hud-cyclebars">
              {cycles.map((c) => (
                <span key={c.start} title={`${c.min} min · ${new Date(c.start).toLocaleString("es-AR")}`}>
                  <i style={{ height: `${((c.min ?? 0) / maxCycle) * 100}%` }} />
                  <small>{c.min}</small>
                </span>
              ))}
            </div>
          ) : (
            <Empty>Todavía no hay ciclos completos.</Empty>
          )}
          {s?.cycle && <small>Ciclo actual: {Math.round((now - s.cycle.start) / 60000)} min · {Object.keys(s.cycle.marks).length} hitos</small>}
        </div>
      }
      foldLabel="Historial de ciclos"
    >
      <div className="hud-bignum">
        <strong>{compact(s?.exp.perMin1)}</strong>
        <span>/ min</span>
        <small>
          5 min: {compact(s?.exp.perMin5)}
          {best > 0 && ` · máx. ${compact(best)}`}
        </small>
      </div>
      <Sparkline values={vals} label={`Experiencia por minuto, últimos ${Math.round((vals.length * 5) / 60)} minutos`} />
      <div className="hud-kv">
        <span>
          Reset <b>{eta !== null ? `~${eta} min` : "—"}</b>
        </span>
        <span>
          Exp. de la sesión <b>{compact(ses?.exp)}</b>
        </span>
        <span>
          Progreso <b>{Math.round(levelProgress(s?.char.level ?? 0) * 100)}%</b>
        </span>
      </div>
    </Card>
  );
}

// ---- Sesión, feed, dorados -------------------------------------------------------------------------------
export function SessionTiles({ s, now }: { s: PanelState | null; now: number }) {
  const ses = s?.session;
  const mins = ses ? Math.max(1, (now - ses.since) / 60000) : 1;
  const tiles: [ReactNode, string, string][] = [
    [<Swords size={14} key="k" />, fmt(ses?.kills), "kills"],
    [<Zap size={14} key="r" />, ses ? (ses.kills / mins).toFixed(1) : "—", "kills/min"],
    [<Gem size={14} key="l" />, fmt(ses?.loot), "loot"],
    [<Trophy size={14} key="n" />, ses && s ? `+${Math.max(0, s.char.level - ses.level0)}` : "—", "niveles"],
    [<Skull size={14} key="d" />, fmt(ses?.deaths), "muertes"],
    [<Clock size={14} key="t" />, ses ? `${Math.round(mins)}m` : "—", "sesión"],
  ];
  return (
    <div className="hud-tiles" role="list">
      {tiles.map(([icon, v, l]) => (
        <div key={l} role="listitem" className={l === "muertes" && ses?.deaths ? "bad" : ""}>
          {icon}
          <strong>{v}</strong>
          <small>{l}</small>
        </div>
      ))}
    </div>
  );
}
const FEED_ICON = { kill: Swords, gold: Sparkles, loot: Gem, level: Trophy, death: Skull, map: Flag, reset: ArrowRightLeft } as const;
export function Feed({ feed, now }: { feed: FeedItem[]; now: number }) {
  const shown = feed.slice(-14).reverse();
  return (
    <Card title="En vivo" icon={<Zap size={14} />} extra={<small>{feed.length} eventos</small>} className="hud-feed-card">
      <ul className="hud-feed" aria-live="off">
        {shown.map((f, i) => {
          const Icon = FEED_ICON[f.kind];
          return (
            <li key={`${f.at}:${i}`} className={`${f.kind}${f.tier ? ` t-${f.tier}` : ""}${i === 0 ? " fresh" : ""}`}>
              <Icon size={13} aria-hidden />
              <span>{f.text}</span>
              <time title={new Date(f.at).toLocaleTimeString("es-AR")}>{ago(f.at, now)}</time>
            </li>
          );
        })}
        {!shown.length && <Empty>Acá aparecen kills, dorados, loot y niveles apenas pasan.</Empty>}
      </ul>
    </Card>
  );
}
export function Goldens({ s }: { s: PanelState }) {
  const me = s.where;
  const golds = (s.entities?.monsters ?? [])
    .filter((m) => m.gold)
    .map((m) => ({ ...m, d: cheb(m.x, m.y, me.x, me.y), dragon: isDragon(m.type) }))
    .sort((a, b) => Number(b.dragon) - Number(a.dragon) || a.d - b.d);
  const inv = s.invasion?.status === "active" ? s.invasion : null;
  return (
    <Card title="Dorados a la vista" icon={<Sparkles size={14} />} extra={<span className="hud-count">{golds.length}</span>}>
      <ul className="hud-list">
        {golds.map((g) => (
          <li key={g.id} className={g.type === 44 ? "red" : g.type === 79 ? "dragon" : "gold"}>
            <span className="hud-arrow" aria-hidden>{arrow(g.x - me.x, g.y - me.y)}</span>
            <span className="name">
              {g.name}
              {g.target && <em> · objetivo</em>}
            </span>
            <small>
              {g.d} tiles · {g.x},{g.y}
            </small>
          </li>
        ))}
        {!golds.length && <Empty>Ningún dorado a la vista.</Empty>}
      </ul>
      {inv && (
        <p className="hud-invline">
          Invasión: {inv.maps.filter((m) => m.alive > 0).map((m) => <span key={m.map} className={m.map === me.map ? "gold" : ""}>{m.name} {m.alive}</span>)}
          <b>{inv.total} vivos</b>
        </p>
      )}
    </Card>
  );
}
export function Nearby({ s }: { s: PanelState }) {
  const groups = new Map<string, { n: number; near: number; gold: boolean }>();
  for (const m of s.entities?.monsters ?? []) {
    const d = cheb(m.x, m.y, s.where.x, s.where.y);
    const g = groups.get(m.name) ?? { n: 0, near: 999, gold: m.gold };
    g.n++;
    g.near = Math.min(g.near, d);
    groups.set(m.name, g);
  }
  const rows = [...groups].sort((a, b) => Number(b[1].gold) - Number(a[1].gold) || a[1].near - b[1].near);
  return (
    <Card title="A tu alrededor" icon={<Crosshair size={14} />} extra={<span className="hud-count">{s.nearby.monsters}</span>}>
      <ul className="hud-list">
        {rows.slice(0, 5).map(([name, g]) => (
          <li key={name} className={g.gold ? "gold" : ""}>
            <span className="name">
              {g.gold ? "✦ " : ""}
              {name}
              <small> ×{g.n}</small>
            </span>
            <small>{g.near} tiles</small>
          </li>
        ))}
        {!rows.length && <Empty>No hay monstruos a la vista.</Empty>}
      </ul>
      {rows.length > 5 && (
        <details className="hud-more">
          <summary>{rows.length - 5} tipos más</summary>
          <ul className="hud-list">
            {rows.slice(5).map(([name, g]) => (
              <li key={name}>
                <span className="name">{name}<small> ×{g.n}</small></span>
                <small>{g.near} tiles</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="hud-invline">
        {s.nearby.players} jugadores cerca · {s.entities?.drops.filter((d) => d.valuable).length ?? 0} objetos valiosos
      </p>
    </Card>
  );
}
export function Skills({ s, now }: { s: PanelState | null; now: number }) {
  const list = s?.skills ?? (s?.session ? [{ name: s.session.skill, current: true } as NonNullable<PanelState["skills"]>[number]] : []);
  const mins = s?.session ? Math.max(1, (now - s.session.since) / 60000) : 1;
  return (
    <Card title="Skills" icon={<Zap size={14} />} extra={s?.session ? <small>{(s.session.casts / mins).toFixed(1)} tiros/min</small> : undefined}>
      <ul className="hud-skills">
        {list.map((k) => {
          const left = k.readyAt ? Math.max(0, k.readyAt - now) : 0;
          return (
            <li key={k.name} className={`${k.current ? "current" : ""}${left ? " cd" : ""}`}>
              <span>{k.name}</span>
              <small>{k.current ? "en uso" : left ? `${(left / 1000).toFixed(left < 10000 ? 1 : 0)} s` : "listo"}</small>
              {left > 0 && <i style={{ width: `${Math.min(100, (left / 45000) * 100)}%` }} />}
            </li>
          );
        })}
        {!list.length && <Empty>Sin datos de skills.</Empty>}
      </ul>
      {!s?.skills && <small className="hud-note">Esta versión del bot no informa las esperas de cada skill.</small>}
    </Card>
  );
}

// ---- Atributos -------------------------------------------------------------------------------------------------
export function Stats({ s }: { s: PanelState | null }) {
  const st = s?.char.stats;
  const rows: [string, number | undefined][] = [["Fuerza", st?.str], ["Agilidad", st?.agi], ["Vitalidad", st?.vit], ["Energía", st?.ene]];
  const max = Math.max(1, ...rows.map((r) => r[1] ?? 0));
  return (
    <Card title="Atributos" extra={<small>{fmt(s?.char.zen)} zen</small>}>
      <div className="hud-stats">
        {rows.map(([l, v]) => (
          <div key={l}>
            <span>{l}</span>
            <div className="hud-bar-track"><i style={{ width: `${((v ?? 0) / max) * 100}%` }} /></div>
            <b>{fmt(v)}</b>
          </div>
        ))}
      </div>
      {!!s?.char.points && <p className="hud-invline">{fmt(s.char.points)} puntos por repartir</p>}
    </Card>
  );
}

// ---- Eventos ------------------------------------------------------------------------------------------------------
const EVENT_NAME = { devilSquare: "Devil Square", bloodCastle: "Blood Castle", chaosCastle: "Chaos Castle" } as const;
export function EventsView({ s, now }: { s: PanelState | null; now: number }) {
  const inv = s?.invasion;
  return (
    <div className="hud-stack">
      <Card title="Invasión dorada" icon={<Sparkles size={14} />}>
        <div className={`hud-invasion${inv?.status === "active" ? " active" : ""}`}>
          <Sparkles size={22} />
          <div>
            <strong>{inv?.status === "active" ? `${inv.total} dorados vivos` : "Próxima invasión"}</strong>
            <small>
              {inv?.status === "active" ? "En curso" : inv?.nextAt ? `en ${countdown(inv.nextAt, now)}` : "Sin datos todavía"}
              {inv?.status === "active" && inv.nextAt ? ` · próxima en ${countdown(inv.nextAt, now)}` : ""}
            </small>
          </div>
        </div>
        {inv?.status === "active" &&
          inv.maps.map((m) => {
            const here = m.map === s?.where.map;
            return (
              <div className={`hud-row${here ? " here" : ""}`} key={m.map}>
                <span>{m.name}{here && <em> · estás acá</em>}</span>
                <b>{m.alive} vivos</b>
              </div>
            );
          })}
      </Card>
      <Card title="Eventos" icon={<Flag size={14} />}>
        {s?.events?.length ? (
          s.events.map((e) => (
            <div className="hud-row event" key={e.key}>
              <div>
                <strong>{EVENT_NAME[e.key]}</strong>
                <small>
                  {e.minutes === 0 ? "Entrada abierta" : e.opensAt ? `Abre a las ${clock(e.opensAt)}` : "Más de 4 horas"}
                  {e.users ? ` · ${e.users} anotados` : ""}
                </small>
              </div>
              <span className={e.minutes === 0 ? "open" : "mono"}>{e.minutes === 0 ? "Abierto" : e.opensAt ? countdown(e.opensAt, now) : "—"}</span>
            </div>
          ))
        ) : (
          <Empty>El bot todavía no recibió información de eventos.</Empty>
        )}
        {Object.keys(s?.tickets ?? {}).length > 0 && (
          <div className="hud-tickets">
            {Object.entries(s?.tickets ?? {}).map(([name, n]) => (
              <span key={name}>{name} ×{n}</span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---- Diario ---------------------------------------------------------------------------------------------------------
const KIND_ICON: Record<string, typeof Flag> = { decide: BookOpen, travel: Plane, reset: ArrowRightLeft, mode: Flag, command: Terminal };
export function Journal({ decisions, now, limit }: { decisions: Decision[]; now: number; limit?: number }) {
  const [filter, setFilter] = useState("all");
  const list = decisions.filter((d) => filter === "all" || d.kind === filter).slice(-(limit ?? 60)).reverse();
  return (
    <Card
      title="Diario del bot"
      icon={<BookOpen size={14} />}
      extra={
        !limit && (
          <div className="hud-filters" role="group" aria-label="Filtrar el diario">
            {[["all", "Todo"], ["decide", "Decisiones"], ["travel", "Viajes"], ["command", "Órdenes"], ["mode", "Modos"]].map(([v, l]) => (
              <button key={v} className="hud-chip sm" aria-pressed={filter === v} onClick={() => setFilter(v!)}>{l}</button>
            ))}
          </div>
        )
      }
    >
      <ol className="hud-journal">
        {list.map((d, i) => {
          const h = humanize(d);
          const Icon = KIND_ICON[d.kind] ?? BookOpen;
          return (
            <li key={`${d.at}:${i}`} className={d.kind}>
              <Icon size={14} aria-hidden />
              <div>
                <strong>
                  {h.title}
                  {d.n > 1 && <b className="hud-x2"> ×{d.n}</b>}
                </strong>
                {h.detail && <small>{h.detail}</small>}
              </div>
              <time title={new Date(d.at).toLocaleTimeString("es-AR")}>{ago(d.at, now)}</time>
            </li>
          );
        })}
        {!list.length && <Empty>Acá aparece lo que decide el personaje y por qué.</Empty>}
      </ol>
    </Card>
  );
}

// ---- Consola y chat --------------------------------------------------------------------------------------------------
export function Console({ logs }: { logs: Log[] }) {
  const [onlyBot, setOnlyBot] = useState(false);
  const box = useRef<HTMLDivElement>(null),
    atBottom = useRef(true);
  useEffect(() => {
    if (atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs, onlyBot]);
  return (
    <Card
      title="Consola"
      icon={<Terminal size={14} />}
      extra={
        <label className="switch-label">
          <Switch.Root checked={onlyBot} onCheckedChange={setOnlyBot} className="switch">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          Solo el bot
        </label>
      }
    >
      <div
        className="hud-console"
        ref={box}
        tabIndex={0}
        role="log"
        aria-label="Registro de actividad"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        }}
      >
        {logs
          .filter((l) => !onlyBot || l.kind === "bot")
          .map((l, i) => (
            <div className={l.kind} key={`${l.at}:${i}`}>
              <time>{clock(l.at)}</time>
              <span>{l.text}</span>
            </div>
          ))}
        {!logs.length && <Empty>Todavía no hay actividad.</Empty>}
      </div>
    </Card>
  );
}
const chatKinds: Record<Chat["kind"], string> = { normal: "", party: "Party", guild: "Guild", whisper: "Susurro", server: "Server" };
const channels = [
  { value: "normal", label: "Público" },
  { value: "party", label: "Party" },
  { value: "guild", label: "Guild" },
  { value: "whisper", label: "Susurro" },
];
export function ChatPanel({
  chats,
  result,
  send,
  disabled,
}: {
  chats: Chat[];
  result: { id: number; ok: boolean } | null;
  send: (c: PanelCommand) => number | null;
  disabled: boolean;
}) {
  const [channel, setChannel] = useState("normal"),
    [to, setTo] = useState(""),
    [text, setText] = useState(""),
    [showServer, setShowServer] = useState(true),
    // Último mensaje mandado: si el bot lo rechaza (muy rápido, muy largo) vuelve a la caja.
    pending = useRef<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!result || result.id !== pending.current?.id) return;
    if (!result.ok) setText(pending.current.text);
    pending.current = null;
  }, [result]);
  const box = useRef<HTMLDivElement | null>(null),
    atBottom = useRef(true);
  useEffect(() => {
    if (atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [chats, showServer]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    let id: number | null;
    if (channel === "whisper") {
      if (!to.trim()) return;
      id = send({ cmd: "say", text: t, to: to.trim() });
    } else id = send({ cmd: "say", text: t, ...(channel === "normal" ? {} : { channel: channel as "party" | "guild" }) });
    if (id == null) return;
    pending.current = { id, text: t };
    setText("");
  };
  return (
    <Card
      title="Chat del personaje"
      icon={<Send size={14} />}
      extra={
        <label className="switch-label">
          <Switch.Root checked={showServer} onCheckedChange={setShowServer} className="switch">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          Avisos del server
        </label>
      }
    >
      <div
        className="hud-console chat"
        ref={box}
        tabIndex={0}
        role="log"
        aria-label="Chat"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        }}
      >
        {chats
          .filter((c) => showServer || c.kind !== "server")
          .map((c, i) => (
            <div className={`chat-${c.kind}${c.mine ? " mine" : ""}`} key={`${c.at}:${i}`}>
              <time>{clock(c.at)}</time>
              {chatKinds[c.kind] && <b className="chat-kind">{chatKinds[c.kind]}</b>}
              <span>
                {c.from && <strong>{c.from}: </strong>}
                {c.text}
              </span>
            </div>
          ))}
        {!chats.length && <Empty>Todavía no llegó nada del chat.</Empty>}
      </div>
      <form className="hud-chatform" onSubmit={submit}>
        <div className="chat-channel">
          <Choice value={channel} onChange={setChannel} items={channels} label="Canal" />
        </div>
        {channel === "whisper" && <input className="chat-input chat-to" value={to} maxLength={10} placeholder="A quién" aria-label="Destinatario" onChange={(e) => setTo(e.target.value)} />}
        <input className="chat-input" value={text} maxLength={60} placeholder="Escribí un mensaje (sin comandos /)" aria-label="Mensaje" onChange={(e) => setText(e.target.value)} />
        <Action className="primary" disabled={disabled} type="submit">
          <Send size={14} />
          Enviar
        </Action>
      </form>
    </Card>
  );
}

// ---- Ayuda de atajos --------------------------------------------------------------------------------------------------
export const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: "Panel",
    keys: [["1 – 7", "Cambiar de pestaña"], ["P", "Pausar / continuar"], ["R", "Volver a la ruta (confirma)"], ["H", "Cazar dorados (confirma)"], ["W", "Viajar a un spot (confirma)"], ["?", "Esta ayuda"]],
  },
  {
    group: "Mapa",
    keys: [["M", "Alternar 3D / táctico"], ["F", "Seguir al personaje"], ["C", "Centrar"], ["N", "Norte arriba"], ["Q  E", "Girar la cámara"], ["+  −", "Acercar / alejar"], ["G", "Escenario del 3D"], ["L", "Capas"], ["Esc", "Cerrar el detalle"]],
  },
];
