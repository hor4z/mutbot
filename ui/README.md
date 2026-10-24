# Interfaz de la estación

React + Vite, componentes Base UI, fuentes Geist y Geist Mono locales, radar Three.js.

- `bun run ui:dev`: desarrollo en Vite. `/api` usa la estación local en 8787; el panel de cada personaje sigue en su puerto.
- `bun run ui:build`: compila y actualiza `../estacion.html` y `../panel.html`. Después recargar el navegador. No hace falta reiniciar la estación ni los bots.
- `bun run tsc`: comprobación de tipos del proyecto y la interfaz.

`bun run ui:dev` + `/?demo` abre la estación con datos simulados (sin tocar la estación ni los bots). Vistas: Flota, Personaje, Estrategias, Dorados, Ranking, Consola; atajos 1-6, N, A, ? y Ctrl/Cmd+K.

Los HTML son artefactos generados: editar `src/`, no los bundles. Fuentes e ilustración se incluyen en el build para conservar las rutas HTTP existentes, sin CDN ni dependencias de red al abrir el panel.

La estación conserva `/api/state`, `/api/log/:personaje` y `/api/do`. El panel usa el WebSocket de su mismo origen y el contrato de `panel-protocol.ts`. Cambiar de personaje o de vista no envía órdenes al bot.

## Radar

El radar carga los archivos visuales de `assets/radar/` por `/radar-assets/`. La estación y los paneles nuevos sirven esa ruta en loopback; un panel de un bot que ya estaba corriendo puede usar la estación sin reiniciar el bot. Solo se sirven los nombres y extensiones previstos. No hay acceso a archivos arbitrarios ni comandos del juego en esta ruta.

El escenario usa los datos del cliente local: altura de cada vértice de `TerrainHeight.OZB` (factor 0.015), huecos de `.att`, mezcla de texturas y alfa de `.map`, iluminación de `TerrainLight`, modelos GLB y las posiciones/rotaciones/escalas de `.obj`. Los archivos de colisiones ya no se representan como paredes inventadas. Los personajes, objetivos, objetos y recorridos se ubican a la altura real del terreno.

Mapas incluidos: Lorencia, Dungeon, Devias (sus cuatro entradas), Noria, Lost Tower, Stadium/Arenas, Atlans, Tarkan, Devil Square, Icarus, Aida y Elbeland. Los mapas del servidor 83/84/85 comparten World7, igual que `terrain.ts`. Se conservan las coordenadas del mapa; no se mezclan las entradas de Devias con mapas distintos.

Arrastrar para orbitar, rueda para zoom, Centrar para restaurar. Con foco en el canvas: flechas giran/elevan, `+`/`-` acercan/alejan, Home centra. "Mapa" encuadra la extensión del terreno disponible. "Escenario" permite ocultar árboles/edificios y el botón de ampliar habilita pantalla completa. Los marcadores son indicadores de radar y siguen visibles detrás de edificios.

Se carga únicamente el mapa actual. Modelos repetidos se dibujan por instancias agrupadas espacialmente, con cuatro descargas simultáneas como máximo. Al cambiar de mapa o desmontar se aborta la carga y se liberan texturas y geometría. Sin assets completos se mantiene la vista de colisiones; sin WebGL2 se informa sin bloquear el resto del panel.

### Regenerar los mapas

`bun run ui:maps` importa desde `~/self/mu/public/game-assets`, sin red. Requiere Python 3, Pillow y numpy. Para otra instalación:

```sh
python3 ui/scripts/import-maps.py --source /ruta/game-assets
```

`--worlds 1,3,4,7` limita el exportado; `--skip-textures` reutiliza las texturas horneadas. Los assets quedan copiados en este proyecto; la UI no depende del cliente externo en runtime. El informe `assets/radar/import-report.json` enumera modelos ausentes o vacíos. Algunos registros originales son efectos/markers sin modelo disponible; se omiten sin inventar geometría. Los modelos animados del entorno usan su primera pose, sin partículas ni efectos dinámicos del cliente.

Los parsers y transformaciones se contrastaron con `src/common/terrain/`, `getTerrainData.ts`, `customGroundMesh.ts`, `loadMapIntoScene.ts`, `modelObject.ts` y `renderSystem.ts` del cliente local. El importador conserva los valores originales, horneando las capas del suelo a WebP de 4096 × 4096.

## Vista del personaje (`Panel.tsx`)

Cabecera con clase, nivel, resets, HP/MP reales y barra hacia el reset; acciones rápidas (pausar, ruta, cazar, viajar: todo lo que cambia el rumbo pide confirmación); mapa permanente a la izquierda y pestañas Resumen · Combate · Equipo y bolsa · Eventos · Chat · Diario · Consola. Lógica pura en `hud-logic.ts` y `radar-model.ts` (tests: `bun run hud-tests.ts`).

- **Mapa**: 3D (`radar-engine.ts`) y táctico 2D (`Tactical.tsx`, canvas con niebla de lo recorrido), alternables con `M`. Capas conmutables en la barra inferior (monstruos, dorados, jugadores, escuadra, loot, ruta, zonas de dorados, celdas letales, niebla); se recuerdan en el navegador. Clic = coordenadas, distancia y rumbo; el bot no viaja a coordenadas, solo a spots, por eso "Viajar…" abre el selector con confirmación.
- **Atajos**: `?` ayuda · `1-7` pestañas · `P` pausa/continúa · `R` ruta · `H` cazar · `W` viajar · mapa: `M` 3D/táctico, `F` seguir, `C` centrar, `N` norte, `Q/E` girar, `+/-` zoom, `G` escenario, `L` capas, `Esc` cerrar.
- **Campos opcionales de `PanelState`** que la vista usa si el bot los manda (un bot viejo funciona igual): `hazards`, `squad`, `skills`.
- **Demo**: `?demo` (bot simulado, no abre WebSocket) y `?demo=off` (estado desconectado). En `ui:dev`: `http://127.0.0.1:5199/?panel&demo`; en el panel de un bot: `/panel?demo`.

## Arte

`assets/ui/knight-alpha.webp` tiene canal alpha y se muestra con `object-fit: contain`, sin cubrir textos. El prompt y la procedencia están en `assets/ui/knight-alpha.prompt.txt` en la raíz del repo.
