/**
 * Panel de Capitan (Slow): un solo personaje, una sola pantalla. Izquierda: conexión, estado, vitales y stats. Centro: el radar del bot en
 * tiempo real. Derecha: lo que decide el bot y por qué, una línea por decisión.
 */
import {
  Activity, Backpack, ChevronsUp, CircleCheck, Coins, Droplet, Dumbbell, Gauge, Heart, House, Info, ListChecks, MapPin, Pause, Play, Plug, RotateCw, Route,
  ShieldAlert, Skull, Swords, Terminal, TriangleAlert, TrendingUp, Unplug, X, Zap, Anchor, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteKind, PanelState } from "@mubot/protocol";
import { Radar } from "./Radar";
import { Badge, Bar, Button, Label, Panel, Stat, cn, type Tone } from "./components";
import { useActions, useStation, type Result } from "./station-data";

const fmtExp = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 8);
const pct = (a: number, b: number) => (b > 0 ? Math.max(0, Math.min(100, (100 * a) / b)) : 0);
const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

const STATUS: Record<string, { text: string; tone: Tone }> = {
  on: { text: "Conectado", tone: "success" },
  starting: { text: "Conectando…", tone: "warning" },
  stopping: { text: "Desconectando…", tone: "warning" },
  "in-use": { text: "Cuenta abierta en otro lado", tone: "danger" },
  failed: { text: "No pudo entrar", tone: "danger" },
  external: { text: "Corre sin panel", tone: "warning" },
  off: { text: "Desconectado", tone: "default" },
};

/** Un icono por tipo de decisión (se ve de un vistazo qué pasó). */
const NOTE_ICON: Record<NoteKind, LucideIcon> = {
  spot: MapPin, travel: Route, flee: ShieldAlert, stat: Dumbbell, loot: Backpack, order: Terminal, stuck: Anchor, death: Skull, fight: Swords, system: Info,
};

/** Lo que decide el bot y por qué: una línea por decisión, la más nueva abajo. */
function Feed({ g }: { g: PanelState | null }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const notes = g?.notes ?? [];
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [notes]);
  return (
    <div
      ref={box}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {notes.map((n, i) => {
        const Icon = NOTE_ICON[n.kind] ?? Info;
        return (
          <p key={`${n.at}-${i}`} className={cn("flex gap-2 border-t border-line py-1.5 first:border-t-0", (n.kind === "death" || n.kind === "flee") && "text-danger")}>
            <Icon size={14} className="mt-[3px] text-faint" aria-hidden />
            <span className="min-w-0 break-words">
              <time className="mr-2 font-mono text-xs text-faint">{hhmm(n.at)}</time>
              {n.text}
            </span>
          </p>
        );
      })}
      {!notes.length && <p className="py-3 text-faint">Cuando el bot entre al juego, acá aparece cada decisión con su motivo.</p>}
    </div>
  );
}

const STAT_KEYS = ["str", "agi", "vit", "ene"] as const;

