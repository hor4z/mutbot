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
# (los tests se eliminaron a pedido del usuario el 2026-10-23; están en el historial de git)
bun run tsc         # typecheck (tiene que dar limpio)
bun run estacion    # la estación: http://127.0.0.1:8787/panel (ver "Estación")
bun run proxy       # proxy WebSocket -> TCP (127.0.0.1:3000; PORT/HOSTNAME para cambiarlo)
bun run bot         # un bot suelto: credenciales por .env (MUBOT_USER/PASS/CHAR)
```

Flags del bot: ver la cabecera de `headless-bot.ts` (conexión, `--auto-seconds 0` = sin límite con
reconexión y backoff, `--reset-level`, `--build`, `--stat-batch`, `--heal-at`, `--skills`, `--spots`,
`--ws-port`, `--decision-log`, `--exit-if-in-use`, `--list-chars`). **Un flag desconocido corta al arrancar con
código 2**: antes el bot arrancaba con defaults y se colgaba esperando `LoginResponse`.

`--exit-if-in-use`: si en el primer login la cuenta ya está conectada (la pestaña del navegador),
sale con código 3 en vez de reintentar. Un login rechazado que no se arregla reintentando sale con código 4 (cuenta bloqueada) o 5 (clave, cuenta o versión mal), y el personaje que no está en la cuenta (o la cuenta sin personajes en ese servidor) con código 6; la estación lo muestra y no lo reconecta. Después de un corte sí reintenta (el server tarda en soltar
la sesión vieja del propio bot). Lo pasa la estación.

## Estructura

La explicación completa (partes, flujo de un tick, cómo se coopera, cómo mejorar un bot) está en **`docs/arquitectura.md`**. Resumen:

El bot es un loop corto (`farm-loop.ts`, ~500 líneas) sobre módulos de protocolo y de decisión pura. Cada bot es un proceso;
la estación (`estacion.ts`) los lanza y los muestra. Cada bot farmea por su cuenta; se hablan directo por UDP (`bus.ts`) y la estación los mantiene vivos (las sombras se apagan con `MUBOT_SHADOWS=0`).

| Archivo | Qué es |
|---|---|
| `headless-bot.ts` | Entrada del bot: flags (cabecera), panel, `main`/`session` con reconexión y backoff, señales. |
| `farm-loop.ts` | El loop: ciego/trabas > buffs > sobrevivir > pausa/PK > warp pedido > ayuda > reset > ruta > loot > objetivo > pelear. |
| `help.ts` | Party: invita el más fuerte (por stats); si pasan 40 s sin party invita también el más débil (los roles se invierten con los resets). Reintenta rápido (15 s x4) y acepta resolviendo el nombre al responder. |
| `bus.ts` | Canal directo entre bots (UDP): posiciones, avisos de dorado y la orden del orquestador. |
| `alta-sync.ts` | Altas por el worker: la estación trae cada minuto las cuentas cifradas de `workers/edge`, las descifra y las suma a la base; también cifra/envía las del panel y crea la cuenta en el juego por el worker. |
| `state.ts` / `config.ts` | Estado compartido (`world`, `bot`, `learned`) y flags/ritmos humanos. |
| `connection.ts` / `world.ts` / `actions.ts` | Sockets y cifrado, parsers a mano del 0.97d, packets de salida. |
| `combat.ts` / `loot.ts` / `progress.ts` | Skills y pociones, drops, reparto de puntos y `/reset`. |
| `route.ts` / `learning.ts` | Warps, ruta fija por tramo (`maybeChangeSpot`), lo aprendido en `~/.mubot/learning.json`. |
| `directivas.ts` | **Directivas en caliente:** perillas de comportamiento que se cambian sin reiniciar los bots. Viven en `~/.mubot/directivas.json` (`{"global": {...}, "hume": {...}}`, lo del personaje pisa lo global); cada bot y la estación relee el archivo cuando cambia (~2 s) y el código lee `D.<clave>` en cada decisión. Esquema (`ESQUEMA`, con tipo, rango y descripción): `hunt`, `dragonAll`, `stayDragonMap`, `crew`, `claimCommons`, `huntMinLevel`, `cornerCrowdMax`, `cornerBanMin`, `shadows`. Se cambian con `curl -X POST http://127.0.0.1:8787/api/directivas -H 'Origin: http://127.0.0.1:8787' -H 'Content-Type: application/json' -d '{"scope":"global","set":{"crew":false},"unset":["huntMinLevel"]}'` (`scope`: `global` o un personaje; `GET` lista el esquema y lo guardado) o editando el archivo. Un valor inválido se ignora y el bot lo avisa en su log ("Directiva ignorada…"); nunca lo rompe. Para sumar una perilla: agregarla a `ESQUEMA` y leer `D.<clave>` donde decide. Cambia parámetros; para cambiar la *lógica* sin reiniciar, ver `ganchos.ts`. |
| `ganchos.ts` | **Lógica en caliente:** cada bot carga `~/.mubot/ganchos.ts` (o `MUBOT_GANCHOS`) y lo recarga cuando cambia (~2 s). Exporta funciones con el nombre de un gancho y reemplazan la decisión del repo: `elegirZona` (a qué zona de dragón ir), `dejarMapa` (motivo para dejar el mapa de la cacería) y `elegirDorado` (qué dorado pegar); lo que no exporta lo decide el repo. Devolver `undefined` = "no opino"; un error cae al repo en esa llamada y a los 3 seguidos apaga el gancho hasta la próxima recarga; un archivo con error de sintaxis deja el anterior. Plantilla con tipos: `ganchos.ejemplo.ts`. El archivo corre dentro del bot con sus permisos y `tsc` no lo revisa: es código propio, no traerlo de afuera sin leerlo. Para sumar un gancho: tipo en `Ganchos`, nombre en la lista de `recargar()` y envolver la decisión con `gancho(nombre, base)` donde se toma. |
| `dragon-fight.ts` | Registro de cada pelea con un dragón (`dragon_fight` en la base): segundos desde el aviso hasta verlo, hasta el primer golpe y hasta el final, golpes, nuestros y ajenos cerca, y si cayó (por quién) o se perdió de vista. `farm-loop.ts` lo alimenta. |
| `crew.ts` | Reparto del rastrillaje entre los que cazan juntos en un mapa: franjas contiguas por nombre (`bandsOf`, `crewRank`); `hunt.ts` y `HuntExplorer.setCrew/markSeen` lo usan. Un dragón es de todos (aviso `dragon` del bus, vienen aunque cacen en otro mapa); un dorado común lo deja el que lo tiene más cerca un compañero. |
| `camp.ts` / `farming.ts` / `explore.ts` / `power.ts` / `golden.ts` | Campamentos y objetivo por exp/s, exploración del mapa vacío, qué puede matar el personaje, regla de dorados. |
| `loop-ctx.ts` | Caminar con el terreno (`walkTowards`) y detectar trabas (`stuckSince`). |
| `estacion.ts` / `estacion-logic.ts` / `ui/` | La estación y su interfaz (`panel.html`/`estacion.html` se generan con `bun run ui:build`). |
| `scripts/watch.ts` | Monitor de la flota: posición, qué hace y alerta de "sin avanzar". |
| `net/`, `packets/`, `data/` | Copias del cliente MU JS: no reescribir (ver abajo). |

