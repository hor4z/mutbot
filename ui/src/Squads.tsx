import { useEffect, useRef, useState } from "react";
import { Shield, Swords, Compass, Sprout, Plus, OctagonX, Trash2, Users } from "lucide-react";
import type { SquadRequest, SquadView } from "../../estacion-logic";
import { Action, Badge, Choice, Meter, Section } from "./components";

/** Estado que sirve GET /api/squads (estacion.ts squadState). */
type CharRow = { char: string; cls: string | null; level: number; online: boolean; obeys: boolean; squad: string | null };
type Plan = { at: number; user?: string; char: string; cls: string }[];
type State = {
  squads: SquadView[];
  chars: CharRow[];
  accounts: null | { remaining: number; created: number; stopped: boolean; log: string[]; next: { at: number; char: string; cls: string }[] };
};
type Reply = { ok: boolean; msg: string; steps?: Plan };
type Call = (body: SquadRequest | { action: "human-follow"; human: string; chars: string[] } | { action: "human-follow-stop" }) => Promise<Reply>;

const MAPS = [
  { warp: 2, name: "Lorencia", reqLevel: 10 },
  { warp: 6, name: "Devias 3", reqLevel: 20 },
  { warp: 7, name: "Devias 4", reqLevel: 20 },
  { warp: 24, name: "Arena 2", reqLevel: 100 },
  { warp: 25, name: "Arena 3", reqLevel: 200 },
  { warp: 26, name: "Arena 4", reqLevel: 300 },
];
const KINDS = [
  { value: "explore", label: "Explorar en grupo" },
  { value: "golden", label: "Cazar dorados" },
  { value: "nurture", label: "Crianza (padrino)" },
];
const PHASES: Record<string, string> = {
  armed: "Esperando reset", follow: "Siguiendo", travel: "Viajando", gather: "Reuniéndose", sweep: "Recorriendo", converge: "Convergiendo", search: "Buscando",
  engage: "Sobre el dorado", loot: "Juntando cajas", farm: "Criando", retreat: "Retirada", done: "Terminada", aborted: "Abortada",
};
const ROLES: Record<string, string> = { tanque: "Tanque", dano: "Daño", apoyo: "Apoyo", explorador: "Explorador", padrino: "Padrino", protegido: "Protegido" };
const CLS: Record<string, string> = { dk: "BK/DK", dw: "SM/DW", elf: "Elf", mg: "MG", dl: "DL" };
const orderText = (o: SquadView["members"][number]["order"]): string => {
  if (!o) return "—";
  switch (o.kind) {
    case "idle": return o.why || "espera";
    case "warp": return `viaja (warp ${o.warp})`;
    case "goto": return `va a (${o.x},${o.y})`;
    case "follow": return o.tight ? `acompaña a ${o.leader}` : `sigue a ${o.leader}`;
    case "hold": return `cobra cerca de ${o.leader}`;
    case "hunt": return o.focus ? `sobre el dorado (${o.focus.x},${o.focus.y})` : `pelea en (${o.x},${o.y})`;
    case "farm": return "su rutina";
    case "retreat": return "se retira";
    case "release": return "libre";
  }
};
const isLive = (s: SquadView) => !!s.mission && !["done", "aborted"].includes(s.mission.phase);

function MemberRow({ m, leader }: { m: SquadView["members"][number]; leader: boolean }) {
  return (
    <tr className={m.online ? "" : "squad-off"}>
      <td><strong>{m.char}</strong>{leader && <span className="squad-tag">líder</span>}</td>
      <td>{m.cls ? CLS[m.cls] ?? m.cls : "?"}</td>
      <td>{m.level || "—"}</td>
      <td style={{ minWidth: 70 }}>
        <Meter value={m.hpPct} max={100} label="" tone={m.hpPct < 35 ? "rose" : "green"} detail={`${m.hpPct}%`} />
      </td>
      <td>{m.role ? ROLES[m.role] : "—"}</td>
      <td className="squad-order">
        {!m.online ? "fuera de línea" : !m.obeys ? <span className="warning-text">sin clave: reiniciar el bot para que obedezca</span> : orderText(m.order)}
      </td>
    </tr>
  );
}

