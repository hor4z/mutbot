# Revisión del código (2026-10-23)

Solo lectura: no se tocó comportamiento. Base: `main` en `f886842`. Los números de línea son de ese commit.
Lo que no pude comprobar sin tocar bots vivos está marcado **(verificar)**.

Resumen en una línea: el loop (`farm-loop.ts`, 1497 líneas) es una cadena de ~25 `if ... continue` donde **cada módulo
agregado después (cacería, equipo, escuadra, espera en Lorencia, guardián, explorador) se enganchó sin saber de los
otros**, y comparten un único `bot.pinnedSpot`, un único `bot.hunting` y un único `bot.pendingWarp`. Ahí nace la
descoordinación.

---

## 1. Conflictos de control en el loop

### 1.1 Orden real de prioridades de un tick (`autonomousLoop`, `while` en farm-loop.ts:484)

Cada punto puede terminar el tick con `continue`. Marco con **[MUEVE]** lo que puede caminar, warpear o cambiar de objetivo.

1. 485 `refreshAttackable` (filtra monstruos; decide `limited`, ver 1.4).
2. 503-516 Vigía "ciego": sin monstruos o sin exp 3 min -> `closeSockets()` y reconecta. **[MUEVE: reconecta]** (apagado si `squadShadow()`).
3. 519-587 Vigía de trabas (`watchdog.ts`): remedios `rewarp`/`warp_town`/`drop_target`/`leave_camp`/`reconnect`. **[WARPEA]** (apagado si sombra).
4. 595-607 Buffs propios: Soul Barrier (mago) y Swell Life (DK), con `sleep`.
5. 609 `checkSurvival` (solo pociones; no mueve).
6. 615-625 `retarget` y `paused` (pausa corta el resto).
7. ~627-643 `pkGuard` (`/pkclear`).
8. 645-653 `bot.pendingWarp` (orden del panel, squad, waitTown). **[WARPEA]** Sin chequear `WARP_COOLDOWN_MS`.
9. **655 `squadStep`** (solo con `squadActive()`).
10. 658-672 `pendingVault`/`pendingEquip` (baúl: camina/abre NPC). **[MUEVE]**
11. 674-722 Cacería (`bot.hunting`): corta, encadena otro mapa, **warpea** al mapa de caza (hasta 3 intentos). **[WARPEA]**
12. 725-757 Defensa propia contra jugador: persigue al rival o **warpea a Lorencia** si HP < 35 %. **[MUEVE/WARPEA]**
13. 759-792 Regla fuerte de dorados: `golden.pick` **cambia `ctx.target`** a un dorado a <= 20. **[OBJETIVO]**
14. 794-833 "1f" Equipo: pedidos de ayuda de otros bots. Puede **crear `bot.hunting`** o poner `bot.pinnedSpot = null` (línea ~813). **[ESTADO GLOBAL]**
15. 835-863 "1e" Cazador automático y Dragón Rojo: **crea `bot.hunting`** (sale a warpear en el tick siguiente). **[WARPEA]**
16. 865-912 Reset: `supportWaits`, **`waitTown`** (pone `pendingWarp` + `pinnedSpot` a Lorencia y duerme), `doReset()` (903) que a veces **warpea a Lorencia** (progress.ts:133).
17. 916 Reparto de stats en segundo plano (chat; no mueve).
18. ~922-937 Observador de jugadores (solo `weak`): `maybeChangeSpot`, `corner.awayUntil`. **[WARPEA]**
19. 939-949 **Esquina de Arena 2** (`cornerStep`, corner-step.ts:57 y :135 hacen warp). **[MUEVE/WARPEA]**
20. 955-965 Rendimiento (solo `weak`): `maybeChangeSpot`. **[WARPEA]**
21. 966-1018 Hambre / Devias lleno / **cambio de spot por ruta fija** (`maybeChangeSpot`, cada 10 ticks o si `crowded`/`!currentSpot`). **[WARPEA]**
22. 1020-1053 Loot (`lootStep`, camina hasta la caja). **[MUEVE]** Equip de personaje nuevo en segundo plano.
23. 1055-1237 Elegir objetivo, en este orden y pisándose: guardián (`mateAggro`, 1059) -> explorador -> cacería (`stickyGolden`, dragón recordado, fight-heat, pistas de scouts y gold-feed) -> arranque (`EarlyPlanner`) -> campamento (`camps.pick`).
24. 1237-1325 Pelear / acercarse al objetivo (`castOnTheWay`, `walkTowards`, `step`).
25. 1330-1475 Sin objetivo: caminar al campamento del arranque -> recorrer cacería (zonas de dragones, rastrillaje) -> mapa seco (`maybeChangeSpot`, 1413) -> campamento (`camps.goal`, 1425) -> explorador de salidas/hot spots.

