/**
 * Directivas en caliente: perillas de comportamiento que se cambian sin reiniciar los bots. Viven en `~/.mubot/directivas.json`
 * (`{ "global": {...}, "hume": {...} }`: lo de un personaje pisa lo global); cada proceso (bot o estación) relee el archivo
 * cuando cambia y muta `D` en el lugar, así que el código lee `D.crew` en cada decisión, sin copiarlo.
 * Alcances, de menor a mayor prioridad: `global` (todos), `fast` o `slow` (los personajes de ese servidor) y el nombre del personaje.
 * Cada directiva dice a qué servidor pertenece (`srv`): una del Fast no hace nada en un bot del Slow y al revés.
 * Se cambian con `POST /api/directivas` de la estación (valida con este mismo esquema) o a mano. Una clave desconocida o de tipo
 * equivocado se ignora y se avisa: nunca rompe al bot. Para sumar una perilla: agregarla a ESQUEMA y leer `D.<clave>` donde decide.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `srv`: en qué servidor tiene efecto (ambos, solo Fast o solo Slow). */
type Spec = { def: boolean | number; min?: number; max?: number; doc: string; srv: 'ambos' | 'fast' | 'slow' };
export type Servidor = 'fast' | 'slow';

export const ESQUEMA = {
  hunt: { def: true, doc: 'Salir a cazar las invasiones doradas (false: se quedan farmeando).', srv: 'fast' },
  dragonAll: { def: true, doc: 'A un dragón avisado van todos (incluso dejando otra cacería y sin filtro de nivel).', srv: 'fast' },
  stayDragonMap: { def: true, doc: 'No dejar el mapa del Golden Dragon mientras dura su invasión.', srv: 'fast' },
  crew: { def: true, doc: 'Rastrillaje coordinado: cada cazador barre su franja del mapa.', srv: 'fast' },
  claimCommons: { def: true, doc: 'Un dorado común que un compañero tiene más cerca se lo dejo.', srv: 'fast' },
  huntMinLevel: { def: 300, min: 0, max: 400, doc: 'Nivel mínimo para salir a cazar una invasión.', srv: 'fast' },
  cornerCrowdMax: { def: 4, min: 0, max: 99, doc: 'Jugadores cerca de la esquina a partir de los cuales se busca otra Arena (0: nunca se va de la esquina).', srv: 'fast' },
  cornerBanMin: { def: 8, min: 0, max: 120, doc: 'Minutos que busca otra Arena cuando la esquina está llena.', srv: 'fast' },
  scoutShops: { def: false, doc: 'Recorrer las tiendas del pueblo (Lorencia) y anotar lo que vende cada NPC en la base; no compra ni vende. Corre una vez; para repetir, ponerla en false y de nuevo en true.', srv: 'ambos' },
  shadows: { def: true, doc: 'La estación manda al débil a seguir al más fuerte (solo cuenta en la estación).', srv: 'ambos' },
  // --- Slow: lo que se afina en caliente de `slowStrategy` (strategy.ts) ---
  slowStatBatch: { def: 10, min: 1, max: 500, srv: 'slow', doc: 'Puntos que se juntan antes de repartir (el Fast usa 200).' },
  slowAgiTarget: { def: 90, min: 0, max: 400, srv: 'slow', doc: 'Agilidad a la que se llega primero (velocidad de ataque = Agi / 15; 90 = 6).' },
  slowProbarWarp: { def: 0, min: 0, max: 40, srv: 'slow', doc: 'Prueba un lugar: índice del warp al que ir a farmear (4 = Devias 1, 5 = Devias 2, 6 = Devias 3, 7 = Devias 4, 11 = Atlans…). 0: el spot normal por nivel. Se mide con los ticks de la base.' },
  slowBullFromLevel: { def: 12, min: 0, max: 400, srv: 'slow', doc: 'Nivel desde el que se farmea Bull Fighters (antes, Spiders).' },
  slowGiantsFromLevel: { def: 45, min: 0, max: 400, srv: 'slow', doc: 'Nivel desde el que se farmea Giants (~26.000 exp por kill).' },
} as const satisfies Record<string, Spec>;

export type Clave = keyof typeof ESQUEMA;
type Valores = { [K in Clave]: (typeof ESQUEMA)[K]['def'] extends boolean ? boolean : number };

const defaults = () => Object.fromEntries(Object.entries(ESQUEMA).map(([k, s]) => [k, s.def])) as unknown as Valores;
/** Los valores vivos de este proceso. */
export const D: Valores = defaults();

export const ARCHIVO = join(homedir(), '.mubot', 'directivas.json');
export type Archivo = Record<string, Record<string, boolean | number>>;

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

/** Escribe el archivo entero de una vez (por un temporal): ningún bot lo lee a medias. */
export function guardarArchivo(a: Archivo) {
  const tmp = `${ARCHIVO}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2));
  renameSync(tmp, ARCHIVO);
}

/** Aplica `global` y después lo de `quien` sobre los defaults; devuelve lo que cambió y lo que se rechazó. */
export function aplicar(a: Archivo, quien: string, servidor?: Servidor): { cambios: string[]; rechazos: string[] } {
  const next = defaults() as Record<string, boolean | number>;
  const rechazos: string[] = [];
  const quienL = quien.toLowerCase();
  for (const scope of servidor ? ['global', servidor, quienL] : ['global', quienL]) {
    for (const [k, v] of Object.entries(a[scope] ?? {})) {
      // Una directiva de otro servidor no cuenta acá: en `global` o en el alcance del servidor se salta sin ruido; en la de un personaje se avisa.
      const spec = (ESQUEMA as Record<string, Spec>)[k];
      if (spec && servidor && spec.srv !== 'ambos' && spec.srv !== servidor) {
        if (scope === quienL) rechazos.push(`${scope}.${k}: solo vale en el ${spec.srv === 'fast' ? 'Fast' : 'Slow'}`);
        continue;
      }
      const r = validar(k, v);
      if (r.ok) next[k] = r.v;
      else rechazos.push(`${scope}.${k}: ${r.why}`);
    }
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
export function iniciarDirectivas(quien: string, aviso: (msg: string) => void = console.log, cadaMs = 2000, servidor?: Servidor) {
  const tick = () => {
    const m = existsSync(ARCHIVO) ? statSync(ARCHIVO).mtimeMs : 0;
    if (m === mtime) return;
    mtime = m;
    const { cambios, rechazos } = aplicar(leerArchivo(), quien, servidor);
    for (const c of cambios) aviso(`Directiva ${c}`);
    for (const r of rechazos) aviso(`Directiva ignorada ${r}`);
  };
  try { tick(); } catch { /* sin disco: defaults */ }
  setInterval(() => { try { tick(); } catch { /* un archivo a medias se reintenta en el próximo ciclo */ } }, cadaMs).unref?.();
}
