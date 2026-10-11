# Modo navegador (archivado)

El proyecto se enfoca en el bot sin navegador (`headless-bot.ts`) y la estación (`bun run estacion`).
Esto es el agente que jugaba **dentro** de la pestaña del juego: queda como referencia (sus
comentarios explican decisiones aprendidas jugando, y `farming.ts`/`camp.ts` son su port) y para
cuando quieras usarlo. No lo importa ningún `.ts` ni test del bot.

| Archivo | Qué es |
|---|---|
| `browser-agent.js` | El agente: farmea, reparte puntos, resetea. Referencia del bot sin navegador. |
| `bg-timers.js` | Que Chrome no frene la pestaña en segundo plano. |
| `tuner.js`, `skill-ab.js` | Ajustes y pruebas A/B de skills. |
| `hunter.js`, `explorer.js` | Cazador y buscador de dorados. |
| `corner.js`, `defense.js` | Esquina de Arena 2 y defensa propia. |
| `duo.js`, `follow.js` | Dúo / seguidor entre dos pestañas. |
| `mubot-loader.user.js` | Userscript que inyecta el agente al cargar la página. |
| `serve-agent.ts` | `bun run agent`: sirve estos `.js` en 127.0.0.1:8788 (+ `/gold`, `/atlas`). |
| `PLAN-FARMEO.md` | Bitácora de ciclos del agente del navegador. |
| `skill-correr-agente/` | La skill de Claude que lo arrancaba (ya no está activa en `.claude/skills`). |

**Nunca** correr el bot sin navegador con una cuenta abierta en la pestaña.

## Cómo se usa

1. En una terminal: `bun run agent` (sirve los archivos del agente en `127.0.0.1:8788`, solo local).
2. Entrá al juego con el personaje en https://mu.mormon.garden/ y abrí la consola (F12 → Console).
3. Pegá esta línea y Enter:

```js
for (const f of ['bg-timers.js', 'browser-agent.js', 'tuner.js', 'hunter.js', 'defense.js', 'corner.js']) (0, eval)(await (await fetch('http://127.0.0.1:8788/' + f)).text())
```

Desde ahí juega solo: farmea, reparte puntos, resetea en 400, vuelve a entrar con el personaje y
repite. Lo aprendido queda en el `localStorage` del navegador. La terminal se puede cerrar una vez
cargado. Si recargás la pestaña (F5), hay que volver a pegar la línea, con la terminal abierta.
Para pararlo: `__ai.on = false` (y `__ai.on = true` para seguir). El log: `__ai.log.slice(-20)`.
`bg-timers.js` evita que Chrome lo frene cuando la pestaña no está a la vista.

### Que se cargue solo después de un deploy o un F5

Instalá `mubot-loader.user.js` en Tampermonkey o Violentmonkey (abrir el archivo → instalar) y dejá
corriendo `bun run agent`. Cada vez que la página del juego carga y el personaje entra al mundo, el
script inyecta el agente solo. Si un deploy te manda al login, entrás vos y el bot sigue. Para jugar
sin nadie durante horas, el camino es el bot sin navegador, que se reconecta solo con las
credenciales del `.env`.

### Cooperación entre dos personajes (`follow.js`)

Para dos pestañas del mismo Chrome (ej. Horaz y Melu). El líder no cambia nada de lo que hace: solo
publica su posición y nivel (`localStorage`) e invita a la party. El seguidor hace todo lo demás.

```js
// pestaña del LÍDER (Horaz)
window.__followRole = 'lider'; window.__followMate = 'Melu';
(0, eval)(await (await fetch('http://127.0.0.1:8788/follow.js')).text())

// pestaña del SEGUIDOR (Melu), con el agente ya cargado
window.__followRole = 'seguidor'; window.__followLeader = 'Horaz';
(0, eval)(await (await fetch('http://127.0.0.1:8788/follow.js')).text())
```

El seguidor: hace warp al mapa del líder y se acerca (teleport si está a > 10 tiles), acepta solo la
party del líder, ataca con su skill de área a <= 6 tiles sin desviarse (Evil Spirit primero), deja de
pegar si recibe mucho daño, escapa con teleport con < 40 % de vida, resetea solo en 400, y si el mapa
del líder no le da el nivel o el líder va 30+ niveles por debajo, farmea sola con su ruta.

Para cortarla: en el líder `window.__followMate = null`; en el seguidor recargar el agente sin
`follow.js`. **Medido 2026-10-11:** con party el seguidor sube rapidísimo (127 → 284 en ~3 min), pero
el líder reparte la exp y sus ciclos pasaron de ~9 a ~13,6 min. Usarla cuando importa el seguidor.
