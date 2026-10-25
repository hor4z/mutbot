/** Datos y acciones de la estación en el navegador: sondeo de /api/state y pedidos a /api/do. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Alert, Routine, StationRequest } from "../../estacion-logic";
import type { Invasion } from "../../panel-protocol";

export type Character = {
  key: string;
  char: string;
  user: string;
  /** estado de la cuenta en la base: active / blocked */
  account: string;
  status: string;
  msg: string;
  pid: number | null;
  port: number;
  panel: boolean;
  routine: Routine | null;
  stuck: boolean;
  /** a quién sigue como sombra (el orquestador de la estación lo decide) y si el usuario lo apagó */
  shadowOf: string | null;
  shadowOff: boolean;
  /** conexión elegida (se aplica al próximo conectar), la del proceso que corre ahora y si el proxy está configurado */
  conn: "direct" | "proxy";
  connUsed: "direct" | "proxy" | null;
  proxyReady: boolean;
  game: null | {
    mode: string;
    doing: string;
    level: number;
    resets: number | null;
    map: string;
    hp: [number, number];
    expPerMin: number;
    session?: { since: number; kills: number; deaths: number; exp: number } | null;
  };
};
export type StationData = { chars: Character[]; alerts: Alert[]; invasion: Invasion | null; now: number; /** cuentas creadas sin personaje todavía (paso 2 pendiente) */ freeAccounts: string[] };
export type Result = { ok: boolean; msg: string };

export const isOnline = (c: Character) => c.pid != null;
export const isPaused = (c: Character) => c.game?.mode === "paused" || (c.routine?.kind === "pause" && c.status === "on");

const EMPTY: StationData = { chars: [], alerts: [], invasion: null, now: 0, freeAccounts: [] };

/** Estado de la estación cada 2 s (solo lectura: GET /api/state). */
export function useStationData() {
  const [data, setData] = useState<StationData>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
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
        setData({ chars: s.chars ?? [], alerts: s.alerts ?? [], invasion: s.invasion ?? null, now: s.now ?? Date.now(), freeAccounts: s.freeAccounts ?? [] });
        setLoaded(true);
        setError("");
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
  return { data, loaded, error, refresh: refreshFn };
}

/** POST /api/do. */
async function post(body: StationRequest): Promise<Result> {
  try {
    const r = await fetch("/api/do", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, msg: j.msg ?? (r.ok ? "Listo." : `La estación rechazó el pedido (${r.status}).`) };
  } catch {
    return { ok: false, msg: "La estación no contesta." };
  }
}

/** POST a un endpoint de alta de la estación (la clave solo viaja a la propia estación, en loopback). */
async function postAccount(path: string, body: object): Promise<Result> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, msg: j.msg ?? (r.ok ? "Listo." : `La estación rechazó el pedido (${r.status}).`) };
  } catch {
    return { ok: false, msg: "La estación no contesta." };
  }
}
/** Paso 1: crear la cuenta en el juego (por el worker); queda guardada sin personaje. */
export const postCuenta = (a: { user: string; pass: string }) => postAccount("/api/cuenta", a);
/** Paso 2: el personaje y su clase en una cuenta sin personaje; el bot lo crea al conectarlo. */
export const postPersonaje = (a: { user: string; char: string; cls: string; replace?: string }) => postAccount("/api/personaje", a);
/** Cuenta y personaje que ya existen en el juego: se cifran y pasan por el worker. */
export const postAlta = (a: { user: string; char: string; pass: string; cls?: string }) => postAccount("/api/alta", a);

export type Actions = Record<"connect" | "disconnect" | "retry" | "pause" | "resume", (c: Character) => Promise<Result>> & {
  shadow: (c: Character, on: boolean) => Promise<Result>;
  conn: (c: Character, mode: "direct" | "proxy") => Promise<Result>;
};

export function useActions(refresh: () => void): Actions {
  return useMemo(() => {
    const run = async (body: StationRequest) => {
      const r = await post(body);
      refresh();
      return r;
    };
    return {
      connect: (c) => run({ action: "connect", char: c.key, routine: { kind: "farm" } }),
      disconnect: (c) => run({ action: "disconnect", char: c.key }),
      retry: (c) => run({ action: "retry", char: c.key }),
      pause: (c) => run({ action: "routine", char: c.key, routine: { kind: "pause" } }),
      resume: (c) => run({ action: "routine", char: c.key, routine: { kind: "farm" } }),
      shadow: (c, on) => run({ action: "shadow", char: c.key, on }),
      conn: (c, mode) => run({ action: "conn", char: c.key, mode }),
    };
  }, [refresh]);
}