function SquadCard({ s, call, say }: { s: SquadView; call: Call; say: (m: string) => void }) {
  const [kind, setKind] = useState("explore");
  const [warp, setWarp] = useState("24");
  const [padrino, setPadrino] = useState("auto");
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [follow, setFollow] = useState(false);
  const [resets, setResets] = useState("");
  const live = isLive(s);
  const levels = s.members.filter((m) => m.online).map((m) => m.level);
  const icon = kind === "explore" ? <Compass size={14} /> : kind === "golden" ? <Swords size={14} /> : <Sprout size={14} />;
  async function start() {
    const body: SquadRequest = {
      action: "squad-mission", squad: s.id, kind: kind as "explore", confirm: true as const,
      ...(kind !== "nurture" ? { warp: Number(warp) } : {}),
      ...(kind === "nurture" && !follow && padrino !== "auto" ? { padrino } : {}),
      ...(kind === "nurture" && follow ? { follow: true as const, padrino: padrino !== "auto" ? padrino : [...s.members].sort((a, b) => b.level - a.level)[0].char, ...(resets ? { untilResets: Number(resets) } : {}) } : {}),
      ...(kind === "nurture" && target ? { targetLevel: Number(target) } : {}),
    };
    const r = await call(body);
    say(r.msg);
    if (r.ok) setConfirm(false);
  }
  return (
    <Section
      title={`${s.name}`}
      className="squad-card"
      extra={
        s.mission ? <Badge state={live ? "on" : "off"}>{PHASES[s.mission.phase] ?? s.mission.phase}</Badge> : <Badge state="off">Sin misión</Badge>
      }
    >
      {s.mission && (
        <p className="muted squad-mission-line">
          {KINDS.find((k) => k.value === s.mission!.kind)?.label} · mapa {s.mission.map}
          {s.mission.follow ? ` · resets del padrino: ${s.mission.resetsDone}${s.mission.untilResets ? `/${s.mission.untilResets}` : ""}` : ""}
          {s.mission.visited ? ` · ${s.mission.visited} celdas vistas` : ""}
          {s.mission.found ? ` · hallazgo en (${s.mission.found.x},${s.mission.found.y})` : ""}
          {s.mission.result ? ` · ${s.mission.result}` : ""}
        </p>
      )}
      {s.mission?.follow && (
        <ul className="squad-plan">
          {s.members.map((m) => <li key={m.char}><strong>{m.char}</strong> · Nv. {m.level || "—"} · mapa {m.map}{s.mission!.notes[m.char] ? ` · ${s.mission!.notes[m.char]}` : ""}</li>)}
        </ul>
      )}
      {!s.mission && s.last && <p className="muted squad-mission-line">Última: {s.last.result}</p>}
      <div className="squad-table-wrap">
        <table className="squad-table">
          <thead><tr><th>Personaje</th><th>Clase</th><th>Nv.</th><th>Vida</th><th>Rol</th><th>Orden</th></tr></thead>
          <tbody>{s.members.map((m) => <MemberRow key={m.char} m={m} leader={m.char === s.leader} />)}</tbody>
        </table>
      </div>
      {live ? (
        <div className="squad-actions">
          <Action className="danger" onClick={async () => say((await call({ action: "squad-abort", squad: s.id })).msg)}>
            <OctagonX size={14} /> Abortar y retirar
          </Action>
        </div>
      ) : (
        <div className="squad-form">
          <Choice label="Misión" value={kind} onChange={setKind} items={KINDS} />
          {kind !== "nurture" ? (
            <Choice label="Mapa" value={warp} onChange={setWarp} items={MAPS.filter((m) => !levels.length || m.reqLevel <= Math.min(...levels)).map((m) => ({ value: String(m.warp), label: m.name }))} />
          ) : (
            <>
              <Choice label="Padrino" value={padrino} onChange={setPadrino} items={[{ value: "auto", label: "Padrino: el de más nivel" }, ...s.members.map((m) => ({ value: m.char, label: `Padrino: ${m.char}` }))]} />
              <label className="squad-confirm">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                Seguir al padrino por toda la ruta (arranca en su próximo reset)
              </label>
              {follow && <input className="squad-input" inputMode="numeric" placeholder="Terminar tras N resets del padrino (opcional)" value={resets} onChange={(e) => setResets(e.target.value.replace(/\D/g, "").slice(0, 2))} aria-label="Resets del padrino para terminar" />}
              <input className="squad-input" inputMode="numeric" placeholder="Nivel meta (opcional)" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="Nivel meta de los protegidos" />
            </>
          )}
          <label className="squad-confirm">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            Confirmo que quiero que arranque ahora
          </label>
          <Action className="primary" disabled={!confirm} onClick={start}>{icon} Iniciar misión</Action>
        </div>
      )}
      {s.log.length > 0 && <pre className="squad-log">{s.log.slice(-5).join("\n")}</pre>}
      <div className="squad-actions">
        <Action className="quiet" disabled={live} onClick={async () => say((await call({ action: "squad-disband", squad: s.id })).msg)}>
          <Trash2 size={14} /> Disolver
        </Action>
      </div>
    </Section>
  );
}

