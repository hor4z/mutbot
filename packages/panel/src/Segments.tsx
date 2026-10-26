import { Tabs } from "@base-ui/react/tabs";

/** Selector de opciones en segmentos (alcance del mapa): estilo sherpa, fondo `soft` y el activo en `hover`. */
export function Segments({ value, onChange, items, label }: { value: string; onChange: (v: string) => void; items: { value: string; label: string }[]; label: string }) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(String(v))}>
      <Tabs.List className="inline-flex gap-0.5 rounded-md bg-soft p-0.5" aria-label={label}>
        {items.map((i) => (
          <Tabs.Tab
            key={i.value}
            value={i.value}
            className="flex h-6 items-center justify-center rounded-sm border-0 bg-transparent px-2.5 text-sm font-medium text-muted transition-colors duration-75 hover:text-ink data-[active]:bg-hover data-[active]:text-ink"
          >
            {i.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
