# @mubot/extension

Extensión de Chrome con un asistente para jugar a mano: auto attack, Joyero (levanta zen, joyas, piezas de alas y excelentes), pociones por atajo y
reparto de puntos. **Todo corre dentro de la página del juego**: no hay proceso aparte, ni red local, ni base de datos. Es tu sesión del navegador,
no la de Capitan.

```
página del juego ── frames que entran y salen ──> src/assistant.ts (dentro de la página)
                 <── paquetes del asistente, por el MISMO socket del juego ──
```

## Usarla

1. `bun run --cwd packages/extension build` y en `chrome://extensions` (modo desarrollador) "Cargar descomprimida" con `packages/extension/dist`.
   Cada cambio en `src/` pide volver a compilar y recargar la extensión y la página.
2. **Capitan tiene que estar desconectado** (dos sesiones de la misma cuenta no).
3. Entrá al mundo con la página y esperá unos segundos (el asistente necesita ver el primer paquete de tu cliente para sincronizar el cifrado).
4. El panel de la esquina prende el auto attack y el Joyero: pega al monstruo más cercano al alcance con el skill de siempre (`brain/combat.ts`),
   toma poción a `HEAL_AT_PCT` y respeta los ritmos del bot. No camina: lo movés vos.

## Cómo está armado

- `src/inject.ts`: engancha el WebSocket de la página (el segundo socket; el primero es el connect server) y dibuja el panel. Le da cada frame a
  `assistant.ts` y escribe en el socket con el `send` original lo que el asistente manda.
- `src/assistant.ts`: arma el mundo con el mismo código del bot (`bot/src/core`: paquetes, `world.ts`, `loot-state`) y corre el cerebro
  (`bot/src/brain/assist.ts`).
- **Una sola secuencia de cifrado.** Los C3 (skills, recoger ítems) llevan un contador que el server exige en orden. Todos los C3 de la página se
  descifran y se vuelven a cifrar con un único contador, el del asistente, que arranca donde iba la página; los propios salen con el mismo. Corre en
  el mismo hilo de la página, así que ningún paquete se cruza con otro.
- `build.ts` compila todo a un archivo. `@mubot/db` y `node:fs` se reemplazan por stubs (`src/db-stub.ts`, `src/fs-stub.ts`) y `src/shim.ts` da
  `process` y `Buffer`. Los datos del juego (monstruos, skills, ítems) van dentro de la extensión, tomados de `packages/db/seeds` (`src/seed-data.ts`).
- El reparto de puntos hace clicks reales en el panel de personaje del cliente: no manda ningún paquete.
- El dominio está en `manifest.json` (`https://mu.mormon.garden`).

## Recarga en caliente del cerebro

El cerebro (`bot/src/brain/assist.ts`: a quién pegarle, qué levantar, los ritmos) se puede cambiar con la página abierta, sin recargar nada:

```bash
bun run --cwd packages/extension brain      # compila SOLO el cerebro a dist/brain.js (BRAIN_MIN=1 para achicarlo)
```

y en la página: `window.__mu.swapBrain(<contenido de dist/brain.js>)`. Devuelve `null` si cargó o el motivo si no. El cerebro nuevo comparte el estado vivo del
núcleo (`window.__mu.mods`, ver `src/host-mods.ts`); si el cerebro importa un módulo nuevo de afuera de `brain/`, hay que sumarlo ahí (el build avisa).
Un cambio en el núcleo (`bot/src/core`, `net`, `src/assistant.ts`, `inject.ts`) sí pide `build` y recargar la extensión y la página.
`window.__mu.status()` devuelve lo mismo que muestra el panel.

## Qué se sabe y qué no

- La posición propia sale de la entrada al mundo y de los pasos que manda la página (`WalkRequest075`, C1 con xor32).
- Lo que manda el asistente es un paquete más del mismo socket: el juego no lo anima en tu pantalla. Sin verificar contra el server real.
- Ya no se anota lo que jugás a mano en la base (`ticks`): no hay base desde la página.