function CreateSquad({ chars, call, say }: { chars: CharRow[]; call: Call; say: (m: string) => void }) {
  const free = chars.filter((c) => !c.squad);
  const [name, setName] = useState("");
  const [pick, setPick] = useState<string[]>([]);
  const toggle = (c: string) => setPick((p) => (p.includes(c) ? p.filter((x) => x !== c) : p.length < 5 ? [...p, c] : p));
  return (
    <Section title="Armar escuadra" extra={<Users size={15} />}>
      <p className="muted">Elegí de 2 a 5 personajes propios. El primero es el líder.</p>
      <div className="squad-pick">
        {free.map((c) => (
          <button key={c.char} className={`character-pill ${pick.includes(c.char) ? "active" : ""}`} onClick={() => toggle(c.char)} aria-pressed={pick.includes(c.char)}>
            <span className={`mini-dot ${c.online ? "online" : ""}`} />
            <strong>{c.char}</strong>
            <span>{c.cls ? CLS[c.cls] : "?"} · Nv. {c.level || "—"}</span>
          </button>
        ))}
        {!free.length && <p className="empty-copy">Todos los personajes ya están en una escuadra.</p>}
      </div>
      <div className="squad-form">
        <input className="squad-input" placeholder="Nombre de la escuadra" maxLength={20} value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9 _-]/g, ""))} aria-label="Nombre de la escuadra" />
        <Action className="primary" disabled={pick.length < 2 || !name.trim()} onClick={async () => {
          const r = await call({ action: "squad-create", name: name.trim(), chars: pick });
          say(r.msg);
          if (r.ok) { setPick([]); setName(""); }
        }}>
          <Plus size={14} /> Crear escuadra
        </Action>
      </div>
    </Section>
  );
}

