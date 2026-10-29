/** Compila la extensión a un solo archivo para la página. `@mubot/db` y `node:fs` se reemplazan por stubs: en el navegador no hay base de datos ni disco. */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir;
const result = await Bun.build({
  entrypoints: [join(root, 'src/inject.ts')],
  target: 'browser',
  format: 'iife',
  // La extensión es un script clásico: `import.meta` es un error de sintaxis ahí (el código del bot lo usa solo para saber la carpeta del repo).
  define: { 'import.meta.dir': '""' },
  outdir: join(root, 'dist'),
  plugins: [{
    name: 'sin-base',
    setup(b) {
      b.onResolve({ filter: /^@mubot\/db$/ }, () => ({ path: join(root, 'src/db-stub.ts') }));
      b.onResolve({ filter: /^node:fs$/ }, () => ({ path: join(root, 'src/fs-stub.ts') }));
    },
  }],
});
if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(join(root, 'manifest.json'), join(root, 'dist/manifest.json'));
console.log(`extensión compilada: ${result.outputs.map((o) => `${o.path} (${Math.round(o.size / 1024)} KB)`).join(', ')}`);
