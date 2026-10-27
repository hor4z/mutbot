/**
 * Inventario de Capitan: lo que lleva puesto y la bolsa (grilla de 8 por 8, casillas 12 a 75). Se elige un ítem y se lo puede tirar al suelo;
 * lo valioso (joyas, excelentes, orbs) pide confirmar. El bot no tira solo: esto lo decide el usuario.
 */
import {
  Backpack, Bird, CircleDot, Crosshair, Crown, FlaskConical, Footprints, Gem, Hand, KeyRound, Link2, PawPrint, ScrollText, Shield, Shirt, Sparkles, Sword, Swords, Trash2, Wand2, Axe, Package, type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { PanelState } from "@mubot/protocol";
import { Button, Label, cn } from "./components";

type Item = NonNullable<PanelState["inventory"]>[number];

/** Cada ítem pinta todas las casillas que ocupa con el color de su tipo (se ve el tamaño sin tocarlo). */
const KIND_STYLE: Record<Item["kind"], string> = {
  joya: "border-warning bg-[color-mix(in_srgb,var(--paper)_62%,var(--warning))]",
  skill: "border-info bg-[color-mix(in_srgb,var(--paper)_62%,var(--info))]",
  pocion: "border-danger bg-[color-mix(in_srgb,var(--paper)_66%,var(--danger))]",
  equipo: "border-strong bg-[color-mix(in_srgb,var(--paper)_70%,var(--accent))]",
  otro: "border-strong bg-[color-mix(in_srgb,var(--paper)_74%,var(--success))]",
};
/** Un icono por tipo de ítem (el cliente los dibuja en 3D; acá se reconoce de un vistazo por forma y color). */
function iconOf(i: Item): LucideIcon {
  const n = i.name;
  if (i.kind === "joya") return Gem;
  if (i.kind === "skill" || /^Orb of/i.test(n)) return Sparkles;
  if (/^Scroll of|^Book/i.test(n)) return ScrollText;
  if (/Ring/i.test(n)) return CircleDot;
  if (/Pendant/i.test(n)) return Link2;
  if (/Potion|Alcohol|Antidote|Ale|Remedy/i.test(n)) return FlaskConical;
  if (/Key|Symbol|Blood Bone|Devil Eye/i.test(n)) return KeyRound;
  if (/Wing|Cape/i.test(n)) return Bird;
  if (/Horn|Guardian|Imp|Satan|Uniria|Dinorant|Fenrir/i.test(n)) return PawPrint;
  switch (i.group) {
    case 0: return Sword;
    case 1: return Axe;
    case 2: return Swords;
    case 3: return Swords;
    case 4: return Crosshair;
    case 5: return Wand2;
    case 6: return Shield;
    case 7: return Crown;
    case 8: case 9: return Shirt;
    case 10: return Hand;
    case 11: return Footprints;
    default: return Package;
  }
}
const label = (i: Item) => `${i.name}${i.level ? ` +${i.level}` : ""}${i.excellent ? " (excelente)" : ""}`;
function Icon({ item, size }: { item: Item; size: number }) {
  const C = iconOf(item);
  return <C size={size} strokeWidth={1.75} className={cn(item.excellent ? "text-success" : item.kind === "joya" ? "text-warning" : item.kind === "skill" ? "text-info" : item.kind === "pocion" ? "text-danger" : "text-muted")} aria-hidden />;
}

/** Apagado: al mandar la orden de tirar el server cierra la conexión del bot (probado con 5 ítems). Se prende cuando se sepa el packet correcto. */
const DROP_ENABLED = false;

export function Inventory({ g, onDrop }: { g: PanelState; onDrop: (slot: number) => void }) {
  const inv = g.inventory ?? [];
  const bag = inv.filter((i) => i.slot >= 12 && i.slot < 76);
  const worn = inv.filter((i) => i.slot < 12);
  const [sel, setSel] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const picked = bag.find((i) => i.slot === sel) ?? null;
  useEffect(() => { setConfirm(false); }, [sel]);
  useEffect(() => { if (sel != null && !picked) setSel(null); }, [picked, sel]);
  const used = bag.reduce((a, i) => a + i.w * i.h, 0);
  const valuable = picked != null && (picked.kind === "joya" || picked.kind === "skill" || picked.excellent);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <Label icon={Backpack}>Inventario</Label>
        <span className="font-mono text-xs text-faint">{used}/64 casillas · {bag.length} ítems</span>
      </div>
      <div className="grid grid-cols-8 gap-px rounded-md bg-line p-px" style={{ gridAutoRows: "44px" }} role="grid" aria-label="Bolsa">
        {Array.from({ length: 64 }, (_, k) => <div key={k} className="bg-paper" style={{ gridColumn: (k % 8) + 1, gridRow: Math.floor(k / 8) + 1 }} />)}
        {bag.map((i) => {
          const k = i.slot - 12;
          return (
            <button
              key={i.slot}
              title={label(i)}
              aria-label={label(i)}
              aria-pressed={sel === i.slot}
              onClick={() => setSel(sel === i.slot ? null : i.slot)}
              className={cn("relative z-[1] grid place-items-center overflow-hidden rounded-xs border text-ink", KIND_STYLE[i.kind], i.excellent && "text-success", sel === i.slot && "outline-2 outline-accent")}
              style={{ gridColumn: `${(k % 8) + 1} / span ${i.w}`, gridRow: `${Math.floor(k / 8) + 1} / span ${i.h}` }}
            >
              <Icon item={i} size={Math.min(i.w, i.h) > 1 ? 26 : 18} />
              {i.level ? <small className="absolute right-0.5 bottom-0 font-mono text-[10px] leading-3 font-semibold text-ink">+{i.level}</small> : null}
              {i.excellent && <i className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-success" aria-hidden />}
            </button>
          );
        })}
      </div>
      <div className="min-h-[52px] text-sm">
        {picked ? (
          <div className="flex flex-col gap-1.5">
            <strong className="font-medium">{label(picked)}</strong>
            <small className="text-muted">Casilla {picked.slot}{valuable ? " · es valioso: pensalo antes de tirarlo" : ""}</small>
            <div className="flex gap-1.5">
              {!DROP_ENABLED ? (
                <small className="text-warning">Tirar está apagado: el server corta la conexión del bot al recibir la orden.</small>
              ) : !confirm ? (
                <Button variant="outline" onClick={() => setConfirm(true)}><Trash2 size={13} /> Tirar</Button>
              ) : (
                <>
                  <Button variant="primary" onClick={() => { onDrop(picked.slot); setConfirm(false); setSel(null); }}><Trash2 size={13} /> Sí, tirar {picked.name}</Button>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>Cancelar</Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <small className="text-faint">{bag.length ? "Tocá un ítem para ver y tirar." : "La bolsa está vacía (o todavía no llegó)."}</small>
        )}
      </div>
      {worn.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-mono text-xs text-faint uppercase">Puesto ({worn.length})</summary>
          <ul className="m-0 mt-1 grid list-none gap-0.5 p-0">{worn.map((i) => <li key={i.slot} className="flex items-center gap-2 truncate text-muted"><Icon item={i} size={14} />{label(i)}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
