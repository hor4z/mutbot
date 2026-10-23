/** Alertas de la flota, dorados e invasiones: el feed global y las vistas que lo usan. */
import { useState, type ReactNode } from "react";
import { Binoculars, Bell, BellOff, Flame, Hourglass, Lock, Package, Plug, Skull, Sparkles, Swords, TrendingUp, Info, Target, MapPin } from "lucide-react";
import type { Alert, AlertKind } from "../../estacion-logic";
import { ROLES } from "../../estacion-logic";
import { Action } from "./components";
import { ago, countdown, useNow, type Actions, type Character, type StationData } from "./station-data";
import { Card, Empty, RoleChip } from "./station-kit";

const alertIcon: Record<AlertKind, (s: number) => ReactNode> = {
  gold: (s) => <Sparkles size={s} />,
  invasion: (s) => <Flame size={s} />,
  death: (s) => <Skull size={s} />,
  pk: (s) => <Swords size={s} />,
  blocked: (s) => <Lock size={s} />,
  bagfull: (s) => <Package size={s} />,
  stuck: (s) => <Hourglass size={s} />,
  status: (s) => <Plug size={s} />,
  scout: (s) => <Binoculars size={s} />,
  level: (s) => <TrendingUp size={s} />,
};

/** Feed global de eventos: lo más nuevo arriba; "Solo críticas" deja lo que pide atención. */
export function AlertFeed({ alerts, limit, onPick }: { alerts: Alert[]; limit?: number; onPick?: (char: string) => void }) {
  const now = useNow(15_000);
  const [only, setOnly] = useState(false);
  const list = alerts.filter((a) => !only || a.tone === "bad" || a.tone === "warn").slice(0, limit ?? 60);
  return (
    <Card
      title="Eventos"
      icon={<Bell size={15} />}
      className="feed"
      extra={
        <button className={`chip-toggle ${only ? "on" : ""}`} aria-pressed={only} onClick={() => setOnly(!only)}>
          Solo críticas
        </button>
      }
    >
      {list.length === 0 ? (
        <Empty icon={<BellOff size={20} />} title={only ? "Sin alertas críticas" : "Todo tranquilo"}>
          Acá aparecen dorados, invasiones, muertes, bloqueos, bolsa llena y bots trabados.
        </Empty>
      ) : (
        <ol className="feed-list" aria-live="polite">
          {list.map((a) => (
            <li key={a.id} className={`feed-item tone-${a.tone}`}>
              <span className="feed-ico">{alertIcon[a.kind](14)}</span>
              <span className="feed-body">
                {a.char && onPick ? (
                  <button className="link-btn" onClick={() => onPick(a.char!)}>{a.text}</button>
                ) : (
                  a.text
                )}
                <time dateTime={new Date(a.at).toISOString()}>{ago(a.at, now)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Invasión en curso o la próxima (calendario fijo del server). */
export function InvasionCard({ data }: { data: StationData }) {
  const now = useNow();
  const inv = data.invasion;
  const active = inv?.status === "active";
  const next = inv?.nextAt && inv.nextAt > now ? inv.nextAt - now : null;
  return (
    <div className={`invasion ${active ? "active" : ""}`}>
      <span className="invasion-ico"><Flame size={18} /></span>
      <div className="invasion-main">
        <strong>{active ? `Invasión activa · ${inv!.total} monstruos` : inv?.status === "defeated" ? "Invasión derrotada" : "Sin invasión ahora"}</strong>
        <small>
          {active
            ? inv!.maps.map((m) => `${m.name} (${m.alive})`).join(" · ") || "Sin detalle de mapa"
            : next != null
              ? `Próxima en ${countdown(next)}`
              : inv
                ? "Esperando el calendario"
                : "Ningún personaje conectado la está mirando"}
        </small>
      </div>
      {active && <span className="pill tone-warn">En curso</span>}
    </div>
  );
}

/** Dorados vistos por los bots (viven 1 min) y quién los está cazando. */
export function GoldList({ data, actions }: { data: StationData; actions?: Actions }) {
  const now = useNow();
  const hunters = data.chars.filter((c) => c.pid != null && c.game?.mode === "hunt");
  const idle = data.chars.filter((c) => c.pid != null && c.status === "on" && c.game?.mode !== "hunt" && c.game?.mode !== "dead");
  return (
    <div className="golds">
      {data.golds.length === 0 ? (
        <Empty icon={<Sparkles size={20} />} title="Ningún dorado a la vista">
          Los bots avisan acá apenas ven uno. Cada aviso dura un minuto.
        </Empty>
      ) : (
        <ul className="gold-list">
          {data.golds.map((g) => {
            const left = Math.max(0, 1 - (now - g.at) / 60_000);
            return (
              <li key={`${g.from}:${g.id}`} className="gold-item">
                <span className="gold-ico"><Sparkles size={16} /></span>
                <div className="gold-main">
                  <strong>{g.name || "Dorado"}</strong>
                  <small><MapPin size={11} /> {g.mapName} · {g.x}, {g.y} · visto por {g.from} · {ago(g.at, now)}</small>
                </div>
                <i className="gold-ttl" style={{ transform: `scaleX(${left})` }} aria-hidden />
              </li>
            );
          })}
        </ul>
      )}
      <div className="hunters">
        <span className="hunters-title"><Target size={13} /> Cazadores</span>
        <span className={hunters.length ? "" : "muted"}>{hunters.length ? `${hunters.map((c) => c.char).join(", ")} cazando ahora` : "Nadie está cazando dorados."}</span>
        {actions && idle.length > 0 && (
          <div className="hunters-actions">
            {idle.slice(0, 4).map((c) => (
              <Action key={c.key} className="quiet small" onClick={() => void actions.setRole(c, { role: "golden" })}>
                <Sparkles size={13} /> {c.char} a cazar
              </Action>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Tarjeta "Dorados / invasiones" para la Flota. */
export function GoldsCard({ data, actions, onOpen }: { data: StationData; actions: Actions; onOpen?: () => void }) {
  return (
    <Card
      title="Dorados e invasiones"
      icon={<Sparkles size={15} />}
      extra={onOpen && <button className="link-btn" onClick={onOpen}>Ver todo</button>}
      className="golds-card"
    >
      <InvasionCard data={data} />
      <GoldList data={data} actions={actions} />
    </Card>
  );
}

const eventNames: Record<string, string> = { devilSquare: "Devil Square", bloodCastle: "Blood Castle", chaosCastle: "Chaos Castle" };

export function EventsCard({ data }: { data: StationData }) {
  const now = useNow(5000);
  const ev = data.events ?? [];
  return (
    <Card title="Eventos del server" icon={<Info size={15} />}>
      {ev.length === 0 ? (
        <p className="muted pad">Sin datos: los bots los piden al server cuando están en el juego.</p>
      ) : (
        <ul className="plain-list">
          {ev.map((e) => (
            <li key={e.key}>
              <strong>{eventNames[e.key] ?? e.key}</strong>
              <span className={e.minutes === 0 ? "gold" : "muted"}>
                {e.minutes === 0 ? "Abierto ahora" : e.minutes == null ? "Más de 4 h" : e.opensAt ? `Abre en ${Math.max(0, Math.round((e.opensAt - now) / 60000))} min` : `En ${e.minutes} min`}
                {e.users ? ` · ${e.users} adentro` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function GoldsView({ data, actions, onPick }: { data: StationData; actions: Actions; onPick: (key: string) => void }) {
  const pick = (name: string) => {
    const c = data.chars.find((x) => x.char === name);
    if (c) onPick(c.key);
  };
  return (
    <div className="view-grid two">
      <div className="stack">
        <Card title="Dorados e invasiones" icon={<Sparkles size={15} />}>
          <InvasionCard data={data} />
          <GoldList data={data} actions={actions} />
        </Card>
        <EventsCard data={data} />
        <Card title="Quiénes cazan" icon={<Target size={15} />}>
          <ul className="plain-list">
            {data.chars.map((c: Character) => (
              <li key={c.key}>
                <span className="row-inline"><strong>{c.char}</strong><RoleChip role={c.role.role} warp={c.role.role === "spot" ? c.role.warp : undefined} /></span>
                <span className="muted">{c.role.role === "golden" ? ROLES.golden.label : c.pid == null ? "Desconectado" : c.game?.doing ?? "—"}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <AlertFeed alerts={data.alerts.filter((a) => a.kind === "gold" || a.kind === "invasion" || a.kind === "scout")} onPick={pick} />
    </div>
  );
}
