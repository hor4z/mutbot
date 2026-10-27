/** Piezas base del panel con el lenguaje de sherpa (src/widgets.rs): panel `soft` sin borde, etiqueta de sección, badge en pastilla, botón y barra. */
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Estado plegado/abierto de cada panel, guardado en el navegador (si no hay storage, arranca abierto). */
export function useOpen(id: string | undefined, initial = true): [boolean, (v: boolean) => void] {
  const key = id ? `panel:${id}` : null;
  const [open, setOpen] = useState(() => {
    try { const v = key ? localStorage.getItem(key) : null; return v == null ? initial : v === "1"; } catch { return initial; }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try { if (key) localStorage.setItem(key, v ? "1" : "0"); } catch { /* sin storage */ }
  };
  return [open, set];
}

/** Panel. Con `title` se puede replegar y expandir tocando el encabezado; `summary` se ve aun plegado. */
export function Panel({ className, children, id, title, icon: Icon, summary, defaultOpen = true }: {
  className?: string; children: ReactNode; id?: string; title?: ReactNode; icon?: LucideIcon; summary?: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useOpen(id, defaultOpen);
  if (title == null) return <section className={cn("flex flex-col gap-2 rounded-lg bg-soft px-4 pt-3 pb-3.5", className)}>{children}</section>;
  return (
    <section className={cn("flex flex-col gap-2 rounded-lg bg-soft px-4 py-2.5", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 border-0 bg-transparent p-0 text-left font-mono text-[10.5px] leading-4 font-medium tracking-[0.08em] text-faint uppercase hover:text-ink"
      >
        {Icon && <Icon size={12} aria-hidden />}
        <span>{title}</span>
        {!open && summary != null && <span className="ml-1 min-w-0 flex-1 truncate font-sans text-xs tracking-normal text-muted normal-case">{summary}</span>}
        <ChevronDown size={14} className={cn("ml-auto shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />
      </button>
      {open && children}
    </section>
  );
}

/** Etiqueta de sección: mono, mayúsculas, `faint` (sherpa: label). */
export function Label({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 font-mono text-[10.5px] leading-4 font-medium tracking-[0.08em] text-faint uppercase">
      {Icon && <Icon size={12} aria-hidden />}
      {children}
    </h2>
  );
}

export type Tone = "default" | "success" | "warning" | "danger" | "info";
const TONE: Record<Tone, string> = {
  default: "bg-hover text-muted border-transparent",
  success: "text-success bg-[color-mix(in_srgb,var(--paper)_86%,var(--success))] border-[color-mix(in_srgb,var(--success)_40%,transparent)]",
  warning: "text-warning bg-[color-mix(in_srgb,var(--paper)_86%,var(--warning))] border-[color-mix(in_srgb,var(--warning)_40%,transparent)]",
  danger: "text-danger bg-[color-mix(in_srgb,var(--paper)_86%,var(--danger))] border-[color-mix(in_srgb,var(--danger)_40%,transparent)]",
  info: "text-info bg-[color-mix(in_srgb,var(--paper)_86%,var(--info))] border-[color-mix(in_srgb,var(--info)_40%,transparent)]",
};
/** Badge: pastilla de 20 px con el tono tintado y un punto. */
export function Badge({ tone = "default", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-sm font-medium", TONE[tone])}>
      <i className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

type Variant = "default" | "primary" | "outline" | "ghost";
const VARIANT: Record<Variant, string> = {
  default: "border-line bg-soft text-ink hover:border-strong hover:bg-hover",
  primary: "border-transparent bg-primary text-on-primary hover:opacity-90",
  outline: "border-line bg-transparent text-ink hover:border-strong hover:bg-soft",
  ghost: "border-transparent bg-transparent text-muted hover:bg-soft hover:text-ink",
};
/** Botón con las medidas de Reshaped de sherpa: Sm 28 px (radio 4) y Md 36 px (radio 6). */
export function Button({ variant = "default", size = "sm", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...p}
      className={cn(
        "inline-flex items-center justify-center gap-1 border text-sm font-medium transition-colors duration-75",
        size === "sm" ? "h-7 rounded-sm px-3" : "h-9 rounded-md px-3 text-lg",
        VARIANT[variant],
        className,
      )}
    />
  );
}

/** Barra con el valor encima (vida, maná). */
export function Bar({ value, max, tone, label, icon: Icon }: { value: number; max: number; tone: "danger" | "info"; label: string; icon?: LucideIcon }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
  return (
    <div className="relative h-5 overflow-hidden rounded-sm bg-hover" title={`${label} ${value} / ${max}`}>
      <i className={cn("absolute inset-y-0 left-0 transition-[width] duration-300", tone === "danger" ? "bg-[color-mix(in_srgb,var(--danger)_70%,var(--paper))]" : "bg-[color-mix(in_srgb,var(--info)_70%,var(--paper))]")} style={{ width: `${pct}%` }} />
      <span className="relative z-10 flex items-center gap-1.5 px-2 font-mono text-sm leading-5">
        {Icon && <Icon size={12} aria-hidden />}
        {label} {value}
        <small className="text-muted"> / {max}</small>
      </span>
    </div>
  );
}

/** Par etiqueta / valor en mono. */
export function Stat({ label, icon: Icon, children }: { label: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-faint">
        {Icon && <Icon size={11} aria-hidden />}
        {label}
      </dt>
      <dd className="m-0 truncate font-mono text-sm">{children}</dd>
    </div>
  );
}
