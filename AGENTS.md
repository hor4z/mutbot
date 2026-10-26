# mubot

Bot de **MU Online 0.97d para el servidor Slow**: hace que un personaje (Capitan) **progrese solo** (pelea, sube de nivel, reparte
puntos, levanta botín) hablando el protocolo real del cliente, sin navegador. Aprende dónde farmear y a quién pegarle a medida que
juega. Se maneja desde la estación (`bun run estacion`, `http://127.0.0.1:8787`).

Este documento es la referencia del proyecto. `CLAUDE.md` lo apunta acá. Si algo difiere del código, **el código gana**: corregí el
documento en el mismo cambio.

## Alcance y límites

Esto corre **solo contra la infraestructura propia del usuario**. Guardas en el código:

- `--allow-remote` es obligatorio para apuntar a hosts no locales. Sin eso, el bot se niega a arrancar si el proxy o el connect
  server no son loopback/RFC1918.
- Los ritmos son deliberadamente humanos y hay comentarios que lo explican. **No los bajes para "optimizar".** Ver "Anti-cheat".
- Nunca flood, nunca brute force, nunca dos sesiones de la misma cuenta. Nunca correr el bot con una cuenta que el usuario tenga
  abierta en su navegador (el bot va con `--exit-if-in-use`: si la cuenta está en uso, sale con código 3).
- Una cuenta desconectada desde el panel es el usuario jugando a mano: la estación no la reconecta sola.

**Solo Slow, un solo personaje.** Todo lo del servidor Fast (resets, cacería de dorados, esquina de Arena 2, sombras, orquestador,
varias cuentas) se archivó: tag `fast-final`, rama `archive/fast` y los datos en `~/.mubot/archivo-fast/`. No traer ideas de ahí sin
medirlas en el Slow: son estrategias de otro juego (exp rápida, resets).

## Comandos

```bash
bun run tsc          # tipos (bot, UI y worker): tiene que quedar limpio antes de dar algo por terminado
bun run estacion     # estación + panel en http://127.0.0.1:8787 (conecta y mantiene vivo al personaje)
bun run bot          # el bot suelto (lo normal es lanzarlo desde la estación)
bun run db:up        # ClickHouse local (docker); la base real está en el servidor de .env.db
bun run db:migrate   # aplica las migrations pendientes de db/migrations/ (crea la base `mubot_slow` si falta; no toca `mubot`, la de Fast)
bun run db:seed      # carga los datos del juego de db/seeds/ (solo si cambiaron; --force para recargar)
bun run db:status    # qué migrations y seeds están aplicados
bun run db:init      # migrate + seed
bun run db:importar  # una vez: pasa a la base lo que vivía en ~/.mubot (personaje, directivas, token) y archiva esos archivos
bun run ui:dev       # UI con HMR de React (proxy a la estación)
bun run ui:build     # compila la UI a estacion.html (un solo archivo que sirve la estación)
MU_SRC=~/self/mu/src bun run extract   # regenera packets/ (generado: no se edita a mano)
```

Los tests se eliminaron a pedido del usuario (2026-10-23; están en el historial de git).

## Estructura: núcleo y cerebro

El bot son dos capas (`hot.ts`). El **núcleo** queda siempre vivo y conectado; el **cerebro** se recarga solo cuando cambia un archivo,
**sin desconectar** (se ve en el log: `Cambió el cerebro: lo recargo sin desconectar`).

| Capa | Archivos | Qué hace |
| --- | --- | --- |
| Núcleo | `headless-bot.ts`, `config.ts`, `state.ts`, `db.ts`, `gamedata.ts`, `connection.ts`, `world.ts`, `actions.ts`, `events.ts`, `chat.ts`, `liveness.ts`, `protocol097.ts`, `terrain.ts`, `telemetry.ts`, `journal.ts`, `panel.ts`, `panel-logic.ts`, `panel-protocol.ts`, `ws-server.ts`, `directivas.ts`, `loot-state.ts`, `hot.ts`, `net/`, `packets/` | sesión, protocolo, estado del mundo (`world`, `bot`), panel, base |
| Cerebro | `brain.ts` (entrada), `farm-loop.ts`, `area.ts`, `learning.ts`, `combat.ts`, `power.ts`, `loot.ts`, `loop-ctx.ts`, `progress.ts`, `shop-scout.ts`, `path.ts`, `farming.ts`, `spawns.ts`, `warps.ts` | qué decide: dónde farmear, a quién pegar, qué skill, puntos |

