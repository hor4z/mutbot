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

/** Alta de una cuenta que ya existe en el juego: la estación cifra los datos y los manda por el worker. */
const CLASSES: [string, string][] = [["dk", "Dark Knight"], ["dw", "Dark Wizard"], ["elf", "Fairy Elf"], ["mg", "Magic Gladiator"]];
type Tab = "cuenta" | "personaje" | "existente";

/**
 * Altas en dos pasos: 1) crear la cuenta en el juego (el worker la registra; queda guardada sin personaje y sin tarjeta) y
 * 2) crear su personaje (nombre y clase; el bot lo crea al conectarlo). La tercera pestaña es para lo que ya existe.
 */
function AccountsModal({ free, preset, defaultServer, onClose }: { free: string[]; preset: { user: string; char: string } | null; defaultServer: Srv; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(preset || free.length ? "personaje" : "cuenta");
  const [f, setF] = useState({ user: preset?.user ?? "", char: preset?.char ?? "", pass: "", cls: "", server: defaultServer });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = (t: Tab) => { setTab(t); setRes(null); };
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const user = tab === "personaje" ? (preset?.user ?? (f.user || free[0] || "")) : f.user;
    const r = tab === "cuenta" ? await postCuenta({ user, pass: f.pass }) : tab === "personaje" ? await postPersonaje({ user, char: f.char, cls: f.cls, server: f.server as "fast" | "slow", ...(preset ? { replace: preset.char } : {}) }) : await postAlta({ user, char: f.char, pass: f.pass, cls: f.cls || undefined });
    setBusy(false);
    if (!r.ok) return setRes(r);
    if (tab === "cuenta") { setF({ user: "", char: "", pass: "", cls: "", server: f.server }); setTab("personaje"); setRes(r); } // sigue el paso 2
    else onClose(); // el aviso queda en "Mensajes"
  }
  const info = tab === "cuenta" ? "Paso 1: crea la cuenta en el juego (por el worker). Todavía no aparece en la lista: falta el personaje."
    : tab === "personaje" ? preset ? "El personaje todavía no existe en el juego. Podés cambiarle el nombre y elegir la clase: el bot lo crea la primera vez que lo conectás." : "Paso 2: el personaje de una cuenta sin personaje. El bot lo crea en el juego la primera vez que lo conectás."
    : "Cuenta ya creada en el juego: se cifra y pasa por el worker. Si el personaje todavía no existe, elegí su clase y el bot lo crea al conectarlo.";
  return (
    <div className="simple-modal" role="dialog" aria-modal="true" aria-label="Agregar cuenta" onClick={onClose}>
      <form className="simple-modal-box" onClick={(e) => e.stopPropagation()} onSubmit={submit} autoComplete="off">
        <h2>Agregar cuenta</h2>
        <div className="simple-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "cuenta"} onClick={() => go("cuenta")}>1. Cuenta</button>
          <button type="button" role="tab" aria-selected={tab === "personaje"} onClick={() => go("personaje")}>2. Personaje{free.length ? ` (${free.length})` : ""}</button>
          <button type="button" role="tab" aria-selected={tab === "existente"} onClick={() => go("existente")}>Ya existe</button>
        </div>
        <small>{info}</small>
        {tab === "personaje" && preset ? (
          <label>Cuenta<input value={preset.user} readOnly /></label>
        ) : tab === "personaje" ? (
          free.length ? (
            <label>Cuenta
              <select value={f.user || free[0]} onChange={set("user")}>{free.map((u) => <option key={u} value={u}>{u}</option>)}</select>
            </label>
          ) : <div className="simple-err">No hay cuentas sin personaje: creá una en el paso 1.</div>
        ) : (
          <label>Usuario<input value={f.user} onChange={set("user")} required maxLength={10} pattern={tab === "cuenta" ? "[A-Za-z0-9]{4,10}" : "[A-Za-z0-9_]{1,10}"} autoComplete="off" /></label>
        )}
        {tab !== "cuenta" && <label>Personaje<input value={f.char} onChange={set("char")} required maxLength={10} pattern="[A-Za-z0-9_]{1,10}" autoComplete="off" /></label>}
        {tab === "personaje" && (
          <label>Servidor
            <select value={f.server} onChange={set("server")}>
              <option value="fast">Fast</option>
              <option value="slow">Slow</option>
            </select>
            <small>La cuenta vale en los dos servidores; el personaje se crea en el que elijas.</small>
          </label>
        )}
        {tab !== "cuenta" && (
          <label>{tab === "existente" ? "Clase (solo si el personaje no existe todavía)" : "Clase"}
            <select value={f.cls} onChange={set("cls")} required={tab === "personaje"}>
              {tab === "existente" ? <option value="">Ya existe: no crear</option> : <option value="" disabled>Elegí una clase</option>}
              {CLASSES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
            {f.cls === "mg" && <small>El Magic Gladiator pide un personaje de nivel alto en la misma cuenta: en una cuenta nueva el servidor puede rechazarlo.</small>}
          </label>
        )}
        {tab !== "personaje" && <label>Contraseña<input type="password" value={f.pass} onChange={set("pass")} required maxLength={tab === "cuenta" ? 10 : 64} minLength={tab === "cuenta" ? 4 : 1} autoComplete="new-password" /></label>}
        {res && <div className={res.ok ? "simple-ok" : "simple-err"}>{res.msg}</div>}
        <div className="simple-btns">
          <button type="button" className="pause" onClick={onClose}>Cerrar</button>
          <button type="submit" className="go" disabled={busy || (tab === "personaje" && !preset && !free.length)}>{busy ? "Enviando…" : tab === "cuenta" ? "Crear cuenta" : tab === "personaje" ? "Crear personaje" : "Agregar"}</button>
        </div>
      </form>
    </div>
  );
}

function Shell() {
  const [altaOpen, setAltaOpen] = useState(false);
  const [preset, setPreset] = useState<{ user: string; char: string } | null>(null);
  const { data, loaded, error, refresh } = useStationData();
  const actions = useActions(refresh);
  // Cada servidor es un mundo aparte (otros personajes, mapas, mensajes): una pestaña por servidor, con su propia escuadra.
  const [srv, setSrv] = useState<Srv>(() => { try { return localStorage.getItem("srv") === "slow" ? "slow" : "fast"; } catch { return "fast"; } });
  const pickSrv = (s: Srv) => { setSrv(s); try { localStorage.setItem("srv", s); } catch { /* sin almacenamiento: no pasa nada */ } };
  const all = data.chars.filter((c) => c.account !== "blocked" && !HIDDEN.has(c.key));
  const chars = all.filter((c) => c.server === srv);
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
        <h1>MU / Estación</h1>
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
              <label className="simple-conn" title="Las cuentas valen en los dos servidores, pero cada personaje es de uno. Se aplica al próximo conectar.">
                Servidor
                <select value={c.server} onChange={(e) => void actions.server(c, e.target.value as "fast" | "slow")}>
                  <option value="fast">Fast</option>
                  <option value="slow">Slow</option>
                </select>
              </label>
              <label className="simple-conn" title="Directa: el bot habla con el servidor. Proxy: pasa por el worker de Cloudflare. Se aplica al próximo conectar.">
                Conexión
                <select value={c.conn} onChange={(e) => void actions.conn(c, e.target.value as "direct" | "proxy")}>
                  <option value="direct">Directa</option>
                  <option value="proxy" disabled={!c.proxyReady}>Proxy{c.proxyReady ? "" : " (sin configurar)"}</option>
                </select>
              </label>
              {sibling && <small className="simple-wait">La cuenta la usa {sibling.char}: desconectala para jugar con {c.char}.</small>}
              {c.stuck && <small className="simple-err">⚠ Trabado: no avanza hace rato.</small>}
              {c.status === "failed" && <small className="simple-err">{c.msg}</small>}
              {c.status === "failed" && /no tiene ese personaje/.test(c.msg) && (
                <button className="pause" onClick={() => { setPreset({ user: c.user, char: c.char }); setAltaOpen(true); }} title="El bot lo crea en el juego al conectarlo">Crear personaje…</button>
              )}
              {c.serverUsed && c.serverUsed !== c.server && <small className="simple-wait">Ahora conectado al {c.serverUsed === "slow" ? "Slow" : "Fast"}; el cambio se aplica al reconectar.</small>}
              {c.connUsed && c.connUsed !== c.conn && <small className="simple-wait">Ahora conectado {c.connUsed === "proxy" ? "por proxy" : "directo"}; el cambio se aplica al reconectar.</small>}
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
        <button className="simple-add" onClick={() => { setPreset(null); setAltaOpen(true); }}>+ Agregar cuenta</button>
        {altaOpen && <AccountsModal free={data.freeAccounts} preset={preset} defaultServer={srv} onClose={() => setAltaOpen(false)} />}
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
