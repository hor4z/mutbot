/** Alta de cuenta y personaje en dos pasos: 1) la cuenta, 2) el personaje. */
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeft, ArrowRight, Dices, Search, UserPlus, X } from "lucide-react";
import type { CharClassKey, RoleKey, StationRequest } from "../../estacion-logic";
import { ROLES } from "../../estacion-logic";
import { Action, Choice } from "./components";
import { classNames, post, useToasts, type Character } from "./station-data";
import { roleIcon } from "./station-kit";

type Mode = "new" | "have" | "saved";
const MODES: { value: Mode; title: string; hint: string }[] = [
  { value: "new", title: "Cuenta nueva", hint: "Se registra en el server." },
  { value: "have", title: "Ya tengo cuenta", hint: "Solo la guardo acá." },
  { value: "saved", title: "Cuenta guardada", hint: "Sumo otro personaje." },
];
const CLASSES: { value: CharClassKey; note: string }[] = [
  { value: "dk", note: "Cuerpo a cuerpo" },
  { value: "dw", note: "Magia a distancia" },
  { value: "elf", note: "Arquero y apoyo" },
  { value: "mg", note: "Pide un personaje alto" },
];
type StartRole = Exclude<RoleKey, "spot">;
const START_ROLES: StartRole[] = ["route", "golden", "explorer", "support"];
const okUser = (u: string) => /^[A-Za-z0-9]{4,10}$/.test(u);
const okPass = (p: string) => /^[!-~]{4,10}$/.test(p);

