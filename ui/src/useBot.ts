import { useEffect, useState } from "react";
import type { PanelState } from "../../panel-protocol";

/**
 * El estado del bot por el WebSocket de su panel (mismo origen). Reintenta solo, con espera creciente (1 s → 8 s);
 * mientras reintenta, el último estado queda en pantalla.
 */
export function useBot() {
  const [state, setState] = useState<PanelState | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let done = false;
    let retry: ReturnType<typeof setTimeout>;
    let ws: WebSocket | null = null;
    let tries = 0;
    const connect = () => {
      if (done) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
      ws.onopen = () => {
        tries = 0;
        if (!done) setConnected(true);
      };
      ws.onclose = () => {
        if (done) return;
        setConnected(false);
        tries++;
        retry = setTimeout(connect, Math.min(8000, 1000 * 2 ** Math.min(tries - 1, 3)));
      };
      ws.onmessage = (e) => {
        if (done) return;
        try {
          const m = JSON.parse(e.data);
          if (m.type === "panel-state") setState(m.state);
        } catch {
          /* mensaje que no es JSON: se ignora */
        }
      };
    };
    connect();
    return () => {
      done = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return { state, connected };
}
