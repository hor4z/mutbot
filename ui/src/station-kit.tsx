/** Piezas visuales compartidas de la estación: estados, roles, avatares, vacíos. */
import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Checkbox } from "@base-ui/react/checkbox";
import {
  Anchor, Binoculars, CircleAlert, CirclePause, CircleSlash, Crosshair, Loader, LogOut, Moon, Route, Skull, Sparkles, Swords, Unplug, UsersRound, WifiOff, RotateCw, Lock, Check,
} from "lucide-react";
import type { RoleAssign, RoleKey } from "../../estacion-logic";
import { ROLES } from "../../estacion-logic";
import { classShort, type Character } from "./station-data";

export type Tone = "good" | "gold" | "warn" | "bad" | "info" | "violet" | "idle";

/** Cómo se ve el estado de un personaje: color, ícono y etiqueta (una sola fuente de verdad). */
export function visual(c: Character): { tone: Tone; label: string; icon: ReactNode; live: boolean } {
  const i = 13;
  switch (c.status) {
    case "starting": return { tone: "warn", label: "Conectando", icon: <Loader size={i} className="spin" />, live: true };
    case "stopping": return { tone: "warn", label: "Saliendo", icon: <LogOut size={i} />, live: true };
    case "failed": return { tone: "bad", label: c.account === "blocked" ? "Bloqueada" : "Error", icon: c.account === "blocked" ? <Lock size={i} /> : <CircleAlert size={i} />, live: false };
    case "in-use": return { tone: "warn", label: "Cuenta abierta", icon: <Unplug size={i} />, live: false };
    case "external": return { tone: "info", label: "Sin panel", icon: <CircleSlash size={i} />, live: false };
    case "on": {
      const m = c.game?.mode;
      if (m === "hunt") return { tone: "gold", label: "Cazando", icon: <Crosshair size={i} />, live: true };
      if (m === "paused") return { tone: "info", label: "En pausa", icon: <CirclePause size={i} />, live: false };
      if (m === "dead") return { tone: "bad", label: "Muerto", icon: <Skull size={i} />, live: true };
      if (m === "resetting") return { tone: "violet", label: "Reseteando", icon: <RotateCw size={i} className="spin" />, live: true };
      if (m === "connecting") return { tone: "warn", label: "Entrando", icon: <Loader size={i} className="spin" />, live: true };
      return { tone: "good", label: "Farmeando", icon: <Swords size={i} />, live: true };
    }
    default: return { tone: c.account === "blocked" ? "bad" : "idle", label: c.account === "blocked" ? "Bloqueada" : "Desconectado", icon: c.account === "blocked" ? <Lock size={i} /> : <WifiOff size={i} />, live: false };
  }
}

export function StatusPill({ c }: { c: Character }) {
  const v = visual(c);
  return (
    <span className={`pill tone-${v.tone}`}>
      {v.icon}
      {v.label}
    </span>
  );
}

export const roleIcon: Record<RoleKey, (size?: number) => ReactNode> = {
  golden: (s = 14) => <Sparkles size={s} />,
  route: (s = 14) => <Route size={s} />,
  spot: (s = 14) => <Anchor size={s} />,
  explorer: (s = 14) => <Binoculars size={s} />,
  support: (s = 14) => <UsersRound size={s} />,
};
export const roleTone: Record<RoleKey, Tone> = { golden: "gold", route: "good", spot: "info", explorer: "violet", support: "warn" };

export function RoleChip({ role, warp }: { role: RoleKey; warp?: number }) {
  return (
    <span className={`role-chip tone-${roleTone[role]}`} title={ROLES[role].hint}>
      {roleIcon[role](12)}
      {ROLES[role].short}
      {role === "spot" && warp != null ? ` ${warp}` : ""}
    </span>
  );
}

export function Avatar({ c, size = 40 }: { c: Character; size?: number }) {
  const v = visual(c);
  return (
    <span className={`avatar2 tone-${v.tone} ${v.live ? "live" : ""}`} style={{ width: size, height: size, fontSize: size * 0.42 }} title={c.cls ? classShort[c.cls] : undefined}>
      {c.char.slice(0, 1).toUpperCase()}
      {c.cls && <i>{classShort[c.cls]}</i>}
    </span>
  );
}

/** Barra fina con color por nivel (HP baja → rojo). */
export function Bar({ value, max, tone, label }: { value: number; max: number; tone?: "hp" | "mp" | "exp" | "bag"; label: string }) {
  const p = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const low = tone === "hp" ? (p < 30 ? "low" : p < 60 ? "mid" : "") : tone === "bag" ? (p >= 92 ? "low" : p >= 75 ? "mid" : "") : "";
  return (
    <div className={`bar ${tone ?? ""} ${low}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <i style={{ width: `${p}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon ?? <Moon size={22} />}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} aria-hidden />;
}

export function Card({ title, icon, extra, children, className = "" }: { title: string; icon?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h2>
          {icon}
          {title}
        </h2>
        {extra}
      </header>
      {children}
    </section>
  );
}

/** Spots fijos que se ofrecen (índice de warp del bot). */
export const SPOTS: { warp: number; label: string }[] = [
  { warp: 24, label: "Arena 2" },
  { warp: 25, label: "Arena 3" },
  { warp: 26, label: "Arena 4" },
  { warp: 7, label: "Devias 4" },
  { warp: 6, label: "Devias 3" },
  { warp: 2, label: "Lorencia" },
];
export const spotName = (warp: number) => SPOTS.find((s) => s.warp === warp)?.label ?? `warp ${warp}`;
export const roleText = (a: RoleAssign) => (a.role === "spot" ? `${ROLES.spot.label} · ${spotName(a.warp)}` : ROLES[a.role].label);
export const sameRole = (a: RoleAssign, b: RoleAssign) => a.role === b.role && (a.role !== "spot" || (b.role === "spot" && a.warp === b.warp));

/** Menú para elegir la estrategia; `trigger` es el botón que lo abre. */
export function RoleMenu({ current, onPick, trigger, label }: { current?: RoleAssign; onPick: (r: RoleAssign) => void; trigger: ReactNode; label: string }) {
  const item = (r: RoleAssign, text: ReactNode, key: string, hint?: string) => (
    <Menu.Item key={key} className="menu-item" onClick={() => onPick(r)}>
      <span className={`menu-ico tone-${roleTone[r.role]}`}>{roleIcon[r.role](14)}</span>
      <span className="menu-text">
        <strong>{text}</strong>
        {hint && <small>{hint}</small>}
      </span>
      {current && sameRole(current, r) && <Check size={14} />}
    </Menu.Item>
  );
  return (
    <Menu.Root>
      <Menu.Trigger className="button quiet" aria-label={label}>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start" className="menu-positioner">
          <Menu.Popup className="menu-popup">
            {(["golden", "route", "explorer", "support"] as const).map((k) => item({ role: k }, ROLES[k].label, k, ROLES[k].hint))}
            <Menu.Group>
              <Menu.GroupLabel className="menu-group">Spot fijo</Menu.GroupLabel>
              {SPOTS.map((s) => item({ role: "spot", warp: s.warp }, s.label, `spot${s.warp}`))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Casilla accesible (Base UI) para selección múltiple. */
export function Check2({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean }) {
  return (
    <Checkbox.Root className="check2" checked={checked} indeterminate={indeterminate} onCheckedChange={onChange} aria-label={label}>
      <Checkbox.Indicator className="check2-ind" keepMounted={false}>
        {indeterminate ? <i className="dash" /> : <Check size={12} strokeWidth={3} />}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