El comentario de cabecera (línea 1-5: "sobrevivir > panel > reset > stats > esquina > spot > loot > pelear") no refleja nada de esto:
falta el vigía, la cacería, la defensa, los dorados, el equipo, la espera en Lorencia y la escuadra.

### 1.2 La sombra de escuadra NO está aislada (alto impacto)

`squadStep` (squad-client.ts:101) devuelve `false` en muchos casos y entonces **corre todo lo de abajo (puntos 10-25)**.
Lo único realmente apagado para la sombra es el vigía ciego/sin exp y el watchdog (farm-loop.ts:503, 519; commit f886842).

Casos en que la sombra cae al loop completo:

| Orden / caso | Dónde devuelve `false` | Qué puede hacer el loop después |
|---|---|---|
| `follow` (no `tight`) ya en su lugar (`t` nulo) | squad-client.ts:~218-221 | Todo: ruta fija, esquina, cacería, loot, pelear. **Se va del padrino.** |
| `follow`/`hold`/`idle`/`retreat`/`goto` con `recentlyHit` (monstruo le pegó en 3 s) | squad-client.ts:~121, 158, 183, 213 | Todo, incluido `maybeChangeSpot` y `cornerStep`. |
| `follow` y no ve al padrino y no es `tight` | squad-client.ts:~205 | Todo ("sigo con lo mío"). |
| `warp` / `hunt` / `goto` llegado / `farm` | varios | Pelea y farmeo normal (esto sí es intencional). |
| Cualquier orden, tick siguiente a `squadStep=false` | n/a | Los pasos 10-25 de arriba. |

Qué de lo anterior a `squadStep` **no** está filtrado para la sombra y puede moverla:

- **Panel `pendingWarp` (645)**: va antes y gana a la escuadra. Aceptable, pero ver 1.3.
- **pkGuard (627)**: manda `/pkclear` (no mueve; inofensivo).
- **Buffs (595-607) con `sleep`**: pausan ~1 s; inofensivo.

Qué de lo posterior a `squadStep` puede mover/warpear/cambiar de objetivo a una sombra (ninguno consulta `squadActive()`):

- **Cacería** (674 y 835-863): una invasión dorada o un pedido de ayuda de otro bot (`newRequests`, 794) lo manda a otro mapa. Solo se protege con `!bot.hunting` en la orden `warp` de la escuadra, que lo apaga una vez y el cazador lo vuelve a prender (el cazador salta una vez por invasión, pero el pedido de ayuda de otro bot, el Dragón Rojo y la cadena sí repiten).
- **Reset**: con nivel >= `RESET_LEVEL` el protegido/sombra resetea solo, aunque el padrino siga farmeando (865-912). `waitTown` además lo manda a Lorencia entre :30 y :05.
- **Esquina de Arena 2** (939): si no hay pin y `profile.corner`, `cornerStep` lo lleva a Arena 2, lejos del padrino.
- **Cambio de spot por ruta fija** (978-1018, 955-965, 922): `follow` no fija `pinnedSpot` (solo `warp` lo hace). Cada 10 ticks `maybeChangeSpot` puede warpear al nivel-tramo del protegido. Resultado: el padrino va a Devias, la sombra se va a Arena porque su tramo cambió, y el atajo por warp de squad-client (límite 1 cada 3 min) lo vuelve a traer. **Esto es el ping-pong de mapa.**
- **Loot** (1020) y **defensa propia** (725): persigue cajas o jugadores lejos del padrino.
- **Dorados** (759): `golden.pick` cambia el objetivo de una sombra `hold`.
- **Explorador/campamento** (1330+): al caer del `follow`, camina a su campamento.

Qué hacer: un único guard `const sq = squadActive()` al principio del tick y, para `squadShadow()`, saltar los pasos 11-21 y 25
(cacería, equipo, cazador, reset, espera, esquina, spot, hambre, observador) y dejar solo defensa propia y supervivencia.
Hoy `squadStep` devuelve `false` para decir "pelea lo que tengas cerca", que es otra cosa que "ejecutá todo lo demás".
Mejor un retorno de tres valores: `consumed` / `fight-nearby` / `free`.