Reglas de la recarga:

- El núcleo **nunca importa el cerebro**: lo que el panel y la telemetría necesitan lo instala el cerebro en `hooks` (`state.ts`) desde
  `brain.ts` (`install`). El estado compartido (botín, mundo) vive en el núcleo para sobrevivir a la recarga.
- Un archivo nuevo del cerebro hay que sumarlo a `BRAIN` en `hot.ts`. Si no compila o falla al correr, el bot se queda con el cerebro
  anterior y lo avisa. Un cambio en el núcleo **sí pide reiniciar** el bot (el log lo avisa).
- Las perillas numéricas se cambian sin tocar código: `POST /api/directivas` o la tabla `directives` de la base (`directivas.ts`; el bot la relee cada 5 s).

## Cómo decide el bot (`farm-loop.ts`, un tick = una decisión)

1. Que no esté roto: ciego (3 min sin monstruos o sin exp: reconecta), trabado (15 s sin moverse), vida baja (huye al pueblo y descansa
   hasta el 70 %), pausa.  2. Repartir puntos (`progress.ts`, plan en `area.ts`).  3. Ir a la zona que toca (`area.ts`).
4. Levantar botín (`loot.ts`).  5. Pegarle al monstruo de más valor del área (`valueOf` / distancia).

**Sin spots fijos.** `area.ts` elige y aprende la zona mientras juega: candidatas = celdas de spawns que el personaje aguanta
(`power.ts`) más lo que ve en pantalla (los monstruos custom del server no están en `spawns.json`); si hay zonas medidas elige la que más
exp/min dio, y a veces prueba una sin medir; una zona vacía 45 s se marca vacía un rato; donde murió se evita una hora; sin zonas en el
mapa cambia de mapa por warp. `learning.ts` mide la exp real de cada kill por tipo de monstruo (`valueOf`). **Cada decisión se explica**
con `decide()` (`journal.ts`): va al log, al panel y a la base.

Skills: `combat.ts` usa el primero de `ATTACK_SKILL_POOL` (`config.ts`) que el personaje conozca **y le alcance el maná**: Twisting Slash
(41, área) primero, después Cyclone (22), etc. Sin maná, pega a mano.

## Estación y panel

`estacion.ts` (un personaje, tabla `character` de la base con `{ user, pass, char }`): lanza el bot detached (`~/.mubot/logs/<char>.log`),
lo adopta si ya corre, lo mantiene vivo con espera creciente, y sirve el panel y la API. Solo 127.0.0.1; los POST exigen el Origin
propio y JSON. La conexión va siempre por el worker (`workers/edge`; URL y token en la tabla `settings`: `worker_url`, `proxy_token`). El estado "lo quiero conectado" es el ajuste `wanted`.

| Ruta | Qué |
| --- | --- |
| `GET /`, `/panel` | el panel (`estacion.html`, generado por `bun run ui:build`) |
| `GET /api/state` | estado de la estación y del bot (`PanelState`, `panel-protocol.ts`), cada 1 s |
| `POST /api/do` | `{action:'connect'|'disconnect'|'retry'}` o `{action:'order', command}` con `pause`, `resume`, `town` |
| `GET/POST /api/directivas` | perillas en caliente |
| `GET /api/log`, `/terrain/<mapa>` | últimas líneas del log; terreno del radar |

La UI (`ui/src`, React + Tailwind 4 con el tema de sherpa en `index.css`) muestra el estado, el radar y el feed de decisiones. El bot
habla con la estación por un WebSocket local (`--ws-port 8791`, `ws-server.ts`): estado cada 1 s y órdenes de lista cerrada.

## Datos, migrations y seeds

