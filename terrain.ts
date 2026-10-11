/**
 * Grilla de atributos del terreno (EncTerrainN.att del cliente): paredes, zona segura, agua.
 * Sin navegador el bot no tenía dónde estaban las paredes ("no llego (¿muros?)") y el panel no
 * podía dibujar los mapas sin minimapa (Arena 2/3/4). Lee los archivos de `MU_ASSETS`
 * (default ~/self/mu/public/game-assets), los mismos que baja el cliente web.
 *
 * El descifrado es copia literal de `src/common/terrain/mapFileEncryption.ts` y
 * `parseTerrainAttribute.ts` del cliente (no reescribir: ver CLAUDE.md sobre las copias).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TERRAIN_SIZE = 256;
/** Bits del atributo (TWFlags del cliente). */
export const TW = { SafeZone: 0x01, Character: 0x02, NoMove: 0x04, NoGround: 0x08, Water: 0x10 } as const;

const XOR_KEY = new Uint8Array([0xd1, 0x73, 0x52, 0xf6, 0xd2, 0x9a, 0xcb, 0x27, 0x3e, 0xaf, 0x59, 0x31, 0x37, 0xb3, 0xe7, 0xa2]);
const BUX_CODE = new Uint8Array([0xfc, 0xcf, 0xab]);
const castToByte = (n: number) => n & 0xff;

function decryptMapFile(dst: Uint8Array, src: Uint8Array, size: number) {
  let wMapKey = 0x5e;
  for (let i = 0; i < size; ++i) {
    dst[i] = (src[i] ^ XOR_KEY[i % 16]) - castToByte(wMapKey);
    wMapKey = castToByte(src[i] + 0x3d);
  }
}

function convertBux(buf: Uint8Array, size: number) {
  for (let i = 0; i < size; ++i) buf[i] ^= BUX_CODE[i % 3];
}

/** Archivo .att descifrado → atributo por celda (índice y * 256 + x). */
export function parseAtt(file: Uint8Array): Uint8Array {
  const size = file.length;
  const plain = TERRAIN_SIZE * TERRAIN_SIZE + 4, wide = TERRAIN_SIZE * TERRAIN_SIZE * 2 + 4;
  if (size !== plain && size !== wide) throw new Error(`.att de tamaño inesperado (${size})`);
  const dec = new Uint8Array(size);
  decryptMapFile(dec, file, size);
  convertBux(dec, size);
  if (dec[0] !== 0 || dec[2] !== 255 || dec[3] !== 255) throw new Error('.att con cabecera inválida');
  const out = new Uint8Array(TERRAIN_SIZE * TERRAIN_SIZE);
  if (size === plain) out.set(dec.subarray(4, 4 + out.length));
  else { const dv = new DataView(dec.buffer, 4); for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true) & 0xff; }
  return out;
}

/**
 * Carpeta WorldN del cliente para un índice de mapa del server. Las Arenas de este server (83, 84,
 * 85) usan el terreno del Estadio (mapa 6 → World7), igual que el minimapa del panel.
 */
export const worldFolderOf = (map: number) => ({ 83: 7, 84: 7, 85: 7 } as Record<number, number>)[map] ?? map + 1;

const ASSETS = process.env.MU_ASSETS ?? join(homedir(), 'self/mu/public/game-assets');
// Los mapas del SERVER (los que baja el cliente web 0.97d): pueden diferir de los del cliente genérico.
// El World7 del server (Arenas) tiene una salida en el corral de Arena 2 que el local no: Melu quedó
// trabada contra la cerca. Se bajan una vez y se guardan en ~/.mubot/terrain/.
const SERVER_ASSETS = process.env.MUBOT_ASSETS_URL ?? 'https://mu.mormon.garden/game-assets-v097d';
const SERVER_CACHE = join(homedir(), '.mubot', 'terrain');
const cache = new Map<number, Uint8Array | null>();
const downloading = new Set<number>();

const serverFile = (n: number) => join(SERVER_CACHE, `World${n}`, `EncTerrain${n}.att`);

// Baja el .att del server para ese World (una vez); al terminar, el mapa se vuelve a leer.
function fetchServerTerrain(n: number) {
  if (downloading.has(n) || process.env.MUBOT_NO_SERVER_TERRAIN) return;
  downloading.add(n);
  void (async () => {
    try {
      const r = await fetch(`${SERVER_ASSETS}/World${n}/EncTerrain${n}.att`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const bytes = new Uint8Array(await r.arrayBuffer());
      parseAtt(bytes); // valida antes de guardar
      mkdirSync(join(SERVER_CACHE, `World${n}`), { recursive: true });
      writeFileSync(serverFile(n), bytes);
      for (const [m] of cache) if (worldFolderOf(m) === n) cache.delete(m);
    } catch {
      // sin red o archivo inválido: se sigue con el local
    }
  })();
}

/**
 * Atributos del mapa: los del server (bajados a ~/.mubot/terrain), si no los del cliente local, si no
 * null. Se cachea por mapa; la primera vez dispara la bajada del server (y mientras, usa el local).
 */
export function terrainOf(map: number): Uint8Array | null {
  if (cache.has(map)) return cache.get(map)!;
  const n = worldFolderOf(map);
  let grid: Uint8Array | null = null;
  for (const path of [serverFile(n), join(ASSETS, `World${n}`, `EncTerrain${n}.att`)]) {
    try { if (existsSync(path)) { grid = parseAtt(new Uint8Array(readFileSync(path))); break; } } catch { grid = null; }
  }
  if (!existsSync(serverFile(n))) fetchServerTerrain(n);
  cache.set(map, grid);
  return grid;
}

/** ¿Se puede caminar (x, y)? Sin datos del mapa, se asume que sí. */
export function isWalkable(map: number, x: number, y: number): boolean {
  const g = terrainOf(map);
  if (!g || x < 0 || y < 0 || x >= TERRAIN_SIZE || y >= TERRAIN_SIZE) return !g;
  return (g[y * TERRAIN_SIZE + x] & (TW.NoMove | TW.NoGround)) === 0;
}

/** ¿(x, y) es zona segura (pueblo)? Ahí los golpes no hacen daño. Sin datos del mapa: no. */
export function isSafeZone(map: number, x: number, y: number): boolean {
  const g = terrainOf(map);
  if (!g || x < 0 || y < 0 || x >= TERRAIN_SIZE || y >= TERRAIN_SIZE) return false;
  return (g[y * TERRAIN_SIZE + x] & TW.SafeZone) !== 0;
}

// Tiles que el server rechazó (paso devuelto con 0x11): bloqueados para los caminos, por mapa. Cubre
// lo que el .att no dice (objetos, diferencias del server).
const learned = new Map<number, Set<number>>();
export function learnBlocked(map: number, x: number, y: number) {
  let s = learned.get(map);
  if (!s) learned.set(map, (s = new Set()));
  s.add(y * TERRAIN_SIZE + x);
  if (s.size > 5000) s.clear();
}
/** Caminable según el terreno y lo aprendido (para path.ts). */
export const walkableFor = (map: number) => (x: number, y: number) => isWalkable(map, x, y) && !learned.get(map)?.has(y * TERRAIN_SIZE + x);
/** Solo lo aprendido (cuando el terreno no tiene salida, ver loop-ctx.ts). */
export const learnedFreeFor = (map: number) => (x: number, y: number) => x >= 0 && y >= 0 && x < 256 && y < 256 && !learned.get(map)?.has(y * TERRAIN_SIZE + x);
