# mubot

Bot de MU sin navegador: hace que un personaje **progrese solo** (pelea, sube de
nivel, reparte puntos, resetea, levanta cajas) hablando el protocolo real del
cliente 0.97d. Se maneja desde la estación (`bun run estacion`).

Este documento es la referencia del proyecto. `CLAUDE.md` lo apunta acá.

## Alcance y límites

Esto corre **solo contra la infraestructura propia del usuario**. Guardas en el código:

- `--allow-remote` es obligatorio para apuntar a hosts no locales. Sin eso, el
  bot se niega a arrancar si el proxy o el connect server no son loopback/RFC1918.
- Los ritmos son deliberadamente humanos y hay comentarios que lo explican.
  **No los bajes para "optimizar".** Ver "Anti-cheat" abajo.
- **Incidente real:** existía un modo de prueba que mandaba ráfagas de
  movimiento/ataque a velocidad máxima para auditar el anti-cheat, y una vez
  se corrió por error contra un host con jugadores reales. Ese modo **se
  eliminó**: el bot ahora siempre arranca el loop autónomo a ritmo humano.

Nunca flood, nunca brute force, nunca sesiones simultáneas de la misma cuenta.

## Comandos

```bash
bun install
bun run test        # tests offline (no tocan el server): packet, learning, explore, farming, camp, corner, early, golden, defense, panel, estacion
bun run tsc         # typecheck (tiene que dar limpio)
bun run estacion    # la estación: http://127.0.0.1:8787/panel (ver "Estación")
bun run proxy       # proxy WebSocket -> TCP (127.0.0.1:3000; PORT/HOSTNAME para cambiarlo)
bun run bot         # un bot suelto: credenciales por .env (MUBOT_USER/PASS/CHAR)
bun run agent       # el agente del navegador archivado (browser/serve-agent.ts, 8788)
```

Flags del bot: ver la cabecera de `headless-bot.ts` (conexión, `--auto-seconds 0` = sin límite con
reconexión y backoff, `--reset-level`, `--build`, `--stat-batch`, `--heal-at`, `--skills`, `--spots`,
`--ws-port`, `--decision-log`, `--exit-if-in-use`, `--list-chars`). **Un flag desconocido corta al arrancar con
código 2**: antes el bot arrancaba con defaults y se colgaba esperando `LoginResponse`.

`--exit-if-in-use`: si en el primer login la cuenta ya está conectada (la pestaña del navegador),
sale con código 3 en vez de reintentar. Un login rechazado que no se arregla reintentando sale con código 4 (cuenta bloqueada) o 5 (clave, cuenta o versión mal), y el personaje nuevo que el server no deja crear con código 6; la estación lo muestra y no lo reconecta. Después de un corte sí reintenta (el server tarda en soltar
la sesión vieja del propio bot). Lo pasa la estación.

## Estructura

| Archivo | Qué es |
|---|---|
| `headless-bot.ts` | Entrada del bot (lo que lanza la estación): flags en la cabecera, panel, keepalives, `main`/`session` con reconexión y backoff, señales. |
| `config.ts` | Flags (los desconocidos cortan con código 2), guard de "solo local" y ritmos humanos. |
| `state.ts` | Estado compartido, un objeto por dueño: `world` (lo que dicen los packets), `bot` (spot, modo, cacería, órdenes del panel), `learned` (lo que se guarda en `learning.json`); tablas de monstruos. |
| `connection.ts` | Sockets CS/GS, cifrado de salida (xor32 del 0.97d + SimpleModulus), `waitFor`, login, `LoginError`. |
| `world.ts` | Parsers a mano del 0.97d (CharacterList, CharacterInformation, skills, NPCs, jugadores), `trackWorld` y la entrada al mundo (`selectCharacter`). |
| `actions.ts` | Packets de salida armados a mano: paso, golpe, skills, ping/eco, warp, chat. |
| `combat.ts` | Tabla de skills, área o directo, alcance de cast, `pickAttackSkill`/`useSkill`, pociones. |
| `loot.ts` | Drops en scope y `lootStep` (levantar lo valioso). |
| `route.ts` | Warps de farmeo, `warpAndWait`, ruta fija (`maybeChangeSpot`), cargar/guardar lo aprendido. |
| `progress.ts` | Reparto de puntos (`/add`) y `/reset` encadenado. |
| `events.ts` | Aperturas de eventos (0x91), invasión dorada (0xFD), CharacterResets. |
| `journal.ts` | Diario de acciones (`journal()`) y log al panel. |
| `panel.ts` | Modo, órdenes del panel, estado que se manda cada 1 s, señales de dorados. |
| `farm-loop.ts` | El loop autónomo (`autonomousLoop`): prioridades de cada tick. |
| `corner-step.ts` | Un tick en la esquina de Arena 2 (`cornerStep`): lados por exp medida, aggro, buff, esquina llena. |
| `early-step.ts` | El arranque en el loop (`EarlyPlanner`): Lorencia al Lich, Devias 4 con campamento y correa. |
| `chat.ts` | Chat: lo que llega va al panel (`chat`) y la orden `say` lo manda (un mensaje cada 2 s). |
| `loop-ctx.ts` | Estado de una corrida del loop (objetivo, fase, último cast) y caminar/castear en el camino. |
| `util.ts` | `log`, `sleep`, bytes y las 8 direcciones. |
| `corner.ts` | La esquina de Arena 2 y sus lados (esquina/medio/este por exp medida) (lógica pura, port de `browser/corner.js`). Tests en `corner-tests.ts`. |
| `duo.ts` | Dúo de crianza: reparto de exp de OpenMU (`baseExp`, `partyGain`), padrino/protegido por stats y dónde se para el protegido (lógica pura). Tests en `duo-tests.ts`. |
| `power.ts` | ¿Puede el personaje con este monstruo? Daño y defensa con sus stats reales y la clase contra vida/daño/defensa de `monsters.json`: lo mata en <= 6 s perdiendo <= 35 % de la vida. Decide qué ataca y a qué campo va un personaje nuevo, y si va por un dorado. Tests en `early-tests.ts`. |
| `equip.ts` | Equiparse con lo que levanta (personaje nuevo). Tests en `equip-tests.ts`. |
| `early.ts` | El arranque hasta el 100: farmeo inicial del nivel 1 al 9, salida variada de Lorencia al Lich, campamento de Devias 4, objetivos con correa. Tests en `early-tests.ts`. |
| `golden.ts` | Regla fuerte de dorados (dragones primero, 2 min y se deja, 15 s para las cajas). Tests en `golden-tests.ts`. |
| `defense.ts` | Defensa propia contra jugadores (port de `browser/defense.js`). Tests en `defense-tests.ts`. |
| `camp.ts` | Campamentos (lógica pura): correa, primer campamento por mapa, mudanzas, pelea en el camino, memoria, hambre, skill de área. |
| `explore.ts` | Exploración (lógica pura): filtro de monstruos, spots calientes, salidas del pueblo, mapa seco. |
| `farming.ts` | Exp por segundo (lógica pura): valor y elección de objetivo, exp/segundos por tipo, loot, ciclos, autoevaluación. |
| `learning.ts` | Ruta fija por tramo (`chooseFixedRoute`), spots secos y lo que se guarda en `~/.mubot/learning.json`. |
| `protocol097.ts` | Bytes del 0.97d sin estado: ítems de 5 o 6 bytes, daño 0x15, chat (leer y armar; susurro 0x02, party `~`, guild `@`, ServerMessage 0x0D), aggro (0x18/0x19), party, ItemDropRemoved, backoff. |
| `terrain.ts` | Terreno del `.att` del cliente: caminable, zona segura. |
| `estacion.ts` / `estacion.html` / `estacion-logic.ts` | La estación (ver "Estación"). |
| `ui/` | La interfaz (React + Vite, radar Three.js). **`panel.html` y `estacion.html` se generan** con `bun run ui:build`: editar `ui/src`, no los HTML. Ver `ui/README.md`. |
| `radar-assets.ts` | Sirve los archivos del radar (`/radar-assets/...`, solo lectura, nombres de la lista; CORS solo para la estación y los puertos de los bots). Los archivos (`assets/radar/`, 91 MB del cliente) no van al repo: `bun run ui:maps`. |
| `ws-server.ts` | Server del panel de cada bot detrás de `--ws-port` (solo 127.0.0.1). |
| `panel.html` / `panel-protocol.ts` / `panel-logic.ts` | El panel del bot, su contrato y la lógica pura (0x91, 0xFD, tickets, ciclos, cacería, señales de dorados). |
| `*-tests.ts` | Tests offline de cada módulo (sin red, reloj simulado, dir temporal). |
| `browser/` | El agente que jugaba dentro de la pestaña (archivado, ver `browser/README.md`). **Es la referencia de las reglas**: sus comentarios explican cada decisión aprendida jugando. |
| `proxy.ts` | Proxy WebSocket -> TCP (copia de `proxy/main.ts` del cliente MU JS). |
| `net/` | Socket, cifrado (xor3, xor32, SimpleModulus), helpers de bytes y event bus. |
| `packets/` | Subconjunto de las clases de packets + `routes.ts`. **Generado**, no editar. |
| `data/` | `items.json`, `monsters.json` y `skills.json` del cliente. |
| `extract-packets.ts` | Regenera `packets/` (`bun run extract`). |

Un proceso es un personaje, así que los módulos del bot usan singletons. Lo que escriben varios
módulos va en `world`, `bot` o `learned` (`state.ts`): un `let` exportado no se puede asignar desde
otro módulo. Lo que solo toca un módulo queda privado ahí (cooldown de pociones, `statTry`, el
toggle del golpe). Sin imports circulares: `config`/`util` → `state` → `connection` → `actions` →
`combat`/`loot`/`route` → `world`/`progress`/`panel` → `farm-loop` → `headless-bot`.

### Proyecto independiente

El bot no depende en runtime del cliente MU JS (github.com/asosnovskiy, con el que
nació). `net/`, `packets/` y `data/` son copias de su `src/`:

