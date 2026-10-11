import { useEffect, useState, useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import {
  Users,
  X,
  Plug,
  Power,
  ChevronRight,
  Terminal,
  LayoutDashboard,
  Settings2,
  Sparkles,
  Trophy,
} from "lucide-react";
import type { Routine, StationRequest } from "../../estacion-logic";
import { Action, Badge, Choice, compact, fmt } from "./components";
import knight from "../../assets/ui/knight-alpha.webp";
export type Character = {
  key: string;
  char: string;
  status: string;
  msg: string;
  pid: number | null;
  port: number;
  panel: boolean;
  routine: Routine | null;
  pending: Routine | null;
  game: null | {
    mode: string;
    doing: string;
    level: number;
    resets: number | null;
    map: string;
    x: number;
    y: number;
    hp: [number, number];
    expPerMin: number;
  };
};
type Gold = {
  id: number;
  from: string;
  name: string;
  mapName: string;
  x: number;
  y: number;
  at: number;
};
const routines = [
  ["farm", "Ruta automática"],
  ["spot:24", "Arena 2"],
  ["spot:25", "Arena 3"],
  ["spot:26", "Arena 4"],
  ["spot:7", "Devias 4"],
  ["spot:6", "Devias 3"],
  ["spot:2", "Lorencia"],
  ["pause", "En pausa"],
].map(([value, label]) => ({ value: value!, label: label! }));
const fromRoutine = (r: Routine | null) =>
  r?.kind === "spot" ? `spot:${r.warp}` : (r?.kind ?? "farm");
const toRoutine = (v: string): Routine =>
  v.startsWith("spot:")
    ? { kind: "spot", warp: +v.slice(5) }
    : { kind: v as "farm" | "pause" };
const read = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) || fallback;
  } catch {
    return fallback;
  }
};
function Console({ charKey }: { charKey: string }) {
  const [log, setLog] = useState("Cargando consola…");
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let done = false;
    let nearBottom = true;
    const controller = new AbortController();
    async function poll() {
      try {
        const r = await fetch(`/api/log/${encodeURIComponent(charKey)}`, {
          signal: controller.signal,
        });
        if (!r.ok) throw Error();
        const t = await r.text();
        if (!done) {
          const e = ref.current;
          nearBottom =
            !e || e.scrollTop + e.clientHeight >= e.scrollHeight - 30;
          setLog(t || "Todavía no hay actividad.");
          requestAnimationFrame(() => {
            if (nearBottom && ref.current)
              ref.current.scrollTop = ref.current.scrollHeight;
          });
        }
      } catch {
        if (!done) setLog("No se pudo cargar la consola.");
      }
    }
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      done = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [charKey]);
  return (
    <pre className="console" ref={ref}>
      {log}
    </pre>
  );
}
type RankingData = {
  resets?: { name: string; classNumber: number; totalResets: number; grandResets: number; level: number }[];
  elo?: { name: string; classNumber: number; elo: number; wins: number; losses: number }[];
  updatedAt?: string;
  error?: string;
};
// Ranking del server (la misma API que usa el cliente web para /ranking), a través de la estación.
function Ranking({ mine }: { mine: string[] }) {
  const [data, setData] = useState<RankingData | null>(null);
  useEffect(() => {
    let done = false;
    async function load() {
      try {
        const r = await fetch("/api/ranking", { cache: "no-store" });
        const d = (await r.json()) as RankingData;
        if (!done) setData(d);
      } catch {
        if (!done) setData({ error: "La estación no contesta." });
      }
    }
    load();
    const t = setInterval(load, 60_000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, []);
  const own = new Set(mine.map((n) => n.toLowerCase()));
  const isMine = (n: string) => own.has(n.toLowerCase());
  const resets = data?.resets ?? [];
  const elo = data?.elo ?? [];
  const where = (list: { name: string }[], n: string) => list.findIndex((x) => x.name.toLowerCase() === n.toLowerCase()) + 1;
  return (
    <div className="ranking-view">
      {data?.error && <p className="empty-copy">{data.error}</p>}
      {!data && <p className="empty-copy">Cargando ranking…</p>}
      {data && !data.error && (
        <>
          <div className="ranking-mine">
            {mine.map((n) => (
              <span key={n} className="chip">
                <b>{n}</b> · resets #{where(resets, n) || "—"} · ELO #{where(elo, n) || "—"}
              </span>
            ))}
            {data.updatedAt && <span className="muted">Actualizado {new Date(data.updatedAt).toLocaleTimeString("es-AR")}</span>}
          </div>
          <div className="ranking-tables">
            <section>
              <h2>Resets</h2>
              <table>
                <thead>
                  <tr><th>#</th><th className="name">Personaje</th><th>Resets</th><th title="Grand resets">GR</th><th>Nivel</th></tr>
                </thead>
                <tbody>
                  {resets.slice(0, 50).map((r, i) => (
                    <tr key={r.name} className={isMine(r.name) ? "mine" : ""}>
                      <td>{i + 1}</td><td className="name">{r.name}</td><td>{fmt(r.totalResets)}</td><td>{r.grandResets}</td><td>{r.level}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h2>ELO de Arena</h2>
              <table>
                <thead>
                  <tr><th>#</th><th className="name">Personaje</th><th>ELO</th><th>G-P</th></tr>
                </thead>
                <tbody>
                  {elo.slice(0, 50).map((r, i) => (
                    <tr key={r.name} className={isMine(r.name) ? "mine" : ""}>
                      <td>{i + 1}</td><td className="name">{r.name}</td><td>{fmt(r.elo)}</td><td>{r.wins}-{r.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
function ManageCharacter({
  c,
  selected,
  onSelect,
  act,
}: {
  c: Character;
  selected: boolean;
  onSelect: () => void;
  act: (r: StationRequest) => Promise<void>;
}) {
  const [routine, setRoutine] = useState(fromRoutine(c.routine ?? c.pending));
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setRoutine(fromRoutine(c.routine ?? c.pending));
  }, [fromRoutine(c.routine ?? c.pending)]);
  async function perform(r: StationRequest) {
    setBusy(true);
    await act(r);
    dirty.current = false;
    setBusy(false);
  }
  return (
    <div className={`manage-character ${selected ? "selected" : ""}`}>
      <div className="manage-top">
        <button className="character-link" onClick={onSelect}>
          <span className="avatar">{c.char.slice(0, 1)}</span>
          <span>
            <strong>{c.char}</strong>
            <small>
              {c.game
                ? `${c.game.map} · Nivel ${fmt(c.game.level)}`
                : "Listo para entrar"}
            </small>
          </span>
          <ChevronRight size={15} />
        </button>
        <Badge state={c.status} />
      </div>
      <div className="manage-actions">
        {c.pid == null ? (
          <Action
            className="primary"
            disabled={busy}
            onClick={() =>
              perform({
                action: "connect",
                char: c.key,
                routine: toRoutine(routine),
              })
            }
          >
            <Plug size={15} />
            Conectar
          </Action>
        ) : (
          <Action
            className="danger"
            disabled={busy || c.status === "stopping"}
            onClick={() => perform({ action: "disconnect", char: c.key })}
          >
            <Power size={15} />
            Desconectar
          </Action>
        )}
        <Action
          className="quiet"
          aria-expanded={settings}
          onClick={() => setSettings(!settings)}
        >
          <Settings2 size={15} />
          Rutina
        </Action>
      </div>
      {settings && (
        <div className="routine-editor">
          <Choice
            label={`Rutina de ${c.char}`}
            value={routine}
            onChange={(v) => {
              dirty.current = true;
              setRoutine(v);
            }}
            items={routines}
          />
          {c.pid != null && (
            <Action
              disabled={
                busy || c.status === "external" || c.status === "stopping"
              }
              onClick={() =>
                perform({
                  action: "routine",
                  char: c.key,
                  routine: toRoutine(routine),
                })
              }
            >
              Aplicar
            </Action>
          )}
        </div>
      )}
      {c.msg && !["on", "off"].includes(c.status) && (
        <p className="warning">{c.msg}</p>
      )}
      {c.pending && <p className="muted">La rutina se aplicará al entrar.</p>}
    </div>
  );
}
export function Station() {
  const [chars, setChars] = useState<Character[]>([]);
  const [golds, setGolds] = useState<Gold[]>([]);
  const [selected, setSelected] = useState(() => read("estacion:sel", ""));
  const [tab, setTab] = useState(() => read("estacion:tab", "panel"));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    let fetching = false;
    const controller = new AbortController();
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const r = await fetch("/api/state", { signal: controller.signal });
        if (!r.ok) throw Error();
        const s = await r.json();
        if (live.current) {
          setChars(s.chars);
          setGolds(s.golds ?? []);
          setError("");
          setSelected((old) =>
            s.chars.some((c: Character) => c.key === old)
              ? old
              : (s.chars[0]?.key ?? ""),
          );
        }
      } catch {
        if (live.current)
          setError("La estación no está disponible. Reintentando…");
      } finally {
        fetching = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live.current = false;
      controller.abort();
      clearInterval(timer);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("estacion:sel", selected);
      localStorage.setItem("estacion:tab", tab);
    } catch {}
  }, [selected, tab]);
  async function act(body: StationRequest) {
    let msg = "La estación no contesta.";
    try {
      const r = await fetch("/api/do", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      msg = j.msg ?? msg;
    } catch {}
    if (!live.current) return;
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }
  const c = chars.find((c) => c.key === selected);
  const running = chars.filter((c) => c.pid != null);
  return (
    <div className="station-shell">
      <header className="station-bar">
        <a className="brand" href="/panel" aria-label="MU Estación">
          <span className="brand-mark">M</span>
          <span>
            MU<span className="brand-light"> / Estación</span>
          </span>
        </a>
        <div className="character-switcher" aria-label="Personajes en línea">
          {[
            ...(c ? [c] : []),
            ...running.filter((x) => x.key !== selected),
          ].map((x) => (
            <button
              className={`character-pill ${x.key === selected ? "active" : ""}`}
              key={x.key}
              onClick={() => setSelected(x.key)}
              aria-pressed={x.key === selected}
            >
              <span
                className={`mini-dot ${x.status === "on" ? "online" : ""}`}
              />
              <strong>{x.char}</strong>
              {x.game && <span>Nv. {x.game.level}</span>}
            </button>
          ))}
        </div>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger className="button manage-trigger">
            <Users size={16} />
            <span>Personajes</span>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop className="drawer-backdrop" />
            <Dialog.Popup className="drawer">
              <div className="drawer-title">
                <div>
                  <Dialog.Title>Personajes</Dialog.Title>
                  <Dialog.Description>
                    Conectá tus personajes y elegí a quién seguir.
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  className="button icon-button"
                  aria-label="Cerrar personajes"
                >
                  <X size={18} />
                </Dialog.Close>
              </div>
              <div className="drawer-content">
                {chars.map((x) => (
                  <ManageCharacter
                    key={x.key}
                    c={x}
                    selected={selected === x.key}
                    onSelect={() => {
                      setSelected(x.key);
                      setOpen(false);
                    }}
                    act={act}
                  />
                ))}
                {!chars.length && (
                  <p className="muted">
                    No hay personajes configurados todavía.
                  </p>
                )}
                <p className="connection-note">
                  Antes de conectar un personaje, cerrá su sesión en el juego.
                </p>
                {golds.length > 0 && (
                  <div className="gold-signals">
                    <h3>
                      <Sparkles size={16} />
                      Dorados cerca
                    </h3>
                    {golds.map((g) => (
                      <p key={`${g.from}:${g.id}`}>
                        <strong>{g.name}</strong>
                        <span>
                          {g.mapName} · {g.x}, {g.y} · visto por {g.from}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
              <div className="drawer-art">
                <img src={knight} alt="" />
                <div>
                  <span className="eyebrow">MU ONLINE</span>
                  <p>
                    Una aventura.
                    <br />
                    Todos tus personajes.
                  </p>
                </div>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </header>
      {error && (
        <div className="station-error" role="status">
          {error}
        </div>
      )}
      <Tabs.Root
        className="station-content"
        value={tab}
        onValueChange={(v) => setTab(String(v))}
      >
        <div className="station-toolbar">
          <span className="muted">
            {c?.char ?? "Tu estación"}
            {running.length > 1 && (
              <span className="other-count">
                {" "}
                · {running.length} personajes conectados
              </span>
            )}
          </span>
          <Tabs.List className="view-tabs" aria-label="Vista del personaje">
            <Tabs.Tab value="panel">
              <LayoutDashboard size={14} />
              Panel
            </Tabs.Tab>
            <Tabs.Tab value="log">
              <Terminal size={14} />
              Consola
            </Tabs.Tab>
            <Tabs.Tab value="ranking">
              <Trophy size={14} />
              Ranking
            </Tabs.Tab>
          </Tabs.List>
        </div>
        <Tabs.Panel value="panel" className="station-view">
          {c?.panel ? (
            <iframe
              key={c.port}
              src={`http://127.0.0.1:${c.port}/panel`}
              title={`Panel de ${c.char}`}
            />
          ) : (
            <div className="welcome">
              <img
                src={knight}
                alt="Caballero con armadura y alas de cristal"
              />
              <div>
                <span className="eyebrow">TU MUNDO, EN MARCHA</span>
                <h1>
                  {c?.pid != null
                    ? "Preparando tu aventura…"
                    : "Todo listo para entrar."}
                </h1>
                <p>
                  {c?.pid != null
                    ? `Esperando el panel de ${c.char}.`
                    : "Conectá un personaje para seguir su progreso en tiempo real."}
                </p>
                <Action className="primary" onClick={() => setOpen(true)}>
                  <Users size={16} />
                  Ver personajes
                </Action>
              </div>
            </div>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="ranking" className="station-view">
          <Ranking mine={chars.map((x) => x.char)} />
        </Tabs.Panel>
        <Tabs.Panel value="log" className="station-view">
          {c ? (
            <Console charKey={c.key} />
          ) : (
            <p className="empty-copy">
              Elegí un personaje para ver su consola.
            </p>
          )}
        </Tabs.Panel>
      </Tabs.Root>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
