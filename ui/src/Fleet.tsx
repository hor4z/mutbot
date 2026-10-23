/** Flota: todos los personajes de un vistazo, con acciones rápidas y masivas. */
import { useMemo, useState } from "react";
import { ArrowUpRight, Boxes, CirclePause, Layers, MapPin, Pause, Play, Plug, Power, Search, Skull, Sparkles, TriangleAlert, UserPlus, X, Zap, Gauge, Swords } from "lucide-react";
import { Action, compact, fmt } from "./components";
import { AlertFeed, GoldsCard } from "./Golds";
import { IntelCard } from "./Intel";
import { attention, classNames, isOnline, isPaused, stored, store, type Actions, type Character, type StationData } from "./station-data";
import { Avatar, Bar, Check2, Empty, RoleChip, RoleMenu, Skeleton, StatusPill, visual } from "./station-kit";

type Filter = "all" | "online" | "attention" | "off";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "online", label: "En línea" },
  { value: "attention", label: "Atención" },
  { value: "off", label: "Apagados" },
];

function Summary({ data }: { data: StationData }) {
  const on = data.chars.filter(isOnline);
  const exp = on.reduce((n, c) => n + (c.game?.expPerMin ?? 0), 0);
  const kills = on.reduce((n, c) => n + (c.game?.session?.kills ?? 0), 0);
  const deaths = on.reduce((n, c) => n + (c.game?.session?.deaths ?? 0), 0);
  const warn = data.chars.filter((c) => attention(c, data.alerts).length).length;
  const tiles: { icon: React.ReactNode; label: string; value: string; note: string; tone?: string }[] = [
    { icon: <Plug size={15} />, label: "En línea", value: `${on.length}/${data.chars.length}`, note: on.length ? `${on.filter((c) => c.game?.mode === "farm").length} farmeando` : "Nadie conectado", tone: on.length ? "good" : "idle" },
    { icon: <Gauge size={15} />, label: "Exp / min", value: compact(exp), note: "entre todos", tone: "gold" },
    { icon: <Swords size={15} />, label: "Kills", value: fmt(kills), note: `${deaths} muerte${deaths === 1 ? "" : "s"} en la sesión`, tone: deaths ? "warn" : "info" },
    { icon: <Sparkles size={15} />, label: "Dorados", value: String(data.golds.length), note: data.invasion?.status === "active" ? "Invasión activa" : "a la vista", tone: data.golds.length ? "gold" : "idle" },
    { icon: <TriangleAlert size={15} />, label: "Atención", value: String(warn), note: warn ? "mirá las tarjetas marcadas" : "todo en orden", tone: warn ? "bad" : "good" },
  ];
  return (
    <div className="summary" role="list">
      {tiles.map((t) => (
        <div key={t.label} className={`tile tone-${t.tone}`} role="listitem">
          <span className="tile-label">{t.icon}{t.label}</span>
          <strong>{t.value}</strong>
          <small>{t.note}</small>
        </div>
      ))}
    </div>
  );
}