### 1.3 Estado global con varios dueños (`state.ts`)

- **`bot.pinnedSpot`** lo escriben: panel (panel.ts:79, 92, 133, 146), escuadra (`savedPin`, squad-client.ts:~126, 141, 155), espera en Lorencia (`townPin`, farm-loop.ts:~884-899), equipo (farm-loop.ts:~813, pone `null`). Cada uno guarda y restaura "su" valor, así que se pisan:
  - Pedido de ayuda "esquina" pone `pinnedSpot = null` y borra el pin de la escuadra/panel sin avisar.
  - `townPin` captura el pin de la escuadra, y al terminar la espera lo restaura sobre uno que `restore()` ya soltó.
  - `restore()` de la escuadra restaura un pin viejo aunque el panel ya mandó `farm`.
- **`bot.hunting`** lo crean/anulan: cazador, Dragón Rojo, pedido de ayuda, panel, escuadra (`= null`), `stopHunt`. Sin dueño único.
- **`bot.pendingWarp`**: panel, escuadra (squad-client.ts:~140), atajo del seguidor, waitTown.
- **Contradice su comentario**: squad-client.ts:~147 dice "el loop ejecuta pendingWarp en el mismo tick" pero el `if (bot.pendingWarp)` está en 645, **antes** de `squadStep` (655). Se ejecuta en el tick siguiente. Mientras tanto, en el mismo tick, `maybeChangeSpot` (que ve `pinnedSpot` fijado y `currentSpot` distinto) puede ya warpear al mismo sitio (route.ts:200-204) y en el tick siguiente se warpea **otra vez** (el `pendingWarp` no respeta `WARP_COOLDOWN_MS`). Warps duplicados.
- Seis fuentes de warp sin coordinador: panel/escuadra/waitTown (`pendingWarp`), cacería (`nextWarpAt` propio), defensa (`lastFleeAt`), watchdog (sin cooldown), `doReset`, `maybeChangeSpot` (`lastWarpAt`). Solo `maybeChangeSpot` respeta `WARP_COOLDOWN_MS`. Un `warpAndWait` fallido (6 s) no frena a los demás.
  Qué hacer: un `requestWarp(spot, reason)` que centralice cooldown, `pkGuard.onWarp` y el log, y que rechace si ya hay uno pendiente.

### 1.4 Otras inconsistencias del loop

- **Umbrales distintos para "débil"**: `weak` (= `isFreshChar` o `profile.limited`) en farm-loop.ts:~800; `isFreshChar` usa `FRESH_MAX_STATS = 3000` (farming.ts:445); `AUTO_HUNT.minLevel = 380` fijo (panel-logic.ts:325) mientras `RESET_LEVEL` (config.ts:118) es 400 por defecto y cambiable con `--reset-level`; `CORNER.noReturnLevel = 360` (corner.ts:39). Con `--reset-level 300` el cazador nunca se prende y la espera de Lorencia (`waitTown`, nivel >= RESET_LEVEL) sí. Derivar todo de `RESET_LEVEL` (p. ej. `RESET_LEVEL - 20`).
- **Guardián** (`mateAggro`, 1059) pisa el objetivo de campamento/arranque en cada tick sin histéresis: con dos compañeros pegándole a monstruos distintos, el objetivo cambia cada tick (el `3000` ms de olvido no evita el salto entre dos). Solo cambia si el nuevo está al menos 2 tiles más cerca, o espera a que muera el actual.
- **Arranque + cacería + guardián** eligen objetivo en tres ramas `if/else if`: el guardián corre antes y queda "pegado" aunque el arranque pida soltarlo por correa (`dropTargetAt`, 1193).
- **`ctx.target = null` repartido** (30+ lugares): cualquier módulo lo borra y el siguiente tick elige otro; sin motivo registrado es imposible auditar "objetivos que cambian cada tick".
- **Cada tick recalcula** `findPath` hasta 6000 nodos dentro de `walkTowards` (loop-ctx.ts:~38); sin cachear la ruta, cuando el objetivo se mueve eso se repite cada 380 ms. No es un bug de lógica, es CPU (con 3-4 bots en la misma máquina se nota). **(verificar con perfil)**
- **`weak && observerSignal`** (922) y **`earlyDry`** (999): dos heurísticas distintas disparan `maybeChangeSpot` con mapas distintos en el mismo tick; el que corra primero gana y el segundo queda con `lastWarpAt` reciente (15 s) -> a veces "no hace nada" 15 s.
- **`lastAnyNpcAt`** (farm-loop.ts:~494) se reinicia con `bot.resetting`, pero no con `bot.hunting` ni con `waitTown` en Lorencia (zona segura, sin monstruos en `ctx.npcs` pero `world.npcs` sí los ve). OK mientras `world.npcs.size > 0`; **(verificar)** si en Lorencia el server deja de mandar scope se reconecta a los 3 min aunque la espera sea intencional (ya pasó: "Horaz y Melu en Lorencia: 0 monstruos").