function FollowHuman({ chars, call, say }: { chars: CharRow[]; call: Call; say: (m: string) => void }) {
  const [human, setHuman] = useState("");
  const [pick, setPick] = useState<string[]>([]);
  const bots = chars.filter((c) => c.online);
  const toggle = (c: string) => setPick((p) => (p.includes(c) ? p.filter((x) => x !== c) : p.length < 5 ? [...p, c] : p));
  return (
    <Section title="Que me sigan" extra={<Users size={15} />}>
      <p className="muted">
        Jugás un personaje a mano en el navegador y los bots elegidos aceptan tu party y se pegan a vos mientras te ven. Desconectá antes el bot de ese personaje.
      </p>
      <div className="squad-pick">
        {bots.map((c) => (
          <button key={c.char} className={`character-pill ${pick.includes(c.char) ? "active" : ""}`} onClick={() => toggle(c.char)} aria-pressed={pick.includes(c.char)}>
            <span className="mini-dot online" />
            <strong>{c.char}</strong>
            <span>{c.cls ? CLS[c.cls] : "?"} · Nv. {c.level || "—"}</span>
          </button>
        ))}
        {!bots.length && <p className="empty-copy">No hay bots conectados para que te sigan.</p>}
      </div>
      <div className="squad-form">
        <input className="squad-input" placeholder="Tu personaje (nombre en el juego)" maxLength={10} value={human} onChange={(e) => setHuman(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} />
        <Action className="primary" disabled={!pick.length || !human.trim()} onClick={async () => {
          const r = await call({ action: "human-follow", human: human.trim(), chars: pick });
          say(r.msg);
        }}>
          <Plus size={14} /> Que me sigan
        </Action>
        <Action onClick={async () => { const r = await call({ action: "human-follow-stop" }); say(r.msg); }}>Dejar de seguirme</Action>
      </div>
    </Section>
  );
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

function Accounts({ st, call, say }: { st: State["accounts"]; call: Call; say: (m: string) => void }) {
  const [n, setN] = useState("3");
  const [plan, setPlan] = useState<Plan>([]);
  const [confirm, setConfirm] = useState(false);
  const running = !!st && !st.stopped && st.remaining > 0;
  return (
    <Section title="Crear cuentas para la escuadra">
      <p className="muted">
        Una cuenta nueva cada 12 a 40 minutos, como mucho 2 por hora: nada de ráfagas. Primero mirá el plan; recién después lo arrancás.
      </p>
      <div className="squad-form">
        <Choice label="Cantidad" value={n} onChange={setN} items={[1, 2, 3, 4, 5].map((i) => ({ value: String(i), label: `${i} personaje${i > 1 ? "s" : ""}` }))} />
        <Action onClick={async () => { const r = await call({ action: "squad-accounts", mode: "plan", n: Number(n) }); say(r.msg); setPlan(r.steps ?? []); }}>Ver plan</Action>
      </div>
      {plan.length > 0 && !running && (
        <>
          <ul className="squad-plan">
            {plan.map((p) => <li key={p.char}><strong>{p.char}</strong> · {CLS[p.cls] ?? p.cls} · a las {hhmm(p.at)}</li>)}
          </ul>
          <label className="squad-confirm">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            Confirmo: crear estas cuentas reales en el server, espaciadas
          </label>
          <Action className="primary" disabled={!confirm} onClick={async () => { const r = await call({ action: "squad-accounts", mode: "start", n: Number(n) }); say(r.msg); if (r.ok) { setConfirm(false); setPlan([]); } }}>
            Arrancar el plan
          </Action>
        </>
      )}
      {st && (
        <div className="squad-accounts-state">
          <p className="muted">{st.created} creadas · {st.remaining} pendientes{st.stopped ? " · detenido" : ""}</p>
          {st.log.length > 0 && <pre className="squad-log">{st.log.join("\n")}</pre>}
          {running && <Action className="danger" onClick={async () => say((await call({ action: "squad-accounts", mode: "stop" })).msg)}>Detener</Action>}
        </div>
      )}
    </Section>
  );
}

export function Squads({ demo = false }: { demo?: boolean }) {
  const [state, setState] = useState<State>({ squads: [], chars: [], accounts: null });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const mock = useRef(demo ? makeDemo() : null);
  const live = useRef(true);
  const call: Call = async (body) => {
    if (mock.current) {
      if (body.action === "human-follow" || body.action === "human-follow-stop") return { ok: true, msg: "Demo: no se manda nada a los bots." };
      const r = mock.current.call(body);
      setState(mock.current.state());
      return r;
    }
    try {
      const r = await fetch("/api/do", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return (await r.json()) as Reply;
    } catch {
      return { ok: false, msg: "La estación no contesta." };
    }
  };
  useEffect(() => {
    live.current = true;
    if (mock.current) {
      setState(mock.current.state());
      const t = setInterval(() => { mock.current!.tick(); setState(mock.current!.state()); }, 2500);
      return () => { live.current = false; clearInterval(t); };
    }
    const controller = new AbortController();
    const poll = async () => {
      try {
        const r = await fetch("/api/squads", { signal: controller.signal });
        if (!r.ok) throw Error();
        const s = (await r.json()) as State;
        if (live.current) { setState(s); setError(""); }
      } catch {
        if (live.current) setError("La estación no está disponible. Reintentando…");
      }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => { live.current = false; controller.abort(); clearInterval(t); };
  }, []);
  return (
    <div className="squads-view">
      <div className="squads-head">
        <div>
          <span className="eyebrow">ESCUADRAS{demo ? " · DEMO (datos de mentira)" : ""}</span>
          <h1>Misiones en grupo</h1>
          <p className="muted">
            Hasta 5 personajes con una misión coordinada. Nada arranca solo: cada misión la ordenás vos. Un bot lanzado antes de esta versión no obedece hasta que lo reinicies.
          </p>
        </div>
        <Shield size={28} className="squads-shield" />
      </div>
      {error && <div className="station-error" role="status">{error}</div>}
      {msg && <div className="squad-msg" role="status">{msg}</div>}
      <div className="squads-grid">
        {state.squads.map((s) => <SquadCard key={s.id} s={s} call={call} say={setMsg} />)}
        <CreateSquad chars={state.chars} call={call} say={setMsg} />
        <FollowHuman chars={state.chars} call={call} say={setMsg} />
        <Accounts st={state.accounts} call={call} say={setMsg} />
      </div>
    </div>
  );
}

/** Página de demostración (?demo): sin estación, sin red, con una escuadra explorando y una criando. */
export function SquadsDemo() {
  return (
    <div className="station-shell">
      <header className="station-bar">
        <span className="brand"><span className="brand-mark">M</span><span>MU<span className="brand-light"> / Estación</span></span></span>
      </header>
      <div className="station-content"><Squads demo /></div>
    </div>
  );
}

function makeDemo() {
  type M = SquadView["members"][number];
  const m = (char: string, cls: string, level: number, hpPct: number, role: M["role"], order: M["order"], over: Partial<M> = {}): M => ({ char, cls: cls as M["cls"], level, online: true, obeys: true, hpPct, map: 83, x: 40, y: 40, role, order, ...over });
  const squads: SquadView[] = [
    {
      id: "sq1", name: "Alfa", leader: "umbrion",
      last: null,
      log: ["14:02:11 misión explore en Arena 2", "14:02:41 gather: reunidos", "14:03:05 sweep: reunidos 5/5"],
      mission: { id: "sq1-m1", kind: "explore", phase: "sweep", map: 83, warp: 24, result: null, since: Date.now() - 240_000, maxMs: 1_500_000, visited: 6, follow: false, resetsDone: 0, untilResets: 0, notes: {}, found: null },
      members: [
        m("umbrion", "dk", 342, 92, "explorador", { kind: "goto", map: 83, x: 62, y: 38, radius: 4 }),
        m("kaelthor", "mg", 318, 88, "dano", { kind: "goto", map: 83, x: 48, y: 62, radius: 4 }),
        m("noxis", "dw", 301, 100, "dano", { kind: "goto", map: 83, x: 88, y: 40, radius: 4 }),
        m("ravenia", "elf", 296, 64, "apoyo", { kind: "goto", map: 83, x: 40, y: 88, radius: 7 }),
        m("fenrok", "dk", 310, 31, "tanque", { kind: "goto", map: 83, x: 62, y: 62, radius: 4 }),
      ],
    },
    {
      id: "sq2", name: "Cría de Hume", leader: "hume", last: null,
      log: ["15:10:02 campaña de crianza: los protegidos siguen a hume por toda su ruta"],
      mission: { id: "sq2-m1", kind: "nurture", phase: "follow", map: 83, warp: 0, result: null, since: Date.now() - 900_000, maxMs: 28_800_000, visited: 0, follow: true, resetsDone: 1, untilResets: 3, notes: { thalis: "no entra a Arena 2 (nivel 100): espera en zona segura" }, found: null },
      members: [
        m("hume", "dk", 142, 88, "padrino", { kind: "farm" }),
        m("zamu", "dw", 118, 100, "protegido", { kind: "follow", leader: "hume", tight: true }),
        m("thalis", "elf", 64, 100, "protegido", { kind: "idle", why: "no entra a Arena 2 (nivel 100): espera en zona segura" }, { map: 2 }),
      ],
    },
  ];
  const chars: CharRow[] = [
    ...squads.flatMap((s) => s.members.map((x) => ({ char: x.char, cls: x.cls, level: x.level, online: x.online, obeys: x.obeys, squad: s.id }))),
    { char: "melu", cls: "dw", level: 380, online: true, obeys: true, squad: null },
    { char: "vexorn", cls: "mg", level: 12, online: false, obeys: false, squad: null },
  ];
  let accounts: State["accounts"] = null;
  const cycle = ["sweep", "converge", "sweep"] as const;
  let i = 0;
  return {
    state: (): State => ({ squads: JSON.parse(JSON.stringify(squads)), chars: JSON.parse(JSON.stringify(chars)), accounts }),
    tick() {
      const s = squads[0];
      if (s.mission && !["done", "aborted"].includes(s.mission.phase) && s.mission.kind === "explore") {
        s.mission.visited += 1;
        if (++i % 6 === 0) s.mission.phase = cycle[(i / 6) % 3];
      }
    },
    call(body: SquadRequest): Reply {
      switch (body.action) {
        case "squad-create": {
          const id = `sq${squads.length + 3}`;
          squads.push({ id, name: body.name, leader: body.chars[0], last: null, log: [], mission: null, members: body.chars.map((c) => { const r = chars.find((x) => x.char === c)!; r.squad = id; return m(c, r.cls ?? "dk", r.level, 100, null, null); }) });
          return { ok: true, msg: `escuadra "${body.name}" armada con ${body.chars.length} (demo)` };
        }
        case "squad-mission": {
          const s = squads.find((x) => x.id === body.squad)!;
          s.mission = { id: `${s.id}-m9`, kind: body.kind, phase: "travel", map: 83, warp: body.warp ?? 24, result: null, since: Date.now(), maxMs: 1_500_000, visited: 0, follow: !!body.follow, resetsDone: 0, untilResets: body.untilResets ?? 0, notes: {}, found: null };
          return { ok: true, msg: `misión ${body.kind} (demo): no se mandó nada a ningún bot` };
        }
        case "squad-abort": {
          const s = squads.find((x) => x.id === body.squad);
          if (s?.mission) { s.mission.phase = "retreat"; s.mission.result = "abortada por el usuario"; }
          return { ok: true, msg: "abortando: la escuadra se retira (demo)" };
        }
        case "squad-disband": {
          const k = squads.findIndex((x) => x.id === body.squad);
          if (k >= 0) { squads[k].members.forEach((x) => { const r = chars.find((c) => c.char === x.char); if (r) r.squad = null; }); squads.splice(k, 1); }
          return { ok: true, msg: "escuadra disuelta (demo)" };
        }
        case "squad-accounts": {
          if (body.mode === "stop") { accounts = accounts && { ...accounts, stopped: true }; return { ok: true, msg: "plan detenido (demo)" }; }
          const n = body.n ?? 3;
          const names = ["Umbrion", "Kaelthor", "Noxis", "Ravenia", "Fenrok"];
          const cl = ["dk", "elf", "dw", "mg", "elf"];
          let t = Date.now() + 90_000;
          const steps = Array.from({ length: n }, (_, k) => ({ at: (t += k ? (12 + k * 9) * 60_000 : 0), char: names[k], cls: cl[k] }));
          if (body.mode === "start") accounts = { remaining: n, created: 0, stopped: false, log: ["(demo) no se registra nada"], next: steps };
          return { ok: true, msg: `${n} cuenta(s) en ~${((steps[n - 1].at - Date.now()) / 3_600_000).toFixed(1)} h, espaciadas (demo)`, steps };
        }
      }
    },
  };
}
