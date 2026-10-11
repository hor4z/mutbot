# mubot

Bot headless de MU: hace que un personaje **progrese solo** (pelea, sube exp y
stats, recoge loot, vende basura, repone pociones) sin GUI, hablando el protocolo
real del cliente.

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

# Tests offline (no tocan el server): packet-tests.ts + learning-tests.ts + explore-tests.ts + farming-tests.ts + camp-tests.ts + panel-tests.ts + atlas-tests.ts + estacion-tests.ts.
bun run test

# Typecheck (tiene que dar limpio)
bun run tsc

# Estación: conectar/desconectar personajes y elegir su rutina desde el navegador (http://127.0.0.1:8787)
bun run estacion

# Proxy WebSocket -> TCP (escucha en 127.0.0.1:3000; PORT/HOSTNAME para cambiarlo)
bun run proxy

# El bot: login + loop autónomo que progresa el personaje.
bun run bot --user <u> --pass <p> --char <c> \
  --auto-seconds 600 \
  --decision-log /tmp/decisiones.jsonl \
  --ws-port 8787
```

`--auto-seconds 0` = sin límite: farmea, encadena resets indefinidamente y
reconecta con backoff si se corta (ver "Reset encadenado" y "Port del agente web").
Otros flags: `--build str:50,ene:33,vit:17` (reparto fijo; sin él, `planStats`),
`--stat-batch 200` (puntos mínimos para frenar a repartir), `--free-route` (la
regla vieja de spots por exp/min en vez de la ruta fija), `--spots`, `--warp`.

`--exit-if-in-use`: si en el primer login la cuenta ya está conectada (la pestaña del navegador),
sale con código 3 en vez de reintentar. Después de un corte sí reintenta (el server tarda en soltar
la sesión vieja del propio bot). Lo pasa la estación.

Flag inexistente = el bot arranca con defaults y se cuelga esperando `LoginResponse`.
Los reales son `--user`, `--pass`, `--char` (no `--account`/`--character`). Esto ya
pasó una vez y costó tres intentos de debugging.

## Estructura

| Archivo | Qué es |
|---|---|
| `headless-bot.ts` | El bot. Login, mundo, loop autónomo, economía, capa de decisión. |
| `estacion.ts` / `estacion.html` | Estación: lanza y corta los bots de cada personaje (`.env*`) y les pone una rutina. Ver "Estación". |
| `estacion-logic.ts` | Lado puro de la estación: personajes, argumentos del bot, rutinas, pedidos, detección de bots que ya corren. Tests en `estacion-tests.ts`. |
| `ws-server.ts` | Server del panel detrás de `--ws-port` (solo 127.0.0.1): WebSocket de estado + órdenes de lista cerrada, `panel.html` y `/assets/`. Ver "Panel externo". |
| `panel-protocol.ts` | Contrato bot ↔ panel (tipos, `PANEL_COMMANDS`, `isPanelCommand`). |
| `panel-logic.ts` | Lado bot del panel en lógica pura: 0x91, 0xFD, tickets, ciclos, cacería y buscador de dorados. |
| `panel-tests.ts` | Tests offline de `panel-logic.ts`, `isPanelCommand` y la parte pura de `ws-server.ts`. |
| `atlas.ts` | Explorador / atlas (lógica pura): mapas por nivel, tiempo por mapa, registro de monstruos por celda y dorados, persistencia y reporte. |
| `atlas-tests.ts` | Tests offline de `atlas.ts` (dir temporal, sin red). |
| `scripts/atlas-report.ts` | `bun run atlas-report`: imprime el atlas (solo lectura, sin red). |
| `packet-tests.ts` | Tests offline de parsers y builders. Sin red. |
| `learning.ts` | Capa de aprendizaje (lógica pura): medición por spot, bandit UCB1, persistencia. |
| `learning-tests.ts` | Tests offline de `learning.ts` (usa un dir temporal, sin red). |
| `explore.ts` | Explorador (lógica pura): filtro de monstruos, spots calientes, salidas del pueblo, mapa seco. |
| `explore-tests.ts` | Tests offline de `explore.ts` (reloj simulado, sin red). |
| `farming.ts` | Farmeo por exp/segundo (lógica pura): valor y elección de objetivo, exp/segundos por tipo de monstruo, exp partida, autoevaluación. |
| `farming-tests.ts` | Tests offline de `farming.ts` (reloj simulado, sin red). |
| `camp.ts` | Campamentos (lógica pura): correa, primer campamento por mapa, mudanzas, pelea en el camino, curiosidad, memoria, hambre, skill de área. |
| `camp-tests.ts` | Tests offline de `camp.ts`. |
| `protocol097.ts` | Helpers de bytes sin estado (party, ItemDropRemoved, excelentes) y el backoff de reconexión; testeados en `packet-tests.ts`. |
| `browser/` | Modo navegador archivado (ver `browser/README.md`). `browser/browser-agent.js`: el agente que juega DENTRO del cliente web (pegado en la consola). Es la referencia: sube rápido, y sus comentarios explican cada decisión aprendida jugando. `farming.ts`, `camp.ts` y la ruta fija son su port (ver "Port del agente web"). |
| `proxy.ts` | Proxy WebSocket -> TCP (copia de `proxy/main.ts` del cliente MU JS, en loopback por defecto). |
| `net/` | Socket, cifrado (xor3, xor32, SimpleModulus), helpers de bytes y event bus. |
| `packets/` | Subconjunto de las clases de packets + `routes.ts`. **Generado**, no editar. |
| `data/` | `items.json` y `monsters.json` del cliente. |
| `extract-packets.ts` | Regenera `packets/` desde el cliente MU JS (`bun run extract`). |
| `AGENTS.md` | Este doc. |
| `CLAUDE.md` | Puntero a este doc. |

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

## La capa de decisión (esto es lo importante)

`headless-bot.ts:decide()` es el único camino por el que el bot hace algo con
efecto en el mundo. Nada se ejecuta sin pasar por ahí.

```ts
export function setDecisionHandler(
  h: (d: Decision) => Verdict | Promise<Verdict>,
): void
```

`Decision` tiene `kind`, `what` (legible), `detail` (crudo, para la UI) y
`autoOk`. El handler devuelve `{ allow: boolean }`.

Reglas que hay que respetar:

- **Si el handler lanza, la acción se rechaza.** Fail-safe: no gastamos recursos
  sin permiso.
- `autoOk: false` marca lo irreversible o lo que cuesta plata: `stat`, `sell`,
  `buy`. Es documentación para quien enganche la UI, no behavior.
- Cada decisión se escribe al JSONL de `--decision-log` **antes** de pedir
  veredicto, así la UI ve la intención aunque después se rechace.

**Bug arreglado:** el log se escribía con `Bun.write`, que sobrescribe (en una
corrida larga solo quedaba la última decisión). Ahora usa `appendFile` de
`node:fs/promises` — mismo JSON, mismo fail-safe, pero appendea de verdad.

**Telemetría por WebSocket (`--ws-port`, `ws-server.ts`):** si se pasa, el bot
levanta un WebSocket que manda `hello`/`history` al conectar, y después `state`
(snapshot de `world`, ~1/seg), `panel-state` y `decision` (cada vez que
`decide()` corre). Acepta solo las órdenes de lista cerrada del panel (ver
"Panel externo"); **no** hay canal para aprobar/rechazar decisiones: el
`decisionHandler` sigue aprobando todo por defecto. Eso queda pendiente.

**Loop autónomo — exploración (`explore.ts`, portado de un agente que juega
bien dentro del cliente web):**

- **Qué es un monstruo** (`isMonsterType`): TypeNumber **fuera de 200-299** Y
  (está en `monsters.json` como atacable **o** TypeNumber >= 300).
  - 200-299 son los NPC de pueblo/servicio del 0.97: vendedores, guardias
    (`247` Crossbow / `249` Berdysh, nivel 90), cofre `240`, Thompson `231`,
    Lumen, etc. `monsters.json` trae a varios con atributos de combate (los
    guardias "pegan"), así que su set solo no alcanzaba para excluirlos.
  - >= 300: este server tiene TypeNumbers custom (vistos en vivo: `690`,
    `692`) que `monsters.json` no conoce. Con el filtro viejo (solo
    `monsters.json`) el bot quedaba ciego a ellos.
  - Efecto lateral aceptado: también se excluyen Kalima (260-275) y 290-295;
    ninguno está en `WARP_SPOTS`.
  - Los 200-299 se guardan aparte en `world.townNpcs`: son los candidatos de
    `discoverMerchant()`. **Bug arreglado de paso:** antes el descubrimiento
    sondeaba `world.npcs`, que solo tiene monstruos.
- **Spots calientes** (`HotSpotGrid`): cada exp ganada (`ExperienceGained`)
  se **suma** a la celda de **12x12 por mapa** donde estaba el monstruo
  muerto (posición sacada del registro id → tipo/posición, porque cuando llega
  el evento ya salió del scope). Un spot vale por lo que **rinde**, no por
  cuántos bichos tiene (antes contaba objetivos elegidos). Sin monstruos en
  scope, el bot vuelve a la celda con más exp que no haya estado vacía en los
  últimos **90 s** (y a **≤ 30 tiles**, `HOT_MAX_DIST`; con correa, dentro de
  ella) y **acampa ahí esperando el respawn hasta 30 s** antes de
  marcarla vacía y pasar a la siguiente (con 8 s abandonaba spots buenos justo
  antes del respawn). La grilla se conserva entre resets (depende del mapa,
  no del nivel) y se guarda en `learning.json`.
- **Salidas** (`exitTargets`): sin spots calientes, camina "hacia afuera" del
  pueblo. Centro del pueblo por mapa en `TOWN_CENTERS` (solo Lorencia
  confirmado: `(135,128)`; en otros mapas se usa la posición de llegada). Las
  salidas son las 8 direcciones a ~55 tiles del centro, barridas en abanico
  desde la primera. En **Lorencia la primera es la cripta, `(110,180)`**: el
  usuario confirmó que los monstruos están por la salida que en pantalla se
  ve "arriba", que en coordenadas del mundo es (-x, +y) del centro (zona
  ~(90-130, 170-190)). En mapas sin salida conocida, la primera dirección es
  `--explore-dir` o, si el pueblo está lejos del medio del mapa, hacia
  `(128,128)` (heurística, sin verificar). Una salida se **abandona a los 20 s
  de llegar sin ver monstruos**; un objetivo al que no se llega en 60 s
  (muros) también se abandona. Pelear en el camino no consume esos plazos.
- **Mapa seco:** si en **90 s** (`DRY_MAP_MS`, el `giveUpMapMs` del agente web) no apareció ningún monstruo en todo el mapa,
  el spot actual se marca seco (`dryAt`), se corta el tramo (queda como
  muestra con 0 exp = mala para el bandit) y `maybeChangeSpot()` pasa al
  siguiente spot elegible; el spot seco queda excluido 15 min
  (`LEARN.DRY_EXCLUDE_MS`). Ver "Aprendizaje".
- Reemplaza al explorador viejo (`EXPLORE_RUN_STEPS=25`, caminata recta con
  giros de 90° al chocar), que tardaba minutos en salir de una zona vacía
  (~160 s de exploración desplazaban ~24 tiles). **Sin verificar en vivo
  desde `headless-bot.ts`:** la lógica viene del agente del cliente web y
  está testeada offline, pero el bot headless todavía no la corrió.
- **Bug real:** en una zona con mucho loot acumulado (de otros jugadores), el
  bot se quedaba recogiendo para siempre y nunca llegaba a elegir/atacar un
  monstruo aunque hubiera uno al lado — "recoger loot" tenía prioridad
  absoluta sobre pelear. Arreglado: no se interrumpe un combate ya en rango
  de golpe para ir a recoger.
- **Qué drop levantar** (`lootStep()` + `isValuableDrop`): solo lo valioso
  (cajas, joyas, excelentes, guantes 10/1), caminando hasta él. Antes
  (`dropPriority()`) levantaba todo, dinero primero; se cambió al port del
  agente web (ver "Port del agente web", punto 12).
- `MUBOT_DEBUG_NPCS=1` (variable de entorno): loguea TODOS los NPCs en scope,
  pasen o no `isMonsterType`, con su `TypeNumber`. Así se confirmó que los
  `247`/`249` son los guardias y se vieron los custom `690`/`692`.
- `MUBOT_DEBUG_COMBAT=1`: loguea distancia al objetivo cada 5 ticks y cada
  intento de golpe.

## Aprendizaje

El bot ya no elige el mapa con una regla fija: mide cuánto rinde cada spot y
elige con esa experiencia. La lógica es pura y está en `learning.ts`
(testeada en `learning-tests.ts`); `headless-bot.ts` solo la engancha.

**Qué mide.** Mientras está en un spot (`currentSpot`, que se setea al warpear),
`SpotMeter` acumula exp (`ExperienceGained`), kills propios (`ObjectGotKilled`
con `KillerId` = nosotros) y muertes. Muerte = el HP propio cae a 0
(`CurrentHealthAndShield`) o llega `ObjectGotKilled` con `KilledId` = nosotros;
las dos señales dentro de 15 s cuentan como una. El tramo se corta en una
**muestra** cada ~2 min, al cambiar de spot, al morir, antes de un reset y al
terminar. Cada muestra guarda spot, nivel y reset al que se midió, duración,
exp, kills y muertes. Tramos de menos de 30 s sin muertes se descartan.
Sin `currentSpot` (arrancó sin `--warp` y todavía no warpeó) no se mide.

**Dónde guarda.** `~/.mubot/learning.json` (fuera del repo; `--learn-file` lo
cambia), con una entrada por personaje (`--char`): `{ resets, samples[], hot[],
types }` — `hot` es la grilla de spots calientes (`{map, cx, cy, exp}`) y
`types` lo aprendido por tipo de monstruo (`expByType`, `killSecByType`), como
el `localStorage` del agente web: sobreviven a un reinicio del bot.
Escritura atómica (tmp en el mismo dir + `rename`); cada save relee el archivo y
reemplaza solo la entrada de su personaje, así dos bots con personajes
distintos no se pisan. Archivo ausente = empieza de cero. Archivo corrupto =
empieza de cero y el original se renombra a `learning.json.corrupt-<ts>`.
Muestras mal formadas se descartan una por una. Tope de 2000 muestras por
personaje (quedan las últimas). `resets` es un **contador local** (se suma
cuando `doReset()` termina bien): no hay un packet de resets que sepamos
parsear todavía.

**Cómo decide hoy: ruta FIJA por tramo (`chooseFixedRoute`).** Ver "Port del
agente web" abajo. Lo que sigue (`chooseRouteSpot`) quedó detrás de
`--free-route`.

**(Con `--free-route`) `chooseRouteSpot`, la regla vieja del agente web.** Spot =
exp/min. Los spots son la **ruta del usuario** (`WARP_SPOTS`): Lorencia (warp
2, nivel 10) → Devias 2/3/4 (5, 6, 7; nivel 20) → Arena (1, nivel 50) → Arena 2
(24, 100) → Arena 3 (25, 200) → Arena 4 (26, 300). **Devias 1 (warp 4) no va:
el usuario confirmó que no sirve.** Noria, Dungeon, Lost Tower, Atlans, etc.
salieron de la lista (no están en su ruta). El zen de Arena no se capturó (se
muestra "zen sin capturar"; el server igual valida). Cada 10 ticks, con 15 s
mínimos entre warps, `maybeChangeSpot()`:

1. **Tier nuevo:** si el nivel habilita un `reqLevel` mayor que todos los
   vistos en este ciclo de reset (`tierSeen`), va a probar el primer spot de
   ese tier (si ya está en uno de ese tier, se queda).
2. **Rinde poco:** tras **2 min** (`ROUTE.EVAL_MS`) en un spot, si su exp/min
   de la estadía es 0 o < **50%** del mejor conocido, cambia: primero a uno
   sin medir (el de mayor nivel), si no al mejor medido si supera al actual.
   Si no hay alternativa, se queda y vuelve a medir.
3. **Sin spot** (arranque, muerte): sin tier nuevo, vuelve al mejor medido.
4. **Mapa seco:** igual que antes, cambia aunque no hayan pasado los 2 min.

"Mejor conocido" = `routeScores()`: exp/min por spot de las muestras **del
ciclo de reset actual** (ponderadas por cercanía de nivel), solo de spots con
al menos 2 min reales medidos. Después de un `/reset` el rendimiento por mapa
se vuelve a medir desde cero (cambian stats y nivel). El agente web resetea
igual su `spotScore`.

**El bandit UCB1 de abajo (`chooseSpot`) sigue en `learning.ts` y testeado,
pero el bot ya no lo usa:** pedía 5 min mínimos por spot y no reaccionaba a un
tier nuevo; el agente web, con la regla de arriba, sube mucho más rápido.

**(Histórico) Cómo decidía con `chooseSpot`, bandit UCB1.** Cada ~50 ticks `maybeChangeSpot()`:
1. Candidatos: spots con `reqLevel <= nivel`, limitados por `--spots`.
2. Datos: se ponderan las muestras por cercanía de nivel (triangular, ±40
   niveles; más lejos no cuentan) y las de otro reset pesan la mitad. Tasa
   efectiva = `exp / (minutos + muertes × 3)`: cada muerte cuesta 3 minutos de
   farmeo.
3. Permanencia mínima de **5 min** en el spot antes de evaluar cambio (cada
   warp cuesta zen). Excepción: si el spot actual dejó de ser elegible (reset,
   `--spots`, **mapa seco**) o no hay spot actual (arranque, muerte, reset),
   decide ya.
   - **Mapa seco** (`explore.ts`, 2 min sin ningún monstruo en el mapa): el
     spot entra en `exclude` (`ChooseInput.exclude`, vigente
     `LEARN.DRY_EXCLUDE_MS` = 15 min, ver `activeDryExclusions`), no es
     candidato y si es el actual se cambia con `reason: 'dry'`. El tramo seco
     se guarda como muestra con 0 exp, así que además baja su tasa a futuro.
     Si no queda otro spot elegible, se queda (`reason: 'none'`) y sigue
     explorando.
4. Sin datos para este nivel: **regla vieja** (mayor `reqLevel`).
5. Exploración acotada: un spot sin datos se prueba solo si está entre los 4 de
   mayor `reqLevel` elegibles.
6. Con datos: UCB1 con recompensa = tasa / mejor tasa (0..1), una "jugada" = 5
   min de farmeo, bonus `0.3·√(2 ln N / n)`. Para moverse, el mejor tiene que
   superar al actual por 0.05 (histéresis, evita oscilar).

UCB1 y no epsilon-greedy: epsilon-greedy explora con warps al azar para
siempre (zen y tiempo tirados, y un personaje que salta de mapa sin motivo se
ve raro); UCB1 es determinista, explora solo donde falta evidencia y cada
decisión se explica con números. Los parámetros están en `LEARN` (`learning.ts`).

Cada cambio pasa por `decide()` (`kind: 'travel'`) con un `what` que explica el
porqué, ej. `Atlans 3: 412 exp/min vs Tarkan 345 exp/min (n=6) → warp a
Atlans 3 (cuesta 5000 zen)`, y en `detail` van `reason`
(`no-data`/`explore`/`exploit`/`ineligible`/`dry`), la tabla y los puntajes UCB.
Cada ~2 min se loguea la tabla aprendida:

```
[bot] Aprendizaje (nivel 150, reset 0, * = spot actual):
  spot              n    min  exp/min kill/min muertes efectiva   ucb
  Atlans 3          1   30.0      412      4.1     0.0      412