- `net/utils.ts` y `net/encryption/` son copias **literales**. Una versión anterior
  tenía helpers "reescritos" con otra firma (`GetByteValue` con los argumentos
  invertidos, `ArrayCopy` distinto): el `Count` de `SkillListUpdate` daba siempre 0
  y el SimpleModulus se rompía. No se notaba porque el bot todavía importaba de
  `../src/`. No reescribirlos. Única excepción: `Counter.Increase()` de
  `simpleModulus.ts` vuelve a 0 después de 255 (`& 0xff`). Sin eso, desde el
  paquete C3 número 256 todos daban "can't decrypt packet" y el bot quedaba ciego
  a la exp, la vida y el respawn (2026-10-11).
- `net/socket.ts` resuelve los packets con la tabla completa de S2C del cliente
  (`packets/routes.ts`) y el mismo `find` que su `createSocket`, así que los
  nombres de evento son idénticos (varias trampas de abajo dependen de eso).
- Para regenerar `packets/` hace falta el cliente clonado:
  `MU_SRC=~/self/mu/src bun run extract` (por defecto busca `../mu/src`).

## Diario de acciones

Cada acción de alto nivel (viaje, reset, reparto de puntos, loot, órdenes del panel, cambios de
modo) pasa por `journal()`: va al panel (`decision`/`history`) y, con `--decision-log`, a un JSONL
(`appendFile`, no `Bun.write`, que sobrescribía). Ya no hay "capa de decisión" que pida permiso:
siempre aprobaba y nadie la usaba.

## Lo que aprende y guarda

`~/.mubot/learning.json` (`--learn-file`), por personaje, escritura atómica (tmp + rename) y
tolerante a archivo corrupto: memoria de campamentos, exp y segundos de kill por tipo de monstruo,
spots calientes, registro de tramos por ciclo y la referencia de exp/min por tramo del "hambre". Se
guarda cada ~2 min, al cambiar de spot, al morir y al terminar. Las "samples" del elegidor de spots
viejo (UCB1, `--free-route`) se ignoran al leer: esa lógica se sacó, la ruta es fija.

## Farmeo por exp/segundo (`farming.ts`, port del agente web)

El agente que juega dentro del cliente web (`browser-agent.js`) sube de nivel
mucho más rápido que el bot headless. Su lógica de decisión está portada a
`farming.ts` (pura, testeada en `farming-tests.ts`) y enganchada en
`autonomousLoop` (`farm-loop.ts`):

- **Objetivo por EXP POR SEGUNDO, no por cercanía** (`targetRate`; el bot lo
  usa a través de los campamentos de `camp.ts`, `pickTarget` queda para tests):
  `valor = (exp(tipo) + densidad) / (seg_kill(tipo) + distancia × 0.4)
  × 0.7^(jugadores a ≤ 5 tiles del objetivo)` (penalización 0.3 por jugador,
  `competitionPenalty` del agente web). Densidad: cada otro monstruo a
  ≤ 3 tiles suma la mitad de su valor (Twisting Slash es de área). Los que se
  estiman en > 8 s se descartan si hay alguno más rápido. Solo se miran
  monstruos a < 28 tiles. El objetivo se mantiene hasta que muere o sale del
  scope (o queda inalcanzable).
- **Aprende por tipo de monstruo** (`MonsterTypeStats`, EMA 0.7/0.3):
  - **exp por kill**, de `ExperienceGained` (C3 `0x16`): `KilledObjectId` u16
    BE @3, `AddedExperience` u16 BE @5, `DamageOfLastHit` @7. Como
    `AddedExperience` es u16, **un kill grande llega partido en tramos de
    65535** con el mismo id: los que llegan en < 1.5 s se **suman** y el EMA
    se calcula sobre la suma (`ExpSplitTracker`). Al llegar el evento el
    monstruo ya salió del scope: el tipo sale del registro id → {tipo,
    posición, mapa} que se llena en `AddNpcsToScope` y `ObjectWalked075`.
  - **segundos hasta matarlo**: desde que se elige el objetivo hasta
    `ObjectGotKilled` con nosotros como killer (incluye caminar hasta él, igual
    que el agente web). Fuera de (0, 60) s no se aprende.
- **Sin datos de un tipo:** exp ≈ √vidaMax × mediana(exp/√vida de los tipos
  medidos) (en MU la exp va con el nivel del monstruo, que crece mucho más
  lento que su vida: con monstruos más débiles se sube más rápido); segundos ≈
  vida / mediana(vida/segundos) × 1.4. **La vida máxima no llega en el
  protocolo headless** (el cliente web la lee de su `attributeSystem`): sale de
  `data/monsters.json` (`HP` por `Numb`, `MONSTER_MAX_HP`). Para los custom
  ≥ 300 (sin fila) se usa la mediana de la exp medida y 3 s.
- **Jugadores en scope** (`world.players`) para la penalización: se leen de
  `AddCharactersToScope` (C2 `0x12`) con el layout 0.95d del XML de OpenMU
  (count @4, `CharacterData` de 31 bytes; 27 en 0.75), solo id BE@0 y X/Y
  @2/@3; el stride se deduce del largo y si no cierra se ignora el packet. Se
  actualizan con `ObjectWalked075`/`ObjectMoved` y se borran con
  `MapObjectOutOfScope` y al cambiar de mapa. **Sin verificar en vivo.**
- **Autoevaluación** (`SelfReport`, sobre el `ExpLog` por segundo) cada 5 min en consola: nivel, resets, kills,
  exp/min en 5 y 30 min (ventana real: con 2 min de registro divide por 2), % del tiempo peleando/caminando/esperando/otro, y
  duración de cada ciclo de reset. También al terminar cada reset y al final.
  El tiempo de cada iteración del loop se le atribuye a su fase (pelear =
  hay objetivo, caminar/esperar = explorador, otro = pociones, stats, venta,
  warp, reset).
- `MUBOT_DEBUG_COMBAT=1` además loguea cada objetivo elegido con su exp/s
  estimada y cuántos jugadores tiene cerca.

### Reset encadenado

A `--reset-level` (400): reparte los puntos con `/add` (`planStats` por
defecto, ver "Port del agente web"), warp a Lorencia, `/reset`, vuelve a elegir el
personaje, reparte los puntos nuevos y sigue. Los spots calientes y lo
aprendido por tipo de monstruo se conservan; el rendimiento por mapa
(`routeScores`) y el tier visto se vuelven a medir desde Lorencia. Con
`--auto-seconds 0` lo repite indefinidamente.

**Sin verificar en vivo desde el headless:** todo este bloque (elección por
exp/s, exp partida, jugadores en scope, ruta de spots con Arena 1-4, reset
encadenado). La lógica viene del agente web, que sí juega con el usuario, y
está testeada offline.

## Port del agente web

Lo que el agente web aprendió jugando con el usuario, portado al headless con
tests offline. **Nada de esto se corrió todavía contra el server desde el
headless** (la cuenta estaba jugando en el navegador); ver "Qué falta verificar
en vivo" al final de la sección.

1. **Registro de exp por segundo** (`ExpLog`, `farming.ts`). Los kills grandes
   llegan partidos en tramos de 65535 (~60 `ExperienceGained` por kill). Un
   registro por evento con tope fijo cubría ~30 s y toda medición de 1-3 min
   salía truncada. Ahora hay un bucket por segundo (6 h de tope) y todas las
   mediciones por ventana salen de ahí y dividen por la ventana REAL cubierta:
   informe (`SelfReport`), campamentos (exp/min desde que llegó), memoria de
   campamentos y hambre. `SpotMeter`/`routeScores` (`learning.ts`) y la estadía
   en el spot (`stayExp`) ya eran sumas acumuladas con su duración real: no
   truncaban.
2. **Ruta fija por tramo** (`chooseFixedRoute`, `learning.ts`): Lorencia (warp
   2) solo < 20; Devias 3/4/2 (6, 7, 5) de 20 a 99; Arena 2 (24) ≥ 100; Arena 3
   (25) ≥ 200; Arena 4 (26) ≥ 300. Devias 1 (4) nunca; Arena 1 (1) solo como
   plan B si todas las Devias están llenas de gente (nivel 50-99; una entrada
   llena no se vuelve a probar en 5 min). Cambia de mapa solo al cruzar un
   tramo, con el mapa vacío 90 s o por competencia que bajó la exp (campamentos
   abandonados por gente, o hambre). Si el bot entra al mundo ya parado en el
   mapa del tramo, lo **adopta sin warpear** (`adopt`); tras morir vuelve a
   warpear a la misma entrada (`prefer`). Desde el 100 manda la esquina de Arena 2 (`corner.ts`).
3. **Correa en Devias** (`CampManager.leashFor`): los 4 Devias son el mismo mapa
   (2). Tras cada `MapChanged075` (y al entrar al mundo) se registra la
   llegada; en el mapa 2, campamentos, objetivos, spots calientes, memoria y
   exploración solo a ≤ 25 tiles de ella (las salidas del explorador se ponen
   alrededor de la llegada, empezando "arriba"). Spot inicial: 12 tiles
   "arriba" de la llegada (−x, +y). Recién llegado (3 s) no elige campamento,
   solo pelea a ≤ 6; el loop está bloqueado durante el warp, así que no puede
   elegir campamento con monstruos del mapa anterior.
4. **Arenas (83/84/85)**: al llegar va a la "zona de abajo". El headless **no
   tiene grilla de caminables**: los `.att` de estos mapas custom no están en
   `~/self/mu/public/game-assets` (solo World1-11, 34, 52), y bajarlos del host
   es red. Queda `downZone()` portado y testeado (recibe un `isWalkable`) y, como
   default por mapa (`DOWN_ZONE_DEFAULT`), lo que dio el agente web en vivo:
   **(91,13)** en Arena 3 y 4; Arena 2 asume lo mismo (SIN VERIFICAR). Para
   tener la grilla: bajar `EncTerrain83.att`/`84`/`85` del host (game-assets
   v097d) y parsearlo como `src/common/terrain/parseTerrainAttribute.ts` del
   cliente (XOR de mapa + BUX, 256×256); con eso `downZone` reemplaza al default.
