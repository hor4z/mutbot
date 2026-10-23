/** Tarjeta "Equipo" del personaje: calcula el plan del bot (no mueve nada) y, tras confirmar, lo ejecuta. */
import { useState } from "react";
import { ChevronDown, Shield } from "lucide-react";
import { Action } from "./components";
import { ago, isOnline, useNow, type Actions, type Character } from "./station-data";
import { Card, ConfirmDialog } from "./station-kit";

export function EquipCard({ c, actions }: { c: Character; actions: Actions }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(15_000);
  const plan = c.equipPlan ?? null;
  const live = isOnline(c) && c.status === "on";
  const gains = (plan?.gains ?? []).filter((g) => g.delta !== 0);
  const order = async (cmd: "equipplan" | "equip") => {
    setBusy(true);
    await actions.run({ action: "bot", char: c.key, command: { cmd } });
    setBusy(false);
  };
  return (
    <Card
      title="Equipo"
      icon={<Shield size={15} />}
      className="equip-card"
      extra={
        <span className="row-inline">
          {plan && <small className="muted">{plan.source === "vivo" ? "baúl leído ahora" : "baúl del archivo"} · {ago(plan.at, now)}</small>}
          <button className="button quiet small icon" aria-expanded={open} aria-label={open ? "Ocultar equipo" : "Mostrar equipo"} onClick={() => setOpen(!open)}>
            <ChevronDown size={14} className={open ? "flip" : ""} />
          </button>
        </span>
      }
    >
      {open && (
        <div className="equip-body">
          <div className="equip-actions">
            <Action className="small" disabled={!live || busy} onClick={() => void order("equipplan")} title="Calcula el plan con el baúl ya leído; no mueve nada">Calcular plan</Action>
            <Action className="small danger" disabled={!live || busy || !plan || plan.steps.length === 0} onClick={() => setConfirm(true)} title="Mueve ítems reales: pide confirmación">Equiparse…</Action>
            {!live && <small className="muted">{c.char} tiene que estar en el juego.</small>}
          </div>
          {!plan ? (
            <p className="muted">Sin plan todavía. “Calcular plan” lo arma con el baúl y el equipo actuales, sin mover nada.</p>
          ) : (
            <>
              <p className="equip-summary">{plan.summary}</p>
              {gains.length > 0 && (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Casilla</th><th>Antes</th><th>Después</th><th className="num">Puntaje</th></tr></thead>
                    <tbody>
                      {gains.map((g) => (
                        <tr key={g.slot}>
                          <td>{g.slotName}</td>
                          <td className="muted">{g.before ?? "vacío"}</td>
                          <td>{g.after}</td>
                          <td className="num"><span className={g.delta > 0 ? "good" : "bad"}>{g.scoreBefore} → {g.scoreAfter} ({g.delta > 0 ? "+" : ""}{g.delta})</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {plan.steps.length > 0 && (
                <details className="equip-steps">
                  <summary>{plan.steps.length} paso{plan.steps.length === 1 ? "" : "s"}</summary>
                  <ol>{plan.steps.map((s, i) => <li key={i}>{s.replace(/^\d+\.\s*/, "")}</li>)}</ol>
                </details>
              )}
              {plan.blocked.length > 0 && (
                <ul className="equip-blocked">
                  {plan.blocked.map((b, i) => <li key={i}><strong>{b.name}</strong>: {b.reason}</li>)}
                </ul>
              )}
              {plan.notes.length > 0 && <ul className="equip-notes">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Equipar a ${c.char}`}
        warning="Esto mueve ítems reales: va a Lorencia, saca piezas del baúl y se las pone. El bot vuelve a leer el baúl y arma el plan con datos de ahora."
        confirmLabel="Sí, equipar"
        danger
        onConfirm={() => void order("equip")}
      >
        {plan && (
          <>
            <p className="equip-summary">{plan.summary}</p>
            <ul className="equip-notes">
              {gains.map((g) => <li key={g.slot}>{g.slotName}: {g.before ?? "vacío"} → <strong>{g.after}</strong> ({g.delta > 0 ? "+" : ""}{g.delta})</li>)}
              <li>{plan.steps.length} paso{plan.steps.length === 1 ? "" : "s"}, {plan.blocked.length} bloqueo{plan.blocked.length === 1 ? "" : "s"}.</li>
            </ul>
          </>
        )}
      </ConfirmDialog>
    </Card>
  );
}
