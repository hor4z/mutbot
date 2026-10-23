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
  UserPlus,
  Dices,
  Shield,
  ChevronLeft,
  KeyRound,
} from "lucide-react";
import type { CharClassKey, Routine, StationRequest } from "../../estacion-logic";
import { Action, Badge, Choice, compact, fmt } from "./components";
import { Squads } from "./Squads";
import knight from "../../assets/ui/knight-alpha.webp";
export type Character = {
  key: string;
  char: string;
  user: string;
  /** estado de la cuenta en la base: active / blocked */
  account: string;
  cls: string | null;
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
const classes: { value: CharClassKey; label: string }[] = [
  { value: "dk", label: "Dark Knight" },
  { value: "dw", label: "Dark Wizard" },
  { value: "elf", label: "Fairy Elf" },
  { value: "mg", label: "Magic Gladiator (pide un personaje alto)" },
];
// Personaje nuevo: cuenta (se registra en el server), clase y nombre, con sugerencias de nombres.
function NewCharacter({
  act,
  account,
}: {
  act: (r: StationRequest) => Promise<boolean>;
  /** cuenta ya guardada: solo se piden clase y nombre */
  account?: string;
}) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(account ?? "");
  const [pass, setPass] = useState("");
  const [existing, setExisting] = useState(false);
  // El personaje ya está creado en el server: no hace falta clase y el bot no crea nada.
  const [charExists, setCharExists] = useState(false);
  const known = (!!account || existing) && charExists;
  // Personajes que ya tiene la cuenta en el server (la estación entra, lista y sale).
  const [found, setFound] = useState<{ name: string; level: number }[] | null>(null);
  const [probeMsg, setProbeMsg] = useState("");
  const [probing, setProbing] = useState(false);
  async function probe() {
    setProbing(true);
    setProbeMsg("Entrando a la cuenta para ver tus personajes…");
    setFound(null);
    try {
      const r = await fetch("/api/do", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(account ? { action: "probe", user: account } : { action: "probe", user, pass }),
      });
      const j = await r.json();
      setProbeMsg(j.msg ?? "");
      if (j.ok) setFound(j.chars ?? []);
    } catch {
      setProbeMsg("La estación no contesta.");
    }
    setProbing(false);
  }
  const [cls, setCls] = useState<CharClassKey>("dk");
  const [char, setChar] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function roll() {
    try {
      const r = await fetch("/api/names", { cache: "no-store" });
      const j = (await r.json()) as { names: string[] };
      setNames(j.names);
      setChar((old) => old || j.names[0] || "");
    } catch {}
  }
  useEffect(() => {
    if (open && !names.length) void roll();
  }, [open]);
  const problem = !account && !/^[A-Za-z0-9]{4,10}$/.test(user)
    ? "Cuenta: 4 a 10 letras o números."
    : !account && !/^[!-~]{4,10}$/.test(pass)
      ? "Clave: 4 a 10 caracteres visibles, sin espacios."
      : !/^[A-Za-z0-9]{4,10}$/.test(char)
        ? "Nombre: 4 a 10 letras o números."
        : "";
  async function create() {
    setBusy(true);
    const c = known ? null : cls;
    const ok = await act(
      account
        ? { action: "add", user: account, char, cls: c }
        : { action: "create", user, pass, char, cls: c, existing },
    );
    setBusy(false);
    if (ok) {
      setOpen(false);
      if (!account) setUser("");
      setPass("");
      setChar("");
      setNames([]);
    }
  }
  if (!open)
    return (
      <Action className="quiet new-char-open" onClick={() => setOpen(true)}>
        <UserPlus size={15} />
        {account ? "Nuevo personaje" : "Nueva cuenta"}
      </Action>
    );
  return (
    <div className="manage-character new-char">
      <h3>
        <UserPlus size={16} />
        {account ? `Nuevo personaje en ${account}` : "Nueva cuenta"}
      </h3>
      {!account && (
        <>
      <label className="field">
        <span>Cuenta</span>
        <input className="field-input" value={user} maxLength={10} autoComplete="off" onChange={(e) => setUser(e.target.value.trim())} />
      </label>
      <label className="field">
        <span>Clave</span>
        <input className="field-input" type="password" value={pass} maxLength={10} autoComplete="new-password" onChange={(e) => setPass(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />
        Ya tengo la cuenta (no registrarla)
      </label>
        </>
      )}
      {(account || existing) && (
        <div className="probe">
          <Action
            className="quiet"
            disabled={probing || (!account && (!/^[A-Za-z0-9]{4,10}$/.test(user) || !/^[!-~]{4,10}$/.test(pass)))}
            onClick={() => void probe()}
          >
            <Users size={15} />
            {probing ? "Buscando…" : "Buscar mis personajes"}
          </Action>
          {probeMsg && <p className="muted">{probeMsg}</p>}
          {found && found.length > 0 && (
            <div className="name-chips">
              {found.map((f) => (
                <button
                  key={f.name}
                  className={`chip ${known && char === f.name ? "active" : ""}`}
                  onClick={() => {
                    setCharExists(true);
                    setChar(f.name);
                  }}
                >
                  {f.name} · Nv. {f.level}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {(account || existing) && (
        <label className="check">
          <input type="checkbox" checked={charExists} onChange={(e) => {
            setCharExists(e.target.checked);
            if (e.target.checked && names.includes(char)) setChar("");
          }} />
          El personaje ya existe (entrar con él, no crearlo)
        </label>
      )}
      {!known && (
        <div className="field">
          <span>Clase</span>
          <Choice label="Clase" value={cls} onChange={(v) => setCls(v as CharClassKey)} items={classes} />
        </div>
      )}
      <label className="field">
        <span>{known ? "Nombre exacto del personaje" : "Nombre"}</span>
        <span className="input-action">
          <input className="field-input" value={char} maxLength={10} onChange={(e) => setChar(e.target.value.trim())} />
          {!known && (
            <Action className="quiet" aria-label="Otros nombres" onClick={() => void roll()}>
              <Dices size={15} />
            </Action>
          )}
        </span>
      </label>
      {!known && <div className="name-chips">
        {names.map((n) => (
          <button key={n} className={`chip ${n === char ? "active" : ""}`} onClick={() => setChar(n)}>
            {n}
          </button>
        ))}
      </div>}
      {problem && (user || pass || char) && <p className="warning">{problem}</p>}
      <p className="muted">
        {account ? "" : "La cuenta y la clave quedan en la base local (~/.mubot/mubot.db, solo en esta máquina). "}
        {known
          ? "Al conectar entra con ese personaje y queda en pausa. Si el nombre no está en la cuenta, no entra con otro: avisa."
          : "El personaje se crea al conectar y queda en pausa en Lorencia."}
      </p>
      <div className="manage-actions">
        <Action className="primary" disabled={busy || !!problem} onClick={() => void create()}>
          {busy ? "Guardando…" : known ? "Agregar personaje" : account || existing ? "Crear personaje" : "Crear cuenta y personaje"}
        </Action>
        <Action className="quiet" disabled={busy} onClick={() => setOpen(false)}>
          Cancelar
        </Action>
      </div>
    </div>
  );
}
type Account = { user: string; status: string; chars: Character[] };
const groupAccounts = (chars: Character[]): Account[] => {
  const m = new Map<string, Account>();
  for (const c of chars) {
    const k = c.user.toLowerCase();
    const a = m.get(k) ?? { user: c.user, status: c.account, chars: [] };
    a.chars.push(c);
    m.set(k, a);
  }
  return [...m.values()].sort((a, b) => a.user.localeCompare(b.user));
};
const classNames: Record<string, string> = { dk: "Dark Knight", dw: "Dark Wizard", elf: "Fairy Elf", mg: "Magic Gladiator" };
// Paso 1: elegir (o crear) una cuenta.
function AccountPicker({
  accounts,
  onPick,
  act,
}: {
  accounts: Account[];
  onPick: (user: string) => void;
  act: (r: StationRequest) => Promise<boolean>;
}) {
  return (
    <div className="picker">
      <span className="eyebrow">PASO 1 DE 2</span>
      <h1>Elegí una cuenta</h1>
      <div className="picker-list">
        {accounts.map((a) => (
          <button key={a.user} className="picker-card" onClick={() => onPick(a.user)}>
            <span className="avatar">
              <KeyRound size={15} />
            </span>
            <span className="picker-main">
              <strong>{a.user}</strong>
              <small>
                {a.chars.length} personaje{a.chars.length === 1 ? "" : "s"}: {a.chars.map((c) => c.char).join(", ")}
              </small>
            </span>
            <Badge state={a.status} />
            <ChevronRight size={15} />
          </button>
        ))}
        {!accounts.length && <p className="muted">Todavía no hay cuentas. Creá la primera.</p>}
      </div>
      <NewCharacter act={act} />
    </div>
  );
}
// Paso 2: elegir (o crear) un personaje de la cuenta.
function CharacterPicker({
  account,
  onBack,
  onPick,
  act,
}: {
  account: Account;
  onBack: () => void;
  onPick: (key: string) => void;
  act: (r: StationRequest) => Promise<boolean>;
}) {
  return (
    <div className="picker">
      <button className="picker-back" onClick={onBack}>
        <ChevronLeft size={15} />
        Cuentas
      </button>
      <span className="eyebrow">PASO 2 DE 2</span>
      <h1>
        {account.user} <Badge state={account.status} />
      </h1>
      {account.status === "blocked" && (
        <p className="warning">El server bloqueó esta cuenta (AccountBlocked): no va a poder entrar hasta que la desbloqueen.</p>
      )}
      <div className="picker-list">
        {account.chars.map((c) => (
          <button key={c.key} className="picker-card" onClick={() => onPick(c.key)}>
            <span className="avatar">{c.char.slice(0, 1)}</span>
            <span className="picker-main">
              <strong>{c.char}</strong>
              <small>
                {[c.cls && classNames[c.cls], c.game ? `${c.game.map} · Nivel ${fmt(c.game.level)}` : null].filter(Boolean).join(" · ") || "Elegilo para ver su panel"}
              </small>
            </span>
            <Badge state={c.status} />
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
      <NewCharacter act={act} account={account.user} />
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
  act: (r: StationRequest) => Promise<boolean>;
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
  // Sin nada elegido al abrir: primero la cuenta, después el personaje.
  const [account, setAccount] = useState("");
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState(() => read("estacion:tab", "panel"));
  const [open, setOpen] = useState(false);
  // Vista de escuadras (Squads.tsx): reemplaza el contenido mientras está abierta.
  const [squadsOpen, setSquadsOpen] = useState(false);
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
            s.chars.some((c: Character) => c.key === old) ? old : "",
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
      localStorage.setItem("estacion:tab", tab);
    } catch {}
  }, [tab]);
  async function act(body: StationRequest) {
    let msg = "La estación no contesta.";
    let ok = false;
    try {
      const r = await fetch("/api/do", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      msg = j.msg ?? msg;
      ok = r.ok && j.ok !== false;
    } catch {}
    if (!live.current) return ok;
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
    return ok;
  }
  const c = chars.find((c) => c.key === selected);
  const running = chars.filter((c) => c.pid != null);
  const accounts = groupAccounts(chars);
  const acc = accounts.find((a) => a.user.toLowerCase() === (c?.user ?? account).toLowerCase());
  const pick = (key: string) => {
    const x = chars.find((y) => y.key === key);
    if (x) setAccount(x.user);
    setSelected(key);
  };
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
              onClick={() => pick(x.key)}
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
        <button className={`button manage-trigger ${squadsOpen ? "primary" : ""}`} onClick={() => setSquadsOpen(!squadsOpen)} aria-pressed={squadsOpen}>
          <Shield size={16} />
          <span>Escuadras</span>
        </button>
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
                {accounts.map((a) => (
                  <section key={a.user} className="account-group">
                    <h3>
                      <KeyRound size={14} />
                      {a.user}
                      <Badge state={a.status} />
                    </h3>
                    {a.chars.map((x) => (
                      <ManageCharacter
                        key={x.key}
                        c={x}
                        selected={selected === x.key}
                        onSelect={() => {
                          pick(x.key);
                          setOpen(false);
                        }}
                        act={act}
                      />
                    ))}
                  </section>
                ))}
                {!chars.length && (
                  <p className="muted">
                    No hay cuentas todavía: creá una desde el inicio.
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
      {squadsOpen ? (
        <div className="station-content">
          <Squads />
        </div>
      ) : !c ? (
        <div className="station-content">
          {acc ? (
            <CharacterPicker account={acc} onBack={() => setAccount("")} onPick={pick} act={act} />
          ) : (
            <AccountPicker accounts={accounts} onPick={setAccount} act={act} />
          )}
        </div>
      ) : (
      <Tabs.Root
        className="station-content"
        value={tab}
        onValueChange={(v) => setTab(String(v))}
      >
        <div className="station-toolbar">
          <span className="muted breadcrumb">
            <button onClick={() => { setSelected(""); setAccount(""); }}>Cuentas</button>
            {" › "}
            <button onClick={() => setSelected("")}>{c.user}</button>
            {" › "}
            <strong>{c.char}</strong>
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
                    : `Conectá a ${c.char} para seguir su progreso en tiempo real.`}
                </p>
                {c.pid == null ? (
                  <ManageCharacter c={c} selected onSelect={() => {}} act={act} />
                ) : (
                  <Action className="primary" onClick={() => setOpen(true)}>
                    <Users size={16} />
                    Ver personajes
                  </Action>
                )}
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
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
