# Arquitectura

Bot de MU Online 0.97d que juega solo, sin navegador, por el protocolo real. Cada personaje es **un proceso**; una
**estación** los lanza y los muestra. Los bots no tienen jefe: farmean por su cuenta y se avisan lo importante.

```
estación (estacion.ts) ── lanza / corta ──▶ bot Hume   (headless-bot.ts → farm-loop.ts)
   │  ▲  /api/team (avisos)                 bot Zamu    (idem)
   │  └─────────────────────────────────────  cada bot habla por WebSocket (su panel, solo el mapa)
   ▼
interfaz (ui/): lista + mapas en vivo + mensajes        ClickHouse (db/): historial para decidir
```

## 1. Las partes

### El bot (un personaje)
| Archivo | Qué hace |
|---|---|
| `headless-bot.ts` | Entrada: flags, conexión, reconexión con espera creciente, señales. Arranca el loop. |
| `farm-loop.ts` | **El cerebro.** Un tick = una decisión. Ver sección 2. |
| `hunt.ts` | Cacería de dorados: arrancar con la invasión (0xFD) o un aviso, viajar, elegir dorado, recorrer el mapa, encadenar. |
| `corner.ts` | La esquina de Arena 2 (mejor spot conocido, ~300-550M exp/min): viajar, camino, objetivo dentro del radio. |
| `help.ts` | Party: el más fuerte invita al compañero cercano. |
| `team.ts` | Canal con la estación: dónde está cada compañero, avisos de dorados (`askHelp`), `postInsight`. |
| `intent.ts` | Quién fija el spot (`panel` > `town`) y `requestWarp` (un solo warp pendiente). |
| `route.ts` + `learning.ts` | Ruta fija por tramo de nivel (`maybeChangeSpot`), warps, lo aprendido por personaje (`~/.mubot/learning.json`). |
| `farm-middleware.ts` + `power.ts` | Modelo de poder: ¿puede este personaje con este monstruo / mapa? Decide si es "limitado" y qué mapa le sirve. |
| `camp.ts`, `farming.ts`, `explore.ts` | Objetivo por exp/segundo, campamentos aprendidos, exploración del mapa vacío. |
| `combat.ts`, `loot.ts`, `snipe.ts`, `progress.ts` | Skills y pociones, drops, reparto de puntos y `/reset`. |
| `golden.ts`, `zones.ts`, `insights.ts` | Regla de dorados (dragones primero), zonas de dragones y datos de la base. |
| `loop-ctx.ts`, `path.ts`, `terrain.ts` | Caminar con el terreno y el corte de trabas (15 s). |
| `world.ts`, `actions.ts`, `connection.ts`, `protocol097.ts`, `events.ts`, `chat.ts` | Protocolo: parsers a mano del 0.97d, packets de salida, sockets y cifrado. |
| `state.ts`, `config.ts`, `journal.ts`, `telemetry.ts`, `util.ts` | Estado compartido (`world`, `bot`, `learned`), flags y ritmos humanos, diario, eventos a la base. |

### La estación
| Archivo | Qué hace |
|---|---|
| `estacion.ts` | Lanza y corta bots, adopta los que ya corren, sirve la interfaz y `/api/*`, junta los avisos. |
| `estacion-logic.ts`, `estacion-db.ts` | Validación de pedidos, alertas, cuentas y personajes (`~/.mubot/mubot.db`). |
| `ws-server.ts`, `panel.ts`, `panel-protocol.ts`, `panel-logic.ts` | El panel de cada bot: estado que se manda cada segundo (mapa, entidades) y las pocas órdenes que acepta (`pause`, `resume`, `farm`, `hunt`, `warp`). |

### La interfaz (`ui/src`, ~2.400 líneas)
`Simple.tsx` (lista de personajes, Conectar/Desconectar/Pausar, invasión, mensajes) + `MapOnly.tsx` (el radar de cada bot dentro de un
iframe) + `Radar.tsx` / `Tactical.tsx` / `radar-engine.ts` (el mapa 3D y táctico). Se compila con `bun run ui:build` a `estacion.html` y `panel.html`.

