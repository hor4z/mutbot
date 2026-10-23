/** Estrategias: qué hace cada personaje y qué le cuentan los exploradores al resto. */
import { Binoculars, ChevronDown, Info, Sparkles, Users } from "lucide-react";
import { ROLES, ROLE_KEYS, scoutHeat, type RoleKey } from "../../estacion-logic";
import { ago, useNow, type Actions, type Character, type Scout, type StationData } from "./station-data";
import { Avatar, Card, Empty, RoleChip, RoleMenu, StatusPill, roleIcon, roleText, roleTone } from "./station-kit";

const HEAT = { free: "Libre", busy: "Con gente", crowded: "Llena" } as const;

function RoleLegend({ chars }: { chars: Character[] }) {
  return (
    <div className="role-grid">
      {ROLE_KEYS.map((k: RoleKey) => {
        const mine = chars.filter((c) => c.role.role === k);
        return (
          <div key={k} className={`role-card tone-${roleTone[k]}`}>
            <span className="role-ico">{roleIcon[k](18)}</span>
            <div>
              <h3>{ROLES[k].label}</h3>
              <p>{ROLES[k].hint}</p>
              <div className="role-who">
                {mine.length ? mine.map((c) => <span key={c.key} className="mini-chip">{c.char}</span>) : <small>Nadie</small>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScoutList({ scouts }: { scouts: Scout[] }) {
  const now = useNow(15_000);
  return (
    <Card title="Lo que ven los exploradores" icon={<Binoculars size={15} />}>
      {scouts.length === 0 ? (
        <Empty icon={<Binoculars size={20} />} title="Sin reportes todavía">
          Un personaje con la estrategia Explorador publica acá el mapa, la gente y los dorados que ve. Los reportes duran 10 minutos.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Campo</th><th>Competencia</th><th>Jugadores</th><th>Dorados</th><th>Monstruos</th><th>Explorador</th><th>Cuándo</th></tr>
            </thead>
            <tbody>
              {scouts.map((s) => {
                const h = scoutHeat(s);
                return (
                  <tr key={`${s.from}:${s.map}`}>
                    <td><strong>{s.mapName}</strong><small className="mono"> {s.x}, {s.y}</small></td>
                    <td><span className={`pill tone-${h === "free" ? "good" : h === "busy" ? "warn" : "bad"}`}>{HEAT[h]}</span></td>
                    <td>{s.players}</td>
                    <td>{s.golds ? <span className="gold"><Sparkles size={12} /> {s.golds}</span> : "—"}</td>
                    <td>{s.monsters || "—"}</td>
                    <td>{s.from}</td>
                    <td className="muted">{ago(s.at, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function StrategiesView({ data, actions, onOpen }: { data: StationData; actions: Actions; onOpen: (key: string) => void }) {
  const explorers = data.chars.filter((c) => c.role.role === "explorer");
  return (
    <div className="stack gap-lg">
      <RoleLegend chars={data.chars} />
      <Card title="Personajes" icon={<Users size={15} />} extra={<span className="muted">Elegí la estrategia de cada uno; se guarda y se aplica al instante si está en el juego.</span>}>
        {data.chars.length === 0 ? (
          <Empty title="No hay personajes">Creá una cuenta desde “Nueva cuenta” (Ctrl/Cmd+K).</Empty>
        ) : (
          <ul className="assign-list">
            {data.chars.map((c) => (
              <li key={c.key} className="assign-row">
                <Avatar c={c} size={34} />
                <button className="char-name" onClick={() => onOpen(c.key)}>
                  <strong>{c.char}</strong>
                  <small>{c.game ? `Nv. ${c.game.level} · ${c.game.map}` : "Desconectado"}</small>
                </button>
                <StatusPill c={c} />
                <span className="assign-now muted">{c.game?.doing ?? ""}</span>
                <RoleMenu
                  label={`Estrategia de ${c.char}`}
                  current={c.role}
                  onPick={(r) => void actions.setRole(c, r)}
                  trigger={<><RoleChip role={c.role.role} /><span>{roleText(c.role)}</span><ChevronDown size={14} /></>}
                />
                {!c.roleSaved && <small className="muted" title="Todavía no elegiste una: se dedujo de la última rutina">sugerida</small>}
              </li>
            ))}
          </ul>
        )}
        <p className="note"><Info size={13} /> Dorados usa la caza de dorados; Ruta, Explorador y Soporte farmean por la ruta (la party entre compañeros es automática); Spot fija el mapa. Las funciones propias del explorador y del soporte las cumple cada bot al publicar en la estación.</p>
      </Card>
      <ScoutList scouts={data.scouts} />
      {explorers.length === 0 && data.scouts.length === 0 && (
        <p className="muted pad">Tip: poné a un personaje de nivel bajo como Explorador para que revise campos sin arriesgar al principal.</p>
      )}
    </div>
  );
}
