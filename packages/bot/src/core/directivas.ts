/**
 * Directivas en caliente: perillas de comportamiento que se cambian sin reiniciar el bot. Viven en la tabla `directives` de la base (db.ts); el
 * proceso la relee cada pocos segundos y muta `D` en el lugar, así que el código lee `D.agiTarget` en cada decisión, sin copiarlo.
 * Se cambian desde el panel (`POST /api/directivas` de la estación, que valida con este mismo esquema) o escribiendo en la tabla. Una clave
 * desconocida o de tipo equivocado se ignora y se avisa: nunca rompe al bot. Para sumar una perilla: agregarla a ESQUEMA y leer `D.<clave>` donde decide.
 */
import { deleteDirective, readDirectives, writeDirective } from '@mubot/db';

type Spec = { def: boolean | number; min?: number; max?: number; doc: string };

export const ESQUEMA = {
  zonaWarp: { def: 0, min: 0, max: 40, doc: 'Índice del warp del menú para llegar a la zona fijada (0 = el más cercano a la zona). Ej.: 17 = Lost Tower 4.' },
  comprarMana: { def: 0, min: 0, max: 400, doc: 'Pociones que compra a Amy (Lorencia) en un viaje: esa cantidad de maná y esa cantidad de vida, de las más grandes. Al terminar queda en pausa y se pone en 0 sola.' },
  scoutShops: { def: false, doc: 'Recorrer las tiendas del pueblo (Lorencia) y anotar lo que vende cada NPC en la base; no compra ni vende. Corre una vez; para repetir, ponerla en false y de nuevo en true.' },
  statBatch: { def: 10, min: 1, max: 500, doc: 'Puntos que se juntan antes de repartir.' },
  agiTarget: { def: 90, min: 0, max: 400, doc: 'Agilidad a la que se llega primero (velocidad de ataque = Agi / 15; 90 = 6).' },
  zonaMapa: { def: 0, min: 0, max: 100, doc: 'Número de mapa donde farmear fijo (1 = Dungeon, 2 = Devias); 0 = que el bot elija.' },
  zonaX: { def: 0, min: 0, max: 255, doc: 'X del centro de la zona fija (con zonaMapa).' },
  zonaY: { def: 0, min: 0, max: 255, doc: 'Y del centro de la zona fija (con zonaMapa).' },
} as const satisfies Record<string, Spec>;

export type Clave = keyof typeof ESQUEMA;
type Valores = { [K in Clave]: (typeof ESQUEMA)[K]['def'] extends boolean ? boolean : number };

const defaults = () => Object.fromEntries(Object.entries(ESQUEMA).map(([k, s]) => [k, s.def])) as unknown as Valores;
/** Los valores vivos de este proceso. */
export const D: Valores = defaults();

export type Archivo = Record<string, boolean | number>;

/** Valida un valor contra el esquema: el valor limpio o un motivo de rechazo. */
export function validar(clave: string, v: unknown): { ok: true; v: boolean | number } | { ok: false; why: string } {
  const s = (ESQUEMA as Record<string, Spec>)[clave];
  if (!s) return { ok: false, why: 'directiva desconocida' };
  if (typeof s.def === 'boolean') return typeof v === 'boolean' ? { ok: true, v } : { ok: false, why: 'tiene que ser true o false' };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, why: 'tiene que ser un número' };
  if (v < (s.min ?? -Infinity) || v > (s.max ?? Infinity)) return { ok: false, why: `fuera de rango (${s.min}..${s.max})` };
  return { ok: true, v };
}

/** Guarda cambios en la base (ya validados): `set` escribe, `unset` borra (vuelve al valor por defecto). */
export async function guardarDirectivas(set: Record<string, boolean | number>, unset: string[] = []) {
  for (const [k, v] of Object.entries(set)) await writeDirective(k, v);
  for (const k of unset) await deleteDirective(k);
}

/** Lo que hay guardado en la base. */
export const leerDirectivas = readDirectives;

/** Aplica el archivo sobre los defaults; devuelve lo que cambió y lo que se rechazó. */
export function aplicar(a: Archivo): { cambios: string[]; rechazos: string[] } {
  const next = defaults() as Record<string, boolean | number>;
  const rechazos: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    const r = validar(k, v);
    if (r.ok) next[k] = r.v;
    else rechazos.push(`${k}: ${r.why}`);
  }
  const cambios: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    if ((D as Record<string, boolean | number>)[k] !== v) {
      cambios.push(`${k} pasó de ${(D as Record<string, boolean | number>)[k]} a ${v}`);
      (D as Record<string, boolean | number>)[k] = v;
    }
  }
  return { cambios, rechazos };
}

let avisoError = 0;
/** Relee la tabla cada `cadaMs` (sin filas, todo en sus defaults). `aviso` recibe cada cambio. */
export function iniciarDirectivas(aviso: (msg: string) => void = console.log, cadaMs = 5000) {
  const tick = async () => {
    try {
      const { cambios, rechazos } = aplicar(await readDirectives());
      for (const c of cambios) aviso(`Directiva ${c}`);
      for (const r of rechazos) aviso(`Directiva ignorada ${r}`);
    } catch (e) {
      // La base no responde: se siguen usando los valores que ya tiene `D` (se avisa una vez cada 10 min).
      if (Date.now() - avisoError > 10 * 60_000) { avisoError = Date.now(); aviso(`Directivas: no pude leer la base (${(e as Error).message}); sigo con las que tengo.`); }
    }
  };
  void tick();
  setInterval(() => void tick(), cadaMs).unref?.();
}
