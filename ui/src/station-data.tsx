/**
 * Datos y acciones de la estación en el navegador: sondeo de /api/state, pedidos a /api/do,
 * avisos (toasts) y utilidades de presentación que comparten las vistas.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Alert, RoleAssign, ScoutReport, StationRequest, Routine } from "../../estacion-logic";
import { roleRoutine } from "../../estacion-logic";
import type { EventTimer, Invasion } from "../../panel-protocol";

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
  lastRoutine?: Routine | null;
  /** estrategia (la guardada, o la que sale de la última rutina) */
  role: RoleAssign;
  roleSaved: boolean;
  stuck: boolean;
  game: null | {
    mode: string;
    doing: string;
    level: number;
    resets: number | null;
    map: string;
    x: number;
    y: number;
    hp: [number, number];
    mp?: [number, number];
    expPerMin: number;
    zen?: number | null;
    bag?: number | null;
    nearby?: { monsters: number; players: number };
    resetsPerDay?: number | null;
    session?: { since: number; kills: number; deaths: number; exp: number } | null;
  };
};
export type Gold = { id: number; from: string; name: string; mapName: string; x: number; y: number; at: number };
export type Scout = ScoutReport & { mapName: string };
export type StationData = {
  chars: Character[];
  golds: Gold[];
  alerts: Alert[];
  invasion: Invasion | null;
  events?: EventTimer[];
  scouts: Scout[];
  now: number;
};
export type Result = { ok: boolean; msg: string; body?: Record<string, unknown> };

export const classNames: Record<string, string> = { dk: "Dark Knight", dw: "Dark Wizard", elf: "Fairy Elf", mg: "Magic Gladiator" };
export const classShort: Record<string, string> = { dk: "DK", dw: "DW", elf: "ELF", mg: "MG" };

export const isOnline = (c: Character) => c.pid != null;
export const isPaused = (c: Character) => c.game?.mode === "paused" || (c.routine?.kind === "pause" && c.status === "on");
/** Necesita atención: algo para mirar ya. */
export function attention(c: Character, alerts: Alert[] = [], now = Date.now()): string[] {
  const out: string[] = [];
  if (c.status === "failed") out.push("Error al entrar");
  if (c.status === "in-use") out.push("Cuenta abierta en otro lado");
  if (c.account === "blocked") out.push("Cuenta bloqueada");
  if (c.stuck) out.push("Trabado");
  if (c.game?.bag != null && c.game.bag >= 0.92) out.push("Bolsa llena");
  if (c.game?.mode === "dead") out.push("Muerto");
  const recent = alerts.find((a) => a.char === c.char && a.kind === "pk" && now - a.at < 120_000);
  if (recent) out.push("PK cerca");
  return out;
}

// --- Tiempo ---------------------------------------------------------------------------------------
export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "ahora";
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
export const countdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// --- Avisos ---------------------------------------------------------------------------------------
export type Toast = { id: number; msg: string; tone: "ok" | "bad" | "info" };
type ToastApi = { toasts: Toast[]; push: (msg: string, tone?: Toast["tone"]) => void; dismiss: (id: number) => void };
const ToastCtx = createContext<ToastApi>({ toasts: [], push: () => {}, dismiss: () => {} });
export const useToasts = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((msg: string, tone: Toast["tone"] = "info") => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
    setTimeout(() => dismiss(id), tone === "bad" ? 9000 : 5000);
  }, [dismiss]);
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastCtx.Provider value={value}>{children}</ToastCtx.Provider>;
}

// --- Sondeo ---------------------------------------------------------------------------------------
const EMPTY: StationData = { chars: [], golds: [], alerts: [], invasion: null, scouts: [], now: 0 };