5. **Campamentos** (`camp.ts`): elegir un centro (más exp/s a ≤ 10, penalizado
   0.3 por jugador y por distancia), pelear solo a ≤ 10, quedarse mientras
   rinda. La vara del mapa es el **promedio móvil** (0.7/0.3) de lo que
   rindieron sus campamentos, no el máximo. Mudarse si tras 90 s rinde < 50% de
   la vara, si está vacío 12 s (el reloj corre solo desde que llegó), o por
   competencia (≥ 3 jugadores 20 s **y** exp < 70% de la vara). Un campamento
   al que no llega en 60 s (sin contar lo peleado en el camino) se abandona.
6. **En el camino**: pelea con lo que esté a ≤ 8; si hay ≥ 3 monstruos juntos a
   ≤ 8, acampa ahí. **Skill de área con cualquier monstruo a ≤ 3**, también
   caminando (`castCandidate`): respeta `SKILL_PACE_MS` entre casts y no frena
   la caminata (el paso sale en la misma iteración). Con < 15% de maná no.
7. **Memoria de campamentos** (`CampMemory`, en `learning.json` → `camps`):
   posición + exp/min real desde que llegó + nivel + n (EMA 0.6/0.4 si es el
   mismo a ≤ 4 tiles; estadías < 45 s no cuentan). Al llegar a un mapa va
   primero al mejor aprendido a ±60 niveles; sin campamento, al mejor conocido
   a ≤ 40 tiles. Las reglas fijas (cripta (132,200), "arriba", zona de abajo)
   solo si no conoce nada.
8. **Curiosidad**: tipos con < 3 kills medidos a ≤ 8 se atacan primero.
9. **Skill**: Twisting Slash (41) primero en `DEFAULT_ATTACK_SKILLS`; Rageful
   Blow (42) fuera del pool (el usuario lo descartó: lento).
10. **Stats** (`planStats`): energía hasta fuerza − 2000, después mitad/mitad;
    5% vitalidad. Usa fuerza/energía reales de `CharacterInformation`. Se
    reparte de a 200 puntos (`--stat-batch`). `--build` sigue como override.
11. **Party**: `PartyRequest` (C1 05 40, id BE en el byte 3) se rechaza siempre
    con `C1 06 41 00 <id BE>` tras 0.6-1.5 s.
12. **Loot valioso** (`isValuableDrop`): siempre cajas 14/11 (primero, aunque otra cosa esté hasta 8
    tiles más cerca), **Cristales 14/31** (la moneda del Mercado del server y del Alquimista) y
    talismanes 14/7, 14/12 y 14/20; con 12 casillas libres o más, los excelentes (6 bits bajos del byte
    3 del ItemData; se cristalizan). Las joyas no (no valen nada para comerciar). Con poco lugar avisa
    "Bolsa casi llena" cada 10 min.
    El zen, las pociones y el equipo común no (salvo personaje nuevo). Las cajas no se abren: lo hace
    el usuario. Camina hasta el drop (≤ 12 tiles) y a ≤ 1 pide el pickup cada 0,6 s mientras siga en el
    piso (8 s; 20 s una caja): el server no deja levantar cajas, excelentes ni cristales los primeros 2 s
    ("The item is still falling") y los sortea. `ItemDropRemoved` (C2 21) o el ítem agregado lo sacan
    del registro.
13. **Registro de tramos por ciclo** (`CycleLog`, en `learning.json` →
    `cycles`, con el ciclo en curso para retomarlo): minuto al llegar a
    20/50/100/200/300/350/400. El informe muestra los últimos ciclos y la
    **proyección resets/día** (1440 / promedio de los últimos 5). Solo cierran
    los ciclos que llegaron al 400.
14. **Reconexión** (`main`/`session` en `headless-bot.ts`, `Backoff` en `protocol097.ts`): si se corta
    la conexión (kick, red, timeout) vuelve a conectar con backoff 5 s → 5 min
    (vuelve a 5 s tras una sesión > 5 min; ≥ 60 s si la cuenta figura
    conectada). Nunca dos sesiones: reconecta con la anterior cerrada. Login con
    contraseña/cuenta/versión inválida = no reintenta. Retoma desde el estado
    real: elegir personaje → nivel/mapa/puntos de `CharacterInformation` → la
    ruta adopta el mapa o warpea, y a 400 resetea. Los handlers del EventBus se
    registran una sola vez y `sendToGS` no manda nada con el socket cerrado.
15. **Hambre** (`Hunger`, `camp.ts`; apagada en el arranque, ver "Reglas del farmeo"): si en los últimos 45 s la exp/min es < 25%
    de la referencia del tramo (promedio móvil 0.95/0.05 por tier, a lo sumo una
    actualización por segundo, sin contar el primer minuto tras un warp; se
    persiste como `tierRef`) —o < 5M/min sin referencia— y hay ≥ 1 jugador a
    ≤ 12 tiles, cambia YA de entrada (Devias 3/4/2) o de mapa, sin esperar a las
    reglas del campamento. Si no hay a dónde (Arenas), al menos cambia de
    campamento. Pasó en vivo: 2M exp/min con un jugador a 1 tile y el agente no
    se movía.

**Qué falta verificar en vivo:** que `MapChanged075` llegue tras cada warp con la
posición de llegada (la correa depende de eso) y qué pasa al respawnear tras
morir; que `AddCharactersToScope` (layout 0.95d) traiga bien a los jugadores
(sin eso no hay competencia ni hambre); que el skill de área a 2-3 tiles pegue
de verdad y que castear y caminar en la misma iteración no dispare el
anti-cheat; que (91,13) sirva en Arena 2; que levantar a ≤ 1 tile alcance para
el server; los layouts de `PartyRequest`/`ItemDropRemoved` y el byte de
excelentes en drops; la reconexión con la sesión vieja todavía abierta del
lado server; y que el bot no se trabe caminando contra muros hacia un
campamento sin grilla de caminables (lo corta el plazo de 60 s).

## Combate: historia de tres bugs

> **Estado actual:** el tercero ("el golpe no hace nada") quedó resuelto por la
> captura de "Protocolo real" de abajo: el golpe sale como `C1 07 15`, no
> `0x11`, y `sendHit()` ya lo manda así. Lo que sigue se conserva como
> historia del diagnóstico.

Todo esto se encontró jugando de verdad con la cuenta `horaz` (nivel 48,
personaje con stats altos — no es un problema de nivel/daño insuficiente).

**Arreglado 1 — posición de NPC congelada:** `ObjectWalked075` solo
actualizaba `world.x/y` del JUGADOR, nunca la posición de los monstruos ya
detectados. Un monstruo detectado quedaba con su posición inicial para
siempre aunque caminara, así que el bot perseguía un fantasma y rara vez
llegaba a distancia de golpe. Arreglado: el mismo handler ahora también
actualiza `world.npcs` para cualquier NPC ya trackeado. También se agregó un
handler para `ObjectMoved` (0x15, "se movió instantáneamente") con el mismo
propósito, pero **deliberadamente sin tocar la posición del jugador** — un
intento de usarlo también para el jugador rompió la posición (quedó en
`(0,0)` al final de una corrida) y no se investigó más a fondo por qué.

**Arreglado 2 — IDs de NPC sin enmascarar:** `n.Id` de `AddNpcsToScope095`
viene con el bit alto puesto (ej. `33356`), pero el resto del código siempre
usa `& 0x7fff` para los IDs (jugador, `ObjectGotKilled`, etc.). Faltaba acá:
`npcs.set(n.Id, ...)` guardaba el ID crudo, así que `HitRequest.TargetId`
mandaba un ID que el server no podía resolver (`currentMap.GetObject` no lo
encuentra, confirmado en `HitHandlerPlugInBase.cs` de OpenMU) y además
`onRemove` nunca lograba borrar esos NPCs del mapa (comparaba contra una
clave que nunca existía). Arreglado enmascarando al guardar. **Verificado
contra un cliente de referencia real** (`github.com/xulek/MuOnlineConsoleClient`,
construido sobre la misma librería `MUnique.OpenMU.Network`): hace exactamente
el mismo enmascarado.

**Sin resolver — el golpe no hace nada:** con los dos bugs de arriba
arreglados, el bot llega a distancia de golpe y manda `HitRequest`
repetidamente (confirmado con `MUBOT_DEBUG_COMBAT`), pero **nunca** llega
`ObjectHit` de respuesta ni `ObjectGotKilled`, en ninguna corrida. Se
descartaron, con evidencia real:
- **Cifrado:** `HitRequest` es C1Header (solo xor32, nunca SimpleModulus,
  igual que `WalkRequest075`, que sí funciona) — no es un problema de capa de
  cifrado.
- **Layout del packet:** coincide exacto con el XML y con el cliente de
  referencia (`TargetId`@3 BE uint16, `AttackAnimation`@5,
  `LookingDirection`@6, longitud 7).
- **IDs:** ya enmascarados (ver arriba).
- **Captura real:** se interceptó `WebSocket.prototype.send` en el navegador
  del usuario mientras atacaba de verdad (y sí le bajaba la vida al
  monstruo). **El código `0x11` (HitRequest) nunca apareció** en ningún
  packet C1 capturado — el cliente real no usa este packet para pegar.
- **Alternativa probada por descarte, no por éxito:** `TargetedSkill075`
  (C1, código `0x19`) también requiere que el skill exista en la lista de
  skills del personaje (`GetSkillByIndex` devuelve null si no, y el server no
  contesta nada — confirmado en `TargetedSkillHandlerPlugIn075.cs`). El bot
  **no trackea ningún skill conocido** para este personaje de nivel 48
  (`world.skills` vacío, "Skills conocidos: ninguno" en cada corrida), lo cual
  en sí mismo es sospechoso — puede ser el mismo tipo de bug que ya se
  encontró en `SkillAdded`, no confirmado todavía.
