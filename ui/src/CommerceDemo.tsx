/** Demo de la vista Comercio (`?demo&view=comercio`): estado simulado local, ninguna orden sale a ningún bot. */
import { useMemo, useState } from "react";
import type { PanelCommand } from "../../panel-protocol";
import { CommerceView } from "./Commerce";
import { createDemo, demoState } from "./commerce-mock";

export function CommerceDemo() {
  const demo = useMemo(() => createDemo(), []);
  const [s, setS] = useState(demo.initial);
  const [toast, setToast] = useState("");
  const send = (c: PanelCommand) => {
    const r = demo.apply(s, c);
    setS(r.next);
    setToast(`${r.ok ? "" : "Rechazada: "}${r.msg}`);
    return 1;
  };
  return (
    <div className="panel-shell" style={{ maxWidth: 1180, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Comercio · Hume <small className="muted">(demo)</small></h1>
      <CommerceView state={demoState(s.bag, s.extra, s.reads, s.mode, s.zen)} send={send} online demo />
      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  );
}