**Nada vive en archivos locales**: ni la configuración, ni el estado, ni los datos del juego. Todo está en ClickHouse, base **`mubot_slow`**
(la `mubot` del mismo servidor es el archivo de Fast y no se toca). Lo único local son los logs (`~/.mubot/logs`), la caché binaria del
terreno y las credenciales de la conexión a la base (`.env.db`: `MUBOT_DB_URL/USER/PASSWORD`, y `MUBOT_DB_NAME`, por defecto `mubot_slow`).

- **Migrations** (`db/migrations/`, las aplica `bun run db:migrate`, registro en `schema_migrations`): `NNNN_nombre.sql` se aplican en orden y no se
  editan una vez aplicadas (se agrega otra); `R__nombre.sql` son repetibles y se re-aplican cuando cambian (las vistas, `R__views.sql`).
  `0001` telemetría, `0002` configuración (`directives`, `character`, `settings`), `0003` datos del juego.
- **Seeds** (`db/seeds/`, los carga `bun run db:seed`, registro en `schema_seeds`): los datos del cliente web, que el bot lee al arrancar
  (`gamedata.ts`): `monsters` (353, con los custom del Slow, de la constante `xMt` del bundle de `mu.mormon.garden`), `skills`, `items` y
  `spawns` (el `spawns.json` del repo del cliente: es el estándar y no ubica los monstruos custom). Cada seed vacía su tabla y la rellena; solo
  corre si el archivo cambió. Sin los datos el bot no arranca (espera a la base): `gamedata.ts` los carga con reintentos.
- **Configuración**: `directives` (perillas en caliente), `character` (cuenta, clave y personaje; la clave va en texto plano, decisión del
  usuario porque la base está en su red) y `settings` (`worker_url`, `proxy_token`, `wanted`). Son ReplacingMergeTree por `updated_at` y se
  leen con `argMax`; `db.ts` tiene las funciones (`readDirectives`, `readCharacter`, `readSettings`…).

Telemetría: `telemetry.ts` manda `ticks` (cada 5 s: posición, exp/min, skill, zona), `events` (`decide`, `kill` con su exp, `death`, `flee`,
`monster_seen`, …) y `players_seen`, por lotes y sin frenar el juego. Vistas: `v_cell_rate` (exp/min por zona de 16×16), `v_deaths`,
`v_kill_value` (exp por tipo de monstruo), `v_skill_rate`, `v_outcome` (exp/min antes y después de cada decisión), `v_monsters`.
`scripts/report.ts` resume una hora.

## Reglas de código

- `packets/` es generado. `net/utils.ts` y `net/encryption/` son copias literales del cliente: no reescribirlas (una versión "más limpia"
  ya rompió el cifrado y el parseo de skills).
- Prioridad al estilo del código que rodea: comentarios en español, el porqué antes que el qué.

## Historia del protocolo

Lo que sigue se capturó jugando y **sigue valiendo para el Slow** (mismo cliente 0.97d). Los ejemplos con resets, Arenas o dorados son
del Fast archivado.

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


### Stats (capturado)

Todo por **chat** (`C1 len 00 <nombre 10 bytes> <texto>`): `/add <stat> <n>` reparte n puntos de una vez (`str`, `agi`, `vit`, `ene`
confirmados). **Tope por stat: 65535**: `capStats` manda lo que no entra a los otros. El server contesta con un `CharacterInformation`
completo (F3/03). Si el server no toma el reparto, `progress.ts` espera 15 min antes de reintentar.

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
Desde el baúl: `buildMoveItem(2, casillaBaúl, ítem, 0, casillaBolsa)` (`protocol097.ts`; depósito 2 = baúl, 3 = Chaos Machine, de los `placePickedItem`/`autoMoveItem` del cliente web). **Sin verificar en vivo desde el headless.**

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

## Anti-cheat

`SpeedHackDetectPlugIn`: delay base de ataque 450ms + token bucket de 5.

Ritmos actuales: caminata 380ms, ataque 500ms, skills 900ms, ventas 600ms.
**Son deliberados.** Bajarlos hace que el bot sea detectado.

**No tocar `SpeedHackDetectPlugIn` ni la configuración del server para que el bot
vaya más rápido.** El objetivo es saber si el server valida, no hacerlo pasar.
