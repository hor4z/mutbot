/**
 * La estación: navegación (Flota · Personaje · Estrategias · Dorados · Ranking · Consola), atajos,
 * paleta de comandos y avisos. Cada vista vive en su archivo; los datos, en station-data.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Binoculars, Command as CommandIcon, Compass, HelpCircle, LayoutGrid, Plug, Power, Pause, Play, Shield, Sparkles, Terminal, Trophy, UserPlus, UserRound, X } from "lucide-react";
import { Action } from "./components";
import { FleetView } from "./Fleet";
import { GoldsView } from "./Golds";
import { NewAccount } from "./NewAccount";
import { Help, Palette, type Cmd } from "./Palette";
import { StrategiesView } from "./Strategies";
import { ConsoleView, CharacterView, RankingView } from "./Views";
import { ROLES, ROLE_KEYS } from "../../estacion-logic";
import { ToastProvider, attention, isOnline, isPaused, stored, store, useActions, useNow, useStationData, useToasts, type Character } from "./station-data";
import { Kbd, roleIcon } from "./station-kit";
import { isDemo } from "./mock";

const VIEWS = [
  { id: "flota", label: "Flota", icon: <LayoutGrid size={16} /> },
  { id: "personaje", label: "Personaje", icon: <UserRound size={16} /> },
  { id: "estrategias", label: "Estrategias", icon: <Compass size={16} /> },
  { id: "dorados", label: "Dorados", icon: <Sparkles size={16} /> },
  { id: "ranking", label: "Ranking", icon: <Trophy size={16} /> },
  { id: "consola", label: "Consola", icon: <Terminal size={16} /> },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];
const isView = (v: string): v is ViewId => VIEWS.some((x) => x.id === v);

function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast2 ${t.tone}`}>
          <span>{t.msg}</span>
          <button aria-label="Cerrar aviso" onClick={() => dismiss(t.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

function Sync({ error, updatedAt, demo }: { error: string; updatedAt: number; demo: boolean }) {
  const now = useNow(2000);
  const stale = updatedAt > 0 && now - updatedAt > 8000;
  const bad = !!error || stale;
  return (
    <span className={`sync ${bad ? "bad" : ""}`} role="status" title={error || (demo ? "Datos de demostración" : "Conectado a la estación")}>
      <i />
      {demo ? "Demo" : bad ? "Sin señal" : "En vivo"}
    </span>
  );
}

function Shell() {
  const demo = isDemo();
  const { data, loaded, error, updatedAt, refresh } = useStationData();
  const actions = useActions(refresh);
  const [view, setViewRaw] = useState<ViewId>(() => {
    const v = stored("estacion:vista", "flota");
    return isView(v) ? v : "flota";
  });
  const [selected, setSelected] = useState(() => stored("estacion:personaje", ""));
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [creating, setCreating] = useState(false);
  const setView = useCallback((v: ViewId) => {
    setViewRaw(v);
    store("estacion:vista", v);
  }, []);
  const open = useCallback((key: string) => {
    setSelected(key);
    store("estacion:personaje", key);
    setView("personaje");
  }, [setView]);
  const pickChar = useCallback((key: string) => {
    setSelected(key);
    store("estacion:personaje", key);
  }, []);

  // Si el elegido ya no existe, soltarlo; la selección múltiple solo con personajes que existen.
  useEffect(() => {
    if (!loaded) return;
    if (selected && !data.chars.some((c) => c.key === selected)) setSelected("");
    setMulti((m) => {
      const keep = [...m].filter((k) => data.chars.some((c) => c.key === k));
      return keep.length === m.size ? m : new Set(keep);
    });
  }, [data.chars, loaded]);

  // Atajos de teclado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      if (/^[1-6]$/.test(e.key)) setView(VIEWS[+e.key - 1].id);
      else if (e.key === "n") { e.preventDefault(); setCreating(true); }
      else if (e.key === "?") setHelp(true);
      else if (e.key === "a" && view === "flota") setMulti((m) => (m.size === data.chars.length ? new Set() : new Set(data.chars.map((c) => c.key))));
      else if (e.key === "Escape") setMulti(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, data.chars, setView]);

  const commands = useMemo<Cmd[]>(() => {
    const out: Cmd[] = VIEWS.map((v, i) => ({ id: `v-${v.id}`, group: "Ir a", label: v.label, icon: v.icon, keys: String(i + 1), run: () => setView(v.id) }));
    out.push({ id: "new", group: "Cuentas", label: "Nueva cuenta o personaje", icon: <UserPlus size={15} />, keys: "N", run: () => setCreating(true) });
    out.push({ id: "help", group: "Ayuda", label: "Atajos de teclado", icon: <HelpCircle size={15} />, keys: "?", run: () => setHelp(true) });
    const on = data.chars.filter(isOnline);
    if (on.length > 1) {
      out.push({ id: "all-pause", group: "Flota", label: "Pausar a todos los conectados", icon: <Pause size={15} />, run: () => void actions.bulk(on.filter((c) => !isPaused(c)), "pause") });
      out.push({ id: "all-resume", group: "Flota", label: "Reanudar a todos los conectados", icon: <Play size={15} />, run: () => void actions.bulk(on.filter(isPaused), "resume") });
    }
    for (const c of data.chars) {
      out.push({ id: `o-${c.key}`, group: c.char, label: `Abrir el panel de ${c.char}`, hint: c.game ? `${c.game.map} · Nv. ${c.game.level}` : "Desconectado", icon: <UserRound size={15} />, run: () => open(c.key) });
      out.push({ id: `l-${c.key}`, group: c.char, label: `Consola de ${c.char}`, icon: <Terminal size={15} />, run: () => { pickChar(c.key); setView("consola"); } });
      if (isOnline(c)) {
        out.push(isPaused(c)
          ? { id: `r-${c.key}`, group: c.char, label: `Reanudar a ${c.char}`, icon: <Play size={15} />, run: () => void actions.resume(c) }
          : { id: `p-${c.key}`, group: c.char, label: `Pausar a ${c.char}`, icon: <Pause size={15} />, run: () => void actions.pause(c) });
        out.push({ id: `d-${c.key}`, group: c.char, label: `Desconectar a ${c.char}`, icon: <Power size={15} />, run: () => void actions.disconnect(c) });
      } else out.push({ id: `c-${c.key}`, group: c.char, label: `Conectar a ${c.char}`, hint: "con su estrategia", icon: <Plug size={15} />, run: () => void actions.connect(c) });
      for (const k of ROLE_KEYS.filter((k) => k !== "spot"))
        out.push({ id: `s-${c.key}-${k}`, group: c.char, label: `${c.char}: ${ROLES[k].label}`, hint: "estrategia", icon: roleIcon[k](15), run: () => void actions.setRole(c, { role: k }) });
    }
    return out;
  }, [data.chars, actions, open, pickChar, setView]);

  const pending = data.chars.filter((c: Character) => attention(c, data.alerts).length).length;
  const online = data.chars.filter(isOnline).length;
  const badge: Partial<Record<ViewId, number>> = { flota: online, dorados: data.golds.length, estrategias: data.scouts.length };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/panel" aria-label="MU Estación">
          <span className="brand-mark">M</span>
          <span className="brand-text">MU<span> / Estación</span></span>
        </a>
        <nav className="nav" aria-label="Vistas">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? "on" : ""} aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>
              {v.icon}
              <span>{v.label}</span>
              {!!badge[v.id] && <b className={v.id === "flota" && pending ? "alert" : ""}>{badge[v.id]}</b>}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <Sync error={error} updatedAt={updatedAt} demo={demo} />
          <button className="palette-btn" onClick={() => setPalette(true)} aria-label="Abrir la paleta de comandos">
            <CommandIcon size={14} /> <span>Buscar o ejecutar</span> <Kbd>Ctrl K</Kbd>
          </button>
          <Action className="primary small" onClick={() => setCreating(true)}><UserPlus size={15} /><span className="hide-narrow">Nueva cuenta</span></Action>
        </div>
      </header>

      {error && !loaded && <div className="banner bad" role="alert">{error}</div>}
      {error && loaded && <div className="banner bad" role="status">{error} Mostrando lo último que llegó.</div>}
      {demo && <div className="banner info" role="note"><Binoculars size={14} /> Modo demo: datos simulados, ninguna orden sale a la estación ni a los bots.</div>}

      <main className="main" id="main">
        {view === "flota" && <FleetView data={data} loaded={loaded} actions={actions} selected={multi} setSelected={setMulti} onOpen={open} onGoto={(v) => isView(v) && setView(v)} onNew={() => setCreating(true)} />}
        {view === "personaje" && <CharacterView data={data} selected={selected} onPick={pickChar} actions={actions} demo={demo} />}
        {view === "estrategias" && <StrategiesView data={data} actions={actions} onOpen={open} />}
        {view === "dorados" && <GoldsView data={data} actions={actions} onPick={open} />}
        {view === "ranking" && <RankingView mine={data.chars.map((c) => c.char)} />}
        {view === "consola" && <ConsoleView data={data} selected={selected} onPick={pickChar} />}
      </main>

      <NewAccount open={creating} onOpenChange={setCreating} chars={data.chars} refresh={refresh} onDone={open} />
      <Palette open={palette} onOpenChange={setPalette} commands={commands} />
      <Help open={help} onOpenChange={setHelp} />
      <Toasts />
    </div>
  );
}

export function Station() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