- **No se pudo descifrar el tráfico C3** de la captura real para ver qué
  manda el cliente real en los packets encriptados (candidatos: `TargetedSkill`
  095, o algo custom de este server): `SimpleModulusDecryptor.DefaultClientKey`
  no es la clave real de este server (igual que el xor32 de login, este
  server tiene su propia clave para el canal C3/C4, todavía no identificada).

**Próximo paso sugerido, no intentado:** arreglar el tracking de
`world.skills` primero (ver por qué un personaje nivel 48 no tiene ninguno
trackeado) — si eso revela skills reales, `useSkill()` ya tiene la lógica
para usarlos vía `TargetedSkill095Packet`, y quedaría resuelto sin tocar
`HitRequest` más.

## Protocolo real, capturado del cliente web (2026-10-10)

Capturado enganchando `__store.sendToGS` del cliente web (antes de cifrar) mientras
el usuario jugaba con `Horaz`. El cliente declara su backend en el perfil `v097d`
(`index-*.js`): **OpenMU con inicializador `Version095d`** (`versionArg: "0.95d"`),
más un adaptador propio. El cliente arma packets season6 y **`adaptOutgoing` los
reescribe antes de mandarlos**. Por eso los parsers generados de `packets/` (season6)
mandan códigos equivocados aunque el layout coincida:

| Acción | El cliente arma | Sale por el cable |
|---|---|---|
| Golpe | `C1 11` | **`C1 07 15 <id BE> <anim 78/79 alternado> <dir>`** |
| Caminar | `C1 D4` | `C1 10` (mismo layout; dirs empaquetadas de a 2 por byte desde el 6, nibble bajo del 5 = pasos, alto = rotación = última dir) |
| Skill a objetivo | `C3 19 <num u16>` | `C3 06 19 <ÍNDICE en la lista> <id BE>` |
| Skill de área | `C3 1E <num u16> x y rot .. <id>` | `C3 07 1E <índice> x y rot`, o `C3 09 1E <índice> x y rot <id BE>` si hay objetivo |
| Area skill hit | `C3 DB` | `C3 .. 1D <índice> x y serial n <id BE>×n` |
| Gate | `C1 1C` (8 bytes) | `C1 06 1C ..` |

**Corrección:** la sección "Combate" decía que el cliente real nunca usa `0x11`.
Lo usa, pero su adaptador lo convierte en `0x15`. El bot mandaba `0x11` crudo: ese es
el motivo de las 0 kills, no el cifrado ni los IDs. Los skills van por **índice**, con
el mapa número→índice que llega en `SkillListUpdate075` (3 bytes por entrada:
índice, número, nivel). Los 5 skills de Horaz (22, 41, 42, 43, 47) tienen **nivel 0**,
así que `pickAttackSkill()` no debe filtrar por `level > 0`.

Otros packets que el cliente manda solo:
- Ping `C3 0C 0E 00 <TickCount LE u32> <AttackSpeed LE u16> 00 00` cada 5 s (el
  server lo usa para el detector de speed hack).
- Eco `C1 04 FB 02` cada 2 s (custom; el server contesta `PingRelay`).
- Warp por menú `C1 0A 8E 02 00 00 00 00 <índice LE u16>`. **Lorencia = 2.** Así
  viaja el cliente; no hace falta caminar a un portal (`EnterGate`).

Claves: las de SimpleModulus del cliente (`ze`/`_e`) son las mismas que
`DefaultClientKey` de `net/encryption/`. El xor32 es `XOR32_KEY_097D`.

### Reset y stats (capturado)

**Confirmado en vivo (2026-10-10, ciclo 4):** `/reset` se acepta desde Arena 4 (no hace
falta estar en Lorencia) y el server devuelve al personaje a Lorencia al volver a entrar.
El reset completo (comando → selección → volver al mundo) tarda ~7 s.

Todo por **chat** (`C1 len 00 <nombre 10 bytes> <texto>`):
- `/add <stat> <n>` reparte n puntos de una vez. Confirmados `str`, `ene` y `vit`
  (3000 puntos post-reset repartidos con 3 comandos); `agi` confirmado el 2026-10-10.
  **Tope por stat: 65535** ("Se ha alcanzado el máximo de 65535 Base Energy"). Con 15 resets Horaz
  tiene fuerza y energía al tope: `planStats` manda lo que no entra a agilidad y después a vitalidad.
  Antes repetía `/add str`/`/add ene` rechazados cada 3 s sin fin. El server contesta con un
  `CharacterInformation` completo (F3/03) y `CharacterResets` (`C1 06 FE 00 ..`).
- `/reset` exige **nivel 400**: probado en 300, el server contestó "El nivel necesario para el
  reset es 400." (2026-10-10). El agente ya no prueba niveles menores (`resetProbe: []`).
  La barra muestra `Resets: 15 · GR: 1`: hay **grand reset**, todavía sin investigar.
- `/reset` (el usuario lo hizo en nivel 400, en Lorencia, después de repartir puntos).
  El server descuenta zen y **devuelve al cliente a la selección de personaje**
  (`CharacterList`); hay que volver a elegir el personaje para entrar.

## Protocolo: trampas encontradas

Lo que sigue está **verificado contra el server real**, no inferido. Los packets
del cliente MU JS (`src/common/packets/`, de donde sale `packets/`) están generados desde los XML del cliente 1.xs y
en varios casos **no matchean** 0.97d. Por eso hay tests.

### Eventos que se emiten con otro nombre

| Se esperaba | Se emite realmente | Code |
|---|---|---|
| `SkillListUpdate` | `SkillAdded` | F3/11 |
| `ObjectWalked` | `ObjectWalked075` | 0x10 |
| `MapChanged` | `MapChanged075` | C3/0x1C |

Escuchar el nombre "correcto" = listener muerto y el bot cree estar ciego.
`SkillAdded` hay que desambiguar por `Count`: lista completa vs add vs remove.

**Incidente real (cuenta `melu`, personaje nivel 1, 0 skills):** el `SkillAdded`
de este caso llega más corto de lo que `getSkills()` asume (offset 6 + 4
bytes/entry) y `Count` no cae en `0xfe`/`0xff` ni matchea cuántas entries
caben en el buffer real. El parser generado leía fuera de rango y **tiraba
abajo el proceso entero** — no un dato corrupto, un crash total. Se arregló
clampeando `Count` al tamaño real del buffer en `readSkillsUpdate()`
(fail-safe: mejor perder esa actualización de skills que crashear). Sigue sin
saberse cuál es el layout correcto para este caso corto — eso queda pendiente,
solo se evitó el crash.

**Otro incidente real, mismo personaje, jugando de verdad (subiendo de
nivel):** `ItemsDropped` y `MoneyDropped075` comparten el código `C2/0x20`,
igual que el caso de `SkillAdded` arriba. `createSocket` solo tiene generado
`ItemsDroppedPacket` para ese código (sin `SubCode`), así que un drop de
dinero **siempre** llega disfrazado de `ItemsDropped`. `MoneyDropped075` es
un packet de 14 bytes fijos (`Id` BE@5, `X`@7, `Y`@8, nibble `MoneyNumber`/
`MoneyGroup`@9, `Amount` LE uint32@10 — confirmado contra el XML de OpenMU),
nada que ver con la lista de ítems de `ItemsDropped` (stride 16 bytes/ítem).
Leer un `ItemData` de 12 bytes de ahí tiraba el proceso entero. Se arregló
distinguiendo por tamaño de buffer en `parseDropsPacket()` (5+16·N para
ítems, 14 fijo para dinero) antes de elegir qué clase usar.

### Ítems de 6 bytes (desde 2026-10-23)

