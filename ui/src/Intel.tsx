/** Tarjeta "Inteligencia": lo que los bots aprenden de la base (dragón probable, ladrones, zonas letales) y sus alertas de PK / trabado. */
import { Brain, Flame, Hourglass, Skull, Swords, UserX } from "lucide-react";
import { ago, useNow, type StationData } from "./station-data";
import { Card } from "./station-kit";

export function IntelCard({ data }: { data: StationData }) {
  const now = useNow(15_000);
  const list = data.insights ?? [];
  const best = list[0];
  const dragon = list.find((i) => i.dragon)?.dragon ?? null;
  const thieves = new Map<string, number>();
  for (const i of list) for (const t of i.thieves) thieves.set(t.name, Math.max(thieves.get(t.name) ?? 0, t.n));
  const lethal = best?.lethal ?? [];
  const hunt = [...(best?.hunt ?? [])].sort((a, b) => b.factor - a.factor).slice(0, 4);
  const warns = data.alerts.filter((a) => (a.kind === "pk" || a.kind === "stuck") && now - a.at < 60 * 60_000).slice(0, 6);
  const empty = !best && warns.length === 0;
  return (
    <Card title="Inteligencia" icon={<Brain size={15} />} extra={best && <small className="muted">{best.from} · {ago(best.at, now)}</small>} className="intel-card">
      {empty ? (
        <p className="muted pad">Sin datos todavía: los bots mandan su resumen cada 10 min si tienen base de datos.</p>
      ) : (
        <div className="intel-body">
          {dragon && (
            <div className="intel-row">
              <Flame size={14} className="gold" />
              <span>Dragón probable: <strong>{dragon.name}</strong> <small className="muted">({Math.round(dragon.share * 100)}% de {dragon.n} invasiones{dragon.scope ? `, ${dragon.scope}` : ""})</small></span>
            </div>
          )}
          {thieves.size > 0 && (
            <div className="intel-row">
              <UserX size={14} className="bad" />
              <span>Ladrones de cajas: {[...thieves].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, k]) => `${n} (${k})`).join(", ")}</span>
            </div>
          )}
          {lethal.length > 0 && (
            <div className="intel-row">
              <Skull size={14} className="bad" />
              <span>Zonas letales: {lethal.map((l) => `${l.name} (${l.cells.length} celda${l.cells.length === 1 ? "" : "s"})`).join(", ")}</span>
            </div>
          )}
          {hunt.length > 0 && (
            <ul className="intel-hunt" aria-label="Factor de cacería por mapa">
              {hunt.map((h) => (
                <li key={h.map}><span>{h.name}</span><small className="muted">{Math.round(h.minutes)} min · {h.boxes} cajas</small><b className={h.factor >= 1 ? "good" : "bad"}>×{h.factor.toFixed(2)}</b></li>
              ))}
            </ul>
          )}
          {warns.length > 0 && (
            <ul className="intel-alerts" aria-label="Alertas de PK y trabados">
              {warns.map((a) => (
                <li key={a.id} className={`tone-${a.tone}`}>
                  {a.kind === "pk" ? <Swords size={13} /> : <Hourglass size={13} />}
                  <span>{a.text}</span>
                  <time>{ago(a.at, now)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
