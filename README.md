# mubot

Bot headless de MU. Hace que un personaje **progrese solo** —pelea, sube exp y
stats, recoge loot, vende basura, repone pociones— sin GUI, hablando el protocolo
real del cliente.

Corre **solo contra la infraestructura propia**, y a ritmo humano a propósito.

## Quick start

```bash
bun install

# 1. Tests offline (no tocan el server)
bun run test

# Proxy WebSocket -> TCP hacia tu server (127.0.0.1:3000)
bun run proxy

# 2. El bot: login + loop autónomo que hace progresar al personaje
bun run bot --user <u> --pass <p> --char <c> \
  --auto-seconds 600 \
  --build str,vit \
  --decision-log /tmp/decisiones.jsonl
```

El `--decision-log` escribe cada decisión como JSONL, una por línea. Es el punto
de enganche para una UI que quiera decidir.

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `headless-bot.ts` | El bot: login, mundo, loop autónomo, economía, capa de decisión. |
| `packet-tests.ts` | 25 tests offline de packets. Sin red. |
| `AGENTS.md` | Referencia técnica: protocolo, economía, anti-cheat, limitaciones. |

**Leé `AGENTS.md` antes de tocar el código.** La sección "Trampas de protocolo"
documenta packets donde los parsers generados del repo están mal para 0.97d y el
bot queda ciego sin avisar.

## Estado

Funciona y está verificado: login 0.97d, selección de personaje, entrada al
mundo, movimiento, stats, loot, pociones y los packets de venta/compra de NPC.

**Bloqueante para jugar solo:** el golpe (`HitRequest`) no produce efecto
contra el server real, así que el bot no mata nada todavía. Detalle en
`AGENTS.md` → "Combate".

## Reglas

- Solo contra infraestructura propia. `--allow-remote` es obligatorio para hosts
  no locales.
- Ritmos humanos y deliberados (caminata 380ms, ataque 500ms, skills 900ms). **No
  bajarlos.** El server tiene `SpeedHackDetectPlugIn` con delay base de 450ms y
  token bucket de 5.
- No tocar `SpeedHackDetectPlugIn` ni la config del server para que el bot vaya
  más rápido. El objetivo es saber si el server valida, no hacerlo pasar.
- Nada de flood, brute force ni sesiones simultáneas de la misma cuenta.

Es un proyecto independiente: `net/`, `packets/` y `data/` son copias del
cliente MU JS, así que no necesita ese repo para correr (solo para regenerar
`packets/`, ver `AGENTS.md`).
## Agente en el navegador (sin que nadie lo dirija)

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