---

## 2. Bugs concretos (los que explican "errático")

Ordenados por impacto.

1. **Alto: el pin de la escuadra se filtra para siempre cuando la estación deja de mandar.** `restore()` (squad-client.ts:~223) solo se llama desde `squadStep`, y `squadStep` solo corre si `squadActive()`, que exige orden **vigente** (no vencida). Cuando la estación se reinicia o cae, la orden vence a los 20 s, `squadActive()` es `false`, **nunca se llama `restore()`**, y `bot.pinnedSpot` queda fijado al warp de la misión. El bot queda clavado en ese mapa, `pinActive()` bloquea la esquina y la ruta. Lo mismo si la estación contesta `{ none: true }` (squad-client.ts:~54: `current = null` sin `restore()`).
   Qué hacer: llamar a `restore()` en el poll cuando `none` o cuando la orden vence, y en `squadStep` salir por el `release`.
2. **Alto: `lastSeq` del bot no se reinicia.** `verifyAssignment(... lastSeq)` descarta órdenes con `seq < lastSeq` (squad.ts:211). Al disolver y crear otra escuadra el `seq` arranca en 0 (squad.ts:780) y cada tick de la estación suma 1 por miembro (`++s.seq`, squad.ts:916, cada 2 s). El bot ignora las órdenes ("más vieja que la última") hasta que alcanza el viejo valor: con `seq` de miles son decenas de minutos. Hay que bajar `lastSeq` a -1 al recibir `none`/otro `squadId`, o ligar el `seq` al `squadId`.
3. **Alto: sombra que cae al loop completo** (ver 1.2): ruta fija, esquina, reset, cacería, loot.
4. **Alto: warps duplicados** por `pendingWarp` + `maybeChangeSpot` en el mismo par de ticks (ver 1.3).
5. **Alto: orden `warp` de la escuadra se reintenta cada tick si el warp falla**: squad-client.ts `case 'warp'` vuelve a poner `pendingWarp` cuando `!bot.pendingWarp`; `warpAndWait` espera 6 s por intento y no hay tope de intentos ni cooldown. Con zen insuficiente o PK son warps sin respuesta repetidos (y alimentan `pkGuard.onWarp`, que termina mandando `/pkclear` sin que haya PK).
6. **Medio: `onDeath` + `maybeChangeSpot`**: `onDeath` pone `currentSpot = null` y `canAdopt = false`; el siguiente tick `!bot.currentSpot` fuerza `maybeChangeSpot` aunque el bot esté en Lorencia con `waitTown` o con una orden de escuadra `follow`. El warp de vuelta a su tramo pisa al seguidor.
7. **Medio: errores silenciados que esconden fallos**:
   - `farm-loop.ts:1029` `void equipStep().catch(() => {})`: si el equipado falla, nunca se sabe (y se reintenta cada 8 s).
   - `estacion.ts:96, 150, 291, 621`: `catch {}` en la lectura de procesos, adopción de bots y **guardado de `squads.json`** (si el disco falla, se pierden las escuadras sin aviso).
   - `squad-client.ts:~58` poll: `catch` vacío, sin log. Si la estación está caída, el bot no lo registra (útil saberlo cuando "no obedece").
   - `knowledge.ts:64` ilegible = vacío; `journal.ts:20` pierde el JSONL de decisiones.
   - `warpAndWait` (route.ts:181): `waitFor(...).catch(() => null)` trata "sin respuesta" y "error de socket" igual.
