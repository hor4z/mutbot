/** Atributos de celdas (256×256) de un mapa: los pide una vez a la estación (`/terrain/<mapa>`) y los comparte el mapa táctico. */
const terrainCache = new Map<number, Uint8Array | null>();
export async function getTerrain(map: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (terrainCache.has(map)) return terrainCache.get(map)!;
  let out: Uint8Array | null = null;
  {
    try {
      const r = await fetch(`/terrain/${map}`, { signal });
      if (r.ok) {
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length === 65536) out = b;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
    }
  }
  terrainCache.set(map, out);
  return out;
}
