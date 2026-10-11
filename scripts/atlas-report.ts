/**
 * Reporte del atlas (solo lectura, sin red): por mapa, los monstruos más vistos
 * por zona de 25 tiles y todos los dorados con hora local.
 *
 *   bun run atlas-report [ruta]     (default ~/.mubot/atlas.json)
 *   bun run atlas-report --top 8
 */
import { existsSync } from 'node:fs';
import { ATLAS_FILE, formatAtlasReport, loadAtlas } from '../atlas';

const argv = process.argv.slice(2);
const topIdx = argv.indexOf('--top');
const top = topIdx >= 0 ? Math.max(1, parseInt(argv[topIdx + 1] ?? '') || 5) : 5;
const path = argv.find((a, i) => !a.startsWith('--') && (topIdx < 0 || i !== topIdx + 1)) ?? ATLAS_FILE;

if (!existsSync(path)) {
  console.log(`No hay atlas en ${path}: correr el bot con --atlas primero.`);
  process.exit(0);
}
console.log(`Atlas: ${path}\n`);
console.log(formatAtlasReport(loadAtlas(path), { top }));
