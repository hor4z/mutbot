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

# Tests offline (no tocan el server): packet-tests.ts + learning-tests.ts.
bun run test

# Typecheck (tiene que dar limpio)
bun run tsc

# Proxy WebSocket -> TCP (escucha en 127.0.0.1:3000; PORT/HOSTNAME para cambiarlo)
bun run proxy

# El bot: login + loop autónomo que progresa el personaje.
bun run bot --user <u> --pass <p> --char <c> \
  --auto-seconds 600 \
  --build str,vit \
  --decision-log /tmp/decisiones.jsonl \
  --ws-port 8787
```

Flag inexistente = el bot arranca con defaults y se cuelga esperando `LoginResponse`.
Los reales son `--user`, `--pass`, `--char` (no `--account`/`--character`). Esto ya
pasó una vez y costó tres intentos de debugging.

## Estructura

| Archivo | Qué es |
|---|---|
| `headless-bot.ts` | El bot. Login, mundo, loop autónomo, economía, capa de decisión. |
| `ws-server.ts` | Telemetría por WebSocket (solo lectura), detrás de `--ws-port`. |
| `packet-tests.ts` | Tests offline de parsers y builders. Sin red. |
| `learning.ts` | Capa de aprendizaje (lógica pura): medición por spot, bandit UCB1, persistencia. |
| `learning-tests.ts` | Tests offline de `learning.ts` (usa un dir temporal, sin red). |
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
  `../src/`. No reescribirlos.
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
levanta un WebSocket de **solo lectura** que manda `hello`/`history` al
conectar, y después `state` (snapshot de `world`, ~1/seg) y `decision` (cada
vez que `decide()` corre). Probado contra el server local: `hello`/`history`/
`state` llegan bien a un cliente de prueba. **No tiene canal de control**
(aprobar/rechazar desde afuera) — `decisionHandler` sigue aprobando todo por
defecto, sin cambios. Conectar un control real (que una UI apruebe/rechace
`autoOk:false` en vivo) queda pendiente, ver la sección de abajo.

**Loop autónomo — explorador y prioridad de loot (ajustado jugando en vivo):**
- El "explorar cuando no hay nada que hacer" caminaba al azar recalculando
  dirección cada 4-9 pasos — en la práctica no se alejaba del punto de
  partida (confirmado: ~160s de exploración solo desplazaron al personaje
  ~24 tiles en línea recta). Ahora compromete una dirección mucho más tiempo
  (`EXPLORE_RUN_STEPS=25`) y gira 90° (no recalcula al azar) si choca contra
  algo. Ayuda, pero **no resuelve** el caso de un personaje encerrado por los
  muros del pueblo — ver "Viaje entre mapas (gates)" abajo.
- **Bug real:** en una zona con mucho loot acumulado (de otros jugadores), el
  bot se quedaba recogiendo para siempre y nunca llegaba a elegir/atacar un
  monstruo aunque hubiera uno al lado — "recoger loot" tenía prioridad
  absoluta sobre pelear. Arreglado: no se interrumpe un combate ya en rango
  de golpe para ir a recoger.
- **Prioridad al elegir qué drop levantar** (`dropPriority()`): dinero (no
  ocupa slot) > equipamiento/grupo desconocido > basura confirmada. Todavía
  no hay forma de "dropear" basura al piso (packet nuevo sin verificar), así
  que la basura se sigue levantando para vender, solo que de última
  prioridad.
- `MUBOT_DEBUG_NPCS=1` (variable de entorno): loguea TODOS los NPCs en scope,
  pasen o no el filtro `MONSTER_TYPE_NUMBERS`, con su `TypeNumber`. Se usó
  para confirmar que los tipos `247`/`249` que veía `melu` son los guardias
  del pueblo (`Crossbow Guard`/`Berdysh Guard`, nivel 90, filtrados a
  propósito), no un bug del filtro.
- `MUBOT_DEBUG_COMBAT=1`: loguea distancia al objetivo cada 5 ticks y cada
  intento de golpe. Se usó para diagnosticar el problema de combate de abajo.

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
cambia), con una entrada por personaje (`--char`): `{ resets, samples[] }`.
Escritura atómica (tmp en el mismo dir + `rename`); cada save relee el archivo y
reemplaza solo la entrada de su personaje, así dos bots con personajes
distintos no se pisan. Archivo ausente = empieza de cero. Archivo corrupto =
empieza de cero y el original se renombra a `learning.json.corrupt-<ts>`.
Muestras mal formadas se descartan una por una. Tope de 2000 muestras por
personaje (quedan las últimas). `resets` es un **contador local** (se suma
cuando `doReset()` termina bien): no hay un packet de resets que sepamos
parsear todavía.

**Cómo decide (`chooseSpot`, bandit UCB1).** Cada ~50 ticks `maybeChangeSpot()`:
1. Candidatos: spots con `reqLevel <= nivel`, limitados por `--spots`.
2. Datos: se ponderan las muestras por cercanía de nivel (triangular, ±40
   niveles; más lejos no cuentan) y las de otro reset pesan la mitad. Tasa
   efectiva = `exp / (minutos + muertes × 3)`: cada muerte cuesta 3 minutos de
   farmeo.
3. Permanencia mínima de **5 min** en el spot antes de evaluar cambio (cada
   warp cuesta zen). Excepción: si el spot actual dejó de ser elegible (reset,
   `--spots`) o no hay spot actual (arranque, muerte, reset), decide ya.
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
(`no-data`/`explore`/`exploit`/`ineligible`), la tabla y los puntajes UCB.
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

## Combate: dos bugs reales arreglados, uno sin resolver

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

Todo por **chat** (`C1 len 00 <nombre 10 bytes> <texto>`):
- `/add <stat> <n>` reparte n puntos de una vez. Confirmados `str`, `ene` y `vit`
  (3000 puntos post-reset repartidos con 3 comandos); `agi` sin probar todavía. El server contesta con un
  `CharacterInformation` completo (F3/03) y `CharacterResets` (`C1 06 FE 00 ..`).
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
- `TargetedSkill095` (0x19) manda el **número** de skill, no el índice.
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

`data/monsters.json` **solo tiene monstruos, ningún NPC**. No hay forma de
saber de antemano qué Id es un merchant. Los TypeNumbers que "matchean" con un
monstruo son coincidencia.

Por eso el bot descubre: habla con los NPCs que ve en scope y lee qué ventana
conteste. `NpcWindowResponse.Window` `Merchant=0` / `Merchant1=1` son las de venta.
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
- **No hay reconexión ni backoff.**
- **Las stats locales se pueden desincronizar.** `CharacterLevelUpdate` no trae
  los valores de stat; los valores reales nunca llegan, así que el tracker cuenta
  por su cuenta.
- **No hay inversión de master skill points**, que era parte del objetivo original.
  Falta definir el build y los requisitos.
- **El inventario no trackea cantidad.** Solo `slot/group/num`, así que no puede
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
  en una caja de ~20x20 tiles cerca del spawn (confirmado: `EXPLORE_RUN_STEPS`
  más largo y giro de 90° al chocar no alcanzan, sigue sin poder salir). Sin
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