* Tarkan            1   30.0      380      3.8     1.0      345
```

Al morir se corta la muestra y se olvida `currentSpot`, así el próximo
`maybeChangeSpot` vuelve a warpear (el respawn suele ser en otro lado).
`--no-learn` desactiva todo y vuelve a `pickSpot()` (mayor `reqLevel`).

**Sin verificar en vivo:** que el server mande `CurrentHealthAndShield` con 0 /
`ObjectGotKilled` propio al morir, dónde respawnea este server, y si el
re-warp tras morir es lo que haría un humano. El reparto de stats
(`BUILD_WEIGHTS`) **no** aprende todavía: sigue fijo.

## Farmeo por exp/segundo (`farming.ts`, port del agente web)

El agente que juega dentro del cliente web (`browser-agent.js`) sube de nivel
mucho más rápido que el bot headless. Su lógica de decisión está portada a
`farming.ts` (pura, testeada en `farming-tests.ts`) y enganchada en
`autonomousLoop`:

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
   warpear a la misma entrada (`prefer`). `--free-route` vuelve a la regla vieja.
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
12. **Loot valioso** (`isValuableDrop`): cajas 14/11, joyas 14/13,14,16,22,31 y
    12/15, excelentes (6 bits bajos del byte 3 del ItemData) y guantes 10/1. El
    zen y el equipo común ya **no** se levantan. Camina hasta el drop (≤ 12
    tiles, 8 s de plazo) y lo levanta a ≤ 1. `ItemDropRemoved` (C2 21) saca del
    registro lo que levantó otro o expiró.
13. **Registro de tramos por ciclo** (`CycleLog`, en `learning.json` →
    `cycles`, con el ciclo en curso para retomarlo): minuto al llegar a
    20/50/100/200/300/350/400. El informe muestra los últimos ciclos y la
    **proyección resets/día** (1440 / promedio de los últimos 5). Solo cierran
    los ciclos que llegaron al 400.
14. **Reconexión** (`main`/`session`, `Backoff` en `protocol097.ts`): si se corta
    la conexión (kick, red, timeout) vuelve a conectar con backoff 5 s → 5 min
    (vuelve a 5 s tras una sesión > 5 min; ≥ 60 s si la cuenta figura
    conectada). Nunca dos sesiones: reconecta con la anterior cerrada. Login con
    contraseña/cuenta/versión inválida = no reintenta. Retoma desde el estado
    real: elegir personaje → nivel/mapa/puntos de `CharacterInformation` → la
    ruta adopta el mapa o warpea, y a 400 resetea. Los handlers del EventBus se
    registran una sola vez y `sendToGS` no manda nada con el socket cerrado.
15. **Hambre** (`Hunger`, `camp.ts`): si en los últimos 45 s la exp/min es < 25%
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

### Layouts que el parser generado rompe

- **CharacterList**: el XML define el "Extended" (34 bytes/char), pero 0.97d
  manda el chico (26 bytes/char, count en índice 4). El parser desborda. Por eso
  `headless-bot.ts` lo parsea a mano con `parseCharacterList097()`.
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

Flujo de venta, según `SellItemToNpcAction` de OpenMU:

1. `TalkToNpcRequest` (0x30) → el server setea `player.OpenedNpc`. **Obligatorio.**
   Sin esto, `SellItemToNpcRequest` responde `Success=false`.
2. `SellItemToNpcRequest` (0x33) por slot.
3. `CloseNpcRequest` (0x31).

El server valida que el item exista, sea vendible y no esté ligado. La única señal
de éxito autoritativa es que **el item desaparece del inventario**: el bot compara
el estado del slot antes y después, no cuenta a ciegas.

Responses: `NpcItemSellResult` (0x33), `InventoryMoneyUpdate` (0x22/FE),
`NpcItemBuyFailed` (0x32/FF), `OpenNpcDialog` (F9/01), `NpcWindowResponse` (0x30).

### Descubrimiento de merchants

`data/monsters.json` mezcla monstruos y NPCs (los NPC de servicio del 0.97
son los TypeNumber 200-299). No hay forma de saber de antemano qué Id es un
merchant.

Por eso el bot descubre: habla con los NPCs de pueblo que ve en scope
(`world.townNpcs`, TypeNumber 200-299 salvo los guardias 247/249) y lee qué
ventana conteste. `NpcWindowResponse.Window` `Merchant=0` / `Merchant1=1` son las de venta.
Con `--merchant <ids>` se saltea el sondeo.

**Limitación real:** el `ItemSlot` de `BuyItemFromNpcRequest` NO es el índice de
`items.json`, es la posición dentro de la lista del merchant, que el server arma por
su cuenta. El bot no ve esa lista, así que el índice va por `--buy-slot`. Si está
mal, el server contesta `NpcItemBuyFailed` y no cobra nada (por eso no insiste).

### Qué se vende

Por grupo, desde `items.json`. Lo conservador:

- **Se venden**: 12 (jewels/ribbons), 15 (scrolls), 30/31/32/41/42/43 (event).
- **Nunca**: pociones curativas (sosten la vida) y equipamiento (grupos 0-11, 13) —
  eso es decisión del humano.
- **Grupos desconocidos**: no se tocan.

Se dispara cuando el inventario pasa 60% de 40 slots.

## Anti-cheat

`SpeedHackDetectPlugIn`: delay base de ataque 450ms + token bucket de 5.

Ritmos actuales: caminata 380ms, ataque 500ms, skills 900ms, ventas 600ms.
**Son deliberados.** Bajarlos hace que el bot sea detectado.

**No tocar `SpeedHackDetectPlugIn` ni la configuración del server para que el bot
vaya más rápido.** El objetivo es saber si el server valida, no hacerlo pasar.

## Limitaciones conocidas

Estas están **verificadas como problemas**, no como sospechas:

- **Login: resuelto, confirmado en vivo contra `mu.mormon.garden`.** El bug era
  la clave `xor32` (el cliente 0.97d usa una propia, distinta de la de
  season6). Con la clave correcta, el login funciona, trae `LoginResponse`
  OK, personaje y entrada al mundo. Contra el server **local** (OpenMU
  genérico de prueba) pasa lo contrario: la clave 0.97d rompe el login y hace
  falta la clave por defecto (`MUBOT_XOR32_DEFAULT=1`), y además no hay
  ninguna cuenta de prueba cargada — para probar localmente hay que crear una
  cuenta en ese server o usar esa variable de entorno contra uno que sí tenga
  `test1`.
- **Venta, compra y descubrimiento de merchants nunca se ejecutaron contra el
  server.** Están escritos y con los packets verificados en tests, pero no
  probados end-to-end.
- **Los skills no tienen cooldown, costo de mana ni rango.** El `useSkill` actual
  dispara cada 900ms sin preguntar. Los defaults no se validaron.
- **`--gate` no tiene gate table.** Manda un número arbitrario sin caminar al
  tile. Debería quedar deshabilitado hasta capturar el flujo real
  (`src/Persistence/Initialization/Version075/Gates.cs` en el repo de OpenMU).
- **Reconexión con backoff: escrita y testeada offline, sin probar en vivo**
  (ver "Port del agente web", punto 14).
- **Las stats locales se pueden desincronizar.** `CharacterLevelUpdate` no trae
  los valores de stat; los valores reales nunca llegan, así que el tracker cuenta
  por su cuenta.
- **No hay inversión de master skill points**, que era parte del objetivo original.
  Falta definir el build y los requisitos.
- **El inventario no trackea cantidad.** Solo `slot/group/num` (y nivel/excelente para el panel), así que no puede
  razonar sobre stack sizes ni decidir bien qué guardar.

## Orden sugerido para retomar

Con el login ya resuelto, probar **de a una** cosa y con capturas de cada
packet: un ataque, un stat point, **descubrir un merchant**, vender un item,
comprar una poción. Recién ahí, automatización más agresiva.

## Pendiente: investigado pero no implementado

Research ya hecho (protocolo confirmado contra el repo de OpenMU en
`/tmp/opencode/OpenMU`), falta escribir el código y verificar de a un paso
contra el server real. No tocar esto sin seguir esa metodología.

- **Catálogo real del merchant: HECHO (parseo), compra/equipo: falta.**
  `StoreItemList` (C2/`0x31`) se parsea a mano (`parseStoreItemList097`,
  mismo bug de stride que tenía documentado: el `getItems()` generado calcula
  `ItemData` con longitud 0). El catálogo (`shopCatalog`) ya se usa en
  `ensurePotions()` en vez de depender ciegamente de `--buy-slot`. **Probado
  solo offline** (3 tests nuevos en `packet-tests.ts`); falta confirmar en
  vivo que `group/num` matchean lo que vende un merchant real. **Falta por
  completo:** comparar con el equipo actual y comprar+equipar mejor gear. Para
  equipar no hay packet "Equip" separado, es un `ItemMoveRequest` (C3/`0x24`,
  ya generado) moviendo el ítem de un slot de inventario a un slot de equipo
  (ambos dentro del mismo storage "Inventory", slots 0-11 son equipo). La
  heurística de "mejor ítem" necesita saber la clase del personaje (hoy no se
  trackea; propuesta: flag `--class`).
- **Master skill tree: escucha pasiva HECHA, inversión falta.**
  `MasterStatsUpdate`/`MasterCharacterLevelUpdate`/`MasterSkillLevelUpdate` ya
  se escuchan (solo logean, no mandan nada) y pueblan
  `world.masterLevel`/`masterLevelUpPoints`/`masterSeen`. **Riesgo real sin
  confirmar todavía:** el sistema de Master es de Season 3+, y este server
  corre perfil V097D (pre-season) — no se sabe si manda esos tres eventos
  para este personaje. Primer paso pendiente: correr el bot contra el server
  real y ver si `world.masterSeen` pasa a `true`. Si no, el resto de este
  punto queda bloqueado (no tiene sentido escribir
  `AddMasterSkillPoint`/`investMasterSkillPoints()` sin esa confirmación).
- **Viaje entre mapas (gates).** Confirmado en `WarpGateHandler075PlugIn.cs`
  de OpenMU: el server valida que la posición actual del jugador esté dentro
  del rectángulo del `EnterGate` antes de aceptar el viaje — por eso `--gate`
  manda un número sin caminar al tile y falla en silencio. Las tablas
  (`Version075/Gates.cs`, `Version095d/Gates.cs`, `VersionSeasonSix/Gates.cs`)
  dan mapa+rectángulo+requisito de nivel, pero no hay garantía de que
  matcheen la config de este server — hay que confirmarlo mapa por mapa.
  **Se volvió urgente, no solo "nice to have":** probado en vivo con una
  cuenta de personaje nivel 1 (`melu`), el explorador se queda **encerrado**
  en una caja de ~20x20 tiles cerca del spawn (con el explorador viejo,
  `EXPLORE_RUN_STEPS`; el nuevo de `explore.ts` camina a salidas fijas y
  abandona las inalcanzables, pero no se probó en ese caso). Sin
  gates reales, un personaje que arranca adentro de esa zona no puede
  progresar solo. Mitigación de corto plazo: usar una cuenta cuyo personaje
  ya esté afuera del spawn (confirmado con `horaz`, nivel 48, `map=3`, ya en
  campo abierto) en vez de insistir con una cuenta atascada.
- **UI con fidelidad real (Rust + wgpu).** Investigado a fondo: no hace falta
  reversear el formato binario `.bmd` — el cliente web de este mismo repo ya
  sirve (y el host `/game-assets-v097d/` expone) los modelos pre-convertidos a
  `.glb` estándar, cargables con un crate glTF normal de Rust. Lo único que
  hay que portar de cero es el parser de terreno (`src/common/terrain/*.ts`,
  chico, sin XOR en las texturas — eso fue una hipótesis incorrecta inicial,
  solo tienen un header de unos pocos bytes). Estimado realista para un v1
  con terreno+personaje animado+equipo+overlay conectado al WebSocket de
  telemetría: 6-9 semanas de trabajo enfocado, en 7 fases con demo en cada
  una (ver plan de sesión para el detalle fase por fase).

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
## Estación (conectar personajes desde el navegador)

`bun run estacion` → `http://127.0.0.1:8787/panel` (también `/`). Lista los personajes, los conecta o desconecta sin
navegador, les pone una rutina y muestra adentro el panel de cada bot (iframe a su `--ws-port`) o
su consola.

- **Personajes:** cada `.env` / `.env.<nombre>` de la raíz con `MUBOT_USER`, `MUBOT_PASS` y
  `MUBOT_CHAR` (`.env.example` no cuenta). La estación no lee ni pasa la contraseña: lanza
  `bun --env-file=<archivo> run headless-bot.ts --allow-remote --proxy … --auto-seconds 0
  --ws-port 879x --exit-if-in-use` sin heredar ningún `MUBOT_*` propio. Servidor por defecto el
  de PLAN-SIN-NAVEGADOR.md; `MUBOT_PROXY` / `MUBOT_CS_HOST` / `MUBOT_CS_PORT` lo cambian.
- **Puertos:** estación 8787 (`ESTACION_PORT`), agente del navegador 8788, bots 8791, 8792…
  (por orden alfabético del archivo de env).
- **Rutinas** (`estacion-logic.ts:routineCommands`): se traducen a órdenes del panel y se mandan por
  el WebSocket del bot cuando entra al mundo (`mode` ≠ `connecting` y nivel > 0). Farmear = `farm`;
  spot fijo = `warp` (Arena 2/3/4, Devias 3/4, Lorencia); explorar = `farm` + `atlas`; pausa =
  `pause`. Con el bot ya conectado, "Aplicar" las cambia. Cazar e ir a un spot puntual siguen en
  el panel del bot.
- **Los bots sobreviven a la estación:** corren con `setsid` y escriben en
  `~/.mubot/logs/<personaje>.log` (la pestaña Consola muestra las últimas 200 líneas). Al arrancar
  (y cada 2 s) la estación busca en `/proc` los `headless-bot.ts` de cada cuenta (`--user`,
  `--env-file`, `MUBOT_USER` o, sin nada, el `.env`) y los adopta con su `--ws-port`; uno sin
  `--ws-port` solo se puede desconectar. Desconectar = `SIGTERM` (el bot guarda el atlas y sale).
- **Nunca dos sesiones de una cuenta:** no lanza si ya corre un bot con esa cuenta, y con
  `--exit-if-in-use` el bot no insiste si la cuenta está abierta en el navegador: la estación lo
  muestra como "cuenta abierta". Igual cerrá la pestaña antes de conectar. Excepción: si se lo desconectó desde la
  estación hace menos de 90 s, va sin `--exit-if-in-use` (la sesión vieja todavía figura abierta y
  el bot reintenta con backoff).
- **Seguridad:** solo 127.0.0.1. `POST /api/do` exige `Origin` de la propia estación (si no, 403),
  `content-type: application/json` y un pedido de lista cerrada (`parseStationRequest`: `connect`,
  `disconnect`, `routine`, sin campos de más). No exponerla con ngrok ni similares.

**Probado:** tests offline, y la estación contra un server inexistente (lanzar, adoptar al reiniciar
la estación, desconectar, Origin ajeno rechazado). **Falta en vivo:** conectar contra el server real
y ver la rutina aplicada al entrar.

## Panel externo

`panel.html` (lo mantiene otra persona; no se toca desde el bot) se conecta al
WebSocket del bot y **todo lo saca del protocolo del juego**: anda igual sin
navegador ni cliente web. El contrato está en `panel-protocol.ts`, la lógica pura
en `panel-logic.ts` y el server en `ws-server.ts`.

```bash
# credenciales por env (MUBOT_USER / MUBOT_PASS / MUBOT_CHAR, de .env), nunca en el código
bun run bot --auto-seconds 0 --ws-port 8787
# otra cuenta: su propio archivo de env (está en .gitignore)
bun --env-file=.env.melu run headless-bot.ts --auto-seconds 0 --ws-port 8788
```

Abrir `http://127.0.0.1:8787/panel`. **Solo 127.0.0.1**: el server no escucha en
otras interfaces y rechaza (403) un WebSocket cuyo `Origin` no sea
`http://127.0.0.1:<puerto>` o `http://localhost:<puerto>` (sin esto, cualquier
página abierta en el navegador podía mandarle órdenes al bot). Clientes sin
`Origin` (un script local) se aceptan. No exponerlo con ngrok ni similares.

**HTTP (mismo puerto, solo GET):** `/` y `/panel` sirven `panel.html` de la raíz
(404 si no está). `/assets/<path>` sirve modelos y texturas para el 3D desde
`MU_ASSETS` (default `~/self/mu/public/game-assets`): solo `.glb .jpg .png .webp
.OZT .tga .ozj` (sin importar mayúsculas), `Cache-Control: max-age=3600`, la
ruta se resuelve y tiene que quedar adentro del directorio (path traversal → 404).

**WebSocket, bot → panel:** `hello` (`botVersion`, `commands`), `history`
(decisiones), `panel-state` (cada 1 s), `log` (órdenes, cambios de modo,
cacería), `command-result`, y los viejos `state`/`decision`.

`panel-state` sale de lo que el bot ya trackea:
- `char`: nivel, resets (contador local), HP/MP, stats, puntos, zen
  (`CharacterInformation` + `InventoryMoneyUpdate`), `classId` (bits altos del
  primer byte de apariencia del `CharacterList`, **sin verificar en 0.97d**).
- `mode` (`farm`/`hunt`/`scout`/`atlas`/`paused`/`resetting`/`connecting`/`dead`) y `doing`
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
acepta solo las 7 órdenes **con sus campos exactos** (un campo de más = rechazo);
mensajes de más de 4 KB se ignoran; nada se evalúa. Toda orden contesta
`command-result` con `{ok, msg}` en castellano y queda en el log del panel y en
el `--decision-log` (`kind: 'command'`; los cambios de modo, `kind: 'mode'`).
- `pause` / `resume`: en pausa el loop no camina, no pelea, no warpea ni
  resetea; las pociones siguen.
- `farm`: vuelve a la ruta normal (cancela la cacería, suelta el spot fijo y la pausa).
- `warp {warp}`: solo índices de `WARP_SPOTS` (y de `--spots` si se pasó), con
  su nivel; viaja con `warpTo` y el spot **queda fijo** (ni la ruta ni el
  hambre lo cambian; si muere vuelve ahí) hasta `farm`.
- `hunt {map?}`: cacería de dorados. Mapa pedido o el de más vivos según el
  último 0xFD al que pueda entrar: Lorencia (warp 2), Noria (3, nivel 10),
  Devias (6, nivel 20). Warpea (sin medir para el aprendizaje), recorre el mapa en
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

### Buscador (scout)

Un personaje (Melu, DW) **nunca pelea**: recorre una franja del mapa y avisa por
HTTP cada dorado que ve, para que otro (Horaz, en el navegador) lo vaya a matar.

```bash
bun --env-file=.env.melu run headless-bot.ts --allow-remote --proxy wss://mu.mormon.garden/ws \
  --cs-host mu.mormon.garden --cs-port 44405 --auto-seconds 0 --ws-port 8787 \
  --scout --scout-sector 1 --scout-sectors 2
```

- `--scout`: arranca en pausa (pociones sí), vuelve a Lorencia (warp 2, hasta 3
  intentos) y espera. Cuando llega un 0xFD con estado 1 sale solo a buscar, una
  vez por invasión, al mapa con más vivos (`chooseHuntMap`: Lorencia, Noria,
  Devias). En toda la corrida **no farmea ni pelea**: `resume`, `warp` y `hunt`
  se rechazan y `farm` solo termina la búsqueda y deja la pausa.
- Orden del panel: `{ cmd: 'scout', map?, sector?, sectors? }` (default franja
  1 de 2, `sectors` 1-16). `farm` o `pause` la terminan.
- Franjas: el mapa de 256 se parte en `sectors` franjas verticales por x
  (`scoutBand`); recorre solo las celdas de 25 tiles cuyo centro cae en la suya
  (`HuntExplorer` con `band`), la más cercana primero, celda visitada al llegar
  o a los 45 s; terminada la franja, otra vuelta.
- Sin golpes ni skills (ni `castOnTheWay`), sin loot, sin reset. Con HP < 50 %
  y sin pociones camina 5 tiles en sentido contrario al monstruo más cercano (≤ 6).
- **Corta sola y queda en pausa** (no farmea): 0xFD posterior al inicio con 0
  vivos en ese mapa, invasión no activa, o 20 min (`shouldStopScout`).
- `doing`: `buscando dorados en Noria (franja 2/2)`.

**Contrato `/gold`:** `POST http://127.0.0.1:8788/gold`, JSON, timeout 1,5 s,
errores ignorados (el receptor puede no estar):

```ts
{ from: 'Melu', map: 3, x: 140, y: 60, name: 'Golden Goblin', id: 77, at: 1760000000000 } // visto / se movió
{ from: 'Melu', map: 3, id: 77, gone: true, at: 1760000000000 }                            // murió o salió del scope
```

Un dorado nuevo se avisa ya (y una línea en el log); si se mueve, como mucho
cada 2 s por id con la última posición (`GoldReporter`). Al cambiar de mapa o
terminar, `gone` de todos los avisados. `id` es el id de objeto del server.

**Sin verificar en vivo:** probado offline (`panel-tests.ts`: franjas, payload,
reintentos/`gone`, corte, `isPanelCommand`) y `tsc`; no corrió contra el server
ni contra un receptor `/gold` real.

### Explorador (atlas)

Melu (DW) recorre mapas enteros **sin pelear** y anota qué aparece dónde, para
encontrar lugares de farmeo y dónde salen dorados o monstruos especiales (también
fuera de la invasión de cada hora).

```bash
bun --env-file=.env.melu run headless-bot.ts --allow-remote --proxy wss://mu.mormon.garden/ws \
  --cs-host mu.mormon.garden --cs-port 44405 --auto-seconds 0 --ws-port 8787 --atlas
```

- `--atlas-maps 0,3,2`: índices de mapa, en orden. Default: Lorencia 0, Noria 3,
  Devias 2, Dungeon 1, Lost Tower 4, Atlans 7, Tarkan 8. Se saltea (con una línea
  de log) lo que pide más nivel que el del personaje o no está en `ATLAS_WARPS`
  (`atlas.ts`). Warps (menú del cliente 0.97d / OpenMU): Lorencia 2 (nivel 10),
  Noria 3 (10), Devias 6 (Devias 3, 20), Dungeon 8 (30), Lost Tower 14 (50),
  Atlans 11 (70), Tarkan 21 (140). Icarus (23, nivel 170, pide alas) no va. Con
  Melu en ~120, Tarkan queda afuera.
- `--atlas-minutes-per-map 12` (default): tope por mapa; pasa antes si recorrió
  todas las celdas. Terminada la lista, otra vuelta (para siempre): cada vuelta suma datos.
- Igual que el buscador: **nunca pelea** (ni golpe, ni skill, ni `castOnTheWay`),
  no levanta loot, no farmea ni resetea. Con `--atlas`, `resume`, `warp`, `hunt` y
  `scout` se rechazan; `farm`/`pause` lo terminan y queda en pausa (`atlas` lo
  vuelve a arrancar). Sin `--atlas`, la orden `{ cmd: 'atlas' }` lo arranca en
  cualquier momento y `farm` vuelve a farmear.
- **Pociones antes de salir** (solo con `--buy-potions`; sin él no compra nada, ni farmeando ni
  en el atlas: el usuario no pidió compras) (y al empezar otra vuelta si se acabaron): va a
  Lorencia, habla con los merchants conocidos y los NPC de pueblo en scope, y en el
  primero cuyo catálogo (`StoreItemList`) tenga pociones de curación compra de a
  una (600 ms entre compras) hasta 40, grandes si hay, si no medianas, si no chicas
  (sin catálogo, `--buy-slot`). Cuenta una compra si llega `ItemBought` o baja el
  zen; dos fallos seguidos cortan. Loguea cuántas compró y el zen gastado. Si no
  pudo comprar, sale igual con la regla de huida más prudente.
- Recorrido: warp al mapa (hasta 3 intentos, 15 s entre intentos), celdas de 25
  tiles con `HuntExplorer` (la sin visitar más cercana, visitada al llegar o a los
  45 s). Hay un explorador por mapa que dura toda la corrida: la vuelta siguiente
  sigue por las celdas que faltaban, no vuelve a empezar cerca del warp.
- Supervivencia: pociones con HP ≤ `--heal-at` (60 %). HP < 50 % y un monstruo a
  ≤ 6 tiles: camina 5 tiles para el otro lado (sin haber podido comprar: < 70 % y
  ≤ 8). HP < 30 % y sin pociones: warp a Lorencia, 60 s de descanso y sigue con el
  mapa siguiente. Muerta: espera el respawn y vuelve a warpear.
- `doing`: `explorando Atlans (celda 12/100)`; `where.spot`: `atlas Atlans`.

**Qué anota** (`~/.mubot/atlas.json`, se suma entre corridas; se escribe como
mucho cada 30 s, al cambiar de mapa, al terminar y con Ctrl+C/SIGTERM):

```ts
{ version: 1,
  maps: { "<mapa>": { "<cx>,<cy>": { "<tipo>": { name, seen, lastSeen, sampleXY: [x, y] } } } },
  goldens: [{ map, x, y, type, name, at, duringInvasion, id }] }
```

- Celda = `floor(x/25),floor(y/25)`. `seen` = ids de objeto distintos vistos en
  esa celda por visita al mapa (el mismo monstruo en cada tick cuenta una vez; en
  la vuelta siguiente vuelve a contar: el server reusa ids al respawnear).
- `goldens`: cada dorado (`GOLDEN_TYPES`), sin repetir el mismo id en el mismo
  mapa dentro de 30 min. `duringInvasion` = el último 0xFD decía activa (y es de
  hace menos de 20 min). Además van a `/gold` como con el buscador (`GoldReporter`),
  para que el cazador de Horaz reaccione si está cazando.
- **`special` no se anota:** `data/monsters.json` no dice en qué mapa sale cada
  monstruo, así que no se puede saber qué es "fuera de lo normal" para un mapa. El
  atlas mismo es la base para deducirlo después.

`bun run atlas-report [ruta] [--top 8]`: por mapa, los más vistos y las zonas con
más monstruos, y todos los dorados con hora local, ordenados. Solo lee el archivo.

**Sin verificar en vivo:** probado offline (`atlas-tests.ts`, `panel-tests.ts`) y
`tsc`. No corrió contra el server: los warps de Dungeon/Lost Tower/Atlans/Tarkan,
la compra de pociones (catálogo, `ItemBought`, descuento de zen) y que el NPC de
pociones de Lorencia esté en scope al llegar por warp.

## Separar dúo y cacería del farmeo (2026-10-10)

- `duo.js` y `hunter.js` son opcionales y están en pausa. `browser-agent.js` y `tuner.js` no dependen de ellos.
- Los ciclos jugados en dúo o cazando llevan `tag` en `mubot-cycles:<pj>` y quedan fuera de
  `__ai.soloCycles()`. Lo mismo vale para el log de ciclos de `PLAN-FARMEO.md`.
- **Reinstalar `browser-agent.js` desconecta el autoajuste:** `tuner.js` queda colgado del objeto
  `__ai` viejo. Hay que volver a cargar `tuner.js` después. Si no, el agente arranca con los valores
  por defecto: Horaz "se puso tonto" al perder `roam=1` y `skillMinMp=0.05`.
- Los experimentos del autoajuste corridos en dúo (6:30–6:52 PM) adoptaron `roam=1` (+11 %) y
  `skillMinMp=0.05` (+37 %). Se mantienen porque Horaz farmeaba a su manera. El experimento
  `campRadius` que quedó a medias se descartó.