8. **Medio: constantes duplicadas** de Lorencia: `LORENCIA_WARP` (route.ts:49) y `LORENCIA_WAIT_WARP` (farm-loop.ts:~237) más cuatro `WARP_SPOTS.find((sp) => sp.index === 2)!` repetidos (farm-loop.ts:~540, 556, 730; progress.ts:133).
9. **Medio: el vigía queda "dormido" durante la sombra** (`if (!shadow)` en 519): al salir de sombra el `StuckWatch` ve un salto de posición/tiempo sin haber sido alimentado. **(verificar)** que no dispare el paso 1/3 de inmediato.
10. **Bajo: `seq` hace que `squads.json` se reescriba cada 2 s** mientras haya misión (el JSON nunca coincide con `squadSaved` porque `seq` cambia): desgaste de disco y carrera si la estación muere en medio del `writeFileSync` (sin tmp+rename como `learning.ts`).
11. **Bajo: `lastDragon`/`lastRedAt`/`lastTownTry`/`townPin` sin reiniciar entre sesiones**: son variables de módulo (farm-loop.ts:~57-58, 237-239) que sobreviven a la reconexión (el loop corre una vez por conexión). Tras un reset o reconexión un `townPin` viejo puede restaurar un pin ya obsoleto.
12. **Bajo: `bot`/`world`/`learned` sin dueño de reset**: `clearScope` (headless-bot.ts:~38) limpia unos campos; `bot.hunting`, `bot.pinnedSpot`, `bot.pendingWarp`, `bot.invasion` sobreviven a una reconexión. Una cacería vieja puede reanudarse con `since` de hace 10 minutos.
13. **Doc obsoleta**: AGENTS.md:28 y README.md:38,171 mandan a `bun run test`, que **no existe** en package.json (el usuario eliminó los tests). CLAUDE.md dice "bun run test en verde" antes de terminar. AGENTS.md:778 dice que los bots corren "con `setsid`" y estacion.ts:11 dice "sin `setsid`". Ver 4.

---

## 3. Código muerto, sin uso o redundante

Verificado con `grep` de imports en `*.ts`, `*.tsx` y `scripts/` (lo único que los importa son tests ya borrados o nadie).

### Seguro de borrar

| Archivo | Líneas | Por qué |
|---|---|---|
| `shop.ts` | 71 | Cero importadores. "Escrito, sin enganchar" (PLAN-SIN-NAVEGADOR.md). `buyPotions`/`potionCount` nadie los llama. |
| `crafting.ts` | 304 | Cero importadores. Solo mencionado en docs. Planes de crafteo (`planCrafts`, `describeProposal`) sin consumidor. |
| `squad-gear.ts` | 85 | Cero importadores (`gearNotes`, `wingsFor`...). Solo `docs/escuadras.md`. |
| `types.d.ts` | 14 | Revisar: no lo importa nadie (puede ser ambient; **verificar** con `bun run tsc` antes de borrar). |

Subtotal ~460 líneas de `.ts`. Si el plan es usarlos, mejor dejarlos en una rama; en `main` solo suman ruido y confunden a quien lea `AGENTS.md`.

### Dudoso (decidir con el usuario)

- `browser/` (~3 200 líneas JS + MANUAL-CHAOS/PLAN-FARMEO/README, `serve-agent.ts`, `skill-correr-agente/`). Archivado por decisión; AGENTS.md lo usa de "referencia de reglas" y muchos módulos citan `browser/*.js` en comentarios. Solo `package.json` (`"agent"`) lo engancha. No lo carga el bot ni la estación. Candidato a mover a una rama o a `archive/`.
- `commerce.ts` (603) + `commerce-packets.ts` (257) + `commerce-plan.ts` (228) + `ui/src/Commerce.tsx` (401) + `commerce-mock.ts` (119): ¿están enganchados al loop? Los importa `panel.ts`; revisar que algo lo dispare de verdad (las órdenes de comercio pasan por el panel manual).
- `insights.ts` + `scout.ts` + `fight-heat.ts` + `gold-feed.ts` + `sweep.ts`: se usan todos en la cacería, pero cuatro heurísticas de "adónde ir a cazar" (zonas de la base, pistas de scouts, feed de la estación, fight-heat) escriben a la misma tabla `hunting.spots`. Por separado son razonables, juntas se pisan (cuál manda?).
- `snipe.ts` (18) y `finisher.ts` (65): el remate está "apagado por defecto" (commit ac2e98a) pero `finisherOn()` y el bloque de farm-loop.ts:~1260 siguen. Si el remate no se usa, el bloque es peso muerto en el camino caliente.
- Bandera/`env` solo para depurar: `MUBOT_DEBUG*` (5), `MUBOT_XOR32_DEFAULT`, `MUBOT_NO_SERVER_TERRAIN`, `MUBOT_COMPETITION`, `MUBOT_KNOWLEDGE`. Ninguna es "muerta", pero conviene listarlas en un solo lugar (config.ts) en vez de `process.env` suelto en 15 archivos.
- Módulos con un solo importador y poco código (`rivals.ts` 27, `observer.ts` 38, `health.ts` 63, `names.ts` 73): están bien; solo menciono que `rivals.ts` y `knowledge.ts` guardan constantes por personaje ("Horaz" por defecto en `PRIORITY_CHAR`, knowledge.ts:30) que deberían venir de la base.

