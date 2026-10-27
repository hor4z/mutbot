# @mubot/extension

Extensión de Chrome con un auto attack para jugar a mano: engancha el WebSocket de la página del juego, le pasa lo que ve al bot local y escribe en el
mismo socket lo que el bot decide. Es tu sesión del navegador, no la de Capitan.

```
página del juego ── frames (entran y salen) ──> ws://127.0.0.1:8792 (bot/src/attach.ts)
                 <── paquetes ya cifrados ────
```

## Usarla

1. `bun run asistente` (levanta el puerto 8792; solo acepta la página del juego).
2. `bun run --cwd packages/extension build` y en `chrome://extensions` (modo desarrollador) "Cargar descomprimida" con `packages/extension/dist`.
3. **Capitan tiene que estar desconectado** (dos sesiones de la misma cuenta no): el asistente se niega a prenderse si la estación lo ve conectado.
4. Cargá la página del juego **después** de arrancar el asistente (necesita ver el login para saber quién sos y qué skills tenés) y entrá al mundo.
5. El botón de la esquina prende el auto attack: pega al monstruo más cercano al alcance con el skill de siempre (`brain/combat.ts`), toma poción a
   `HEAL_AT_PCT` y respeta los ritmos del bot. No camina: lo movés vos.

## Qué se sabe y qué no

- El dominio está en `manifest.json` y en `ALLOWED_ORIGINS` de `attach.ts` (`https://mu.mormon.garden`).
- La posición propia sale de la entrada al mundo y de los pasos que manda la página (`WalkRequest075`, C1 con xor32).
- Los skills y los golpes con skill van como C3: salen cifrados con un contador propio, distinto al de la página. Si el server lo rechaza, el
  asistente solo golpea a mano; sin probar contra el server real.
