/** Vistas de un personaje (panel), consola y ranking. */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Plug, Search, Terminal, Trophy, UserRound } from "lucide-react";
import { Action, fmt } from "./components";
import knight from "../../assets/ui/knight-alpha.webp";
import { isOnline, isPaused, useToasts, type Actions, type Character, type StationData } from "./station-data";
import { Avatar, Card, Empty, RoleChip, RoleMenu, StatusPill } from "./station-kit";

/** Selector de personaje en fila (para Personaje y Consola). */
export function CharTabs({ chars, value, onChange }: { chars: Character[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="char-tabs" role="tablist" aria-label="Personaje">
      {chars.map((c) => (
        <button key={c.key} role="tab" aria-selected={c.key === value} className={c.key === value ? "on" : ""} onClick={() => onChange(c.key)}>
          <Avatar c={c} size={22} />
          {c.char}
        </button>
      ))}
    </div>
  );
}

export function CharacterView({ data, selected, onPick, actions, demo }: { data: StationData; selected: string; onPick: (key: string) => void; actions: Actions; demo: boolean }) {
  const c = data.chars.find((x) => x.key === selected);
  if (!c) {
    return (
      <Empty icon={<UserRound size={22} />} title="Elegí un personaje">
        {data.chars.length ? (
          <span className="pick-grid">
            {data.chars.map((x) => (
              <button key={x.key} className="pick-tile" onClick={() => onPick(x.key)}>
                <Avatar c={x} size={36} />
                <strong>{x.char}</strong>
                <StatusPill c={x} />
              </button>
            ))}
          </span>
        ) : (
          "Todavía no hay personajes: creá una cuenta."
        )}
      </Empty>
    );
  }
  return (
    <div className="character-view">
      <div className="char-bar">
        <CharTabs chars={data.chars} value={c.key} onChange={onPick} />
        <span className="grow" />
        <RoleMenu label={`Estrategia de ${c.char}`} current={c.role} onPick={(r) => void actions.setRole(c, r)} trigger={<RoleChip role={c.role.role} warp={c.role.role === "spot" ? c.role.warp : undefined} />} />
        {isOnline(c) ? (
          <>
            {isPaused(c) ? (
              <Action className="small" onClick={() => void actions.resume(c)}>Reanudar</Action>
            ) : (
              <Action className="quiet small" onClick={() => void actions.pause(c)}>Pausar</Action>
            )}
            <Action className="quiet small danger-text" onClick={() => void actions.disconnect(c)}>Desconectar</Action>
          </>
        ) : (
          <Action className="primary small" disabled={c.account === "blocked"} onClick={() => void actions.connect(c)}><Plug size={14} />Conectar</Action>
        )}
      </div>
      <div className="panel-frame">
        {c.panel && !demo ? (
          <iframe key={c.port} src={`http://127.0.0.1:${c.port}/panel`} title={`Panel de ${c.char}`} />
        ) : (
          <div className="welcome">
            <img src={knight} alt="Caballero con armadura y alas de cristal" />
            <div>
              <span className="eyebrow">{demo ? "MODO DEMO" : "PANEL DEL PERSONAJE"}</span>
              <h1>{demo ? "El panel en vivo no corre en la demo." : isOnline(c) ? "Preparando la aventura…" : `${c.char} está desconectado.`}</h1>
              <p>{demo ? "Con la estación real, acá va el panel completo con radar, inventario y chat." : isOnline(c) ? `Esperando el panel de ${c.char}.` : "Conectalo para seguir su progreso en tiempo real."}</p>
              {!isOnline(c) && !demo && (
                <Action className="primary" onClick={() => void actions.connect(c)}><Plug size={15} />Conectar</Action>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const lineTone = (l: string) =>
  /error|fall[óo]|rechaz|muri[óo]|died|bloquead|trabad|timeout/i.test(l) ? "bad" : /aviso|warn|reintent|espero|sin /i.test(l) ? "warn" : /dorado|golden|nivel|level|reset/i.test(l) ? "gold" : "";

export function ConsoleView({ data, selected, onPick }: { data: StationData; selected: string; onPick: (key: string) => void }) {
  const key = data.chars.some((c) => c.key === selected) ? selected : data.chars[0]?.key ?? "";
  const [log, setLog] = useState("");
  const [loading, setLoading] = useState(true);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { push } = useToasts();
  useEffect(() => {
    if (!key) return;
    let done = false;
    setLoading(true);
    const controller = new AbortController();
    async function poll() {
      try {
        const r = await fetch(`/api/log/${encodeURIComponent(key)}`, { signal: controller.signal, cache: "no-store" });
        if (!r.ok) throw Error();
        const t = await r.text();
        if (!done) setLog(t);
      } catch {
        if (!done) setLog("");
      }
      if (!done) setLoading(false);
    }
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      done = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [key]);
  const lines = useMemo(() => {
    const t = q.trim().toLowerCase();
    return log.split("\n").filter((l) => l && (!t || l.toLowerCase().includes(t)));
  }, [log, q]);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);
  if (!data.chars.length) return <Empty icon={<Terminal size={22} />} title="No hay consola" >Sin personajes todavía.</Empty>;
  return (
    <div className="console-view">
      <div className="char-bar">
        <CharTabs chars={data.chars} value={key} onChange={onPick} />
        <span className="grow" />
        <label className="search compact">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar líneas" aria-label="Filtrar la consola" />
        </label>
        <Action className={`quiet small ${follow ? "active" : ""}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title="Seguir lo último">
          <ArrowDownToLine size={14} />Seguir
        </Action>
        <Action className="quiet small icon" aria-label="Copiar la consola" title="Copiar" onClick={() => navigator.clipboard?.writeText(lines.join("\n")).then(() => push("Consola copiada.", "ok"), () => push("No pude copiar.", "bad"))}>
          <Copy size={14} />
        </Action>
      </div>
      <div className="console2" ref={ref} tabIndex={0} aria-label="Salida del bot" onScroll={(e) => { const t = e.currentTarget; if (t.scrollTop + t.clientHeight < t.scrollHeight - 40 && follow) setFollow(false); }}>
        {loading ? (
          <p className="muted">Cargando consola…</p>
        ) : lines.length === 0 ? (
          <p className="muted">{q ? "Ninguna línea coincide." : "Todavía no hay actividad."}</p>
        ) : (
          lines.map((l, i) => <div key={i} className={`line ${lineTone(l)}`}>{l}</div>)
        )}
      </div>
    </div>
  );
}

type RankingData = {
  resets?: { name: string; classNumber: number; totalResets: number; grandResets: number; level: number }[];
  elo?: { name: string; classNumber: number; elo: number; wins: number; losses: number }[];
  updatedAt?: string;
  error?: string;
};

export function RankingView({ mine }: { mine: string[] }) {
  const [data, setData] = useState<RankingData | null>(null);
  const [which, setWhich] = useState<"resets" | "elo">("resets");
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
    void load();
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
  if (!data) return <p className="muted pad">Cargando ranking…</p>;
  if (data.error) return <Empty icon={<Trophy size={22} />} title="No pude leer el ranking">{data.error}</Empty>;
  return (
    <div className="stack gap-lg">
      <div className="mine-row">
        {mine.map((n) => (
          <span key={n} className="mine-chip"><b>{n}</b><span>Resets #{where(resets, n) || "—"}</span><span>ELO #{where(elo, n) || "—"}</span></span>
        ))}
        {data.updatedAt && <small className="muted">Actualizado {new Date(data.updatedAt).toLocaleTimeString("es-AR")}</small>}
      </div>
      <div className="seg only-narrow" role="group" aria-label="Ranking">
        <button className={which === "resets" ? "on" : ""} aria-pressed={which === "resets"} onClick={() => setWhich("resets")}>Resets</button>
        <button className={which === "elo" ? "on" : ""} aria-pressed={which === "elo"} onClick={() => setWhich("elo")}>ELO de Arena</button>
      </div>
      <div className="view-grid two">
        <Card title="Resets" icon={<Trophy size={15} />} className={which === "resets" ? "" : "hide-narrow"}>
          <div className="table-wrap tall">
            <table className="data">
              <thead><tr><th>#</th><th>Personaje</th><th className="num">Resets</th><th className="num" title="Grand resets">GR</th><th className="num">Nivel</th></tr></thead>
              <tbody>
                {resets.slice(0, 50).map((r, i) => (
                  <tr key={r.name} className={isMine(r.name) ? "mine" : ""}><td>{i + 1}</td><td>{r.name}</td><td className="num">{fmt(r.totalResets)}</td><td className="num">{r.grandResets}</td><td className="num">{r.level}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="ELO de Arena" icon={<Trophy size={15} />} className={which === "elo" ? "" : "hide-narrow"}>
          <div className="table-wrap tall">
            <table className="data">
              <thead><tr><th>#</th><th>Personaje</th><th className="num">ELO</th><th className="num">G-P</th></tr></thead>
              <tbody>
                {elo.slice(0, 50).map((r, i) => (
                  <tr key={r.name} className={isMine(r.name) ? "mine" : ""}><td>{i + 1}</td><td>{r.name}</td><td className="num">{fmt(r.elo)}</td><td className="num">{r.wins}-{r.losses}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
