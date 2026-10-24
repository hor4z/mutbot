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
export type StationData = { chars: Character[]; alerts: Alert[]; invasion: Invasion | null; now: number };
export type Result = { ok: boolean; msg: string };

export const isOnline = (c: Character) => c.pid != null;
export const isPaused = (c: Character) => c.game?.mode === "paused" || (c.routine?.kind === "pause" && c.status === "on");

const EMPTY: StationData = { chars: [], alerts: [], invasion: null, now: 0 };

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
        setData({ chars: s.chars ?? [], alerts: s.alerts ?? [], invasion: s.invasion ?? null, now: s.now ?? Date.now() });
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

/** POST /api/alta: la estación cifra los datos y los manda por el worker. */
export async function postAlta(a: { user: string; char: string; pass: string; create: boolean }): Promise<Result> {
  try {
    const r = await fetch("/api/alta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, msg: j.msg ?? (r.ok ? "Listo." : `La estación rechazó el alta (${r.status}).`) };
  } catch {
    return { ok: false, msg: "La estación no contesta." };
  }
}

export type Actions = Record<"connect" | "disconnect" | "pause" | "resume", (c: Character) => Promise<Result>> & {
  shadow: (c: Character, on: boolean) => Promise<Result>;
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
      pause: (c) => run({ action: "routine", char: c.key, routine: { kind: "pause" } }),
      resume: (c) => run({ action: "routine", char: c.key, routine: { kind: "farm" } }),
      shadow: (c, on) => run({ action: "shadow", char: c.key, on }),
    };
  }, [refresh]);
}
