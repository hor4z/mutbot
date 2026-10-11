---
name: correr-agente
description: Arrancar o reanudar el agente de MU (Horaz) en la pestaña del navegador y verificar que juega solo. Usar cuando el usuario dice "correlo", "arrancalo", "ponelo a jugar", "activá el bot" o similar.
---

# Correr el agente de MU en el navegador

Objetivo: que Horaz quede jugando solo en mu.mormon.garden (farmear → /add → /reset en 400 → repetir),
con el agente del navegador. No es el bot sin navegador (`headless-bot.ts`), salvo que el usuario lo pida.

## Reglas que no se negocian

- **Nunca tipear contraseñas en el navegador.** Si la pestaña no está logueada o está en la pantalla
  de login, pedirle al usuario que entre él con el personaje y avisar cuando esté.
- **Una sola sesión por cuenta:** no correr `bun run bot` con la misma cuenta que está abierta en el navegador.
- **`hunter.js`**: en Horaz caza solo (dorada a las :49:20 en Devias con gira por Lorencia y Noria, y
  Dragón Rojo). En otras pestañas queda apagado salvo `__hunt.setAuto(true)`. **`duo.js` no**: en pausa.
- **`defense.js`** (defensa propia): solo contesta a un jugador que le pegó en los últimos 10 s, con el
  skill más fuerte (DK: Death Stab); con vida < 35% se va a otro mapa de la ruta. Nunca ataca primero.
- **Ritmo humano:** no tocar animaciones, cooldowns ni velocidad de packets.

## Pasos

1. **Servidor local del agente.** Ver si ya corre: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/tuner.js`
   (200 = ya está). Si no, arrancarlo en background: `bun run agent` (desde `~/self/mubot`, `run_in_background`).
   Solo escucha en 127.0.0.1.

2. **Pestaña del juego.** Con las herramientas de Chrome (`tabs_context_mcp`), buscar la pestaña de
   `https://mu.mormon.garden/`. No abrir otra si ya hay una con el personaje adentro.
   Comprobar con `javascript_tool`:
   `({ ui: __store?.uiState, pj: __store?.playerData?.name, nivel: __store?.playerData?.level, agente: !!window.__ai, on: window.__ai?.on })`
   - `ui === 5` = en el mundo. `ui === 3` = selección de personaje (el agente entra solo con el
     personaje si ya está cargado; si no, cargarlo igual: lo hace él).
   - Sin `__store` o en login: pedirle al usuario que entre (no tipear credenciales).

3. **Cargar el agente** (orden: bg-timers → agente → autoajuste → cazador → defensa). En la pestaña:
   ```js
   window.__mubotOut = 'pending';
   (async () => { for (const f of ['bg-timers.js', 'browser-agent.js', 'tuner.js', 'hunter.js', 'defense.js', 'corner.js']) { const t = await (await fetch('http://127.0.0.1:8788/' + f + '?' + Date.now())).text(); (0, eval)(t); } window.__mubotOut = 'ok'; })().catch((e) => window.__mubotOut = 'ERR ' + e.message);
   ```
   `javascript_tool` no espera promesas: leer `window.__mubotOut` en la llamada siguiente.
   - Si `__ai.busy` es true (reseteando/repartiendo), esperar a que termine antes de recargar.
   - **Reinstalar `browser-agent.js` desconecta el autoajuste**: siempre volver a cargar `tuner.js` después.
   - Si ya estaba corriendo y solo hay que reanudar: `__ai.on = true` (no recargar).

4. **Verificar que juega** (a los ~20 s):
   `({ on: __ai.on, tuner: !!__ai.tuner?.timer, roam: __ai.cfg.roam, anchor: __ai.cfg.anchor, resetLevel: __ai.cfg.resetLevel, nivel: __store.playerData.level, log: __ai.log.slice(-6) })`
   Esperado: `on: true`, `tuner: true`, `roam: 0`, `anchor: 1`, `resetLevel: 400`, y el log
   avanzando (warps, campamentos, "tramo: nivel N").

5. **Avisar al usuario** en pocas líneas: personaje, nivel, mapa, que está jugando solo, y cómo
   pararlo (`__ai.on = false`).

## No hacer mientras corre

- No recargar el agente a mitad de ciclo para probar cambios: borra lo medido del mapa y ensucia
  la medición. Si hay un cambio de código, programar la recarga para el próximo reset
  (ver `AGENTS.md`, "Separar dúo y cacería del farmeo", y la recarga en el reset).
- Ciclos con intervenciones se marcan con `tag` en `__ai.cycleLog` para que no cuenten.

## Estado y diagnóstico rápido

- Ciclos: `__ai.cycleReport()` (duración, resets/día, minuto de cada nivel hito).
- Tiempos: `__ai.time` (fight / walk / idle).
- Autoajuste: `__ai.tuner.history`, experimento actual `__ai.tuner.exp`.
- Más contexto: `README.md` (pasos para el usuario), `AGENTS.md`, `PLAN-FARMEO.md`.