/** Estado de la estación cada 2 s (solo lectura: GET /api/state). */
export function useStationData() {
  const [data, setData] = useState<StationData>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    let fetching = false;
    const controller = new AbortController();
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const r = await fetch("/api/state", { signal: controller.signal, cache: "no-store" });
        if (!r.ok) throw Error();
        const s = await r.json();
        if (!live) return;
        setData({
          chars: s.chars ?? [],
          golds: s.golds ?? [],
          alerts: s.alerts ?? [],
          invasion: s.invasion ?? null,
          events: s.events,
          scouts: s.scouts ?? [],
          now: s.now ?? Date.now(),
        });
        setLoaded(true);
        setError("");
        setUpdatedAt(Date.now());
      } catch {
        if (live) setError("La estación no está disponible. Reintentando…");
      } finally {
        fetching = false;
      }
    }
    refresh.current = () => void poll();
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const refreshFn = useCallback(() => refresh.current(), []);
  return { data, loaded, error, updatedAt, refresh: refreshFn };
}

/** POST /api/do con aviso del resultado. */
export async function post(body: StationRequest): Promise<Result> {
  try {
    const r = await fetch("/api/do", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, msg: j.msg ?? (r.ok ? "Listo." : `La estación rechazó el pedido (${r.status}).`), body: j };
  } catch {
    return { ok: false, msg: "La estación no contesta." };
  }
}

export type BulkOp = "connect" | "disconnect" | "pause" | "resume" | RoleAssign;
export type Actions = {
  /** una orden con aviso */
  run: (body: StationRequest, quiet?: boolean) => Promise<Result>;
  connect: (c: Character) => Promise<Result>;
  disconnect: (c: Character) => Promise<Result>;
  pause: (c: Character) => Promise<Result>;
  resume: (c: Character) => Promise<Result>;
  setRole: (c: Character, role: RoleAssign) => Promise<Result>;
  /** la misma operación sobre varios, de a uno; un solo aviso con el resumen */
  bulk: (chars: Character[], op: BulkOp) => Promise<void>;
};

const BULK_LABEL: Record<string, string> = { connect: "Conectados", disconnect: "Desconectados", pause: "En pausa", resume: "Reanudados" };

export function useActions(refresh: () => void): Actions {
  const { push } = useToasts();
  return useMemo(() => {
    const run: Actions["run"] = async (body, quiet) => {
      const r = await post(body);
      if (!quiet) push(r.msg, r.ok ? "ok" : "bad");
      refresh();
      return r;
    };
    const quiet = {
      connect: (c: Character) => run({ action: "connect", char: c.key, routine: roleRoutine(c.role) }, true),
      disconnect: (c: Character) => run({ action: "disconnect", char: c.key }, true),
      pause: (c: Character) => run({ action: "routine", char: c.key, routine: { kind: "pause" } }, true),
      resume: (c: Character) => run({ action: "routine", char: c.key, routine: roleRoutine(c.role) }, true),
      role: (c: Character, role: RoleAssign) => run({ action: "role", char: c.key, role }, true),
    };
    const loud = (fn: (c: Character) => Promise<Result>) => async (c: Character) => {
      const r = await fn(c);
      push(r.msg, r.ok ? "ok" : "bad");
      return r;
    };
    const bulk: Actions["bulk"] = async (chars, op) => {
      if (!chars.length) return;
      const res: Result[] = [];
      for (const c of chars) res.push(await (typeof op === "string" ? quiet[op](c) : quiet.role(c, op)));
      const bad = res.filter((r) => !r.ok);
      const label = typeof op === "string" ? BULK_LABEL[op] : "Estrategia cambiada";
      if (chars.length === 1) push(res[0].msg, res[0].ok ? "ok" : "bad");
      else if (!bad.length) push(`${label}: ${chars.length} personajes.`, "ok");
      else push(`${label}: ${res.length - bad.length} de ${res.length}. ${bad[0].msg}`, "bad");
    };
    return {
      run,
      connect: loud(quiet.connect), disconnect: loud(quiet.disconnect), pause: loud(quiet.pause), resume: loud(quiet.resume),
      setRole: (c, role) => loud((x) => quiet.role(x, role))(c),
      bulk,
    };
  }, [push, refresh]);
}

/** Hora actual que se refresca sola (para contadores y "hace x min"). */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

// --- Persistencia chica (solo comodidad) ---------------------------------------------------------
export function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