### Datos
ClickHouse local (`db/`): fotos cada 5 s (`ticks`), eventos (`golden_kill`, `walk_stuck`, `death`...). El bot **nunca depende** de la base:
sin ella usa valores neutros. `scripts/watch.ts` es un monitor de la flota por consola (marca ⚠ si un bot no avanza).

## 2. Un tick del bot (`farm-loop.ts`)
En orden; cada paso puede cortar el tick con `continue`:
1. **Ciego**: sin monstruos o sin exp 3 min → reconectar.
2. **Corte de trabas**: 15 s caminando sin moverse → suelta objetivo y campamento; si repite, vuelve a entrar al mapa.
3. Buffs propios, 4. **sobrevivir** (pociones), 5. pausa, PK (`/pkclear`), warp pedido.
6. **Compañeros**: party por cercanía (`help.ts`) y avisos de dorados.
7. **Cacería** (`hunt.ts`): arrancar / cortar / viajar al mapa de la invasión.
8. **Reset** al nivel 400 y reparto de puntos.
9. Spot: **esquina** de Arena 2 si el personaje la aguanta (`corner.ts`); si no, **ruta fija** por tramo (`route.ts`).
10. **Loot**. 11. **Elegir objetivo**: dorado a la vista (cazando, `huntPick`), esquina, o campamento por exp/s.
12. **Pelear** (skill de área / golpe) o caminar hacia el objetivo. 13. Sin objetivo: dorado recordado, campamento, explorar.

## 3. Cómo cooperan
- **Avisos**: al ver un dorado, el bot manda `askHelp('golden', mapa, x, y)`; la estación lo muestra en Mensajes y lo reparte; el compañero libre y capaz va a ese mapa recordando el punto.
- **Party**: si dos compañeros están a ≤ 20 tiles, el de más poder (`resets × 1000 + nivel`) invita al otro.
- **No se arrastran**: cada uno sigue su mejor spot. Acompañar al débil costaba ~35× la exp del fuerte (medido).

## 4. Decisiones que importan (y por qué)
- **Esquina de Arena 2**: ~300-550M exp/min contra ~15M en Devias y ~50M en Arena 3/4. Solo la usa quien `farmMiddleware` deja (`profile.corner`).
- **Personaje "limitado"** (stats por detrás del nivel, ej. Zamu): no entra a la esquina; la ruta elige mapa por exp medida. Esa rama **prueba mapas sin medir de arriba a abajo** y una muerte lo descarta 10 min: es el punto débil actual.
- **Cacería**: sale desde nivel 300 (150 para un limitado, que solo avisa y ataca lo que aguanta). La guarda de poder (`weak`) frena al recién reseteado.
- **Ritmos humanos**: no bajarlos (ver AGENTS.md, Anti-cheat).

## 5. Dónde tocar para mejorar un bot
| Quiero… | Toco |
|---|---|
| Que cace mejor dorados | `hunt.ts` (elección de mapa: `pickHuntMap` en `panel-logic.ts`; recorrido: `huntWander`) |
| Mejor spot / ruta de farmeo | `corner.ts`, `route.ts` (`chooseFixedRoute` en `learning.ts`), `farm-middleware.ts` |
| Que un personaje frágil no muera | `farm-middleware.ts` / `power.ts` (qué mapas aguanta) y `progress.ts` (reparto de puntos) |
| Pelear más rápido | `combat.ts`, y el bloque "pelear" de `farm-loop.ts` |
| Menos trabas | `loop-ctx.ts` (`walkTowards`), `path.ts`, corte de 15 s en `farm-loop.ts` |
| Nueva forma de cooperar | `help.ts` / `team.ts` (+ el feed en `estacion.ts`) |
| Medir si algo mejoró | ClickHouse: `ticks.exp_min_1m` por mapa, `events` (`golden_kill`, `death`, `walk_stuck`) y `scripts/watch.ts` |

## 6. Qué se quitó (sigue en el tag `pre-cerebro` y en git)
Agente del navegador, tests, escuadras con misiones y crianza, director, exploradores, esquina con rivales y lados, defensa contra jugadores,
observadores de otros jugadores, comercio y tiendas, baúl y equipamiento, vigía de 4 min, ayuda "voy a tu mapa", y toda la interfaz grande (Flota,
Estrategias, Dorados, Ranking, Consola, Panel completo).
