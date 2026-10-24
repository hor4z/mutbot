/**
 * La estación simple: personajes (conectar / desconectar), el mapa de cada conectado en tiempo real y los mensajes
 * entre ellos (dorados vistos, pedidos de ayuda, muertes). Los personajes con la cuenta bloqueada (baneados) no se
 * muestran. Cada mapa es el radar del propio bot (`/panel?mapa` en su puerto): no repite lógica.
 */
import { isOnline, isPaused, useActions, useStationData, type Character } from "./station-data";
import "./simple.css";

// Personajes que no se muestran aunque la cuenta esté activa (el server ya no deja conectar 3 a la vez).
const HIDDEN = new Set(["mortael"]);
const fmtExp = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e6)}M/min` : n >= 1e3 ? `${Math.round(n / 1e3)}k/min` : "0");
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 8);

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

function Shell() {
  const { data, loaded, error, refresh } = useStationData();
  const actions = useActions(refresh);
  const chars = data.chars.filter((c) => c.account !== "blocked" && !HIDDEN.has(c.key));
  const online = chars.filter((c) => isOnline(c) && c.panel);
  // Sin los avisos de subida de nivel: tapaban los dorados, los pedidos y las muertes.
  const msgs = data.alerts.filter((a) => a.kind !== "level").sort((a, b) => b.at - a.at).slice(0, 60);

  return (
    <div className="simple">
      <aside className="simple-list">
        <h1>MU / Estación</h1>
        <Invasion inv={data.invasion} now={data.now || Date.now()} />
        {error && <div className="simple-err">{error}</div>}
        {chars.map((c) => {
          const st = stateOf(c);
          return (
            <div key={c.key} className="simple-row">
              <div className="simple-head">
                <strong>{c.char}</strong>
                <span className={`simple-dot ${st.tone}`} title={st.text} />
                <small>{c.game ? `Nv. ${c.game.level} · ${c.game.map} · ${fmtExp(c.game.expPerMin)}` : st.text}</small>
              </div>
              {c.game && (
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
                <button className={isOnline(c) ? "stop" : "go"} disabled={st.tone === "wait"} onClick={() => void (isOnline(c) ? actions.disconnect(c) : actions.connect(c))}>
                  {isOnline(c) ? "Desconectar" : "Conectar"}
                </button>
              </div>
            </div>
          );
        })}
        {loaded && !chars.length && <p className="simple-empty">No hay personajes disponibles.</p>}
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
        {!online.length && <div className="simple-empty">Conectá un personaje para ver su mapa.</div>}
      </main>
    </div>
  );
}

export const SimpleStation = Shell;