### Flags de CLI

`--explore-dir`, `--max-stat`, `--stat-batch`, `--build`, `--heal-at`, `--skills`, `--spots`, `--party-mates`, `--no-auto-hunt`, `--decision-log`, `--learn-file` están en `KNOWN_FLAGS` (config.ts:~27) y todos se leen. No encontré flags que no hagan nada. `BUILD_WEIGHTS` solo lo lee `progress.ts` cuando se pasa `--build` (el default usa `planStats`). Documentación en la cabecera de `headless-bot.ts` sí está al día.

### Exports sin uso fuera de su archivo

Hay ~330 exports que solo se usan dentro de su propio archivo o por tests ya borrados (lista completa con el script `grep -w` de la revisión; la mayoría son tipos y constantes `HUNT_*`, `INSIGHT_*`, `FARM_*`). No molestan al runtime. Para podar de verdad correr `ts-prune` o `knip` (no lo agregué para no tocar `package.json`). Los de código vivo y llamativos: `loot.ts` `lootPolicy`, `progress.ts` `investStatPoints` (solo vía `...InBackground`), `route.ts` `seedCampsFromDb`, `estacion-logic.ts` `isRoutine`/`isBotOrder`, `terrain.ts` `parseAtt`/`worldFolderOf`, `combat.ts` `spotIsTight`.

### Redundancias

- `corner.ts` (263) + `corner-step.ts` (327) + `golden.ts` (180) + `defense.ts` (58): ports de `browser/corner.js` y `browser/defense.js`. Si se archiva `browser/`, la referencia vive en esos comentarios.
- Dos versiones del "pedí ayuda" (`team.ts`: `askHelp` + `postScout` + `postInsight`) y el feed de dorados de la estación (`gold-feed.ts` + `publishGold` + `GoldReporter`) llevan la misma información (dónde hay un dorado) por tres caminos distintos.

---

## 4. Estación (`estacion.ts` 839, `estacion-logic.ts` 519, `squad.ts` 1024)

### 4.1 Por qué mueren los bots al matar/reiniciar la estación

Lo que hice: leí `connect()`/`disconnect()`/`syncRunning` y probé en una máquina limpia (un `sleep 6` lanzado con `Bun.spawn(..., { detached: true })`
desde un proceso Bun): **el hijo `detached` queda en su propio process group** (PGID = su PID), distinto del padre. Entonces
Ctrl+C o cerrar la terminal que recibe el SIGINT/SIGHUP del grupo del padre **no llega** a los bots. Lo que sí encontré:

