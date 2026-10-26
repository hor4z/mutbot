/** Datos y acciones de la estación en el navegador: sondeo de /api/state (1 s) y pedidos a /api/do y /api/directivas. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelCommand, PanelState } from "../../panel-protocol";

export type Station = {
  char: string | null;
  /** off | starting | on | stopping | in-use | failed | external */
  status: string;
  msg: string;
  pid: number | null;
  /** el usuario lo quiere conectado (si cae, la estación lo reconecta) */
  wanted: boolean;
  panel: boolean;
  game: PanelState | null;
  now: number;
};
export type Result = { ok: boolean; msg: string };

const EMPTY: Station = { char: null, status: "off", msg: "", pid: null, wanted: false, panel: false, game: null, now: 0 };

export function useStation() {
  const [data, setData] = useState<Station>(EMPTY);
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
        const s = (await r.json()) as Station;
        if (!live) return;
        setData(s);
        setError("");
        setLoaded(true);
      } catch (e) {
        if (live && (e as Error).name !== "AbortError") setError("Sin conexión con la estación.");
      } finally {
        fetching = false;
      }
    }
    refresh.current = () => void poll();
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(t);
    };
  }, []);
  return { data, loaded, error, refresh: useCallback(() => refresh.current(), []) };
}

async function post(path: string, body: unknown): Promise<Result> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Result;
  } catch {
    return { ok: false, msg: "No pude hablar con la estación." };
  }
}

export function useActions(refresh: () => void, onResult: (r: Result) => void) {
  const run = useCallback(async (body: unknown) => {
    const r = await post("/api/do", body);
    onResult(r);
    refresh();
    return r;
  }, [refresh, onResult]);
  return {
    connect: () => run({ action: "connect" }),
    disconnect: () => run({ action: "disconnect" }),
    retry: () => run({ action: "retry" }),
    order: (command: PanelCommand) => run({ action: "order", command }),
  };
}

export type Directivas = {
  esquema: Record<string, { def: boolean | number; min?: number; max?: number; doc: string }>;
  valores: Record<string, boolean | number>;
  vivos: Record<string, boolean | number>;
};
export async function getDirectivas(): Promise<Directivas | null> {
  try {
    const r = await fetch("/api/directivas", { cache: "no-store" });
    return r.ok ? ((await r.json()) as Directivas) : null;
  } catch {
    return null;
  }
}
export const setDirectivas = (set: Record<string, boolean | number>, unset: string[] = []) => post("/api/directivas", { set, unset });

export async function getLog(): Promise<string> {
  try {
    const r = await fetch("/api/log", { cache: "no-store" });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}
