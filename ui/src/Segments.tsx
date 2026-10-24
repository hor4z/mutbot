import { Tabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

/** Selector de opciones en segmentos (3D/Táctico, Cámara/Cerca/Zona/Mapa). */
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
