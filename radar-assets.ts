/** Static visual assets only. This handler cannot read arbitrary files or send game commands. */
import { join } from "node:path";
const ROOT = join(import.meta.dir, "assets/radar");
const PATH =
  /^\/radar-assets\/(catalog\.json|world\d{1,3}\/(map\.json|terrain\.bin|ground\.webp|models\/[A-Za-z0-9_-]+\.glb))$/;
// Íconos de ítems (equipo e inventario del panel): assets/items/item_<grupo>_<número>_<nivel>[_e].png.
const ITEMS_ROOT = join(import.meta.dir, "assets/items");
const ITEM_PATH = /^\/radar-assets\/items\/(item_\d{1,2}_\d{1,3}_\d{1,2}(?:_e)?\.png)$/;
export async function serveRadarAsset(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/radar-assets/")) return null;
  if (req.method !== "GET")
    return new Response("Solo lectura.", { status: 405 });
  const item = url.pathname.match(ITEM_PATH);
  const match = item ?? url.pathname.match(PATH);
  if (!match) return new Response("No encontrado.", { status: 404 });
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const u = new URL(origin);
      // Solo la estación y los paneles de los bots (sus puertos), como originAllowed de ws-server.
      const port = Number(u.port);
      if (
        u.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(u.hostname) ||
        !(port === Number(process.env.ESTACION_PORT ?? 8787) || (port >= 8791 && port < 8891))
      )
        return new Response("Origen no permitido.", { status: 403 });
    } catch {
      return new Response("Origen no permitido.", { status: 403 });
    }
  }
  const file = Bun.file(join(item ? ITEMS_ROOT : ROOT, match[1]));
  if (!(await file.exists()))
    return new Response("Mapa no disponible.", { status: 404 });
  const type = item
    ? "image/png"
    : url.pathname.endsWith(".glb")
    ? "model/gltf-binary"
    : url.pathname.endsWith(".bin")
      ? "application/octet-stream"
      : url.pathname.endsWith(".webp")
        ? "image/webp"
        : "application/json";
  return new Response(file, {
    headers: {
      "content-type": type,
      "cache-control": url.searchParams.has("v")
        ? "public, max-age=86400"
        : "no-cache",
      ...(origin
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {}),
    },
  });
}
