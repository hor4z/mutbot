import { useEffect, useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Switch } from "@base-ui/react/switch";
import {
  Play,
  Pause,
  Swords,
  ArrowUpRight,
  MapPin,
  Activity,
  Sparkles,
  UserRound,
  ScrollText,
  CircleAlert,
  WifiOff,
  MessageSquare,
  Send,
  Store,
} from "lucide-react";
import type { EquippedItem, PanelCommand, PanelState } from "../../panel-protocol";
import {
  Action,
  Badge,
  Choice,
  Meter,
  Section,
  Metric,
  fmt,
  compact,
} from "./components";
import { Radar } from "./Radar";
import { CommerceView } from "./Commerce";
// Equipo e inventario: íconos del cliente (assets/items, servidos por el bot en /radar-assets/items).
const SLOT_NAMES = ["Arma", "Escudo / 2ª arma", "Casco", "Armadura", "Pantalones", "Guantes", "Botas", "Alas", "Mascota", "Collar", "Anillo", "Anillo"];
const ICON_TIERS = [15, 13, 11, 9, 7, 5, 3, 0];
function iconSources(it: EquippedItem): string[] {
  const tier = ICON_TIERS.find((t) => it.level >= t) ?? 0;
  const base = (lv: number, e: boolean) => `/radar-assets/items/item_${it.group}_${it.num}_${lv}${e ? "_e" : ""}.png`;
  const list = [base(it.level, it.excellent), base(tier, it.excellent), base(0, it.excellent), base(it.level, false), base(tier, false), base(0, false)];
  return [...new Set(list)];
}
function ItemIcon({ it }: { it: EquippedItem }) {
  const sources = iconSources(it);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [sources[0]]);
  const title = `${it.name ?? `${it.group}/${it.num}`}${it.level ? ` +${it.level}` : ""}${it.excellent ? " (excelente)" : ""}`;
  if (i >= sources.length) return <span className="item-name" title={title}>{it.name ?? `${it.group}/${it.num}`}</span>;
  return <img className="item-icon" src={sources[i]} alt={title} title={title} onError={() => setI(i + 1)} />;
}
function Equipment({ items }: { items: EquippedItem[] }) {
  return (
    <div className="equipment">
      {SLOT_NAMES.map((label, slot) => {
        const it = items.find((x) => x.slot === slot);
        return (
          <div key={slot} className={`equip-slot ${it ? "filled" : ""} ${it?.excellent ? "exc" : ""}`}>
            <div className="equip-icon">{it && <ItemIcon it={it} />}</div>
            <div className="equip-text">
              <small>{label}</small>
              <strong>{it ? `${it.name}${it.level ? ` +${it.level}` : ""}` : "—"}</strong>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function Inventory({ items }: { items: EquippedItem[] }) {
  return (
    <div className="inventory-grid">
      {Array.from({ length: 64 }, (_, i) => (
        <div key={`c${i}`} className="inv-cell" style={{ gridColumn: (i % 8) + 1, gridRow: Math.floor(i / 8) + 1 }} />
      ))}
      {items.map((it) => {
        const pos = it.slot - 12;
        return (
          <div
            key={it.slot}
            className={`inv-item ${it.excellent ? "exc" : ""}`}
            style={{ gridColumn: `${(pos % 8) + 1} / span ${Math.min(it.w ?? 1, 8 - (pos % 8))}`, gridRow: `${Math.floor(pos / 8) + 1} / span ${it.h ?? 1}` }}
          >
            <ItemIcon it={it} />
          </div>
        );
      })}
    </div>
  );
}
import knight from "../../assets/ui/knight-alpha.webp";
type Log = { at: number; text: string; kind: string };
// Decisiones del bot (el diario): viajes, reset, órdenes, cambios de modo y decisiones con motivo.
type Decision = { at: number; kind: string; what: string; n: number };
const DECISION_KINDS = new Set(["decide", "travel", "reset", "mode", "command"]);
type Chat = { at: number; kind: "normal" | "party" | "guild" | "whisper" | "server"; from: string; text: string; mine?: boolean };
const chatKinds: Record<Chat["kind"], string> = { normal: "", party: "Party", guild: "Guild", whisper: "Susurro", server: "Server" };
const channels = [
  { value: "normal", label: "Público" },
  { value: "party", label: "Party" },
  { value: "guild", label: "Guild" },
  { value: "whisper", label: "Susurro" },
];
const classes: Record<number, string> = {
  0: "Dark Wizard",
  1: "Soul Master",
  2: "Soul Master",
  4: "Dark Knight",
  5: "Blade Knight",
  6: "Blade Knight",
  8: "Fairy Elf",
  9: "Muse Elf",
  10: "Muse Elf",
  12: "Magic Gladiator",
  16: "Dark Lord",
};
const spots = [
  ["2", "Lorencia"],
  ["6", "Devias 3"],
  ["7", "Devias 4"],
  ["5", "Devias 2"],
  ["24", "Arena 2"],
  ["25", "Arena 3"],
  ["26", "Arena 4"],
].map(([value, label]) => ({ value: value!, label: label! }));
const hunts = [
  { value: "auto", label: "Mapa con más dorados" },
  { value: "0", label: "Lorencia" },
  { value: "3", label: "Noria" },
  { value: "2", label: "Devias" },
];
const clock = (t: number) =>
  new Date(t).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
  });
const countdown = (t: number, now: number) => {
  const sec = Math.max(0, Math.round((t - now) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};
function useBot() {
  const [state, setState] = useState<PanelState | null>(null),
    [connected, setConnected] = useState(false),
    [logs, setLogs] = useState<Log[]>([]),
    [chats, setChats] = useState<Chat[]>([]),
    [decisions, setDecisions] = useState<Decision[]>([]),
    [result, setResult] = useState<{ id: number; ok: boolean } | null>(null),
    [toast, setToast] = useState("");
  const socket = useRef<WebSocket | null>(null),
    nextId = useRef(1),
    lastAt = useRef(0),
    levels = useRef<[number, number][]>([]);
  const add = (text: string, at = Date.now(), kind = "bot") =>
    setLogs((old) => [...old, { text, at, kind }].slice(-500));
  useEffect(() => {
    let done = false;
    let retry: ReturnType<typeof setTimeout>;
    function connect() {
      if (done) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`,
      );
      socket.current = ws;
      ws.onopen = () => !done && setConnected(true);
      ws.onclose = () => {
        if (done) return;
        setConnected(false);
        retry = setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        if (done) return;
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.type === "panel-state") {
          const now = Date.now();
          lastAt.current = now;
          setState(m.state);
          // Después de un reset el nivel baja: la medición de niveles/min arranca de nuevo.
          const prevLevel = levels.current[levels.current.length - 1]?.[1];
          if (prevLevel != null && m.state.char.level < prevLevel) levels.current = [];
          levels.current.push([now, m.state.char.level]);
          levels.current = levels.current.filter(([t]) => now - t < 600000);
          window.dispatchEvent(
            new CustomEvent("panel-state", { detail: m.state }),
          );
        } else if (m.type === "decision" || m.type === "history") {
          const list = m.type === "decision" ? [m.decision] : m.decisions;
          setDecisions((old) => {
            let out = old;
            for (const d of list) {
              if (!DECISION_KINDS.has(d.kind)) continue;
              const at = Date.parse(d.at) || Date.now();
              // La misma decisión seguida no se repite: se cuenta (×n) y se actualiza la hora.
              const last = out[out.length - 1];
              out = last && last.what === d.what ? [...out.slice(0, -1), { ...last, at, n: last.n + 1 }] : [...out, { at, kind: d.kind, what: d.what, n: 1 }];
            }
            return out.slice(-50);
          });
        }
        if (m.type === "hello") {
          // Al (re)conectar el bot vuelve a mandar el historial, el log y el chat: empezar de cero
          // (si no, cada reconexión los duplicaba).
          setLogs([]);
          setChats([]);
          setDecisions([]);
        } else if (m.type === "log") add(m.text, m.at);
        else if (m.type === "chat")
          setChats((old) => [...old, m as Chat].slice(-500));
        else if (m.type === "decision")
          add(
            `${m.decision.kind}: ${m.decision.what}`,
            Date.parse(m.decision.at) || Date.now(),
          );
        else if (m.type === "history")
          for (const d of m.decisions.slice(-40))
            add(`${d.kind}: ${d.what}`, Date.parse(d.at) || Date.now());
        else if (m.type === "command-result") {
          add(m.msg, Date.now(), m.ok ? "ok" : "bad");
          setToast(m.msg);
          setResult({ id: m.id, ok: m.ok });
        }
      };
    }
    connect();
    return () => {
      done = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  function send(command: PanelCommand): number | null {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      setToast("Sin conexión con el personaje.");
      return null;
    }
    const id = nextId.current++;
    socket.current.send(JSON.stringify({ type: "command", id, command }));
    add(
      `Orden: ${command.cmd}${"warp" in command ? " · " + command.warp : ""}${"map" in command ? " · " + command.map : ""}`,
      Date.now(),
      "cmd",
    );
    return id;
  }
  return { state, connected, logs, chats, decisions, result, toast, send, lastAt, levels };
}
function Controls({
  s,
  send,
  disabled,
}: {
  s: PanelState | null;
  send: (c: PanelCommand) => void;
  disabled: boolean;
}) {
  const [warp, setWarp] = useState("24"),
    [hunt, setHunt] = useState("auto"),
    [advanced, setAdvanced] = useState(false);
  return (
    <Section title="Acciones">
      {/* Solo lo que cambia algo: farmeando por la ruta no se ofrece "Farmear". */}
      <p className="muted action-now">
        {s?.mode === "paused"
          ? "En pausa."
          : s?.mode === "hunt"
            ? `Cazando dorados${s.where.spot ? ` (${s.where.spot.replace(/^cacería /, "")})` : ""}.`
            : s?.where.pinned
              ? `Farmeando fijo en ${s.where.spot ?? "un spot"}.`
              : s?.mode === "farm"
                ? "Farmeando por la ruta."
                : ""}
      </p>
      <div className="main-actions">
        {(s?.mode === "hunt" || s?.where.pinned) && (
          <Action
            className="primary"
            disabled={disabled}
            onClick={() => send({ cmd: "farm" })}
          >
            <Swords size={15} />
            {s?.mode === "hunt" ? "Dejar de cazar" : "Volver a la ruta"}
          </Action>
        )}
        <Action
          className={s?.mode === "paused" ? "primary" : ""}
          disabled={disabled}
          onClick={() =>
            send({ cmd: s?.mode === "paused" ? "resume" : "pause" })
          }
        >
          {s?.mode === "paused" ? <Play size={15} /> : <Pause size={15} />}{" "}
          {s?.mode === "paused" ? "Continuar" : "Pausar"}
        </Action>
      </div>
      <button
        className="text-button"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
      >
        {advanced ? "Ocultar opciones" : "Viajar o cazar dorados"}
        <ArrowUpRight size={13} />
      </button>
      {advanced && (
        <div className="advanced-controls">
          <label>Viajar a un lugar</label>
          <div className="input-action">
            <Choice
              label="Destino"
              value={warp}
              onChange={setWarp}
              items={spots}
            />
            <Action
              disabled={disabled}
              onClick={() => send({ cmd: "warp", warp: +warp })}
            >
              Ir
            </Action>
          </div>
          <label>Cazar dorados</label>
          <div className="input-action">
            <Choice
              label="Mapa de cacería"
              value={hunt}
              onChange={setHunt}
              items={hunts}
            />
            <Action
              disabled={disabled}
              onClick={() =>
                send(
                  hunt === "auto"
                    ? { cmd: "hunt" }
                    : { cmd: "hunt", map: +hunt },
                )
              }
            >
              Cazar
            </Action>
          </div>
        </div>
      )}
    </Section>
  );
}
// Dorados de un vistazo (usuario, 2026-10-23: "en el panel no puedo ver rápido dónde quedan criaturas"):
// los que se ven, con distancia y flecha (arriba = +y, igual que el radar), y los vivos por mapa en la invasión.
const ARROWS = ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"];
const arrow = (dx: number, dy: number) =>
  dx === 0 && dy === 0 ? "•" : ARROWS[Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8];
function Goldens({ s }: { s: PanelState }) {
  const me = s.where;
  const golds = (s.entities?.monsters ?? [])
    .filter((m) => m.gold)
    .map((m) => ({ ...m, d: Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)), dragon: m.type === 44 || m.type === 79 }))
    .sort((a, b) => Number(b.dragon) - Number(a.dragon) || a.d - b.d);
  const inv = s.invasion?.status === "active" ? s.invasion : null;
  return (
    <Section title="Dorados" extra={<span className="count">{golds.length}</span>}>
      <div className="near-list">
        {golds.map((g) => (
          <div key={g.id}>
            <span className={g.type === 44 ? "red-dragon" : g.type === 79 ? "golden-dragon" : "gold"}>
              {arrow(g.x - me.x, g.y - me.y)} {g.name}
              {g.target ? <small> · objetivo</small> : null}
            </span>
            <small>
              {g.d} tiles · {g.x},{g.y}
            </small>
          </div>
        ))}
        {!golds.length && <p className="empty-copy">Ningún dorado a la vista.</p>}
      </div>
      {inv && (
        <div className="near-footer">
          {inv.maps
            .filter((m) => m.alive > 0)
            .map((m) => (
              <span key={m.map} className={m.map === me.map ? "gold" : ""}>
                {m.name} {m.alive}
                {" · "}
              </span>
            ))}
          {inv.total} vivos
        </div>
      )}
    </Section>
  );
}
function Near({ s }: { s: PanelState }) {
  const groups = new Map<string, { n: number; near: number; gold: boolean }>();
  for (const m of s.entities?.monsters ?? []) {
    const d = Math.max(Math.abs(m.x - s.where.x), Math.abs(m.y - s.where.y));
    const g = groups.get(m.name) ?? { n: 0, near: 999, gold: m.gold };
    g.n++;
    g.near = Math.min(g.near, d);
    groups.set(m.name, g);
  }
  return (
    <Section
      title="A tu alrededor"
      extra={<span className="count">{s.nearby.monsters}</span>}
    >
      <div className="near-list">
        {[...groups]
          .sort(
            (a, b) =>
              Number(b[1].gold) - Number(a[1].gold) || a[1].near - b[1].near,
          )
          .map(([name, g]) => (
            <div key={name}>
              <span className={g.gold ? "gold" : ""}>
                {g.gold ? "✦ " : ""}
                {name}
                <small> ×{g.n}</small>
              </span>
              <small>{g.near} tiles</small>
            </div>
          ))}
        {!groups.size && (
          <p className="empty-copy">No hay monstruos a la vista.</p>
        )}
      </div>
      <div className="near-footer">
        {s.nearby.players} jugadores cerca ·{" "}
        {s.entities?.drops.filter((d) => d.valuable).length ?? 0} objetos
        valiosos
      </div>
    </Section>
  );
}
function ChatPanel({
  chats,
  result,
  send,
  disabled,
}: {
  chats: Chat[];
  result: { id: number; ok: boolean } | null;
  send: (c: PanelCommand) => number | null;
  disabled: boolean;
}) {
  const [channel, setChannel] = useState("normal"),
    [to, setTo] = useState(""),
    [text, setText] = useState(""),
    [showServer, setShowServer] = useState(true),
    // Último mensaje mandado: si el bot lo rechaza (muy rápido, muy largo) vuelve a la caja.
    pending = useRef<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!result || result.id !== pending.current?.id) return;
    if (!result.ok) setText(pending.current.text);
    pending.current = null;
  }, [result]);
  const box = useRef<HTMLDivElement | null>(null),
    atBottom = useRef(true);
  useEffect(() => {
    if (atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [chats, showServer]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    let id: number | null;
    if (channel === "whisper") {
      if (!to.trim()) return;
      id = send({ cmd: "say", text: t, to: to.trim() });
    } else id = send({ cmd: "say", text: t, ...(channel === "normal" ? {} : { channel: channel as "party" | "guild" }) });
    if (id == null) return;
    pending.current = { id, text: t };
    setText("");
  };
  return (
    <Section
      title="Chat del personaje"
      extra={
        <div className="chat-tools">
          <label className="switch-label">
            <Switch.Root checked={showServer} onCheckedChange={setShowServer} className="switch">
              <Switch.Thumb className="switch-thumb" />
            </Switch.Root>
            Avisos del server
          </label>
        </div>
      }
    >
      <div
        className="activity-log chat-log"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        }}
      >
        {chats
          .filter((c) => showServer || c.kind !== "server")
          .map((c, i) => (
            <div className={`chat-${c.kind}${c.mine ? " mine" : ""}`} key={`${c.at}:${i}`}>
              <time>{clock(c.at)}</time>
              {chatKinds[c.kind] && <b className="chat-kind">{chatKinds[c.kind]}</b>}
              <span>
                {c.from && <strong>{c.from}: </strong>}
                {c.text}
              </span>
            </div>
          ))}
        {!chats.length && <p className="empty-copy">Todavía no llegó nada del chat.</p>}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <div className="chat-channel">
          <Choice value={channel} onChange={setChannel} items={channels} label="Canal" />
        </div>
        {channel === "whisper" && (
          <input className="chat-input chat-to" value={to} maxLength={10} placeholder="A quién" aria-label="Destinatario" onChange={(e) => setTo(e.target.value)} />
        )}
        <input
          className="chat-input"
          value={text}
          maxLength={60}
          placeholder="Escribí un mensaje (sin comandos /)"
          aria-label="Mensaje"
          onChange={(e) => setText(e.target.value)}
        />
        <Action className="primary" disabled={disabled} type="submit">
          <Send size={14} />
          Enviar
        </Action>
      </form>
    </Section>
  );
}
export function Panel() {
  const { state: s, connected, logs, chats, decisions, result, toast, send, lastAt, levels } = useBot();
  const [tab, setTab] = useState("overview"),
    [onlyBot, setOnlyBot] = useState(false),
    [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null),
    logBottom = useRef(true);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (logBottom.current && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, tab]);
  const stale = !!s && now - lastAt.current > 5000;
  const online = connected && !stale;
  const ses = s?.session;
  const alerts: string[] = [];
  if (s) {
    if (s.mode === "dead") alerts.push("El personaje está muerto.");
    if (s.char.hp[1] && s.char.hp[0] / s.char.hp[1] < 0.3)
      alerts.push("Vida por debajo del 30%.");
    if (
      s.mode === "farm" &&
      s.exp.perMin5 === 0 &&
      ses &&
      now - ses.since > 300000
    )
      alerts.push("5 minutos sin ganar experiencia.");
  }
  const [t0, l0] = levels.current[0] ?? [now, s?.char.level ?? 0];
  const rate = ((s?.char.level ?? 0) - l0) / Math.max(1, (now - t0) / 60000);
  const eta =
    rate > 0.05
      ? Math.max(0, Math.round((400 - (s?.char.level ?? 0)) / rate))
      : null;
  return (
    <div className="panel-shell">
      <header className="character-header">
        <div className="character-identity">
          <div className="identity-line">
            <h1>{s?.char.name ?? "Conectando…"}</h1>
            <Badge state={online ? (s?.mode ?? "connecting") : "off"}>
              {online
                ? undefined
                : connected
                  ? "Sin datos recientes"
                  : "Sin conexión"}
            </Badge>
          </div>
          <p>
            <MapPin size={13} />
            {s
              ? `${classes[s.char.classId ?? -1] ?? s.char.cls ?? "Personaje"} · ${s.where.mapName}`
              : "Esperando datos del personaje"}
          </p>
        </div>
        <div className="current-action">
          <span>Actividad actual</span>
          <p>{s?.doing ?? "Conectando con el mundo…"}</p>
        </div>
        <img className="character-art" src={knight} alt="" />
      </header>
      {(!online || alerts.length > 0) && (
        <div className="notice" role="status">
          {!online ? <WifiOff size={15} /> : <CircleAlert size={15} />}
          <span>
            {!connected
              ? "Conectando con el bot. Se reintenta automáticamente."
              : stale
                ? `Sin novedades hace ${Math.max(0, Math.round((now - lastAt.current) / 1000))} s.`
                : alerts.join(" ")}
          </span>
        </div>
      )}
      <div className="dashboard-metrics">
        <div className="level-metric">
          <Metric
            label="Nivel"
            value={fmt(s?.char.level)}
            note="de 400 para resetear"
          />
          <div className="level-line">
            <i
              style={{ width: `${Math.min(100, (s?.char.level ?? 0) / 4)}%` }}
            />
          </div>
        </div>
        <Metric
          label="Experiencia / min"
          value={compact(s?.exp.perMin1)}
          note={`Últimos 5 min: ${compact(s?.exp.perMin5)}`}
        />
        <Metric
          label="Resets"
          value={fmt(s?.char.resets)}
          note={eta !== null ? `Próximo en ~${eta} min` : "Progreso automático"}
        />
      </div>
      <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))}>
        <Tabs.List
          className="dashboard-tabs"
          aria-label="Información del personaje"
        >
          {[
            { value: "overview", label: "Vista general", Icon: Activity },
            { value: "character", label: "Personaje", Icon: UserRound },
            { value: "events", label: "Eventos", Icon: Sparkles },
            { value: "activity", label: "Actividad", Icon: ScrollText },
            { value: "chat", label: "Chat", Icon: MessageSquare },
            { value: "commerce", label: "Comercio", Icon: Store },
          ].map(({ value, label, Icon }) => (
            <Tabs.Tab key={value} value={value}>
              <Icon size={15} />
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="overview">
          <div className="overview-grid">
            <Radar state={s} />
            <div className="overview-side">
              <Controls s={s} send={send} disabled={!online || !s} />
              {s && <Goldens s={s} />}
              <Section title="Estado del personaje">
                <Meter
                  value={s?.char.hp[0] ?? 0}
                  max={s?.char.hp[1] ?? 0}
                  label="Vida"
                  tone="rose"
                />
                <Meter
                  value={s?.char.mp[0] ?? 0}
                  max={s?.char.mp[1] ?? 0}
                  label="Maná"
                  tone="blue"
                />
              </Section>
              <Section title="Decisiones">
                <div className="decisions">
                  {decisions.slice(-6).reverse().map((d, i) => (
                    <div className={`decision ${d.kind}`} key={`${d.at}:${i}`}>
                      <time>{clock(d.at)}</time>
                      <span>
                        {d.what}
                        {d.n > 1 && <b className="decision-count"> ×{d.n}</b>}
                      </span>
                    </div>
                  ))}
                  {!decisions.length && <p className="empty-copy">Acá aparece lo que decide el personaje y por qué.</p>}
                </div>
              </Section>
              {s && <Near s={s} />}
            </div>
          </div>
          <div className="activity-peek">
            <span className="live-dot" />
            <p>
              {logs.at(-1)?.text ?? "La actividad del personaje aparecerá acá."}
            </p>
            <button className="text-button" onClick={() => setTab("activity")}>
              Ver registro
              <ArrowUpRight size={13} />
            </button>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="character">
          <div className="detail-grid">
            <Section title="Atributos">
              <div className="attributes">
                {[
                  ["Fuerza", s?.char.stats.str],
                  ["Agilidad", s?.char.stats.agi],
                  ["Vitalidad", s?.char.stats.vit],
                  ["Energía", s?.char.stats.ene],
                ].map(([label, v]) => (
                  <Metric
                    key={label}
                    label={String(label)}
                    value={fmt(v as number)}
                  />
                ))}
              </div>
              <div className="detail-line">
                <span>Puntos por repartir</span>
                <strong>{fmt(s?.char.points)}</strong>
              </div>
              <div className="detail-line">
                <span>Zen</span>
                <strong>{fmt(s?.char.zen)}</strong>
              </div>
              {s?.where.spot && (
                <div className="detail-line">
                  <span>Lugar fijo</span>
                  <strong>{s.where.spot}</strong>
                </div>
              )}
            </Section>
            <Section title="Equipo">
              <Equipment items={s?.equipment ?? []} />
            </Section>
            <Section
              title="Inventario"
              extra={<small>{(s?.inventory ?? []).length} objetos · {fmt(s?.char.zen)} zen</small>}
            >
              <Inventory items={s?.inventory ?? []} />
            </Section>
            <Section
              title="Esta sesión"
              extra={
                <small>{ses ? `Desde ${clock(ses.since)}` : "Sin datos"}</small>
              }
            >
              <div className="session-metrics">
                {[
                  ["Monstruos derrotados", ses?.kills],
                  [
                    "Por minuto",
                    ses
                      ? (
                          ses.kills / Math.max(1, (now - ses.since) / 60000)
                        ).toFixed(1)
                      : "—",
                  ],
                  [
                    "Niveles ganados",
                    ses && s ? Math.max(0, s.char.level - ses.level0) : "—",
                  ],
                  ["Skills usados", ses?.casts],
                  ["Objetos recogidos", ses?.loot],
                  ["Muertes", ses?.deaths],
                ].map(([label, v]) => (
                  <Metric key={label} label={String(label)} value={v ?? "—"} />
                ))}
              </div>
              <div className="detail-line">
                <span>Skill actual</span>
                <strong>{ses?.skill ?? "—"}</strong>
              </div>
              <div className="detail-line">
                <span>Experiencia ganada</span>
                <strong>{compact(ses?.exp)}</strong>
              </div>
            </Section>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="events">
          <div className="detail-grid">
            <Section title="Invasión dorada">
              <div className="invasion-value">
                <Sparkles size={25} />
                <strong>
                  {s?.invasion?.status === "active"
                    ? `${s.invasion.total} dorados vivos`
                    : "Próxima invasión"}
                </strong>
                <span>
                  {s?.invasion?.status === "active"
                    ? "En curso"
                    : s?.invasion?.nextAt
                      ? countdown(s.invasion.nextAt, now)
                      : "Sin datos todavía"}
                </span>
              </div>
              {s?.invasion?.status === "active" &&
                s.invasion.maps.map((m) => (
                  <div className="detail-line" key={m.map}>
                    <span>{m.name}</span>
                    <strong>{m.alive} vivos</strong>
                  </div>
                ))}
            </Section>
            <Section title="Eventos">
              {s?.events?.length ? (
                s.events.map((e) => (
                  <div className="detail-line event-row" key={e.key}>
                    <div>
                      <strong>
                        {
                          {
                            devilSquare: "Devil Square",
                            bloodCastle: "Blood Castle",
                            chaosCastle: "Chaos Castle",
                          }[e.key]
                        }
                      </strong>
                      <small>
                        {e.minutes === 0
                          ? "Entrada abierta"
                          : e.opensAt
                            ? `Abre a las ${clock(e.opensAt)}`
                            : "Más de 4 horas"}
                        {e.users ? ` · ${e.users} anotados` : ""}
                      </small>
                    </div>
                    <span className={e.minutes === 0 ? "green" : "mono"}>
                      {e.minutes === 0
                        ? "Abierto"
                        : e.opensAt
                          ? countdown(e.opensAt, now)
                          : "—"}
                    </span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">
                  El bot todavía no recibió información de eventos.
                </p>
              )}
              <div className="tickets">
                {Object.entries(s?.tickets ?? {}).map(([name, n]) => (
                  <span key={name}>
                    {name} ×{n}
                  </span>
                ))}
              </div>
            </Section>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="activity">
          <Section
            title="Registro de actividad"
            extra={
              <label className="switch-label">
                <Switch.Root
                  checked={onlyBot}
                  onCheckedChange={setOnlyBot}
                  className="switch"
                >
                  <Switch.Thumb className="switch-thumb" />
                </Switch.Root>
                Solo el bot
              </label>
            }
          >
            <div
              className="activity-log"
              ref={logRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                logBottom.current =
                  el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
              }}
            >
              {logs
                .filter((l) => !onlyBot || l.kind === "bot")
                .map((l, i) => (
                  <div className={l.kind} key={`${l.at}:${i}`}>
                    <time>{clock(l.at)}</time>
                    <span>{l.text}</span>
                  </div>
                ))}
              {!logs.length && (
                <p className="empty-copy">Todavía no hay actividad.</p>
              )}
            </div>
          </Section>
        </Tabs.Panel>
        <Tabs.Panel value="chat">
          <ChatPanel chats={chats} result={result} send={send} disabled={!online || !s} />
        </Tabs.Panel>
        <Tabs.Panel value="commerce">
          <CommerceView state={s} send={send} online={online} />
        </Tabs.Panel>
      </Tabs.Root>
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
    </div>
  );
}
