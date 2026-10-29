/**
 * Recarga en caliente del cerebro (brain.ts) sin cortar la conexión. El núcleo se queda vivo; el cerebro se compila aparte con Bun.build:
 * lo que es del cerebro (los archivos de `src/brain/`) va dentro del bundle y todo lo demás (estado, conexión, protocolo, panel…) queda como import externo
 * al mismo archivo, así el cerebro nuevo comparte el estado del núcleo (`world`, `bot`, `D`) en vez de tener el suyo.
 *
 *   watchBrain()   mira los archivos del cerebro; al cambiar compila y prueba cargar el nuevo. Si anda, pide recargar (`bot.reloadBrain`);
 *                  si no compila o falla al cargar, se queda con el cerebro anterior y lo avisa.
 *   takeBrain()    el cerebro con el que arranca el loop: el nuevo si hay uno listo, si no el último que funcionó.
 *   revertBrain()  el cerebro nuevo falló al correr: se vuelve al anterior.
 * Solo se recarga el cerebro: un cambio en el núcleo (config, state, world, connection, panel, telemetry, journal, directivas, terrain…) pide
 * reiniciar el bot, y `watchBrain` lo avisa en el log.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { bot } from './state';
import { log } from './util';

/** `src/brain/`: todo lo que está ahí es cerebro (se recompila y se recarga en caliente). Lo demás de `src/` es núcleo. */
const SRC = join(import.meta.dir, '..');
const BRAIN_DIR = join(SRC, 'brain');
const CORE_DIR = join(SRC, 'core');
const OUT_DIR = join(homedir(), '.mubot', 'hot');
const POLL_MS = 2_000;

export type Brain = typeof import('../brain/brain');

let current: { mod: Brain; id: string } | null = null;
let next: { mod: Brain; id: string } | null = null;
/** El cerebro anterior al actual, para volver si el nuevo falla al correr. */
let previous: { mod: Brain; id: string } | null = null;
let seq = 0;

const tsIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));
const brainFiles = () => tsIn(BRAIN_DIR);
const signature = () => brainFiles().map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)).join('|');

/** Compila un punto de entrada del cerebro a un solo archivo de texto. Tira si no compila. */
async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(BRAIN_DIR, entry)],
    target: 'bun',
    format: 'esm',
    packages: 'external', // los paquetes (node_modules) no se copian al bundle: una sola instancia, la del proceso
    plugins: [{
      name: 'nucleo-externo',
      setup(b) {
        b.onResolve({ filter: /^\.\.?\// }, (args) => {
          const file = Bun.resolveSync(args.path, dirname(args.importer));
          if (dirname(file) === BRAIN_DIR) return undefined; // del cerebro: se recompila
          return { path: file, external: true }; // núcleo: el mismo módulo (y el mismo estado) que usa el proceso
        });
        // Los paquetes del monorepo (@mubot/db, @mubot/protocol) también quedan externos, con su ruta real: el bundle vive en ~/.mubot/hot y
        // desde ahí no se resolverían por nombre.
        b.onResolve({ filter: /^@mubot\// }, (args) => ({ path: Bun.resolveSync(args.path, dirname(args.importer)), external: true }));
      },
    }],
  });
  if (!result.success) throw new Error(result.logs.map((l) => l.message).join('; ').slice(0, 400) || 'no compiló');
  return await result.outputs[0]!.text();
}

/** Compila el cerebro a un archivo propio y lo carga. Tira si no compila o no carga. */
async function build(): Promise<{ mod: Brain; id: string }> {
  const id = `${Date.now().toString(36)}-${++seq}`;
  const text = await bundle('brain.ts');
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `brain-${id}.mjs`);
  writeFileSync(file, text);
  try {
    return { mod: (await import(file)) as Brain, id };
  } finally {
    // Quedan los últimos archivos (el actual y el nuevo); el resto se borra.
    for (const f of readdirSync(OUT_DIR)) if (f.startsWith('brain-') && f !== `brain-${id}.mjs` && f !== `brain-${current?.id}.mjs`) try { unlinkSync(join(OUT_DIR, f)); } catch { /* en uso */ }
  }
}

/** El cerebro con el que arranca (o reanuda) el loop. */
export async function takeBrain(): Promise<Brain> {
  if (next) { previous = current; current = next; next = null; return current.mod; }
  if (!current) current = await build();
  return current.mod;
}

/** El cerebro que se acaba de cargar falló al correr: vuelve al anterior (null si no había otro). */
export function revertBrain(): Brain | null {
  if (!previous) return null;
  current = previous;
  previous = null;
  return current.mod;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Mira los archivos y recarga el cerebro cuando cambian (una vez por proceso). */
export function watchBrain() {
  if (timer) return;
  let seen = signature();
  let coreSeen = coreSignature();
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    const sig = signature();
    const core = coreSignature();
    if (core !== coreSeen) {
      coreSeen = core;
      log('Cambió un archivo del núcleo (conexión, protocolo, estado, panel…): eso pide reiniciar el bot; el cerebro se recarga solo.');
    }
    if (sig === seen) return;
    seen = sig;
    busy = true;
    try {
      const b = await build();
      next = b;
      bot.reloadBrain = true;
      log(`Cambió el cerebro: lo recargo sin desconectar (${b.id}).`);
    } catch (e) {
      log(`El cerebro nuevo no compila o no carga (${(e as Error).message}); sigo con el anterior.`);
    } finally {
      busy = false;
    }
  }, POLL_MS);
  timer.unref?.();
}

/** Los archivos del núcleo (`src/core/` y `src/station/`): solo se vigilan para avisar. */
function coreSignature(): string {
  return [...tsIn(CORE_DIR), ...tsIn(join(SRC, 'station'))].map((f) => statSync(f).mtimeMs).join('|');
}
