import { useEffect, useRef, useState } from "react";
import type { PanelCommand, PanelState } from "../../panel-protocol";
import { addDecisions, diffFeed, pushFeed, type Decision, type FeedItem } from "./hud-logic";
import { demoMode, startDemo } from "./demo";

export type Log = { at: number; text: string; kind: string };
export type Chat = { at: number; kind: "normal" | "party" | "guild" | "whisper" | "server"; from: string; text: string; mine?: boolean };
export type Sample = { at: number; exp: number; kills: number };

/**
 * Conexión con el bot (WebSocket del mismo origen) o con el bot simulado de `?demo`.
 * Reintenta solo, con espera creciente (1 s → 8 s); mientras reintenta, el último estado queda en pantalla
 * marcado como viejo (lo decide Panel con `lastAt`).
 */
export function useBot() {
  const [state, setState] = useState<PanelState | null>(null),
    [connected, setConnected] = useState(false),
    [attempt, setAttempt] = useState(0),
    [logs, setLogs] = useState<Log[]>([]),
    [chats, setChats] = useState<Chat[]>([]),
    [decisions, setDecisions] = useState<Decision[]>([]),
    [feed, setFeed] = useState<FeedItem[]>([]),
    [samples, setSamples] = useState<Sample[]>([]),
    [result, setResult] = useState<{ id: number; ok: boolean } | null>(null),
    [toast, setToast] = useState("");
  const socket = useRef<WebSocket | null>(null),
    demo = useRef<ReturnType<typeof startDemo> | null>(null),
    nextId = useRef(1),
    lastAt = useRef(0),
    prev = useRef<PanelState | null>(null),
    still = useRef<{ x: number; y: number; map: number; since: number }>({ x: -1, y: -1, map: -1, since: Date.now() }),
    levels = useRef<[number, number][]>([]);
  const add = (text: string, at = Date.now(), kind = "bot") => setLogs((old) => [...old, { text, at, kind }].slice(-500));

  useEffect(() => {
    let done = false;
    let retry: ReturnType<typeof setTimeout>;
    let tries = 0;
    const onState = (st: PanelState) => {
      const now = Date.now();
      lastAt.current = now;
      setState(st);
      // Cuánto hace que no se mueve (para avisar de una traba).
      const s = still.current;
      if (s.x !== st.where.x || s.y !== st.where.y || s.map !== st.where.map) still.current = { x: st.where.x, y: st.where.y, map: st.where.map, since: now };
      // Después de un reset el nivel baja: la medición de niveles/min arranca de nuevo.
      const prevLevel = levels.current[levels.current.length - 1]?.[1];
      if (prevLevel != null && st.char.level < prevLevel) levels.current = [];
      levels.current.push([now, st.char.level]);
      levels.current = levels.current.filter(([t]) => now - t < 600000);
      // Feed en vivo a partir de las diferencias.
      const lines = diffFeed(prev.current, st);
      if (lines.length) setFeed((old) => pushFeed(old, lines, now));
      prev.current = st;
      // Una muestra cada ~5 s (hasta 15 min) para la sparkline de exp/min.
      setSamples((old) => {
        const last = old[old.length - 1];
        if (last && now - last.at < 5000) return old;
        const out = [...old, { at: now, exp: st.exp.perMin1, kills: st.session?.kills ?? 0 }];
        return out.length > 180 ? out.slice(-180) : out;
      });
    };
    const onDecisions = (list: { at: string | number; kind: string; what: string }[]) => setDecisions((old) => addDecisions(old, list));
    const reset = () => {
      // Al (re)conectar el bot vuelve a mandar el historial, el log y el chat: empezar de cero
      // (si no, cada reconexión los duplicaba).
      setLogs([]);
      setChats([]);
      setDecisions([]);
    };
    const mode = demoMode();
    if (mode === "on") {
      reset();
      setConnected(true);
      demo.current = startDemo({
        state: onState,
        log: (t, at) => add(t, at),
        chat: (c) => setChats((o) => [...o, c].slice(-500)),
        decisions: (l) => {
          onDecisions(l);
          for (const d of l) add(`${d.kind}: ${d.what}`, typeof d.at === "number" ? d.at : Date.parse(d.at));
        },
        result: (id, ok, msg) => {
          add(msg, Date.now(), ok ? "ok" : "bad");
          setToast(msg);
          setResult({ id, ok });
        },
      });
      return () => {
        done = true;
        demo.current?.stop();
        demo.current = null;
      };
    }
    if (mode === "off") return; // demo "desconectado": sin estado, sin socket
    function connect() {
      if (done) return;
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
      socket.current = ws;
      ws.onopen = () => {
        if (done) return;
        tries = 0;
        setAttempt(0);
        setConnected(true);
      };
      ws.onclose = () => {
        if (done) return;
        setConnected(false);
        tries++;
        setAttempt(tries);
        retry = setTimeout(connect, Math.min(8000, 1000 * 2 ** Math.min(tries - 1, 3)));
      };
      ws.onmessage = (e) => {
        if (done) return;
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.type === "panel-state") onState(m.state);
        else if (m.type === "decision") onDecisions([m.decision]);
        else if (m.type === "history") onDecisions(m.decisions);
        if (m.type === "hello") reset();
        else if (m.type === "log") add(m.text, m.at);
        else if (m.type === "chat") setChats((old) => [...old, m as Chat].slice(-500));
        else if (m.type === "decision") add(`${m.decision.kind}: ${m.decision.what}`, Date.parse(m.decision.at) || Date.now());
        else if (m.type === "history") for (const d of m.decisions.slice(-40)) add(`${d.kind}: ${d.what}`, Date.parse(d.at) || Date.now());
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
    const id = nextId.current++;
    if (demo.current) {
      add(`Orden: ${command.cmd}`, Date.now(), "cmd");
      demo.current.send(id, command);
      return id;
    }
    if (socket.current?.readyState !== WebSocket.OPEN) {
      setToast("Sin conexión con el personaje.");
      return null;
    }
    socket.current.send(JSON.stringify({ type: "command", id, command }));
    add(
      `Orden: ${command.cmd}${"warp" in command ? " · " + command.warp : ""}${"map" in command ? " · " + command.map : ""}`,
      Date.now(),
      "cmd",
    );
    return id;
  }
  return { state, connected, attempt, logs, chats, decisions, feed, samples, result, toast, send, lastAt, levels, still };
}