Historia: cacería automática, exploradores, esquina de Arena 2, defensa contra jugadores, escuadras con misiones, crianza,
agente del navegador y tests viven en el tag `pre-cerebro` y en el historial de git.

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

## Limitaciones y pendientes

Ver `docs/arquitectura.md`.
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
## Worker de Cloudflare (`workers/edge`, monorepo con Bun workspaces)

El repo es un monorepo chico: el bot vive en la raíz y `workers/edge` es un worker de Cloudflare. `bun run tsc` chequea los dos.
- **Altas en dos pasos (panel, "+ Agregar cuenta"):** 1) `POST /api/cuenta` {user, pass}: el worker registra la cuenta en el juego
  (`/api/register` del servidor; ahí ve la clave en claro por TLS, sin guardarla; tope de 5 por hora) y la estación la guarda en la base
  **sin personaje y sin tarjeta**. 2) `POST /api/personaje` {user, char, cls}: se elige una cuenta sin personaje, el nombre y la clase
  (dk/dw/elf/mg); aparece la tarjeta y el bot crea el personaje en el juego al conectarlo (`MUBOT_CREATE_CLASS`, paquete `F3/01`; el Magic
  Gladiator pide un personaje de nivel alto en la cuenta). Una tarjeta fallida por "no tiene ese personaje" ofrece "Crear personaje…" (pone
  la clase al personaje que ya figura). La tercera pestaña ("Ya existe") agrega cuenta y personaje que ya existen: `POST /api/alta` cifra
  los datos (RSA-OAEP) y los deja en la cola (KV) del worker; la estación los trae, los descifra con su clave privada
  (`~/.mubot/alta/private.jwk`) y hace `db.addChar`. Todos los POST exigen el Origin de la propia estación.