function CharCard({
  c, data, selected, onSelect, onOpen, actions,
}: {
  c: Character; data: StationData; selected: boolean; onSelect: (v: boolean) => void; onOpen: () => void; actions: Actions;
}) {
  const [busy, setBusy] = useState(false);
  const g = c.game;
  const flags = attention(c, data.alerts);
  const v = visual(c);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const hpPct = g && g.hp[1] ? Math.round((g.hp[0] / g.hp[1]) * 100) : 0;
  const can = c.status !== "external" && c.status !== "stopping";
  return (
    <article className={`char-card tone-${v.tone} ${selected ? "selected" : ""} ${flags.length ? "flagged" : ""} ${v.live ? "live" : ""}`} aria-label={c.char}>
      <header className="char-head">
        <Check2 checked={selected} onChange={onSelect} label={`Elegir a ${c.char}`} />
        <Avatar c={c} />
        <button className="char-name" onClick={onOpen} title={`Abrir el panel de ${c.char}`}>
          <strong>{c.char}</strong>
          <small>
            {g ? `Nv. ${fmt(g.level)}${g.resets != null ? ` · ${g.resets} resets` : ""}` : c.cls ? classNames[c.cls] : c.user}
          </small>
        </button>
        <StatusPill c={c} />
      </header>

      <div className="char-doing">
        {g && c.status === "on" ? (
          <>
            <p className="doing-text">{g.doing || "…"}</p>
            <p className="doing-where"><MapPin size={12} /> {g.map} · {g.x}, {g.y}</p>
          </>
        ) : (
          <p className="doing-text muted">{c.msg || "Desconectado."}</p>
        )}
      </div>

      {g && c.status === "on" ? (
        <div className="vitals">
          <div className="vital">
            <span><b>HP</b> {fmt(g.hp[0])}<em>/{fmt(g.hp[1])}</em></span>
            <Bar value={g.hp[0]} max={g.hp[1]} tone="hp" label={`Vida de ${c.char}: ${hpPct}%`} />
          </div>
          <dl className="stats">
            <div><dt><Zap size={11} />Exp/min</dt><dd>{compact(g.expPerMin)}</dd></div>
            <div><dt><Swords size={11} />Kills</dt><dd>{fmt(g.session?.kills ?? 0)}</dd></div>
            <div><dt><Skull size={11} />Muertes</dt><dd className={g.session?.deaths ? "bad" : ""}>{g.session?.deaths ?? 0}</dd></div>
            {g.bag != null && <div><dt><Boxes size={11} />Bolsa</dt><dd className={g.bag >= 0.92 ? "bad" : ""}>{Math.round(g.bag * 100)}%</dd></div>}
          </dl>
        </div>
      ) : (
        <div className="vitals ghost" aria-hidden />
      )}

      {flags.length > 0 && (
        <ul className="flags" aria-label="Alertas">
          {flags.map((f) => <li key={f}><TriangleAlert size={11} />{f}</li>)}
        </ul>
      )}

      <footer className="char-foot">
        <RoleMenu
          label={`Estrategia de ${c.char}`}
          current={c.role}
          onPick={(r) => void run(() => actions.setRole(c, r))}
          trigger={<RoleChip role={c.role.role} warp={c.role.role === "spot" ? c.role.warp : undefined} />}
        />
        <span className="grow" />
        {!isOnline(c) ? (
          <Action className="primary small" disabled={busy || c.account === "blocked"} onClick={() => void run(() => actions.connect(c))}>
            <Plug size={14} /> Conectar
          </Action>
        ) : (
          <>
            {isPaused(c) ? (
              <Action className="small" disabled={busy || !can} onClick={() => void run(() => actions.resume(c))} title="Reanudar con su estrategia">
                <Play size={14} /> Reanudar
              </Action>
            ) : (
              <Action className="quiet small" disabled={busy || !can} onClick={() => void run(() => actions.pause(c))} title="Pausar">
                <Pause size={14} /> Pausar
              </Action>
            )}
            <Action className="quiet small icon" disabled={busy || c.status === "stopping"} onClick={() => void run(() => actions.disconnect(c))} aria-label={`Desconectar a ${c.char}`} title="Desconectar">
              <Power size={14} />
            </Action>
          </>
        )}
        <Action className="quiet small icon" onClick={onOpen} aria-label={`Abrir panel de ${c.char}`} title="Abrir el panel">
          <ArrowUpRight size={14} />
        </Action>
      </footer>
    </article>
  );
}

function BulkBar({ chars, selected, actions, clear }: { chars: Character[]; selected: Set<string>; actions: Actions; clear: () => void }) {
  const [busy, setBusy] = useState(false);
  const sel = chars.filter((c) => selected.has(c.key));
  if (!sel.length) return null;
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const off = sel.filter((c) => !isOnline(c));
  const on = sel.filter(isOnline);
  return (
    <div className="bulk" role="toolbar" aria-label="Acciones sobre la selección">
      <strong>{sel.length} elegido{sel.length === 1 ? "" : "s"}</strong>
      <span className="bulk-sep" />
      <Action className="small primary" disabled={busy || !off.length} onClick={() => void go(() => actions.bulk(off, "connect"))}><Plug size={14} />Conectar{off.length ? ` (${off.length})` : ""}</Action>
      <Action className="small" disabled={busy || !on.length} onClick={() => void go(() => actions.bulk(on, "resume"))}><Play size={14} />Reanudar</Action>
      <Action className="small" disabled={busy || !on.length} onClick={() => void go(() => actions.bulk(on, "pause"))}><CirclePause size={14} />Pausar</Action>
      <Action className="small danger" disabled={busy || !on.length} onClick={() => void go(() => actions.bulk(on, "disconnect"))}><Power size={14} />Desconectar</Action>
      <RoleMenu label="Cambiar estrategia de la selección" onPick={(r) => void go(() => actions.bulk(sel, r))} trigger={<><Layers size={14} />Estrategia</>} />
      <span className="grow" />
      <Action className="quiet small icon" onClick={clear} aria-label="Limpiar selección" title="Limpiar (Esc)"><X size={14} /></Action>
    </div>
  );
}