export function NewAccount({ open, onOpenChange, chars, onDone, refresh }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  chars: Character[];
  onDone: (key: string) => void;
  refresh: () => void;
}) {
  const { push } = useToasts();
  const accounts = useMemo(() => [...new Set(chars.map((c) => c.user))].sort(), [chars]);
  const [step, setStep] = useState<1 | 2>(1);
  const [mode, setMode] = useState<Mode>("new");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [saved, setSaved] = useState("");
  const [exists, setExists] = useState(false);
  const [found, setFound] = useState<{ name: string; level: number }[] | null>(null);
  const [probeMsg, setProbeMsg] = useState("");
  const [probing, setProbing] = useState(false);
  const [cls, setCls] = useState<CharClassKey>("dk");
  const [char, setChar] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [role, setRole] = useState<StartRole>("route");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const account = mode === "saved" ? saved : user;
  // Al abrir: de cero.
  useEffect(() => {
    if (!open) return;
    setStep(1); setMode(accounts.length && !chars.length ? "saved" : "new"); setUser(""); setPass(""); setSaved(accounts[0] ?? "");
    setExists(false); setFound(null); setProbeMsg(""); setChar(""); setNames([]); setError(""); setRole("route"); setCls("dk");
  }, [open]);
  const known = mode !== "new" && exists;
  const step1ok = mode === "saved" ? !!saved : okUser(user) && okPass(pass);
  const charOk = /^[A-Za-z0-9]{4,10}$/.test(char);

  async function roll() {
    try {
      const r = await fetch("/api/names", { cache: "no-store" });
      const j = (await r.json()) as { names: string[] };
      setNames(j.names);
      setChar((old) => old || j.names[0] || "");
    } catch {}
  }
  useEffect(() => {
    if (open && step === 2 && !names.length) void roll();
  }, [open, step]);

  async function probe() {
    setProbing(true);
    setFound(null);
    setProbeMsg("Entrando a la cuenta para ver tus personajes…");
    const r = await post(mode === "saved" ? { action: "probe", user: saved } : { action: "probe", user, pass });
    setProbeMsg(r.msg);
    setProbing(false);
    if (r.ok) setFound((r.body?.chars as { name: string; level: number }[] | undefined) ?? []);
  }

  async function create() {
    setBusy(true);
    setError("");
    const c = known ? null : cls;
    const body: StationRequest = mode === "saved"
      ? { action: "add", user: saved, char, cls: c }
      : { action: "create", user, pass, char, cls: c, existing: mode === "have" };
    const r = await post(body);
    if (r.ok) {
      await post({ action: "role", char: char.toLowerCase(), role: { role } });
      push(r.msg, "ok");
      refresh();
      onOpenChange(false);
      onDone(char.toLowerCase());
    } else setError(r.msg);
    setBusy(false);
  }

  const summary = known
    ? "Entra con ese personaje y queda en pausa. Si el nombre no está en la cuenta, avisa en vez de crear otro."
    : "El personaje se crea al conectar y queda en pausa en Lorencia. Reanudalo cuando quieras.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="modal wizard">
          <header className="modal-head">
            <div>
              <span className="eyebrow">PASO {step} DE 2</span>
              <Dialog.Title>{step === 1 ? "Elegí la cuenta" : "Armá el personaje"}</Dialog.Title>
              <Dialog.Description>{step === 1 ? "Sin tocar el juego: la estación hace el resto." : `Cuenta ${account}${known ? "" : " · se crea al conectar"}.`}</Dialog.Description>
            </div>
            <Dialog.Close className="button quiet icon" aria-label="Cerrar"><X size={16} /></Dialog.Close>
          </header>

          <div className="modal-body">
            {step === 1 ? (
              <>
                <div className="mode-grid" role="radiogroup" aria-label="Tipo de cuenta">
                  {MODES.map((m) => (
                    <button key={m.value} role="radio" aria-checked={mode === m.value} disabled={m.value === "saved" && !accounts.length} className={`mode ${mode === m.value ? "on" : ""}`} onClick={() => { setMode(m.value); setExists(m.value === "saved" ? false : false); }}>
                      <strong>{m.title}</strong>
                      <small>{m.hint}</small>
                    </button>
                  ))}
                </div>
                {mode === "saved" ? (
                  <div className="field"><span>Cuenta</span><Choice label="Cuenta guardada" value={saved} onChange={setSaved} items={accounts.map((a) => ({ value: a, label: a }))} /></div>
                ) : (
                  <>
                    <label className="field">
                      <span>Cuenta</span>
                      <input className="field-input" value={user} maxLength={10} autoComplete="off" autoFocus aria-invalid={!!user && !okUser(user)} onChange={(e) => setUser(e.target.value.trim())} />
                      <small className={user && !okUser(user) ? "bad" : ""}>4 a 10 letras o números.</small>
                    </label>
                    <label className="field">
                      <span>Clave</span>
                      <input className="field-input" type="password" value={pass} maxLength={10} autoComplete="new-password" aria-invalid={!!pass && !okPass(pass)} onChange={(e) => setPass(e.target.value)} />
                      <small className={pass && !okPass(pass) ? "bad" : ""}>4 a 10 caracteres visibles, sin espacios. Queda guardada solo en esta máquina.</small>
                    </label>
                  </>
                )}
              </>
            ) : (
              <>
                {mode !== "new" && (
                  <div className="probe">
                    <label className="check-line">
                      <input type="checkbox" checked={exists} onChange={(e) => { setExists(e.target.checked); if (e.target.checked && names.includes(char)) setChar(""); }} />
                      El personaje ya existe en la cuenta (entrar con él, no crearlo)
                    </label>
                    <Action className="quiet small" disabled={probing} onClick={() => void probe()}><Search size={14} />{probing ? "Buscando…" : "Buscar mis personajes"}</Action>
                    {probeMsg && <p className="muted">{probeMsg}</p>}
                    {found && found.length > 0 && (
                      <div className="chips">
                        {found.map((f) => (
                          <button key={f.name} className={`chip ${known && char === f.name ? "on" : ""}`} onClick={() => { setExists(true); setChar(f.name); }}>
                            {f.name} · Nv. {f.level}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!known && (
                  <div className="field">
                    <span>Clase</span>
                    <div className="class-grid" role="radiogroup" aria-label="Clase">
                      {CLASSES.map((k) => (
                        <button key={k.value} role="radio" aria-checked={cls === k.value} className={`mode ${cls === k.value ? "on" : ""}`} onClick={() => setCls(k.value)}>
                          <strong>{classNames[k.value]}</strong>
                          <small>{k.note}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="field">
                  <span>{known ? "Nombre exacto del personaje" : "Nombre"}</span>
                  <span className="input-row">
                    <input className="field-input" value={char} maxLength={10} aria-invalid={!!char && !charOk} onChange={(e) => setChar(e.target.value.trim())} />
                    {!known && <Action className="quiet icon" aria-label="Otros nombres" title="Otros nombres" onClick={() => void roll()}><Dices size={15} /></Action>}
                  </span>
                  <small className={char && !charOk ? "bad" : ""}>4 a 10 letras o números.</small>
                </label>
                {!known && names.length > 0 && (
                  <div className="chips">
                    {names.map((n) => <button key={n} className={`chip ${n === char ? "on" : ""}`} onClick={() => setChar(n)}>{n}</button>)}
                  </div>
                )}
                <div className="field">
                  <span>Estrategia inicial</span>
                  <div className="role-pick" role="radiogroup" aria-label="Estrategia inicial">
                    {START_ROLES.map((k) => (
                      <button key={k} role="radio" aria-checked={role === k} className={`chip ${role === k ? "on" : ""}`} title={ROLES[k].hint} onClick={() => setRole(k)}>
                        {roleIcon[k](13)}{ROLES[k].short}
                      </button>
                    ))}
                  </div>
                  <small>{ROLES[role].hint}</small>
                </div>
                <p className="note">{summary}</p>
              </>
            )}
            {error && <p className="alert-line" role="alert">{error}</p>}
          </div>

          <footer className="modal-foot">
            {step === 2 ? (
              <Action className="quiet" onClick={() => setStep(1)} disabled={busy}><ArrowLeft size={15} />Atrás</Action>
            ) : (
              <Dialog.Close className="button quiet">Cancelar</Dialog.Close>
            )}
            <span className="grow" />
            {step === 1 ? (
              <Action className="primary" disabled={!step1ok} onClick={() => setStep(2)}>Siguiente<ArrowRight size={15} /></Action>
            ) : (
              <Action className="primary" disabled={busy || !charOk} onClick={() => void create()}>
                <UserPlus size={15} />
                {busy ? "Guardando…" : known ? "Agregar personaje" : mode === "new" ? "Crear cuenta y personaje" : "Crear personaje"}
              </Action>
            )}
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