Con la Jewel of Harmony el server pasó de ítems de 5 a **6 bytes** en todos lados: drop de una caja de 15 bytes
(5 + 4 + 6), inventario de 6 + N·7, ítem agregado de 10 y mover ítem `C3 0D 24`. Los bytes 0-3 no cambian;
`e[4] & 0x10` es el bit 5 del número, `e[4] & 0x20` la opción 380 y `e[5]` la armonía (función `x` del
adaptador 0.97d del cliente). Con los parsers de 5 bytes el bot descartaba drops e inventario ("layout
inesperado") y dejó de levantar cajas sin otro aviso. `protocol097.ts` acepta 5, 6 y 12.

### Levantar drops y zen

- Levantar: **`C3 05 22 <id BE>`** (`sendPickup`, PickupItemRequest cifrado), como el cliente web. El
  bot mandaba `PickupItemRequest075` (C1 22) y el server lo ignoraba: nunca levantó nada.
- Respuesta: `C3 22 <casilla> <ítem 5 bytes>` (ítem al inventario), **`C3 08 22 FE <zen total u32 BE>`**
  (zen levantado: no llega InventoryMoneyUpdate) o `C3 04 22 FF` (no se pudo). El zen del suelo llega
  como ítem 14/15 en `ItemsDropped`.

### Mover ítems (equiparse)

`C3 0C 24 <depósito> <casilla> <ítem 5 bytes> <depósito> <casilla>` (adaptador del cliente web para el
0x24 de 19 bytes de season6; depósito 0 = inventario, equipo 0-11, bolsa 12-75). Respuesta `ItemMoved`
(C3 24): byte 3 = casilla nueva o 0xFF (no se pudo: requisitos, clase o lugar). `equip.ts` lo usa con
los 5 bytes crudos que ahora guarda el inventario (`raw`). **Probado en vivo** (Hume, 2026-10-12).

### Reaparición tras morir

`RespawnAfterDeath075` (C1 F3 04, 22 bytes en este server): X @4, Y @5, mapa @6. **No se manejaba**:
después de morir el bot seguía en la posición de la muerte, caminaba desde ahí y el panel quedaba
congelado (Hume, 2026-10-12). Ahora actualiza posición/mapa y cuenta como llegada (`onMapArrival`).

### Layouts que el parser generado rompe

- **CharacterList**: el XML define el "Extended" (34 bytes/char), pero 0.97d
  manda el chico (26 bytes/char, count en índice 4). El parser desborda. Por eso
  `world.ts` lo parsea a mano con `parseCharacterList097()`.
- **ServerListResponse (F4/06)** vs **ServerListResponseOld (F4/02)**: layouts
  distintos. F4/06 trae solo `ServerId` + `LoadPercentage`, **no trae dirección**,
  así que la dirección sale siempre de `--cs-host`. Este bug rompía el arranque
  entero contra el server real.
- **NpcItemSellResult.Money** es **little** endian.
- **InventoryMoneyUpdate.Money** es **big** endian.
  Parecidos y con endianness opuesta. Mezclarlos da basura silenciosa.
- **OpenNpcDialog.NpcNumber** es **little** endian uint16 en el índice 4.

### Lo que sí funciona con los parsers del repo

- Items: 12 bytes. `num = ItemData[0]`, `group = (ItemData[5] & 0xf0) >> 4`.
- Pociones curativas: group `14`, nums `1/2/3`.
- ~~`TargetedSkill095` (0x19) manda el **número** de skill~~: corregido por la
  captura real, sale por el cable con el **índice** en la lista (ver
  "Protocolo real, capturado del cliente web").
- Stats: `str=0`, `agi=1`, `vit=2`, `ene=3`.
- Cifrado: el cliente 0.97d tiene **su propio xor32 key**. Con el default de
  season6 el server no descifra el login y lo descarta **en silencio**.

## Economía

El bot **no compra ni vende** (pedido del usuario). Solo lleva el zen para el panel. El código de
merchants (venta de basura, compra de pociones, catálogo, descubrimiento) se sacó: la venta tenía un
bucle sin espera con más de 24 ítems y vendía las cajas (grupo 14).

## Anti-cheat

`SpeedHackDetectPlugIn`: delay base de ataque 450ms + token bucket de 5.

Ritmos actuales: caminata 380ms, ataque 500ms, skills 900ms, ventas 600ms.
**Son deliberados.** Bajarlos hace que el bot sea detectado.

**No tocar `SpeedHackDetectPlugIn` ni la configuración del server para que el bot
vaya más rápido.** El objetivo es saber si el server valida, no hacerlo pasar.

## Limitaciones y pendientes

Están en **[PLAN-SIN-NAVEGADOR.md](PLAN-SIN-NAVEGADOR.md)** (estado, lo aprendido y lo que falta
portar del agente del navegador). Las secciones de arriba sobre combate y protocolo son historia
de cómo se llegó acá: el código gana si difieren.

## Archivos externos

En `/tmp/opencode/OpenMU` (fuera de este repo) están las referencias de OpenMU
0.99b que se usaron para validar el flujo de venta:
`SellItemToNpcAction.cs`, `SellItemToNpcHandlerPlugIn.cs`, `TalkNpcAction.cs`,
`BotShoppingHandler.cs`, `Version075/Gates.cs`.

`BotShoppingHandler.cs` es **el bot nativo server-side de OpenMU** (MIT, sin
licencia, `BotConfiguration.Enabled`). Hace shopping, skills y navegación contra
el estado real del server, que es más confiable que cualquier reimplementación por
packet. Si en algún momento la UI deja de ser el requisito dominante, ese es el
camino corto. No se usa ahora porque no acepta control externo: las decisiones
quedan fijas en el C#.
## Reglas del farmeo (port del agente del navegador)

Lo que hacía rápido al agente del navegador, enganchado en `farm-loop.ts`:

- **Personaje débil por stats** (`isFreshChar`: < 3000 puntos en total, aunque tenga resets):
  - Reparte los puntos apenas los tiene, según la clase (`planFreshStats`: DK fuerza 55 %, agilidad 25 %, vitalidad 20 %).
  - Farmeo inicial en Lorencia hasta el 20 por campos (este: arañas/Budge; norte: Bull Fighter; oeste:
    Hound; sur: Lich), eligiendo campo y monstruos con `power.ts` (sus stats, no el nivel). Campamento
    estable: empate → el más cercano; se muda solo por un grupo de 3+.
  - No ataca dorados con los que no puede ni sale a cazar en las invasiones.
  - Levanta zen, pociones (14/0-3), joyas y, con lugar en la bolsa, equipo; se equipa solo lo mejor
    (`equip.ts`: lo intenta y si el server lo rechaza no lo vuelve a probar).
  - No se va de Lorencia (la ruta no lo mueve) hasta nivel 20 + 5.000 zen (warp a Devias 4: 2.500) +
    poder con el Lich (`readyToLeave`). Hume en el 27 con 0 zen intentaba el warp y volvía al Lich.
- **Selector de mapa por exp medida** (`farm-middleware.ts`): manda desde el nivel 100 para el personaje que no hace la esquina (el modelo de `power.ts` no le aprueba Drakan); el que la hace sigue con la ruta fija y la esquina. Opciones: Arena 4, 3, 2, 1 y las entradas de Devias que su nivel habilita. Cada spot guarda su exp/min neta (desde el warp, con la caminata, prueba de 150 s y una muestra por minuto en promedio móvil) junto con el nivel y la **potencia** (suma de stats); solo se compara lo medido a ±80 niveles y ±20 % de potencia (tras un grand reset la exp de antes no cuenta: Hume con 2 resets descartaba Arena 3 a 100M porque con 63 resets Arena 2 daba 261M, y terminaba en Arena 1 a 0,9M/min). Primero prueba las Arenas sin medir de arriba hacia abajo; Arena 1 y Devias solo si las Arenas medidas rinden < 40M. Después va a la que más rinde y se queda salvo que otra rinda 15 % más; una muerte saca el mapa 10 min y un mapa con el monstruo común imposible (modelo, Twisting Slash ~3×) no se prueba. `seedRouteFromDb` (`route.ts`) siembra los puntajes con los ticks de ClickHouse del mismo personaje (resets ±3, nivel ±80, 3 días), así no repite la gira en cada conexión. El plan B de Arena 1 de la ruta fija mira el nivel real, no el de la ruta. En `camp.ts` ese mismo personaje (`setPower(..., strict)`) solo usa campamentos medidos con su potencia y **explora** los grupos densos de monstruos (celdas de 12 con >= 4, densidad vista en vivo y de la base de todos los personajes, una vez cada 20 min) en vez de quedarse junto a la llegada; lo que mide queda en la memoria con su potencia. Además, una caída de la EXP reciente respecto al promedio del campamento obliga a buscar otro grupo visible; un campamento **planeado** (memoria, exploración, zona medida o zona de abajo) no se cambia en camino por 3 monstruos juntos. `seedCampsFromDb` carga los campamentos de Arena 3/4 medidos en ClickHouse (celda 8×8, tramo de 50 niveles, >= 2 min). Un warp fijado desde el panel sigue mandando.
- **Variación humana sin perder ROI**: entre objetivos o centros de campamento a ≥ 95 % del mejor valor estimado, `camp.ts` sortea uno; mantiene el objetivo hasta que muere para no zigzaguear. La estación inyecta `Math.random`; los tests usan un generador fijo. `humanPace()` agrega hasta 12 % de variación a pasos, golpes y skills sin bajar nunca `WALK_PACE_MS`, `ATTACK_PACE_MS` ni `SKILL_PACE_MS`.
- **Arena 4 con poca vida (dato del 2026-10-18)**: Hume murió tres veces cerca de (85,14–22), mientras la zona (84,48) sostuvo ~127M/min desde nivel 360 y >200M/min desde 380. Cuando un personaje con <5000 HP ya tiene potencia para salir de la entrada, va primero a (84,48). Un campamento propio aprendido manda antes; uno sin potencia suficiente sigue buscando cerca de la llegada.
- **Presencia de otros jugadores sin lista de nombres** (`observer.ts`): registra a cualquiera que permanezca quieto a ≤16 tiles durante 30 s o acompañe al bot durante 45 s. No concluye que sea un guardia ni usa el ranking como prueba. A lo sumo cada 2 min prueba otra entrada de Devias o cambia de campamento; en Arena 2 suspende la esquina 3 min. **Solo para personajes limitados**: con stats completos lo cubre el hambre (en el MU casi siempre hay alguien quieto cerca; sacaba a Hume de la esquina 8-19 veces por hora). En Lorencia, para un personaje débil (`isFreshChar`; con stats completos va al Lich igual), si un jugador está a ≤ 10 del Lich de destino (no en el camino ni en la puerta: es de pasada), el arranque usa otro campo hasta poder warpear a Devias; ese campo se elige una vez por llegada (antes iba y venía entre Hound y Bull Fighter cada 4 s). Esto evita repetir el mismo paso por la puerta ocupada sin reaccionar a cada encuentro breve.
- **Arranque** (`early.ts` + `early-step.ts`), debajo del 100 en Lorencia y Devias:
  - **Farmeo inicial** (personaje nuevo, nivel 1 a 9 en Lorencia, `INITIAL` en `early.ts`): solo monstruos de hasta 3 niveles más que él (nivel de `data/monsters.json`; sin dato, no). Acampa en el grupo más grande de esos a ≤ 20 tiles y, sin ninguno a la vista, se aleja del pueblo (135,128) hacia el Lich en proporción al nivel. En el 10 pasa al farmeo avanzado: el plan del Lich.
  - Lorencia (10-19): el server elige el mismo punto de aparición tras `/reset`; el bot escoge entre siete rutas caminables al Lich (134,202 ±5), excluye las dos últimas y las guarda en `learning.json` (`lorenciaRoutes`). Cinco salen por la puerta sur (paso (133,166)) y se abren después; dos salen por la puerta oeste o la este y rodean por afuera (~22 s más).
  - Devias 4: campamento en el grupo más denso junto a la llegada (o el spot 69,181, solo si está a ≤ 25 de la llegada: desde Devias 3 Horaz cruzaba el mapa a pie); objetivos a ≤ 8 del campamento.
  - **Sin hambre**: solo cambia de spot si Devias está llena (3+ jugadores en el campamento por 20 s) o si pasan 60 s en el mapa sin exp. Con jugadores cerca cuenta como llena; sin nadie, como mapa vacío. En los dos casos va primero a otra entrada de Devias y solo a Arena 1 (rinde ~0,4M/min) si todas están llenas.
- **Esquina de Arena 2** (`corner.ts` + `corner-step.ts`), del 100 al reset:
  - Espera en el lado (esquina / medio / este) que más exp/min midió.
  - Prioriza a los monstruos que le pegaron (aggro, 0x18/0x19) a ≤ 15 tiles.
  - Compite si rinde (con 2+ jugadores encima no camina, gira con lo que entra; **el prioritario sí camina a disputar el grupo**: quieto, los rivales se llevaban el 66-87 % de las kills del sector). Se va 5 min a la Arena de su nivel si rinde menos que esa Arena medida (piso 60M): llena (3+ jugadores, 60 s) o sin rendir (90 s, aunque no haya nadie). Nunca debajo del 200 (afuera sería Arena 2 misma) ni con un compañero en la esquina.
- **Dúo en la esquina** (pedido del usuario: Horaz plantado en la esquina y Melu al lado se quedan con el sector):
  - Los compañeros (`MUBOT_MATES`, que la estación pasa con todos sus personajes; por defecto Horaz y Melu) se reconocen por el nombre, que viene en `AddCharactersToScope`: byte 14 en el formato 075 de 27 bytes, byte 18 en el 095 de 31.
  - No cuentan como rivales: ni para "esquina llena", ni para la elección de lado, ni para la defensa.
  - Si un compañero está en la esquina, los lados que ocupa no se eligen y se cambia ya; el DK se planta en la esquina (2,10) si está libre.
  - **El mago le deja la esquina al DK** (`CornerSides.pick` con `yieldCorner`): con un compañero a la vista va al **segundo spot (medio, 7,11)** si está libre, y si está parado en la esquina se corre antes de girar. Con el DK en la esquina se queda plantado y tira de lejos (`castReach`) al grupo más grande, sin caminar hacia los monstruos.
  - **Skill del mago** (`mageNeedsPower`, default de `pickAttackSkill`, en cualquier mapa): **Decay (38)**, lo más poderoso, con un rival a ≤ 8 o un compañero a ≤ 15 (hay que ganar el spot o se coopera); **Evil Spirit** farmeando sola. Usuario: "usa evil cuando está solo farmeando, pero si están cooperando o debe ganarle a alguien, lo más poderoso". También Decay en un **spot cerrado** (`spotIsTight`: muchos monstruos saliendo juntos, un Decay agarra ≥ 80 % de lo que agarra un Evil Spirit).
  - **Mago solo** (sin rivales, sin compañero, spot abierto): se centra en el grupo más grande (`mageCenter`) para que Evil Spirit agarre la mayor cantidad; se mueve si allá agarra 2+ más. El skill de área que confirma el server se loguea ("Tiro Decay (38)", `ownAreaSkill`, 0x1E de 9 bytes).
  - **Party**: el DK invita al compañero que está en la esquina (`buildPartyInvite`, C1 05 40) cada 60 s si no están en party y los datos no dicen lo contrario (`knowledge.ts`); para disolverla manda PartyPlayerKick índice 0 (sin verificar en vivo).
  - **Party solo entre compañeros**: con la estación (MUBOT_MATES) o `--party-mates` se acepta la invitación de un compañero; el resto se rechaza. Con party la exp se reparte (en el navegador los ciclos de Horaz pasaron de ~9 a ~13,6 min): se está midiendo en el dúo de la esquina. En party, el mago le pone Soul Barrier (16) al compañero a <= 6 en los huecos del giro; Swell Life (48) del DK ya alcanza a la party.
- **Dúo de crianza** (`duo.ts`; usuario: "que Hume los ayude a crecer"): un compañero a <= 15 con stats de otra liga (`isFreshChar`, que la estación pasa como `fresh` en `/api/team`) arma el dúo; el fuerte es **padrino** y el nuevo **protegido**, sin importar la clase.
  - Reparto de exp de OpenMU (Party.cs): la base sale del **nivel promedio** de la party (`baseExp`), el pozo es base × miembros × 1,05^(n−1) y a cada uno le toca según su nivel. Con un compañero bajo el castigo por nivel alto se achica: Hume 300 con Zamu 100 contra Gaint Drakan saca ~2,1× por kill que solo (`partyGain`), y Zamu ~1/3 de eso.
  - El padrino invita al protegido cada 60 s cuando `partyGain` >= 1,1 (`partyWanted` con `ward`: manda la cuenta, sin experimentos ni la regla de carrera). El protegido nunca invita ni disuelve.
  - El protegido con el padrino en la esquina no pelea (un Gaint Drakan pega 580-640): se para en el bolsillo de abajo ((7,16), (8,15), (6,15) o (3,12), el de menos monstruos a <= 4 y a <= 9 del padrino, `wardSpot`) y cobra. Debajo del 100 (el warp a Arena 2) farmea solo con el arranque: ahí la party no rinde (la parte va por nivel y los monstruos son bajos). Sin probar en vivo todavía: el alcance del reparto (los que ven al que mata) y si el bolsillo es seguro.
- **Equipo** (`team.ts`; la estación hace de canal: `GET/POST /api/team`, `MUBOT_TEAM_URL`):
  - Cada bot consulta cada 5 s dónde están los compañeros y los pedidos de ayuda vigentes (2 min).
  - **Pide ayuda en la esquina** con 2+ rivales, sin compañero y rindiendo < 150M/min (como mucho una vez cada 3 min).
  - **Pide ayuda con un dragón** (Golden Dragon o Dragón Rojo) a la vista.
  - **El compañero contesta** con una decisión: va a la esquina (desde el 100), sale a cazar a ese mapa, o dice por qué no puede (nivel, cazando, reseteando, en pausa).
  - Cuando un compañero llega a la esquina se anuncia el reparto de lados.
  - El `POST` solo lo aceptan los bots: con `Origin` se rechaza.
- **Dorados** (`golden.ts`): farmeando, un dorado a ≤ 20 tiles es el objetivo, dragones (44/79) primero. A los 2 min sin matarlo se deja. Mientras dura, y 15 s después para las cajas, no resetea, no cambia de spot ni vuelve a la esquina.
- **Defensa propia** (`defense.ts`):
  - Solo contesta a un jugador que le pegó en los últimos 10 s y está a ≤ 10 tiles; usa Death Stab si lo tiene.
  - Con vida < 35 % se va a Lorencia y evita ese mapa 5 min.
  - Sin verificar: los nombres de los jugadores en scope (no se excluye a los propios por nombre).
- **Cacería con memoria** (`HuntState.spots`): cada dorado visto se recuerda 3 min. Sin dorados a la vista, va primero al recordado más cercano (después de morir, por ejemplo) y recién después recorre celdas. Un dorado nuevo se le avisa al compañero al momento (`askHelp('golden', …, 15 s)`); si caza en el mismo mapa, va. Al morir se anota quién lo mató (`Me mató X en (x,y)`, KillerId del 0x17): casi siempre un rival, los dorados no pueden con Horaz ni con Melu.
- **Carrera de resets del prioritario** (`isPriorityChar`, `MUBOT_PRIORITY`, por defecto Horaz; meta: top 10 en 1-2 días): no sale a cazar ni contesta pedidos de dorados (van para Melu), el reset no se frena por invasiones, y sin party salvo que los datos digan que le suma.
- **Mesa de agentes (PR #39)**: el prioritario vuelve siempre a la esquina (sin `noReturnLevel`) y `cornerFull` nunca saca al prioritario ni al mago del dúo; el apoyo en el 400 espera (≤ 20 min) a que el prioritario resetee si él está en 100-399; en Devias el prioritario no cae a Arena 1 y una entrada llena vale 90 s debajo del 100; la huida por PK del prioritario evita el mapa 1 min; vigía `long_cycle` si un ciclo pasa de 15 min.
- **Rival del top cerca** (`rivals.ts`: top 20 del ranking de la base, refresco cada 10 min): a ≤ 10 tiles se anuncia en Decisiones (cada 5 min); el mago le disputa con Decay el grupo a **cualquier rival** a ≤ 10 de Horaz (o de ella si no lo ve) (`contestTarget`, sin atacarlo; **nunca** apunta a monstruos a ≤ 4 + radio del giro de Horaz, para no sacarle kills a él; usuario: "que Melu moleste donde pegue él o cualquiera que esté cerca de Horaz") y el prioritario, sin nada a tiro, ocupa el lugar que ese rival dejó en la esquina (15 s a 3 min después de irse, ej. reseteando). Nunca se ataca ni se persigue al rival.
- **Cazador automático** (`autoHuntChoice` / `pickHuntMap`, `panel-logic.ts`; `--no-auto-hunt` lo apaga): con la invasión dorada activa (0xFD de hace < 2 min) y nivel 380 o más, sale a cazar solo al mejor mapa: vivos (tope 30) × valor de sus cajas (Noria 1, Lorencia y Devias 2, Atlans 3,5, Tarkan 4), más un bonus para el mapa del Golden Dragon, que el server avisa a las :50 con `[Devias] Golden invasion!` (`dragonMapFromServerMessage`, `bot.dragonMap`). Sigue en el mapa hasta que quede en **0** (usuario: "hasta que no quede ninguno, prioridad máxima"); se va antes solo si pasan 2 min sin ver un dorado y otro mapa tiene más vivos (`huntDryOut`). También corta con la invasión terminada o a los 15 min. Cada corte queda en la base (`hunt_end`: mapa, dorados vistos, minutos), y **encadena** el siguiente mapa que no haya hecho (el 2026-10-23 Devias se vació en 3 min con Noria en 38). Un mapa sin zonas conocidas (`mapsWithZones`, `zones.ts`: celdas donde se vio cualquier dorado, de `golden_seen`) vale ×0,25, salvo el del dragón: sin zonas recorre a ciegas y da vueltas (Atlans). Cazando va primero a las zonas de dragones y después a las de cualquier dorado; si el dragón al que le pega sale de la vista, va 6 s a donde estaba en vez de repartir el daño con otro dorado. Una caja de otro ("doesn't belong to you") se suelta ya y se reintenta a los 10 s. Cazando no pelea con comunes ni tira el skill de área en el camino (frenan). A la base: `golden_kill` (cada dorado que muere a la vista y quién lo mató), `loot_ok` y `loot_foreign` (levantado de verdad o de otro). Entre :30 y :05 no resetea (llegar a la invasión en nivel 400). Contra los dorados, correa (`stickyGolden`, `golden.ts`): no suelta al que le pega salvo por un dragón; y el skill más fuerte a un objetivo (`goldenSkill`, `combat.ts`: Death Stab 43, si no Rageful Blow 42, respetando el nivel mínimo 160/170 del Blade Knight). El caballero mantiene Swell Life (48) cada ~55 s. Los avisos del server van al log (`Server: …`) y a la base (`server_msg`); "The item is still falling" y "This item doesn't belong to you" son los 2 s de espera y la caja de otro (la del que más daño hizo).
- **Reparto de puntos** (`capStats`): tope de 65535 por stat; lo que no entra va a agilidad y después a vitalidad. Con todo en el tope no se reparte.

## Datos y aprendizaje (ClickHouse local)

- `bun run db:up` levanta ClickHouse en Docker (`db/docker-compose.yml`): solo en `127.0.0.1:8123`, datos
  en `~/.mubot/clickhouse`, credenciales en `.env.db` (no se commitea; `MUBOT_DB_USER`,
  `MUBOT_DB_PASSWORD`, `MUBOT_DB_URL`). `bun run db:init` aplica `db/schema.sql` y `db/views.sql`.
  Consola web: `http://127.0.0.1:8123/play`.
- Espacio: TTL de 90 días para ticks, 60 para jugadores y 365 para eventos (con 2 personajes, pocos MB
  por día). Logs internos de ClickHouse a 3 días o apagados, y logs rotados (`db/config.d/mubot.xml`,
  compose). Si quedan menos de 5 GB libres, la estación borra ticks y jugadores de más de 7 días.
- `telemetry.ts`: los bots mandan `ticks` (foto cada 5 s), `events` (decide/journal, death con
  asesino, kill, cast, golden_seen, party, cycle) y `players_seen` (cada 10 s). Junta en memoria y manda
  cada 5 s; si la base no responde, reintenta espaciado y sigue jugando. La estación pasa `MUBOT_DB_*`
  de `.env.db`; sin eso no hace nada.
- Qué se guarda (solo lo que sirve para aprender): la foto cada 5 s, muertes con asesino, skills,
  dorados, party, ciclos, decisiones/viajes/resets, y jugadores vistos fuera de la zona segura. No se
  guarda cada kill (la exp ya está en la foto) ni comandos o modos. `v_outcome` / `v_outcome_type`: el
  resultado de cada decisión (exp/min 5 min antes contra 5 después), la base para aprender qué conviene.
- Pelea por los spots: cada tick guarda kills en scope de los últimos 5 s (nuestras, del compañero, de
  rivales y el rival que más mató) y dónde está el compañero (`mate_spot`); `v_spot_fight` muestra qué
  parte del sector es nuestra, solos/juntos/separados. Versión (commit, con `+<hash del diff>` si el árbol tiene cambios sin commitear) y política (perillas) en cada fila.
  La estación guarda el ranking cada hora (`ranking`, `v_rival_pace`: ritmo de resets de los rivales).
- `bun run aprender` (la estación lo corre cada 30 min) muestra las vistas (`v_party`, `v_exp_spot`,
  `v_skill`, `v_killers`, `v_rivals`, `v_cycles`, `v_golden`) y escribe `~/.mubot/knowledge.json`.
- `knowledge.ts`: perillas que el bot ajusta solo con lo aprendido (lista cerrada). Hoy: party sí/no en
  el dúo de la esquina (decideParty: 30 min medidos de cada lado, margen 5 %), con experimento ~10 % de
  bloques de 30 min (`experimentSlot`). El DK disuelve la party con PartyPlayerKick índice 0 cuando los
  datos dicen que no. Cada cambio sale en Decisiones. Borrar `knowledge.json` vuelve atrás.

## Estación (conectar personajes desde el navegador)

`bun run estacion` → `http://127.0.0.1:8787/panel` (también `/`). Lista los personajes, los conecta o desconecta sin
navegador, les pone una rutina y muestra adentro el panel de cada bot (iframe a su `--ws-port`) o
su consola.

- **Personajes:** salen de la base SQLite `~/.mubot/mubot.db` (`estacion-db.ts`, ver "Base de cuentas"
  en README.md): `servers`, `accounts` (con `status` active/blocked) y `characters`. Los `.env` /
  `.env.<nombre>` de la raíz se importan solos al arrancar (idempotente; `.env.example` no cuenta) y
  después manda la base. La estación lanza `bun --env-file=/dev/null run headless-bot.ts --user <u> --char
  <C> --allow-remote --proxy … --auto-seconds 0 --ws-port 879x --exit-if-in-use` con `MUBOT_PASS` (y
  `MUBOT_CREATE_CLASS` si tiene clase) por entorno, sin heredar ningún `MUBOT_*` propio; `/dev/null`
  evita que Bun cargue el `.env` de la raíz (otro personaje). Una cuenta juega con un solo personaje a
  la vez (`connect` lo rechaza). Código 4 (AccountBlocked) marca la cuenta `blocked`; entrar al mundo,
  `active`. Servidor por defecto el de PLAN-SIN-NAVEGADOR.md; `MUBOT_PROXY` / `MUBOT_CS_HOST` /
  `MUBOT_CS_PORT` lo cambian.
- **Flujo de la interfaz:** sin nada elegido al abrir; primero la cuenta (con su estado), después el
  personaje (o uno nuevo), después el panel. Arriba, una miga de pan vuelve a cada paso.
- **Personaje nuevo** (botón "Nuevo personaje" en Personajes; `POST /api/do {action:'create', user, pass, char, cls, existing}`):
  - Registra la cuenta con el mismo endpoint que "Crear cuenta" del cliente web: `POST https://<host del
    proxy>/api/register {username, password}` (`MUBOT_REGISTER_URL` lo cambia). Errores `taken` / `throttled`.
    Con "ya tengo la cuenta" (`existing`) no registra.
  - Validación del cliente web: cuenta de 4 a 10 letras o números; clave de 4 a 10 visibles. Nombre de 4
    a 10 letras o números.
  - **Buscar mis personajes** (`{action:'probe', user, pass?}`, sin `pass` usa la de la base): lanza
    el bot con `--list-chars`, que entra, imprime `MUBOT_CHARS <json>` (nombre y nivel) y sale sin elegir
    personaje ni entrar al mundo (3/4/5 si el login se rechaza; 4 marca la cuenta `blocked`). Uno por vez,
    30 s de plazo. **Probado en vivo** (2026-10-12).
  - **Personaje que ya existe** (cuenta existente + "El personaje ya existe"): `cls: null`, no se crea
    nada; si el nombre no está en la cuenta el bot sale con código 6 en vez de entrar con otro
    (`CHAR_EXPLICIT`: con `--char`/`MUBOT_CHAR` ya no cae al primero de la lista).
  - Guarda cuenta y personaje en la base (clase dk, dw, elf, mg) y lo conecta en pausa. La clave no se
    loguea ni vuelve al navegador. `{action:'add', user, char, cls}` suma un personaje a una cuenta ya
    guardada (la clave la pone la estación).
  - El bot (`world.ts:createCharacter`), si `MUBOT_CHAR` no está en la cuenta y hay `MUBOT_CREATE_CLASS`,
    manda `C1 0F F3 01 <nombre 10 bytes> <clase << 2>` (número de red: DW 0, DK 4, Elf 8, MG 12; el
    adaptador del 0.97d no lo toca) y espera F3/01: byte 4 = 1 creado. Éxito y error comparten código y
    llegan como `CharacterCreationSuccessful`. Si falla sale con **código 6** y no reintenta. MG pide
    desbloqueo (`UnlockFlags` del CharacterList). **Sin verificar en vivo.**
  - `GET /api/names`: 8 nombres sugeridos (`names.ts`: raíces + finales de fantasía, siempre de 4 a 10
    letras, sin repetir los personajes de la estación).
- **Puertos:** estación 8787 (`ESTACION_PORT`), agente del navegador 8788, bots 8791, 8792…
  (por orden alfabético del personaje).
- **Rutinas** (`estacion-logic.ts:routineCommands`): se traducen a órdenes del panel y se mandan por
  el WebSocket del bot cuando entra al mundo (`mode` ≠ `connecting` y nivel > 0). Farmear = `farm`;
  spot fijo = `warp` (Arena 2/3/4, Devias 3/4, Lorencia); pausa = `pause`. Con el bot ya conectado, "Aplicar" las cambia. Cazar e ir a un spot puntual siguen en
  el panel del bot.
- **Los bots sobreviven a la estación:** corren con `setsid` y escriben en
  `~/.mubot/logs/<personaje>.log` (la pestaña Consola muestra las últimas 200 líneas; al lanzarlo, un log de más
  de 50 MB se rota a `.log.1`). Al arrancar
  (y cada 2 s) la estación busca en `/proc` los `headless-bot.ts` de cada cuenta (`--user`,
  `--env-file`, `MUBOT_USER` o, sin nada, el `.env`) y los adopta con su `--ws-port`; uno sin
  `--ws-port` solo se puede desconectar. Desconectar = `SIGTERM`.
- **Nunca dos sesiones de una cuenta:** no lanza si ya corre un bot con esa cuenta, y con
  `--exit-if-in-use` el bot no insiste si la cuenta está abierta en el navegador: la estación lo
  muestra como "cuenta abierta". Igual cerrá la pestaña antes de conectar. Excepción: si se lo desconectó desde la
  estación hace menos de 90 s, va sin `--exit-if-in-use` (la sesión vieja todavía figura abierta y
  el bot reintenta con backoff).
- **Seguridad:** solo 127.0.0.1. `POST /api/do` exige `Origin` de la propia estación (si no, 403),
  `content-type: application/json` y un pedido de lista cerrada (`parseStationRequest`: `connect`,
  `disconnect`, `routine`, sin campos de más). No exponerla con ngrok ni similares.

**Flota, estrategias y alertas** (`estacion-logic.ts`, tests en `estacion-tests.ts`; interfaz en `ui/src`: Flota, Personaje, Estrategias, Dorados, Ranking, Consola, paleta Ctrl/Cmd+K):

- **Estrategia (`RoleAssign`)** por personaje, guardada en `characters.role` (migración 2 de `estacion-db.ts`). `golden` (rutina `hunt`), `route`, `explorer` y `support` (rutina `farm`), `spot` (+`warp`). `POST /api/do {action:'role', char, role}` la guarda y, si el bot está en el juego, aplica `roleRoutine(role)`. La rutina `{kind:'hunt'}` es nueva (orden `hunt` del panel). `GET /api/team` suma `role` en cada miembro.
- **Exploración:** un explorador publica `POST /api/team {from, kind:'scout', map, x, y, players?, monsters?, golds?, note?}` (sin Origin). La estación guarda el último por explorador y mapa 10 min (`ScoutReport`) y los devuelve en `GET /api/team` (`scouts`) y `/api/state`. Los bots todavía no publican ni consumen esto: falta del lado del bot.
- **Alertas:** `/api/state` devuelve `alerts` (más nueva primero, ≤120, `Alert`), `invasion`, `scouts` y `now`. La estación detecta muertes, bloqueos, bolsa llena, subidas de nivel, entradas/salidas, bots trabados (5 min sin moverse farmeando o cazando) e invasiones (`diffAlerts`). Los bots pueden sumar avisos con `POST /api/alert {from, kind:'pk'|'bagfull'|'stuck', text}` (sin Origin). `view()` de cada personaje suma `role`, `roleSaved`, `stuck` y en `game`: `mp`, `zen`, `bag`, `nearby`, `resetsPerDay`, `session`.
- **Demo de la interfaz:** `bun run ui:dev` y abrir `/?demo`: datos simulados, no sale ninguna orden (`ui/src/mock.ts`).

**Probado:** tests offline, y la estación contra un server inexistente (lanzar, adoptar al reiniciar
la estación, desconectar, Origin ajeno rechazado). **Falta en vivo:** conectar contra el server real
y ver la rutina aplicada al entrar.

**Ranking:** la estación expone `GET /api/ranking` (top de resets y ELO de Arena del server, la misma
API que usa el cliente web para `/ranking`: `https://<host del proxy>/api/ranking`, o `MUBOT_RANKING_URL`),
con caché de 1 min; la interfaz lo muestra en la pestaña "Ranking" con los personajes propios marcados.
`/ranking` por el chat del juego NO existe (el server contesta "Comando desconocido").

## Panel externo

`panel.html` (el panel de cada bot; la estación lo muestra adentro) se conecta al
WebSocket del bot y **todo lo saca del protocolo del juego**: anda igual sin
navegador ni cliente web. El contrato está en `panel-protocol.ts`, la lógica pura
en `panel-logic.ts` y el server en `ws-server.ts`.

Lo normal es abrirlo desde la estación (cada bot en su puerto: 8791, 8792…). Suelto:
`http://127.0.0.1:<--ws-port>/panel`. **Solo 127.0.0.1**: el server no escucha en
otras interfaces y rechaza (403) un WebSocket cuyo `Origin` no sea
`http://127.0.0.1:<puerto>` o `http://localhost:<puerto>` (sin esto, cualquier
página abierta en el navegador podía mandarle órdenes al bot). Clientes sin
`Origin` (un script local) se aceptan. No exponerlo con ngrok ni similares.

**HTTP (mismo puerto, solo GET):** `/` y `/panel` sirven `panel.html` de la raíz
(404 si no está; es generado, ver `ui/`); `/terrain/<mapa>` el terreno (256×256 bytes de atributos);
`/radar-assets/...` los archivos del radar (`radar-assets.ts`).

**WebSocket, bot → panel:** `hello` (`botVersion`, `commands`), `history`
(decisiones), `panel-state` (cada 1 s), `log` (órdenes, cambios de modo,
cacería), `command-result` y `decision` (el diario).

`panel-state` sale de lo que el bot ya trackea:
- `equipment` (slots 0-11) e `inventory` (12-75, grilla de 8×8): grupo, número, nivel, excelente, nombre
  y tamaño (`itemInfo`, de `data/items.json`). El panel los dibuja en "Personaje" con los íconos de
  `assets/items/item_<grupo>_<número>_<nivel>[_e].png` (servidos en `/radar-assets/items/...`; no van al
  repo). Hay íconos por escalón de nivel (0, 3, 5…15): se prueba el nivel exacto, el escalón y el 0.
- `char`: nivel, resets (contador local), HP/MP, stats, puntos, zen
  (`CharacterInformation` + `InventoryMoneyUpdate`), `classId` (bits altos del
  primer byte de apariencia del `CharacterList`, **sin verificar en 0.97d**).
- `mode` (`farm`/`hunt`/`paused`/`resetting`/`connecting`/`dead`) y `doing`
  (frase corta que pone el loop).
- `exp.perMin1`/`perMin5` del `ExpLog`; `cycle`/`cycles`/`resetsPerDay` del
  `CycleLog` (1440 / promedio de los últimos 5 ciclos sin tag).
- `events`: el bot pregunta `C1 05 91 <tipo> 01` (1 DS, 2 BC, 4 CC) al entrar al
  mundo y después cada ~60 s por evento, **nunca más de una pregunta cada 5 s**,
  y parsea la respuesta (`MiniGameOpeningState`). Solo con `--ws-port`.
- `invasion`: el 0xFD propio del server. No está en `packets/routes.ts`:
  `net/socket.ts` emite todo code desconocido como `'UnroutedPacket'` (crudo) y
  el bot lo parsea (ver EVENTOS.md). `nextAt` = próximo hh:50 local.
- `tickets` (14/19 +N, 13/18 +N, 13/29, 14/11), `equipment` (slots 0-11 con
  nivel y excelente; el inventario ahora guarda el +N del ítem), `trail`
  (60 posiciones, una cada 2 s, se borra al cambiar de mapa), `camp` (punto al
  que va), `nearby` (monstruos a ≤ 10 tiles, jugadores en scope).

**Órdenes, panel → bot:** `{type:'command', id, command}`. `isPanelCommand`
acepta solo las 6 órdenes (`pause`, `resume`, `farm`, `warp`, `hunt`, `say`) **con sus campos exactos** (un campo de más = rechazo);
mensajes de más de 4 KB se ignoran; nada se evalúa. Toda orden contesta
`command-result` con `{ok, msg}` en castellano y queda en el log del panel y en
el `--decision-log` (`kind: 'command'`; los cambios de modo, `kind: 'mode'`).
- `say {text, to?, channel?}`: chat del personaje. Con `to`, susurro; si no, `channel` normal (default), party (`~`) o guild (`@`). Texto de 1 a 60 caracteres imprimibles, sin comandos (`/...`), un mensaje cada 2 s. Lo recibido (y lo mandado, con `mine`) llega al panel como `{type:'chat', at, kind, from, text}`, incluidos susurros y avisos del server; al conectar se mandan los últimos 100.
- `pause` / `resume`: en pausa el loop no camina, no pelea, no warpea ni
  resetea; las pociones siguen.
- `farm`: vuelve a la ruta normal (cancela la cacería, suelta el spot fijo y la pausa).
- `warp {warp}`: solo índices de `WARP_SPOTS` (y de `--spots` si se pasó), con
  su nivel; viaja con `warpTo` y el spot **queda fijo** (ni la ruta ni el
  hambre lo cambian; si muere vuelve ahí) hasta `farm`.
- `hunt {map?}`: cacería de dorados. Mapa pedido o el de más vivos según el
  último 0xFD al que pueda entrar: Lorencia (warp 2), Noria (3, nivel 10),
  Devias (6, nivel 20). Warpea, recorre el mapa en
  celdas de 25 tiles (la sin visitar más cercana; **el headless no tiene la
  grilla de caminables**, así que una celda a la que no llega en 45 s se da por
  visitada), ataca siempre al dorado más cercano en scope (nombre con
  "Gold"/"Golden" en `data/monsters.json`) y a los comunes solo a ≤ 3 tiles. La
  Box of Luck la levanta el loot de siempre. **Corta sola** cuando un 0xFD
  posterior al inicio dice 0 vivos en ese mapa (o el mapa ya no figura), la
  invasión pasa a derrotada, o a los 15 min; vuelve a farmear. Cazando no resetea.
- **Bug arreglado de paso:** los dorados grandes (Golden Dragon, Titan, Soldier,
  Vepar...) tienen `Move` > 50 y el filtro de `MONSTER_TYPE_NUMBERS` los
  descartaba: el bot no los veía. Ahora se suman aparte (`GOLDEN_TYPES`).

**Sin verificar en vivo:** todo lo de arriba está probado offline
(`panel-tests.ts`) y el server HTTP/WS con un cliente local, pero no contra el
server real: falta confirmar que el server contesta 0x91 a esta pregunta, el
layout del 0xFD, el `classId` y el nivel del ítem en 0.97d, y una cacería
completa.

### Dorados sin navegador

Cada bot, farmeando, manda a la estación los dorados que ve (`GoldReporter` en `panel-logic.ts`,
`POST` a `MUBOT_GOLD_URL`, que la estación pasa al lanzarlo: `http://127.0.0.1:8787/api/gold`):
nuevo, movido (como mucho cada 2 s por id) e ido (`gone`). El navegador también puede mandar
señales si el usuario juega ahí (CORS para `https://mu.mormon.garden`). La estación las guarda 1 min
y las muestra en "Dorados vistos". Contrato:

```ts
{ from: 'Horaz', map: 3, x: 140, y: 60, name: 'Golden Goblin', id: 77, at: 1760000000000 } // visto / se movió
{ from: 'Horaz', map: 3, id: 77, gone: true, at: 1760000000000 }                            // murió o salió del scope
```

El buscador (`--scout`), el explorador (`--atlas`) y el dúo se sacaron: eran del modo navegador.
