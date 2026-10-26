/**
 * Directivas en caliente: perillas de comportamiento que se cambian sin reiniciar el bot. Viven en `~/.mubot/directivas.json`
 * (`{ "probarWarp": 38, ... }`); el proceso relee el archivo cuando cambia y muta `D` en el lugar, así que el código lee
 * `D.agiTarget` en cada decisión, sin copiarlo.
 * Se cambian con `POST /api/directivas` de la estación (valida con este mismo esquema) o a mano. Una clave desconocida o de tipo
 * equivocado se ignora y se avisa: nunca rompe al bot. Para sumar una perilla: agregarla a ESQUEMA y leer `D.<clave>` donde decide.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Spec = { def: boolean | number; min?: number; max?: number; doc: string };

export const ESQUEMA = {
  scoutShops: { def: false, doc: 'Recorrer las tiendas del pueblo (Lorencia) y anotar lo que vende cada NPC en la base; no compra ni vende. Corre una vez; para repetir, ponerla en false y de nuevo en true.' },
  statBatch: { def: 10, min: 1, max: 500, doc: 'Puntos que se juntan antes de repartir.' },
  agiTarget: { def: 90, min: 0, max: 400, doc: 'Agilidad a la que se llega primero (velocidad de ataque = Agi / 15; 90 = 6).' },
} as const satisfies Record<string, Spec>;

export type Clave = keyof typeof ESQUEMA;
type Valores = { [K in Clave]: (typeof ESQUEMA)[K]['def'] extends boolean ? boolean : number };

const defaults = () => Object.fromEntries(Object.entries(ESQUEMA).map(([k, s]) => [k, s.def])) as unknown as Valores;
/** Los valores vivos de este proceso. */
export const D: Valores = defaults();

export const ARCHIVO = join(homedir(), '.mubot', 'directivas.json');
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

export function leerArchivo(): Archivo {
  try {
    const raw = JSON.parse(readFileSync(ARCHIVO, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Archivo) : {};
  } catch { return {}; }
}

/** Escribe el archivo entero de una vez (por un temporal): el bot no lo lee a medias. */
export function guardarArchivo(a: Archivo) {
  const tmp = `${ARCHIVO}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2));
  renameSync(tmp, ARCHIVO);
}

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
      cambios.push(`${k}: ${(D as Record<string, boolean | number>)[k]} → ${v}`);
      (D as Record<string, boolean | number>)[k] = v;
    }
  }
  return { cambios, rechazos };
}

let mtime = -1;
/** Relee el archivo cada `cadaMs` (sin archivo, todo en sus defaults). `aviso` recibe cada cambio. */
export function iniciarDirectivas(aviso: (msg: string) => void = console.log, cadaMs = 2000) {
  const tick = () => {
    const m = existsSync(ARCHIVO) ? statSync(ARCHIVO).mtimeMs : 0;
    if (m === mtime) return;
    mtime = m;
    const { cambios, rechazos } = aplicar(leerArchivo());
    for (const c of cambios) aviso(`Directiva ${c}`);
    for (const r of rechazos) aviso(`Directiva ignorada ${r}`);
  };
  try { tick(); } catch { /* sin disco: defaults */ }
  setInterval(() => { try { tick(); } catch { /* un archivo a medias se reintenta en el próximo ciclo */ } }, cadaMs).unref?.();
}
