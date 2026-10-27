/**
 * Llevar al bot a un mapa desde el panel: un select con los warps del menú del juego, agrupados por mapa. Elegir uno lo fija como zona
 * (directivas zonaMapa y zonaWarp): el bot viaja por ese warp y farmea donde deja, hasta que se elija otro o "Que elija solo". Mismos índices que
 * `bot/src/brain/warps.ts`.
 */
import { Compass, House } from "lucide-react";
import { useEffect, useState } from "react";

type Warp = { index: number; name: string; map: number };
const seq = (from: number, n: number, name: string, map: number): Warp[] => Array.from({ length: n }, (_, k) => ({ index: from + k, name: `${name} ${k + 1}`, map }));
const GROUPS: { name: string; warps: Warp[] }[] = [
  { name: "Devias", warps: seq(4, 4, "Devias", 2) },
  { name: "Dungeon", warps: seq(8, 3, "Dungeon", 1) },
  { name: "Lost Tower", warps: seq(14, 7, "Lost Tower", 4) },
  { name: "Atlans", warps: [{ index: 11, name: "Atlans", map: 7 }, { index: 12, name: "Atlans 2", map: 7 }, { index: 13, name: "Atlans 3", map: 7 }] },
  { name: "Otros", warps: [{ index: 3, name: "Noria", map: 3 }, { index: 1, name: "Arena", map: 6 }, { index: 21, name: "Tarkan", map: 8 }, { index: 27, name: "Aida", map: 33 }, { index: 28, name: "Aida 2", map: 33 }] },
];
const ALL = GROUPS.flatMap((g) => g.warps);
const AUTO = "auto";
const POINT = "punto";

export function Travel({ onTown }: { onTown: () => void }) {
  const [value, setValue] = useState(AUTO);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/directivas").then((r) => r.json()).then((d) => {
      const v = d?.valores ?? {};
      setValue(Number(v.zonaMapa) > 0 ? (Number(v.zonaWarp) > 0 ? String(v.zonaWarp) : POINT) : AUTO);
    }).catch(() => {});
  }, []);
  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); };
  const choose = async (next: string) => {
    const w = ALL.find((x) => String(x.index) === next);
    const set = w ? { zonaMapa: w.map, zonaWarp: w.index, zonaX: 0, zonaY: 0 } : { zonaMapa: 0, zonaWarp: 0, zonaX: 0, zonaY: 0 };
    try {
      const r = await fetch("/api/directivas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set }) });
      if (r.ok) setValue(next);
      say(r.ok ? (w ? `Listo: va a ${w.name}` : "Listo: vuelve a elegir solo") : "No se pudo guardar");
    } catch { say("No se pudo guardar"); }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1 text-sm">
          <Compass size={14} className="shrink-0 text-muted" aria-hidden />
          <span className="sr-only">Llevarlo a</span>
          <select className="min-w-0 flex-1 bg-transparent py-0.5 font-medium outline-none" value={value} onChange={(e) => void choose(e.target.value)}>
            <option value={AUTO}>Que elija solo</option>
            {value === POINT && <option value={POINT}>Punto fijado en el mapa</option>}
            {GROUPS.map((g) => (
              <optgroup key={g.name} label={g.name}>
                {g.warps.map((w) => <option key={w.index} value={w.index}>{w.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <button
          onClick={onTown}
          title="Va a Lorencia y queda en pausa"
          className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2.5 py-1 text-sm hover:border-strong hover:bg-hover"
        >
          <House size={13} aria-hidden /> Pueblo
        </button>
      </div>
      {msg && <small className="text-xs text-muted" role="status">{msg}</small>}
    </div>
  );
}
