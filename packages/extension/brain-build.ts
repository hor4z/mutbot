/**
 * Compila SOLO el cerebro del asistente (bot/src/brain/assist.ts y lo que importa de brain/) a `dist/brain.js`, listo para cargarse en la página ya
 * abierta con `window.__mu.swapBrain(código)` sin recargar nada. Todo lo que el cerebro importa de afuera de `brain/` queda como referencia a
 * `window.__mu.mods` (src/host-mods.ts): el cerebro nuevo usa el estado vivo de la página.
 *   bun run --cwd packages/extension brain
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { HOST_MODS } from './src/host-mods';

const root = import.meta.dir;
const src = resolve(root, '../bot/src');
const brainDir = join(src, 'brain');
const missing = new Set<string>();

const entry = join(root, 'dist/brain-entry.ts');
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(entry, `import * as m from ${JSON.stringify(join(brainDir, 'assist.ts'))};\n(window as unknown as { __muNext?: unknown }).__muNext = m;\n`);

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const resolveTs = (base: string) => [base, `${base}.ts`, join(base, 'index.ts')].find(isFile);

const result = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  format: 'iife',
  outdir: join(root, 'dist'),
  naming: 'brain.js',
  minify: process.env.BRAIN_MIN === '1',
  define: { 'import.meta.dir': '""' },
  plugins: [{
    name: 'cerebro',
    setup(b) {
      b.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        if (!args.importer.startsWith(brainDir)) return undefined;
        const abs = resolveTs(resolve(dirname(args.importer), args.path));
        if (!abs || abs.startsWith(brainDir)) return undefined;
        const key = relative(src, abs).replace(/\.ts$/, '');
        if (!(key in HOST_MODS)) missing.add(key);
        return { path: abs, namespace: 'host' };
      });
      b.onLoad({ filter: /.*/, namespace: 'host' }, (args) => {
        const key = relative(src, args.path).replace(/\.ts$/, '');
        const names = Object.keys(HOST_MODS[key] ?? {}).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
        const lines = names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`);
        return { loader: 'js', contents: `const m = window.__mu.mods[${JSON.stringify(key)}];\n${lines.join('\n')}\n` };
      });
    },
  }],
});
if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}
if (missing.size) {
  console.error(`El cerebro importa módulos que no están en src/host-mods.ts: ${[...missing].join(', ')}`);
  process.exit(1);
}
const out = result.outputs[0]!;
console.log(`cerebro compilado: ${out.path} (${Math.round(out.size / 1024)} KB)`);