export function FleetView({
  data, loaded, actions, selected, setSelected, onOpen, onGoto, onNew,
}: {
  data: StationData;
  loaded: boolean;
  actions: Actions;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onOpen: (key: string) => void;
  onGoto: (view: string) => void;
  onNew: () => void;
}) {
  const [filter, setFilterRaw] = useState<Filter>(() => stored("estacion:filtro", "all") as Filter);
  const setFilter = (f: Filter) => {
    setFilterRaw(f);
    store("estacion:filtro", f);
  };
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.chars.filter((c) => {
      if (t && !`${c.char} ${c.user} ${c.game?.map ?? ""} ${c.cls ?? ""}`.toLowerCase().includes(t)) return false;
      if (filter === "online") return isOnline(c);
      if (filter === "off") return !isOnline(c);
      if (filter === "attention") return attention(c, data.alerts).length > 0;
      return true;
    });
  }, [data, q, filter]);
  const allShown = shown.length > 0 && shown.every((c) => selected.has(c.key));
  const toggleAll = (v: boolean) => {
    const n = new Set(selected);
    for (const c of shown) v ? n.add(c.key) : n.delete(c.key);
    setSelected(n);
  };
  const pick = (key: string, v: boolean) => {
    const n = new Set(selected);
    v ? n.add(key) : n.delete(key);
    setSelected(n);
  };
  const byName = (name: string) => {
    const c = data.chars.find((x) => x.char === name);
    if (c) onOpen(c.key);
  };

  return (
    <div className="fleet">
      <Summary data={data} />
      <div className="fleet-body">
        <div className="fleet-main">
          <div className="toolbar">
            <label className="search">
              <Search size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar personaje, cuenta o mapa" aria-label="Buscar personajes" />
            </label>
            <div className="seg" role="group" aria-label="Filtrar">
              {FILTERS.map((f) => (
                <button key={f.value} aria-pressed={filter === f.value} className={filter === f.value ? "on" : ""} onClick={() => setFilter(f.value)}>
                  {f.label}
                </button>
              ))}
            </div>
            <label className="select-all">
              <Check2 checked={allShown} indeterminate={!allShown && shown.some((c) => selected.has(c.key))} onChange={toggleAll} label="Elegir todos los que se ven" />
              Elegir todos
            </label>
          </div>

          {!loaded ? (
            <div className="grid-cards"><Skeleton h={230} /><Skeleton h={230} /><Skeleton h={230} /></div>
          ) : data.chars.length === 0 ? (
            <Empty icon={<UserPlus size={22} />} title="Todavía no hay personajes" action={<Action className="primary" onClick={onNew}><UserPlus size={15} />Nueva cuenta</Action>}>
              Sumá una cuenta y un personaje; la estación los conecta sin abrir el juego.
            </Empty>
          ) : shown.length === 0 ? (
            <Empty icon={<Search size={22} />} title="Nada con ese filtro" action={<Action onClick={() => { setQ(""); setFilter("all"); }}>Ver todos</Action>} />
          ) : (
            <div className="grid-cards">
              {shown.map((c) => (
                <CharCard key={c.key} c={c} data={data} selected={selected.has(c.key)} onSelect={(v) => pick(c.key, v)} onOpen={() => onOpen(c.key)} actions={actions} />
              ))}
            </div>
          )}
        </div>
        <aside className="fleet-side">
          <GoldsCard data={data} actions={actions} onOpen={() => onGoto("dorados")} />
          <IntelCard data={data} />
          <AlertFeed alerts={data.alerts} limit={12} onPick={byName} />
        </aside>
      </div>
      <BulkBar chars={data.chars} selected={selected} actions={actions} clear={() => setSelected(new Set())} />
    </div>
  );
}