- **Servidor por personaje (Fast / Slow):** las cuentas valen en los dos servidores del juego; los personajes son de uno solo. Columna `characters.server` (`fast` por defecto). Se elige al crear el personaje (paso 2 del alta: `POST /api/personaje {user, char, cls, server}`) y se cambia en la tarjeta (selector "Servidor", `POST /api/do {action:'server', char, server}`); se aplica al próximo conectar. Es independiente de "Conexión" (Directa / Proxy): cualquier combinación. Los datos salen de `SERVERS` en `estacion-logic.ts` (el cliente web los lista como "Servidor Fast" y "Servidor Slow (Beta)"): Fast = `wss://mu.mormon.garden/ws`, `mu.mormon.garden:44405`; Slow = `wss://slow.mu.garden/ws`, connect server `clasico:44405`. El worker llega a los dos: el host `clasico` sale por `SLOW_UPSTREAM_HOST` (`workers/edge/wrangler.toml`; `ALLOWED_HOSTS` incluye `clasico`); probado el 2026-10-25 abriendo el connect server de los dos por los 3 workers. Un personaje que no existe en el servidor elegido sale con el código 6 ("no tiene ese personaje en este servidor"); el bot lo crea al entrar si la tarjeta trae clase. El nombre del personaje sigue siendo único en la estación (la clave de la tarjeta): el mismo nombre en Fast y Slow no se contempla. La pestaña "Personaje existente" del alta (por el worker, cifrada) no lleva servidor: queda en Fast y se cambia en la tarjeta. Sin probar en vivo un bot contra el Slow desde la estación (el Slow dio `NoChargeInfo` con Zamu, ver arriba).
- **Workers de respaldo del proxy:** `MUBOT_PROXY_URLS` en `.env.alta` (URLs separadas por coma) suma workers extra además de `MUBOT_ALTA_URL`. Son el mismo `workers/edge` desplegado con otro nombre y solo con el secreto `PROXY_TOKEN` (`bunx wrangler deploy --name mutbot-edge-2` y `bunx wrangler secret put PROXY_TOKEN --name mutbot-edge-2 < ~/.mubot/alta/proxy-token`); sin los otros secretos, el formulario y las altas quedan cerrados ahí. La estación comprueba cada 30 s cada worker con un GET sin upgrade a `/p/<token>/ws` (426 = vive y acepta el token; no abre nada contra el juego) y `proxyUrl()` entrega el primero que respondió, en el orden del principal y los respaldos. El cambio se nota al próximo conectar o reintentar. Si un bot que va por proxy sale sin haber entrado al juego (error de conexión, no un rechazo: códigos distintos de 0/2/3/4/5/6), esa estación salta ese worker 2 min y lo reconecta enseguida por el siguiente (`proxySwaps`, una vuelta por la lista). No está medido que otro worker dé otro cupo de conexiones: Cloudflare puede salir con la misma IP.
- **Servidor en el bot y en los datos:** la estación pasa `MUBOT_SERVER=fast|slow` (`config.ts` exporta `SERVER_KEY`; sin la variable se deduce del connect server `clasico` = Slow). `telemetry.ts` marca cada fila con `server` (columna nueva en `ticks`, `events`, `players_seen` y `ranking`, por defecto `fast`: lo anterior es todo Fast). Las vistas de `db/views.sql` filtran `server = 'fast'`, y `queryDb` devuelve `[]` en un bot que no es Fast: no decide con conocimiento del otro servidor. `MUBOT_MATES`, los pares del canal UDP y el reenvío de la estación son solo entre personajes del mismo servidor. Una sola base ClickHouse, un solo esquema.
- **Estrategia por servidor (`strategy.ts`):** costura entre `farm-loop.ts` y lo que cambia según `SERVER_KEY`: `hunts`, `resets`, `spendsPoints` y `choosePlace()`. La del Fast es el código de siempre sin cambios (`place.ts`, `progress.ts`, `hunt.ts`). La del Slow (v1.1, medida en la sesión del 2026-10-25): sin cacería ni `/reset`; sube por spots **de Lorencia** (`slowPlace`): Spiders hasta el nivel 12 (200,137), Bull Fighters hasta el 45 (165,55) y Giants desde el 45 (30,22), ~26.000 exp por kill. El ancla de los Giants es (30,35) con radio 30 (la celda más densa de avistamientos es (30-40, 40-50)). `targetValue` elige el monstruo de más valor por distancia (`exp / (d + 8)`, Giant 26.000 contra 3.000 el resto) en vez del más cercano: medido el 2026-10-25, el bot rendía 430.000 exp/min con Giants y 65.000 cuando se ponía con Bull Fighters. Los Giants del Slow viven en Lorencia, no en Devias (la v1 mandaba a Devias 4 y no había monstruos), levanta Zen, pociones, equipo y joyas (`lootAll`, `jewels`) y reparte los puntos 50 % Str, 40 % Vit, 10 % Agi (`slowStatPlan`: sin pociones la vida es lo que falta). Para una decisión nueva que difiere: un campo en `Strategy`, las dos estrategias la definen y el bucle lee `strategy.<campo>`. La estrategia propia del Slow se arma con lo que se aprenda jugando y con sus datos (`server = 'slow'` en ClickHouse). **Sombras:** el orquestador de la estación agrupa por servidor (cada uno tiene su líder y sus sombras; un personaje del Slow no es sombra de uno del Fast). **Joyas:** `jewels` en `Strategy` (Fast `false`, Slow `true`). En el Fast las joyas no valen para comerciar y no se levantan (salvo personaje nuevo); en el Slow son lo más valioso (indicación del usuario, 2026-10-25): `isValuableDrop` las acepta siempre (`lootPolicy.jewels`, farming.ts) y `pickLoot` les da la misma prioridad que a las cajas. Sin probar en vivo un bot Slow de la estación.
- **Aprender del cliente web (`scripts/decode-frames.ts`):** para ver qué hace el cliente real en el Slow y pasarlo al bot, se registran los frames del WebSocket de la página (se parchea `WebSocket.prototype.send` desde `javascript_tool`, guarda `{d:'in'|'out', t, h}` y los manda en lotes a un receptor local) y `bun scripts/decode-frames.ts frames.ndjson [--list|--code <hex>]` los descifra con el mismo cifrado y tabla de rutas que `net/socket.ts`. Solo se descifran los entrantes; los salientes se cuentan. El cliente web no expone su estado (módulos minificados, sin source maps): se aprende por paquetes, no por la página. `bun scripts/analyze-session.ts frames.ndjson` saca de esos frames la exp por kill y por tipo de monstruo, exp/min y subidas de nivel. `bun --env-file=.env.db scripts/ingest-frames.ts <personaje> <crudo.ndjson> [puerto] [servidor]` es el receptor en vivo: la página le manda los frames por POST (`fetch` con `no-cors` a `127.0.0.1`) y los guarda en ClickHouse con `server = 'slow'` (eventos `kill`, `level_up`, `drop`, `item_added`, `shop_list`, `shop_buy`, `shop_sell`, `server_msg`, `chat`, `map_change` y un `tick` cada 5 s), más el crudo para reprocesar. `bun scripts/shops.ts frames.ndjson` lista lo que vende cada tienda que se abrió durante la sesión (StoreItemList; sin precios: los calcula el cliente). Primera lectura (2026-10-25, NPC de Devias): Apple, Small/Healing/Large Healing Potion, Small/Mana/Large Mana Potion, Antidote, Town Portal, Arrows y Bolt. El bot todavía NO compra ni vende (no hay código de tienda): la rutina de pueblo (comprar pociones y equipo, vender lo viejo) está por hacer. Registrando a mitad de sesión el contador de secuencia del descifrador no coincide (`ok` falso) pero el contenido es válido: se usa igual. Primera medición en el Slow (2026-10-25, Capitan nivel 48 → 64 en ~12 min): Giants ~26.000 exp por kill, ~140.000 exp/min de promedio y 200.000-300.000 en los mejores minutos, un nivel cada 20-30 s.
- **Proxy WebSocket:** `wss://<worker>/p/<PROXY_TOKEN>/ws?host=&port=` reenvía solo a `ALLOWED_HOSTS`. Los bots no lo usan por defecto
  (`MUBOT_PROXY` lo activa).