1. **Nada en la estación mata bots al salir**: no hay `process.on('SIGTERM'|'exit')` en `estacion.ts`; el único `kill` es `disconnect()` (estacion.ts:364) y `proc.kill()` del `--list-chars` (estacion.ts:437). No hay lazo estación -> bot por pipe (`stdin: 'ignore'`, stdout/stderr van a un archivo).
2. **El bot muere con cualquier SIGTERM o SIGINT** (headless-bot.ts:245-250: `closeSockets(); process.exit(0)`) y **no maneja SIGHUP** (muerte inmediata por defecto). Cualquier cosa que haga `kill` sobre el **árbol de procesos** (no solo el grupo) de la estación se los lleva: p. ej. el arnés que arrancó `bun run estacion` si lo mata caminando los hijos por `ppid` antes de matar al padre (los `detached` quedan con `ppid` = estación hasta que ésta muere), o un `pkill -f headless-bot`, o `pkill bun`. **(verificar)**: es la hipótesis más probable. Hoy la estación corre como `bun run estacion` con `ppid 1` (ya está desacoplada de una terminal), pero los bots son hijos directos de ella.
3. **Salida invisible**: `exitStatus(null)` y `exitStatus(0)` -> "desconectado" (estacion-logic.ts:120). Un bot matado por señal (código `null`), por SIGKILL/OOM, o por `process.exit(0)` del SIGTERM, se muestra igual que un "Desconectar" del usuario. El `say()` de la estación escribe "salió (código null)" pero el estado no se distingue de lo manual, así que parece que "se desconectó solo".
4. **Nadie los reinicia**: si el bot sale con código != 0 (por ejemplo `main().catch -> exit(1)`, headless-bot.ts:253) el estado queda `failed` hasta que el usuario conecte a mano. No hay supervisor.
5. **Reinicio de la estación -> adopción por `ps`** (estacion.ts:128-137): en macOS lee la lista completa con `ps -axo` y por cada candidato otro `ps eww` (clave de escuadra). Si `ps` falla o el comando cambia de formato, `syncRunning` ve `p` nulo y marca `off` un bot vivo (estacion.ts:169-175) y deja de verlo en el panel; un clic en "Conectar" lanza un segundo bot de la misma cuenta, que el server rechaza y deja en "en uso", mientras el primero sigue. Mitigación: guardar `~/.mubot/pids.json` (char -> pid, wsPort) y adoptar de ahí, con `kill(pid, 0)` para comprobar.
6. Documentación contradictoria: README.md:76 y AGENTS.md:778 dicen `setsid` (no existe en macOS); estacion.ts:11 dice "sin setsid". La forma segura que anda hoy es `setsid nohup ... &` (Linux) o `launchd` (macOS), no `bun run estacion` dentro de una sesión de arnés.

Qué hacer: (a) `proc.unref()` y arrancar los bots con `nohup`/`launchctl` o via un pequeño supervisor aparte; (b) manejar SIGHUP en el bot (ignorarlo); (c) distinguir en `exitStatus` `signal` de `code` (Bun da `proc.signalCode`) y mostrar "murió por señal X"; (d) autorreinicio con backoff para códigos de error; (e) pids persistidos.

### 4.2 Inconsistencias de contrato y estado que se pierde

- Las **misiones no sobreviven** a reiniciar la estación (`SquadBook.fromJSON`: `mission: null`, squad.ts:~954), pero los **bots siguen** con su última orden hasta 20 s y luego quedan con el pin colgado (bug 2.1). Reiniciar la estación en medio de una misión deja a los bots fijados en el mapa de la misión.
- `seq` por escuadra vs `lastSeq` por proceso (bug 2.2).
- `/api/squad` usa `Origin` vacío como prueba de "soy un bot" (estacion.ts:~720): cualquier proceso local sin cabecera `Origin` lo lee; la firma lo cubre, pero entonces el chequeo de `Origin` no aporta nada.
- `obeyPids` se reconstruye por el entorno en `ps eww` (frágil, ver 4.1.5); un bot adoptado que no pasa el `match` queda `obeys: false` y la escuadra lo trata como ausente.
- `squadSnapshot` pasa `hostiles: []` y `findings` solo de dorados (estacion.ts:~650): el contrato de `squad.ts` promete peligro/hostiles, pero la estación nunca los llena (comentario "sin fuente todavía").
- `RoleAssign`, `routineCommands`, `roleRoutine`, `roleFromRoutine` en estacion-logic.ts: dos formas de decir "este personaje cumple un rol" (rutina `scout`/`hunt` y rol de escuadra). Un personaje en escuadra con rutina `scout` recibe dos fuentes de órdenes.
- Timers sin cancelación (`setInterval` de aprendizaje, disco, ranking, 2 s de `refreshSlots`): `connect()` crea un `setTimeout` por conexión y `connectTimer` se reemplaza pero el anterior solo se limpia si se vuelve a pasar por ahí.
- `accountRunner` (creación de cuentas) en memoria: se pierde al reiniciar; deja un plan a medias sin rastro.
- Credenciales: la clave va por `MUBOT_PASS` (bien), pero `ps eww` en macOS imprime el entorno de **otros** procesos del usuario: `scanProcs` lee `MUBOT_[A-Z_]+=\S*` (incluye `MUBOT_PASS`) y lo guarda en `environ` en memoria. No se loguea, pero conviene filtrar `MUBOT_PASS` en el `match`.

---

## 5. Panel / UI (`ui/src`, 10 609 líneas)