export function App() {
  const { data, loaded, error, refresh } = useStation();
  const [toast, setToast] = useState<Result | null>(null);
  const onResult = useCallback((r: Result) => setToast(r), []);
  const act = useActions(refresh, onResult);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const g = data.game;
  const inGame = g != null && g.mode !== "connecting";
  const st = STATUS[data.status] ?? STATUS.off!;
  const online = data.pid != null;
  const paused = g?.mode === "paused";
  const now = data.now || Date.now();
  const stats = g?.char.stats;
  const statTotal = stats ? stats.str + stats.agi + stats.vit + stats.ene : 0;

  return (
    <div className="grid h-screen grid-cols-[340px_minmax(0,1fr)_380px] gap-1 bg-canvas p-1 max-[1100px]:h-auto max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-[auto_60vh_auto]">
      <aside className="flex min-h-0 flex-col gap-1 overflow-auto">
        <Panel className="flex-row items-center justify-between gap-2.5 py-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{data.char ?? "Sin personaje"}</h1>
            <Badge tone={st.tone}>{st.text}</Badge>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {online && data.status !== "starting" && (
              <Button disabled={!inGame} onClick={() => void act.order({ cmd: paused ? "resume" : "pause" })}>
                {paused ? <Play size={13} /> : <Pause size={13} />}
                {paused ? "Reanudar" : "Pausar"}
              </Button>
            )}
            {data.status === "starting" && (
              <Button title="Corta el intento actual y vuelve a probar sin esperar" onClick={() => void act.retry()}>
                <RotateCw size={13} />
                Reintentar
              </Button>
            )}
            <Button variant={online ? "outline" : "primary"} disabled={data.status === "stopping"} onClick={() => void (online ? act.disconnect() : act.connect())}>
              {data.status === "starting" ? <X size={13} /> : online ? <Unplug size={13} /> : <Plug size={13} />}
              {data.status === "starting" ? "Cancelar" : online ? "Desconectar" : "Conectar"}
            </Button>
          </div>
        </Panel>

        {error && <Note tone="danger">{error}</Note>}
        {(data.status === "failed" || data.status === "in-use") && <Note tone="danger">{data.msg}</Note>}
        {!online && data.status === "off" && loaded && <Note>Desconectado desde el panel = jugás vos: el bot no se reconecta solo.</Note>}
        {toast && <Note tone={toast.ok ? "success" : "danger"}>{toast.msg}</Note>}

        {inGame && g && (
          <>
            <Panel>
              <Label icon={Activity}>Ahora</Label>
              <p className="text-lg">{g.doing}</p>
              <div>
                <Button title="Va a Lorencia y queda en pausa" onClick={() => void act.order({ cmd: "town" })}>
                  <House size={13} />
                  Ir al pueblo
                </Button>
              </div>
            </Panel>

            <Panel>
              <div className="flex items-baseline justify-between">
                <strong className="font-semibold tracking-tight">Nivel {g.char.level}</strong>
                <span className="font-mono text-sm text-faint">
                  {g.where.mapName} · {g.where.x},{g.where.y}
                </span>
              </div>
              <Bar value={Math.max(0, g.char.hp[0])} max={g.char.hp[1]} tone="danger" label="Vida" icon={Heart} />
              <Bar value={Math.max(0, g.char.mp[0])} max={g.char.mp[1]} tone="info" label="Maná" icon={Droplet} />
              <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-2">
                <Stat label="Exp 1 min" icon={TrendingUp}>{fmtExp(g.exp.perMin1)}/min</Stat>
                <Stat label="Exp 5 min" icon={Gauge}>{fmtExp(g.exp.perMin5)}/min</Stat>
                <Stat label="Zen" icon={Coins}>{g.char.zen != null ? g.char.zen.toLocaleString("es") : "—"}</Stat>
                <Stat label="Sesión" icon={Swords}>{g.session ? `${g.session.kills} kills · ${g.session.deaths} muertes` : "—"}</Stat>
                <Stat label="Subió" icon={ChevronsUp}>{g.session ? `${g.char.level - g.session.level0} niveles en ${ago(g.session.since, now)}` : "—"}</Stat>
                <Stat label="Ataque" icon={Zap}>{g.session?.skill ?? "—"}</Stat>
              </dl>
            </Panel>

            <Panel>
              <Label icon={Dumbbell}>Stats</Label>
              {stats && (
                <div className="grid grid-cols-2 gap-1.5">
                  {STAT_KEYS.map((k) => (
                    <div
                      key={k}
                      className="relative flex items-center justify-between overflow-hidden rounded-md bg-hover px-2 py-1"
                      title={g.plan ? `plan: ${Math.round(g.plan.shares[k] * 100)} % del resto${k === "agi" ? `, primero hasta ${g.plan.agiTarget}` : ""}` : ""}
                    >
                      <span className="font-mono text-[10.5px] leading-4 font-medium tracking-[0.08em] text-faint">{k.toUpperCase()}</span>
                      <b className="font-mono font-medium">{stats[k]}</b>
                      <i className="absolute bottom-0 left-0 h-0.5 rounded-xs bg-accent" style={{ width: `${pct(stats[k], Math.max(1, statTotal))}%` }} />
                    </div>
                  ))}
                </div>
              )}
              <small className="text-xs text-muted">
                {g.char.points} puntos libres{g.plan ? ` · reparte de a ${g.plan.batch} · Agi hasta ${g.plan.agiTarget}` : ""}
              </small>
            </Panel>
          </>
        )}
        {!inGame && loaded && online && (
          <Panel>
            <p className="text-faint">{g?.doing ?? data.msg ?? "Conectando…"}</p>
          </Panel>
        )}
      </aside>

      <main className="relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-paper max-[1100px]:h-[60vh]">
        {inGame ? <Radar state={g} /> : <div className="grid h-full place-items-center text-faint">{online ? "Esperando al personaje…" : "Conectá a Capitan para ver el mapa."}</div>}
      </main>

      <section className="flex min-h-0 flex-col gap-1.5 rounded-lg bg-soft px-4 py-3">
        <Label icon={ListChecks}>Decisiones</Label>
        <Feed g={g} />
      </section>
    </div>
  );
}

function Note({ tone = "default", children }: { tone?: "default" | "success" | "danger"; children: React.ReactNode }) {
  const Icon = tone === "danger" ? TriangleAlert : tone === "success" ? CircleCheck : Info;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg bg-soft px-3 py-2 text-sm",
        tone === "default" && "text-muted",
        tone === "success" && "bg-[color-mix(in_srgb,var(--paper)_86%,var(--success))] text-success",
        tone === "danger" && "bg-[color-mix(in_srgb,var(--paper)_86%,var(--danger))] text-danger",
      )}
    >
      <Icon size={14} className="mt-0.5" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
