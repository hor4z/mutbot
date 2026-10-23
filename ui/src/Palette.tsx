/** Paleta de comandos (Ctrl/Cmd+K) y ayuda de atajos. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CornerDownLeft, Search, X } from "lucide-react";
import { Kbd } from "./station-kit";

export type Cmd = { id: string; group: string; label: string; hint?: string; icon?: ReactNode; keys?: string; run: () => void };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function Palette({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (v: boolean) => void; commands: Cmd[] }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) { setQ(""); setIdx(0); }
  }, [open]);
  const shown = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return commands.filter((c) => {
      const hay = norm(`${c.group} ${c.label} ${c.hint ?? ""}`);
      return toks.every((t) => hay.includes(t));
    });
  }, [q, commands]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);
  const run = (c?: Cmd) => {
    if (!c) return;
    onOpenChange(false);
    setTimeout(c.run, 0);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[idx]); }
  };
  let last = "";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="modal palette" aria-label="Paleta de comandos">
          <Dialog.Title className="sr-only">Paleta de comandos</Dialog.Title>
          <Dialog.Description className="sr-only">Escribí para buscar una acción, un personaje o una vista.</Dialog.Description>
          <div className="palette-input">
            <Search size={16} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Buscá una acción, un personaje o una vista…" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={shown[idx] ? `cmd-${shown[idx].id}` : undefined} />
            <Kbd>Esc</Kbd>
          </div>
          <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
            {shown.length === 0 && <li className="palette-empty">Nada coincide con “{q}”.</li>}
            {shown.map((c, i) => {
              const head = c.group !== last ? c.group : null;
              last = c.group;
              return (
                <li key={c.id} role="presentation">
                  {head && <div className="palette-group">{head}</div>}
                  <div id={`cmd-${c.id}`} data-idx={i} role="option" aria-selected={i === idx} className={`palette-item ${i === idx ? "on" : ""}`} onMouseMove={() => setIdx(i)} onClick={() => run(c)}>
                    <span className="palette-ico">{c.icon}</span>
                    <span className="palette-label">{c.label}{c.hint && <small>{c.hint}</small>}</span>
                    {c.keys && <Kbd>{c.keys}</Kbd>}
                    {i === idx && !c.keys && <CornerDownLeft size={13} className="muted" />}
                  </div>
                </li>
              );
            })}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ K", "Paleta de comandos"],
  ["1 – 6", "Ir a Flota, Personaje, Estrategias, Dorados, Ranking o Consola"],
  ["N", "Nueva cuenta o personaje"],
  ["A", "Elegir / soltar todos en la Flota"],
  ["Esc", "Soltar la selección o cerrar"],
  ["?", "Esta ayuda"],
];

export function Help({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="modal">
          <header className="modal-head">
            <div>
              <Dialog.Title>Atajos de teclado</Dialog.Title>
              <Dialog.Description>Funcionan en cualquier vista, salvo mientras escribís en un campo.</Dialog.Description>
            </div>
            <Dialog.Close className="button quiet icon" aria-label="Cerrar"><X size={16} /></Dialog.Close>
          </header>
          <dl className="modal-body shortcuts">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k}><dt><Kbd>{k}</Kbd></dt><dd>{d}</dd></div>
            ))}
          </dl>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
