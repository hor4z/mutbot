/**
 * Ganchos en caliente: decisiones de la cacería que se reemplazan sin reiniciar los bots. Cada proceso carga
 * `~/.mubot/ganchos.ts` (o la ruta de MUBOT_GANCHOS) y lo recarga cuando cambia (cada ~2 s). El archivo exporta funciones con el nombre del
 * gancho; las que no exporta siguen con la lógica del repo. Una función que devuelve `undefined` ("no opino") o que tira un error cae
 * a la lógica del repo en esa llamada; a los 3 errores seguidos se apaga hasta la próxima recarga. Ejemplo: `ganchos.ejemplo.ts`.
 * Ojo: el archivo corre dentro del bot con sus permisos: es código propio, no lo traigas de afuera sin leerlo. `tsc` no lo revisa.
 * Las perillas simples siguen en directivas.ts; esto es para cuando cambia la lógica.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Zone } from './zones';
import type { Invasion } from './panel-protocol';
import type { HuntChoice } from './panel-logic';

export type ZonaArgs = {
  /** Zonas candidatas del mapa (dragones de la base, o de cualquier dorado si ya se vieron todas). */
  zonas: readonly Zone[];
  yo: { x: number; y: number };
  /** Claves "x,y" de las zonas ya vistas (por mí o por un compañero). */
  visitadas: ReadonlySet<string>;
  /** Mi lugar entre los cazadores de este mapa (por nombre) y cuántos somos. */
  rank: number;
  n: number;
  mapa: number;
};
export type DejarArgs = { invasion: Invasion | null; map: number; lastSeenAt: number; now: number; next: HuntChoice; since?: number; stay?: boolean };
export type DoradoArgs = {
  yo: { x: number; y: number };
  /** Id del objetivo actual (o null). */
  objetivo: number | null;
  monstruos: readonly { id: number; x: number; y: number; type: number }[];
  /** ¿Es un tipo dorado que puedo pegar? */
  esDorado: (type: number) => boolean;
};

/** Los ganchos: devolver `undefined` = "no opino" (rige la lógica del repo). */
export type Ganchos = {
  /** A qué zona de dragón ir ahora (null: ninguna, se recorre el mapa en celdas). */
  elegirZona: (a: ZonaArgs) => Zone | null | undefined;
  /** Motivo para dejar el mapa de la cacería y pasar al siguiente (null: me quedo). */
  dejarMapa: (a: DejarArgs) => string | null | undefined;
  /** Qué dorado pegar (el monstruo elegido o null). */
  elegirDorado: <M extends DoradoArgs['monstruos'][number]>(a: Omit<DoradoArgs, 'monstruos'> & { monstruos: readonly M[] }) => M | null | undefined;
};
type Nombre = keyof Ganchos;

export const ARCHIVO_GANCHOS = process.env.MUBOT_GANCHOS || join(homedir(), '.mubot', 'ganchos.ts');
const MAX_FALLOS = 3;

let vivos: Partial<Record<Nombre, (...a: any[]) => any>> = {};
const fallos = new Map<Nombre, number>();
let avisar: (m: string) => void = console.log;
let mtime = -1;
let timer: ReturnType<typeof setInterval> | undefined;

async function recargar() {
  const m = existsSync(ARCHIVO_GANCHOS) ? statSync(ARCHIVO_GANCHOS).mtimeMs : 0;
  if (m === mtime) return;
  mtime = m;
  fallos.clear();
  if (!m) {
    if (Object.keys(vivos).length) avisar('Ganchos: archivo borrado, vuelvo a la lógica del repo.');
    vivos = {};
    return;
  }
  try {
    const mod = await import(`${ARCHIVO_GANCHOS}?v=${m}`);
    const src = mod.default && typeof mod.default === 'object' ? mod.default : mod;
    const next: typeof vivos = {};
    for (const k of ['elegirZona', 'dejarMapa', 'elegirDorado'] as const) if (typeof src[k] === 'function') next[k] = src[k];
    vivos = next;
    avisar(`Ganchos recargados: ${Object.keys(next).join(', ') || '(ninguno)'}`);
  } catch (e) {
    avisar(`Ganchos: no pude cargar ${ARCHIVO_GANCHOS} (${(e as Error).message}); sigo con lo anterior.`);
  }
}

/** Relee el archivo cada `cadaMs`. `aviso` recibe cada recarga y cada error. */
export function iniciarGanchos(aviso: (m: string) => void = console.log, cadaMs = 2000) {
  avisar = aviso;
  void recargar();
  if (timer) return;
  timer = setInterval(() => { void recargar(); }, cadaMs);
  timer.unref?.();
}

/** Para pruebas: una pasada de recarga ahora. */
export const recargarAhora = recargar;

/**
 * El gancho `nombre` con la lógica del repo (`base`) de respaldo. `valida(resultado, ...args)`: lo que el gancho devuelve se usa más
 * adelante sin red, así que un resultado con otra forma (una zona sin coordenadas, un dorado que no estaba en la lista) cuenta como fallo.
 */
export function gancho<K extends Nombre>(nombre: K, base: (...a: any[]) => any, valida: (r: any, ...a: any[]) => boolean = () => true): (...a: any[]) => any {
  return (...a) => {
    const f = vivos[nombre];
    if (!f || (fallos.get(nombre) ?? 0) >= MAX_FALLOS) return base(...a);
    try {
      const r = f(...a);
      if (r === undefined) return base(...a);
      if (!valida(r, ...a)) throw new Error('resultado con forma inválida');
      fallos.set(nombre, 0);
      return r;
    } catch (e) {
      const n = (fallos.get(nombre) ?? 0) + 1;
      fallos.set(nombre, n);
      avisar(`Ganchos: ${nombre} falló (${(e as Error).message})${n >= MAX_FALLOS ? '; lo apago hasta la próxima recarga' : ''}.`);
      return base(...a);
    }
  };
}