- **Un solo bundle para dos páginas**: `main.tsx` importa `Station`, `Panel`, `SquadsDemo`, `CommerceDemo`, los mocks y `three`; `ui:build` incrusta el **mismo** JS+CSS en `estacion.html` y `panel.html` (2,2 MB cada uno, ~4 200 líneas pegadas, versionados en git). El panel de un bot carga `Squads`, `Fleet`, `NewAccount`, `Strategies`, `Palette`, `Views`, `Equip`... y la estación carga `Radar`/`Tactical`/three (la estación no importa `Radar`; solo `Panel` lo hace).
  Qué hacer: dos entradas (`station.tsx`, `panel.tsx`) o `import()` dinámico de `Radar`; three (`radar-engine.ts`, `map-assets.ts`, `OrbitControls`, `CSS2DRenderer`) debería ser un chunk que solo carga el panel del personaje, y la estación no lo necesita. Estimación: three minificado ronda 600-700 KB del 1,4 MB. **(verificar con `vite build --report` o `bunx source-map-explorer`)**
- **Demo/mock en producción**: `mock.ts` (191), `demo.ts` (235), `commerce-mock.ts` (119), `CommerceDemo.tsx` (24) y `SquadsDemo` (en Squads.tsx) se compilan al bundle y se activan por `?demo`/`?squadsdemo`. `installMock()` corre siempre (devuelve si no es demo). Mover a import dinámico `if (import.meta.env.DEV || demo)`; ahorra ~600 líneas y datos simulados en el HTML servido.
- **Fuentes**: `@fontsource/geist` 4 pesos + mono, embebidas como base64 en el HTML (cada `.html` las duplica). Reducir a 400/600 o usar `font-display: swap` con subconjunto. **(verificar)**
- **CSS muerto probable** (`style.css` 1271 líneas): heurística simple (`^\.clase` sin aparición en ningún `.tsx`) -> candidatas en `style.css`: `action-now`, `activity-log`, `activity-peek`, `advanced-controls`, `attributes`, `character-art`, `character-header`, `character-identity`, `chat-*` (form, guild, log, party, server, tools, whisper), `current-action`, `dashboard-*`, `decision`, `detail-grid`, `equip-icon/slot/text`, `event-row`, `golden-dragon`, `inv-cell`, `inv-item`, `inventory-grid`, `invasion-value`, `level-line`, `live-dot`, `map-button/help/legend/tooltip`, `near-*`, `overview-*`, `radar-*` (actions, caption, doing, footer, heading, labels, loading, stage, tag*), `red-dragon`, `session-metrics`, `text-button`... Parece el CSS de un panel viejo reemplazado por `panel.css`/`panel-parts.tsx` y `Radar.tsx`. En `panel.css`: `radar-tag-dropdim`, `radar-tag-mate`, `radar-tag-squad`; en `station.css`: `tone-bad/gold/good/idle/info/violet`. Verificar clase por clase (pueden armarse con template strings) y luego podar con `purgecss`.
- **`panel-parts.tsx`** 852 líneas y **`Tactical.tsx`** 442 + **`Radar.tsx`** 441 + **`radar-engine.ts`** 617: componentes grandes; `Tactical` solo lo usa `Radar`. `station-kit.tsx` (199) y `components.tsx` (280) tienen dos conjuntos de botones/selectores parecidos (ambos importan `@base-ui`). Candidatos a unificar.
- **`panel.html`/`estacion.html` en git** (2,2 MB × 2): cada `ui:build` reescribe 8 000 líneas en el diff. Mejor generarlos en `prepare`/`estacion` al arrancar y poner en `.gitignore` (AGENTS.md ya aclara "se generan").
- **Dependencias**: `lucide-react` se usa en 15 archivos (tree-shake ok); `@base-ui/react` en 6; verificar que el bundle no lleve íconos de más (import por nombre, no `* as`).

---

## 6. Por dónde empezar (orden sugerido)

1. Guard de sombra/escuadra en el loop (1.2) + `restore()` al vencer/`none` (2.1) + reinicio de `lastSeq` (2.2). Es lo que más explica "los bots actúan descoordinados".
2. `requestWarp` central con cooldown y sin duplicados (1.3, 2.4, 2.5).
3. Un solo dueño de `pinnedSpot`/`hunting` (una pila de "razones" con prioridad, no `savedPin`/`townPin` sueltos).
4. Estación: supervisor / pids persistidos / mostrar la señal con que murió el bot (4.1).
5. Borrar `shop.ts`, `crafting.ts`, `squad-gear.ts`; arreglar la doc de `bun run test` y `setsid`.
6. Partir el bundle y sacar los mocks de producción (5).
