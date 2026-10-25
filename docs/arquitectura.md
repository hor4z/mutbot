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
| `help.ts` | Party: invita el más fuerte (por stats); si pasan 40 s sin party invita también el más débil (los roles se invierten con los resets). Reintenta rápido (15 s x4) y acepta resolviendo el nombre al responder. |
| `bus.ts` | Canal directo entre bots (UDP): posiciones, avisos de dorado y la orden del orquestador. |
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

## 3. Cómo cooperan (canal directo + orquestador)
- **Canal directo entre bots (`bus.ts`, UDP en loopback):** cada bot escucha en su puerto (`puerto de su panel + 300`) y manda a los
  demás su posición 4 veces por segundo y, al instante, cada dorado que ve. Sin servidor en el medio ni consulta periódica
  (latencia de milisegundos). La estación escucha en el 9090 solo para mostrar los avisos en Mensajes.
  El aviso lleva la marca `dragon` (Golden Dragon y Dragón Rojo): a un dragón van todos los que cazan o farmean (dejan incluso otra cacería, sin filtro de nivel ni de "limitado") y el aviso se repite cada 30 s mientras dura la pelea. Los dorados comunes los atiende el libre y fuerte.
- **Rastrillaje coordinado (`crew.ts`, `hunt.ts`, `HuntExplorer.setCrew/markSeen`):** los que cazan en el mismo mapa (modo `hunt` en el canal) se reparten el mapa en franjas contiguas, ordenados por nombre (sin ponerse de acuerdo); cada uno barre primero la suya y después ayuda en las otras. Lo que pisa un compañero cuenta como visto, y un dorado común que otro tiene más cerca (<= 6 tiles) se lo deja. Medido el 24/10 (ClickHouse): sin reparto, los pares cazaban a < 15 tiles entre sí el 60-73 % del tiempo.
- **Orquestador (en `estacion.ts`, cada segundo):** el más fuerte de los conectados (suma de stats: fuerza+agilidad+vida+energía) es el **líder**; los que
  tienen menos de la mitad de su fuerza (el nivel y los resets no cuentan) son su **sombra**; con una fuerza parecida cooperan, salvo los que el usuario apague (casilla "Sombra de X"). Manda a cada uno por
  el canal `{l: a quién sigue, s: quiénes lo siguen}`. El bot obedece mientras la orden llegue (3 s); si deja de llegar, vuelve a
  decidir solo.
- **La sombra (`place.ts`):** sigue al líder por todos los mapas, pero solo si él está en la esquina (nivel >= 100) o cazando. Va a
  la entrada de su mapa más cercana a él; se para a ~7 tiles, en el lado con menos monstruos, y pelea solo lo que se le acerca.
  En party cobra parte de cada kill: en la esquina rinde ~200M exp/min contra ~2M solo.
- **Recogida:** una Arena que la sombra no puede cruzar sola (Deathvim/Phantom/Gaint) la hace esperar en la entrada; el líder baja a
  buscarla (como mucho cada 3 min), se juntan y cruzan juntos.
- **Dorados:** al ver uno, el bot lo anuncia por el canal; el compañero libre y capaz va a ese mapa (`hunt.ts`).
- **Party:** el de más poder invita al compañero que tiene cerca (`help.ts`).
- **Mantener vivos (`keepAlive`, la estación):** los personajes "deseados" (los que conectó el usuario) se reconectan solos si caen
  (30 s, 1 min, 2 min... hasta 10) y se reinician si pasan 10 min sin sumar exp ni moverse.
- **Datos:** `bun --env-file=.env.db scripts/report.ts [minutos]` resume niveles, resets, exp/min por mapa (en party o solo), muertes y
  dorados. `bun run scripts/watch.ts` muestra la flota en consola cada 5 s.

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
| Nueva forma de cooperar | `bus.ts` / `help.ts` / `place.ts` y el orquestador en `estacion.ts` |
| Medir si algo mejoró | ClickHouse: `ticks.exp_min_1m` por mapa, `events` (`golden_kill`, `death`, `walk_stuck`) y `scripts/watch.ts` |

## 6. Qué se quitó (sigue en el tag `pre-cerebro` y en git)
Agente del navegador, tests, escuadras con misiones y crianza, director, exploradores, esquina con rivales y lados, defensa contra jugadores,
observadores de otros jugadores, comercio y tiendas, baúl y equipamiento, vigía de 4 min, ayuda "voy a tu mapa", y toda la interfaz grande (Flota,
Estrategias, Dorados, Ranking, Consola, Panel completo).
