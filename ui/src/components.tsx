import type { ReactNode, ComponentProps } from "react";
import { Button } from "@base-ui/react/button";
import { Select } from "@base-ui/react/select";
import { Tabs } from "@base-ui/react/tabs";
import { Progress } from "@base-ui/react/progress";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronDown, Check } from "lucide-react";
export const fmt = (n?: number | null) =>
  n == null ? "—" : n.toLocaleString("es-AR");
export const compact = (n?: number | null) =>
  n == null
    ? "—"
    : n >= 1e9
      ? (n / 1e9).toFixed(1) + "B"
      : n >= 1e6
        ? (n / 1e6).toFixed(1) + "M"
        : n >= 1e3
          ? (n / 1e3).toFixed(1) + "k"
          : Math.round(n).toString();
export const modes: Record<string, string> = {
  farm: "Farmeando",
  hunt: "Cazando",
  paused: "En pausa",
  resetting: "Reseteando",
  connecting: "Conectando",
  dead: "Muerto",
  off: "Desconectado",
  on: "En línea",
  starting: "Conectando",
  stopping: "Saliendo",
  failed: "Error",
  "in-use": "Cuenta abierta",
  external: "Sin panel",
  active: "Activa",
  blocked: "Bloqueada",
};
export function Action({
  children,
  className = "",
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button {...props} className={`button ${className}`}>
      {children}
    </Button>
  );
}
export function Badge({
  state,
  children,
}: {
  state: string;
  children?: ReactNode;
}) {
  return (
    <span className={`badge ${state}`}>
      <span className="status-dot" />
      {children ?? modes[state] ?? state}
    </span>
  );
}
export function Choice({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { label: string; value: string }[];
  label: string;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => v !== null && onChange(v)}
      items={items}
    >
      <Select.Trigger className="select" aria-label={label}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          sideOffset={6}
          alignItemWithTrigger={false}
          className="select-positioner"
        >
          <Select.Popup className="select-popup">
            <Select.List>
              {items.map((i) => (
                <Select.Item
                  className="select-item"
                  key={i.value}
                  value={i.value}
                >
                  <Select.ItemText>{i.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
export function Segments({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(String(v))}>
      <Tabs.List className="segments" aria-label={label}>
        {items.map((i) => (
          <Tabs.Tab className="segment" key={i.value} value={i.value}>
            {i.icon}
            {i.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
export function Meter({
  value,
  max,
  label,
  tone = "gold",
  detail,
}: {
  value: number;
  max: number;
  label: string;
  tone?: string;
  detail?: ReactNode;
}) {
  const p = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <Progress.Root value={p} className={`meter ${tone}`}>
      <div className="meter-label">
        <Progress.Label>{label}</Progress.Label>
        <span>{detail ?? `${fmt(value)} / ${fmt(max)}`}</span>
      </div>
      <Progress.Track className="meter-track">
        <Progress.Indicator className="meter-fill" style={{ width: `${p}%` }} />
      </Progress.Track>
    </Progress.Root>
  );
}
export function Section({
  title,
  children,
  extra,
  className = "",
}: {
  title: string;
  children: ReactNode;
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`surface ${className}`}>
      <div className="section-heading">
        <h2>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}
export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

/** Confirmación de una acción que cambia lo que hace el personaje (nunca se manda sin pasar por acá). */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
  disabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Viewport className="modal-viewport">
          <AlertDialog.Popup className="modal-popup">
            <AlertDialog.Title className="modal-title">{title}</AlertDialog.Title>
            <AlertDialog.Description className="modal-body" render={<div />}>
              {description}
            </AlertDialog.Description>
            {children}
            <div className="modal-actions">
              <AlertDialog.Close className="button">Cancelar</AlertDialog.Close>
              <Button
                className="button primary"
                disabled={disabled}
                onClick={() => {
                  onConfirm();
                  onOpenChange(false);
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
/** Diálogo informativo (ayuda de atajos). */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Viewport className="modal-viewport">
          <Dialog.Popup className="modal-popup wide">
            <Dialog.Title className="modal-title">{title}</Dialog.Title>
            {children}
            <div className="modal-actions">
              <Dialog.Close className="button">Cerrar</Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
