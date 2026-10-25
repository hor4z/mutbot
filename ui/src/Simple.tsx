/**
 * La estación simple: personajes (conectar / desconectar), el mapa de cada conectado en tiempo real y los mensajes
 * entre ellos (dorados vistos, pedidos de ayuda, muertes). Los personajes con la cuenta bloqueada (baneados) no se
 * muestran. Cada mapa es el radar del propio bot (`/panel?mapa` en su puerto): no repite lógica.
 */
import type { Alert } from "../../estacion-logic";
import { useState, type FormEvent } from "react";
import { isOnline, isPaused, postAlta, postCuenta, postPersonaje, useActions, useStationData, type Character, type Result } from "./station-data";
import "./simple.css";

// Personajes que no se muestran aunque la cuenta esté activa (el server ya no deja conectar 3 a la vez).
const HIDDEN = new Set(["mortael"]);
const fmtExp = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e6)}M/min` : n >= 1e3 ? `${Math.round(n / 1e3)}k/min` : "0");
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 8);

type Srv = "fast" | "slow";
const SRV_NAME: Record<Srv, string> = { fast: "Fast", slow: "Slow" };
function stateOf(c: Character): { text: string; tone: "on" | "wait" | "off" } {
  if (c.status === "on") return { text: "Conectado", tone: "on" };
  if (c.status === "starting") return { text: "Conectando…", tone: "wait" };
  if (c.status === "stopping") return { text: "Desconectando…", tone: "wait" };
  if (c.status === "in-use") return { text: "Cuenta abierta en otro lado", tone: "off" };
  return { text: "Desconectado", tone: "off" };
}

function Invasion({ inv, now }: { inv: NonNullable<ReturnType<typeof useStationData>["data"]["invasion"]> | null; now: number }) {
  if (inv?.status === "active")
    return <div className="simple-inv on">Invasión: {inv.total} dorados vivos{inv.maps.length ? ` · ${inv.maps.map((m) => `${m.name} ${m.alive}`).join(" · ")}` : ""}</div>;
  const next = inv?.nextAt ?? 0;
  const mins = next > now ? Math.ceil((next - now) / 60_000) : null;
  return <div className="simple-inv">{mins != null ? `Próxima invasión en ${mins} min (a las :50)` : "Sin invasión activa"}</div>;
}

const CLASSES: [string, string][] = [["dk", "Dark Knight"], ["dw", "Dark Wizard"], ["elf", "Fairy Elf"], ["mg", "Magic Gladiator"]];

/**
 * Cuenta (compartida entre los dos servidores): se crea en el juego por el worker o, si ya existe, solo se guarda en la estación.
 * No lleva servidor ni personaje: los personajes se crean después, dentro de la pestaña de cada servidor.
 */
function AccountModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ user: "", pass: "", existing: false });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await postCuenta({ user: f.user, pass: f.pass, ...(f.existing ? { existing: true } : {}) });
    setBusy(false);
    if (r.ok) onClose(); else setRes(r);
  }
  return (
    <div className="simple-modal" role="dialog" aria-modal="true" aria-label="Agregar cuenta" onClick={onClose}>
      <form className="simple-modal-box" onClick={(e) => e.stopPropagation()} onSubmit={submit} autoComplete="off">
        <h2>Agregar cuenta</h2>
        <small>La cuenta vale en los dos servidores. Después, en la pestaña Fast o Slow, le creás sus personajes.</small>
        <label className="simple-check"><input type="checkbox" checked={f.existing} onChange={(e) => setF({ ...f, existing: e.target.checked })} /> Ya existe en el juego (solo guardarla)</label>
        <label>Usuario<input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} required maxLength={10} pattern={f.existing ? "[A-Za-z0-9_]{1,10}" : "[A-Za-z0-9]{4,10}"} autoComplete="off" /></label>
        <label>Contraseña<input type="password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} required maxLength={f.existing ? 64 : 10} minLength={f.existing ? 1 : 4} autoComplete="new-password" /></label>
        {res && <div className={res.ok ? "simple-ok" : "simple-err"}>{res.msg}</div>}
        <div className="simple-btns">
          <button type="button" className="pause" onClick={onClose}>Cerrar</button>
          <button type="submit" className="go" disabled={busy}>{busy ? "Enviando…" : f.existing ? "Guardar cuenta" : "Crear cuenta"}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Personaje en el servidor de la pestaña (fijo): de una cuenta ya guardada, con nombre y clase (el bot lo crea al conectarlo) o, si ya
 * existe en el juego, solo el nombre. `preset`: la tarjeta que falló por "no tiene ese personaje" (cuenta y nombre ya puestos).
 */
function CharacterModal({ server, accounts, preset, onClose }: { server: Srv; accounts: { user: string; n: number }[]; preset: { user: string; char: string } | null; onClose: () => void }) {
  const open = accounts; // sin tope de personajes por cuenta
  const [f, setF] = useState({ user: preset?.user ?? open[0]?.user ?? "", char: preset?.char ?? "", cls: "", existing: false });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await postPersonaje({ user: f.user, char: f.char, cls: f.existing ? "" : f.cls, server, ...(f.existing ? { existing: true } : {}), ...(preset ? { replace: preset.char } : {}) });
    setBusy(false);
    if (r.ok) onClose(); else setRes(r); // el aviso queda en "Mensajes"
  }
  return (
    <div className="simple-modal" role="dialog" aria-modal="true" aria-label={`Agregar personaje al ${SRV_NAME[server]}`} onClick={onClose}>
      <form className="simple-modal-box" onClick={(e) => e.stopPropagation()} onSubmit={submit} autoComplete="off">
        <h2>Personaje en el {SRV_NAME[server]}</h2>
        <small>{preset ? "El personaje todavía no existe en el juego. Podés cambiarle el nombre y elegir la clase: el bot lo crea la primera vez que lo conectás." : `Se crea en el ${SRV_NAME[server]} (la cuenta vale en los dos). El bot lo crea en el juego la primera vez que lo conectás.`}</small>
        {preset ? <label>Cuenta<input value={preset.user} readOnly /></label> : open.length ? (
          <label>Cuenta
            <select value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })}>
              {open.map((a) => <option key={a.user} value={a.user}>{a.user} ({a.n} en el {SRV_NAME[server]})</option>)}
            </select>
          </label>
        ) : <div className="simple-err">No hay cuentas con lugar: agregá una desde "+ Cuenta" arriba.</div>}
        <label>Personaje<input value={f.char} onChange={(e) => setF({ ...f, char: e.target.value })} required maxLength={10} pattern="[A-Za-z0-9_]{1,10}" autoComplete="off" /></label>
        {!preset && <label className="simple-check"><input type="checkbox" checked={f.existing} onChange={(e) => setF({ ...f, existing: e.target.checked })} /> Ya existe en el juego (no crear)</label>}
        {!f.existing && (
          <label>Clase
            <select value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })} required>
              <option value="" disabled>Elegí una clase</option>
              {CLASSES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
            {f.cls === "mg" && <small>El Magic Gladiator pide un personaje de nivel alto en la misma cuenta: en una cuenta nueva el servidor puede rechazarlo.</small>}
          </label>
        )}
        {res && <div className={res.ok ? "simple-ok" : "simple-err"}>{res.msg}</div>}
        <div className="simple-btns">
          <button type="button" className="pause" onClick={onClose}>Cerrar</button>
          <button type="submit" className="go" disabled={busy || (!preset && !open.length)}>{busy ? "Enviando…" : "Agregar personaje"}</button>
        </div>
      </form>
    </div>
  );
}

function Shell() {
  const [accountOpen, setAccountOpen] = useState(false);
  const [charOpen, setCharOpen] = useState(false);
  const [preset, setPreset] = useState<{ user: string; char: string } | null>(null);
  const { data, loaded, error, refresh } = useStationData();
  const actions = useActions(refresh);
  // Cada servidor es un mundo aparte (otros personajes, mapas, mensajes): una pestaña por servidor, con su propia escuadra.
  const [srv, setSrv] = useState<Srv>(() => { try { return localStorage.getItem("srv") === "slow" ? "slow" : "fast"; } catch { return "fast"; } });
  const pickSrv = (s: Srv) => { setSrv(s); try { localStorage.setItem("srv", s); } catch { /* sin almacenamiento: no pasa nada */ } };
  const all = data.chars.filter((c) => c.account !== "blocked" && !HIDDEN.has(c.key));
  const chars = all.filter((c) => c.server === srv);
  // Cuentas compartidas: todas las que hay (con o sin personajes) y cuántos personajes tienen en el servidor de la pestaña.
  const accounts = [...new Set([...all.map((c) => c.user), ...data.freeAccounts])].map((user) => ({ user, n: all.filter((c) => c.user === user && c.server === srv).length })).sort((a, b) => a.n - b.n || a.user.localeCompare(b.user));
  const srvOfChar = new Map(all.map((c) => [c.char, c.server] as const));
  const summary = (s: Srv) => {
    const on = all.filter((c) => c.server === s && isOnline(c));
    return { on: on.length, stuck: on.filter((c) => c.stuck).length, exp: on.reduce((n, c) => n + (c.game?.expPerMin ?? 0), 0) };
  };
  // El mapa solo cuando el personaje ya entró al juego: mientras conecta (o espera cupo) no hay nada que mostrar.
  const inGame = (c: Character) => c.game != null && c.game.mode !== "connecting";
  const online = chars.filter((c) => isOnline(c) && c.panel && inGame(c));
  // Las subidas de nivel tapaban lo importante: de ellas queda solo la última de cada personaje.
  const lastLevel = new Map<string, Alert>();
  for (const a of data.alerts) if (a.kind === "level" && a.char && (lastLevel.get(a.char)?.at ?? 0) < a.at) lastLevel.set(a.char, a);
  // Los mensajes de un personaje van a la pestaña de su servidor; los generales (invasiones) son del Fast.
  const mine = (a: Alert) => (a.char ? srvOfChar.get(a.char) === srv : srv === "fast");
  const msgs = [...data.alerts.filter((a) => a.kind !== "level"), ...lastLevel.values()].filter(mine).sort((a, b) => b.at - a.at).slice(0, 60);

  return (
    <div className="simple">
      <aside className="simple-list">
        <div className="simple-top"><h1>MU / Estación</h1><button className="simple-acc" onClick={() => setAccountOpen(true)} title="Las cuentas son compartidas entre los dos servidores">+ Cuenta</button></div>
        <div className="simple-tabs" role="tablist">
          {(["fast", "slow"] as Srv[]).map((s) => {
            const t = summary(s);
            return (
              <button key={s} role="tab" aria-selected={srv === s} className={srv === s ? "on" : ""} onClick={() => pickSrv(s)} title={`${t.on} conectados${t.stuck ? `, ${t.stuck} trabados` : ""}`}>
                {SRV_NAME[s]} <small>{t.on}{t.stuck ? ` · ⚠ ${t.stuck}` : ""}</small>
              </button>
            );
          })}
        </div>
        {srv === "fast" ? <Invasion inv={data.invasion} now={data.now || Date.now()} /> : <div className="simple-inv">{summary("slow").on ? `Total del Slow: ${fmtExp(summary("slow").exp)}` : "Sin personajes del Slow conectados"}</div>}
        {error && <div className="simple-err">{error}</div>}
        {chars.map((c) => {
          const st = stateOf(c);
          // Una cuenta juega con un solo personaje a la vez: si otro de la misma cuenta está conectado, este no se puede conectar.
          const sibling = isOnline(c) ? undefined : all.find((o) => o !== c && o.user === c.user && isOnline(o));
          return (
            <div key={c.key} className="simple-row">
              <div className="simple-head">
                <strong>{c.char}</strong>
                <span className={`simple-dot ${st.tone}`} title={st.text} />
                <small>{c.game && inGame(c) ? `Nv. ${c.game.level} · ${c.game.map} · ${fmtExp(c.game.expPerMin)}` : st.text}</small>
              </div>
              {isOnline(c) && (c.shadowOf || c.shadowOff) && (
                <label className="simple-shadow" title="El orquestador manda al más débil a seguir al más fuerte por todos los mapas">
                  <input type="checkbox" checked={!c.shadowOff} onChange={(e) => void actions.shadow(c, e.target.checked)} />
                  {c.shadowOf ? `Sombra de ${c.shadowOf}` : "Seguir al más fuerte"}
                </label>
              )}
              {sibling && <small className="simple-wait">La cuenta la usa {sibling.char}: desconectala para jugar con {c.char}.</small>}
              {c.stuck && <small className="simple-err">⚠ Trabado: no avanza hace rato.</small>}
              {c.status === "failed" && <small className="simple-err">{c.msg}</small>}
              {c.status === "failed" && /no tiene ese personaje/.test(c.msg) && (
                <button className="pause" onClick={() => { setPreset({ user: c.user, char: c.char }); setCharOpen(true); }} title="El bot lo crea en el juego al conectarlo">Crear personaje…</button>
              )}
              {c.game && !inGame(c) && isOnline(c) && <small className="simple-doing simple-wait">{c.game.doing}</small>}
              {c.game && inGame(c) && (
                <>
                  <div className="simple-hp" title={`Vida ${c.game.hp[0]} / ${c.game.hp[1]}`}><i style={{ width: `${c.game.hp[1] > 0 ? Math.max(0, Math.min(100, (100 * c.game.hp[0]) / c.game.hp[1])) : 0}%` }} /></div>
                  <small>{c.game.resets != null ? `${c.game.resets} resets · ` : ""}{c.game.session ? `${c.game.session.kills} kills · ${c.game.session.deaths} muertes` : ""}</small>
                  <small className="simple-doing">{c.game.doing}</small>
                </>
              )}
              <div className="simple-btns">
                {isOnline(c) && (
                  <button className="pause" disabled={st.tone === "wait"} onClick={() => void (isPaused(c) ? actions.resume(c) : actions.pause(c))}>
                    {isPaused(c) ? "Reanudar" : "Pausar"}
                  </button>
                )}
                {/* Mientras espera cupo ("Conectando…") se puede reintentar ya o dejar de intentar. */}
                {c.status === "starting" && c.game?.mode === "connecting" && (
                  <button className="pause" onClick={() => void actions.retry(c)} title="Corta el intento actual y vuelve a probar sin esperar">Reintentar ahora</button>
                )}
                <button className={isOnline(c) ? "stop" : "go"} disabled={(st.tone === "wait" && c.status !== "starting") || !!sibling} onClick={() => void (isOnline(c) ? actions.disconnect(c) : actions.connect(c))}>
                  {c.status === "starting" ? "Cancelar" : isOnline(c) ? "Desconectar" : "Conectar"}
                </button>
              </div>
            </div>
          );
        })}
        {loaded && !chars.length && <p className="simple-empty">No hay personajes en el {SRV_NAME[srv]}. Se agregan con "+ Agregar cuenta" y se mueven con el selector Servidor de cada tarjeta.</p>}
        <button className="simple-add" onClick={() => { setPreset(null); setCharOpen(true); }}>+ Personaje en el {SRV_NAME[srv]}</button>
        {charOpen && <CharacterModal server={srv} accounts={accounts} preset={preset} onClose={() => setCharOpen(false)} />}
        {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
        <h2>Mensajes</h2>
        <div className="simple-msgs">
          {msgs.map((m) => (
            <div key={m.id} className={`simple-msg ${m.tone}`}>
              <time>{hhmm(m.at)}</time> {m.text}
            </div>
          ))}
          {!msgs.length && <p className="simple-empty">Sin mensajes todavía.</p>}
        </div>
      </aside>
      <main className={`simple-maps n${Math.min(online.length, 4)}`}>
        {online.map((c) => (
          <section key={c.key} className="simple-map">
            <header>{c.char}</header>
            <iframe src={`http://127.0.0.1:${c.port}/panel?mapa`} title={`Mapa de ${c.char}`} />
          </section>
        ))}
        {!online.length && <div className="simple-empty">Conectá un personaje del {SRV_NAME[srv]} para ver su mapa.</div>}
      </main>
    </div>
  );
}

export const SimpleStation = Shell;