- **Secretos:** `bun run alta:keys` genera claves y tokens en `~/.mubot/alta/` (0600, no los imprime); `MUBOT_ALTA_URL` va en `.env.alta`
  (git lo ignora). Pasos de despliegue en `workers/edge/README.md`.
- **Control de la conexión:** mientras un bot espera cupo, la tarjeta ofrece "Cancelar" (deja de intentar y sale de `wanted.json`) y "Reintentar ahora" (`POST /api/do {action:'retry'}`: corta el intento y lanza otro sin el backoff; se niega si el bot ya está en el juego).
- **Tipo de conexión por personaje:** cada tarjeta tiene un selector "Conexión: Directa / Proxy" (`POST /api/do {action:'conn', char, mode}`), guardado en `~/.mubot/conn.json`. Se aplica al próximo conectar (o a "Reintentar ahora"); si el bot ya corre con otra, la tarjeta avisa. "Proxy" arma la URL con `MUBOT_ALTA_URL` (`.env.alta`) y `~/.mubot/alta/proxy-token`; sin eso se deshabilita y `connect` se niega en vez de caer en directa. `MUBOT_PROXY` sigue siendo el proxy por defecto de la opción "Directa". `net/socket.ts` (copia del cliente) imprime la URL del WebSocket, así que el token queda en los logs de los bots: limpiarlos o rotar el token. En la prueba del 2026-10-24 un tercer personaje entró por el proxy mientras Hume y Zamu estaban directos: el límite de 2 conexiones parece ser por dirección de origen.
- **Límite del servidor:** deja 2 conexiones a la vez (`ServerIsFull` al tercero). El panel muestra el motivo en la tarjeta ("Servidor
  lleno: reintento en N s") y no dibuja el mapa de un personaje que todavía no entró al juego.

## Personajes nuevos, worker y Slow (2026-10-24)

> **2026-10-25:** el algoritmo de lugar/loot/stats (`place.ts`, `farm-loop.ts`, `farming.ts`, `loot.ts`, `progress.ts`, `zones.ts`, `state.ts`, `help.ts`, `bus.ts`) volvió al de la tarde del 24 (PR #48): sin carreo, sin reparto de a 10, sin zen obligatorio ni orden `follow`. El carreo y lo demás de esa sesión (zen siempre, Roamer, seguir a un humano) hacían que Hume y Zamu perdieran exp (juntaban zen con ~2.100 M y bajaban a buscar a una sombra débil). La versión anterior está en el commit `950e59e`. Encima se agregó (`place.ts`): **esquina llena** — si estando en la esquina de Arena 2 el bot ve >= 4 jugadores cerca (los nuestros incluidos; `CORNER_CROWD_MAX`), busca otra Arena 8 min (Arena 4, después 3, si `canFarmMonster` lo permite) y se para en la "primera jaula a la derecha" de la llegada (`ARENA_CAGE`: +18, −2, radio 10; dato del usuario: nunca hacia el norte; sin probar en vivo). Una cuenta juega con un solo personaje a la vez (la estación lo avisa en la tarjeta y no reconecta al otro) y la estación reenvía los paquetes de posición entre los bots, porque los pares del bus se fijan al lanzar.

Ver también [HANDOFF.md](HANDOFF.md) (estado y aprendizajes de esa sesión).
- **Creación de personaje:** `MUBOT_CREATE_CLASS` (lo pasa la estación desde `characters.class`): si el personaje no está en la cuenta, el bot lo crea al entrar (`world.ts`, F3/01).
- **Worker:** el proxy WebSocket devuelve el `fetch` del servidor sin reenviar mensajes (si no, agota los 10 ms de CPU del plan gratuito a los ~20 s). `net/socket.ts` imprime la URL del WebSocket (con el token).
- **Slow (Beta):** proxy `wss://slow.mu.garden/ws`, connect server `clasico:44405`, game `clasico:55901`. El login de una cuenta del Fast devolvió `NoChargeInfo` (9); hipótesis sin confirmar: solo VIP.

## Datos y aprendizaje (ClickHouse)

> **Dónde vive:** `MUBOT_DB_URL` (en `.env.db`, no se commitea) apunta a otro equipo de la red (la IP está en `.env.db`), no a `127.0.0.1`. Si "no responde", probá esa URL antes de levantar nada en local (el 25/10 se creyó caído por consultar `127.0.0.1`). Para consultar: `curl -u "$MUBOT_DB_USER:$MUBOT_DB_PASSWORD" "$MUBOT_DB_URL/?database=mubot" --data-binary "SELECT ..."` con `.env.db` cargado.


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
