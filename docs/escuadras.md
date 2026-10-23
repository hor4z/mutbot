# Escuadras: grupos de hasta 5 con misiones coordinadas

Diseño, hechos con fuente y supuestos. Código: `squad.ts` (misiones, roles, firma), `party.ts`, `formation.ts`,
`squad-gear.ts`, `squad-accounts.ts` (lógica pura, tests `squad-tests.ts`, `party-tests.ts`,
`formation-tests.ts`) y `squad-client.ts` (lado del bot). Interfaz: `ui/src/Squads.tsx` (botón "Escuadras",
o `?demo` con datos de mentira).

Fuentes públicas leídas el 2026-10-23 (`GET https://mu.mormon.garden/api/guides[/<id>]`, `/api/news`):
**G-Pasos** "Primeros pasos" (`…1559306579831038115`), **G-Cmd** "Todos los comandos" (`…1559306474210070558`),
**G-Levear** "Dónde levear" (`…1559306497941307443`), **G-Cazador** (`…1559306510738399373`),
**G-Kun** (`…1559306545047801878`), **G-BC** "Blood Castle…" (`…1559306537900441681`),
**G-Evo** "Quest de evolución" (`…1559306438957080717`), **N-xx** novedades por fecha.

## Hechos medidos o publicados

| Hecho | Fuente |
|---|---|
| Party de hasta **5**; hasta **5 personajes por cuenta**; exp x2000, nivel máx. 400 | G-Pasos |
| Comandos de party del juego: `/party` (o `/pt`) sobre un jugador, `/autoparty on\|off` (aceptar solas), `/follow` sobre un jugador | G-Cmd |
| Spots densos en todos los mapas, de nivel 20 a 400; Arena 2 nivel 100, Arena 3 200, Arena 4 300 | G-Levear |
| Lo que cae de una caja es del dueño **y su party** durante 10 s; Blood Castle da una +5 a quien entrega el arma **y a cada miembro de su party** vivo adentro | G-Kun, G-BC |
| El Cazador cuenta **solo tus kills**: las de la party no suman | G-Cazador |
| Los ítems de la quest de evolución **no caen en party** | G-Evo |
| La 2da fase (nivel 150) habilita alas de 2da: Spirits, Soul, Dragon, Darkness (novedad 2026-10-18); Cape of Lord = Chaos Machine con alas de nivel 1 + Crest of Monarch + Chaos + 5M (N-10-22) | G-Evo, N-10-18, N-10-22 |
| Fenrir: "la montura más rápida del juego", se usa desde el nivel 300 | N-10-22/23 |
| Protocolo de party del 0.97d: invitar `C1 05 40 <id BE>`, responder `C1 06 41 <0/1> <id BE>`, salir/kick `C1 04 43 <índice>`; aceptar/rechazar/invitar **ya corrieron en vivo** (dúo de la esquina, AGENTS.md) | `protocol097.ts`, AGENTS.md |
| Reparto de exp de OpenMU (`Party.cs`): pozo = base(nivel promedio) × miembros × 1,05^(n−1), a cada uno según su nivel | `duo.ts` |

## Lo que NO está publicado (no se inventó)

- **Cuánto suben las alas la velocidad, el daño o la defensa.** Ninguna guía ni `data/items.json` lo dice (y las
  columnas de clase de las alas en el JSON están corridas, ver `docs/items-y-maquinas.md`). `squad-gear.ts` asigna
  las alas por clase según el MU original (**supuesto**) y les da un valor por tier que es una heurística nuestra
  (1ra 40, 2da 100, Cape 80 + 4 por nivel). `equip.ts` ya recuerda lo que el server rechaza.
- **Velocidad del bot**: caminar sale a `WALK_PACE_MS` (380 ms) con o sin alas y ese ritmo no se baja (anti-cheat,
  AGENTS.md). Ir más rápido = warps (menú, `0x8E`), no alas. Lo único publicado como "más rápido" es el Fenrir.
- **Rango de niveles válido para compartir exp en party**: el server no lo publica. `NURTURE_MODEL.maxLevelSpread`
  queda en `null` (sin tope) y `levelSpreadOk` lo respeta si algún día se mide uno.
- **Cuántos metros alcanza el reparto** ("los que ven al que mata"): se asume `WARD_MAX_DIST` = 9 (de `duo.ts`).

## Supuestos (marcados en el código)

- `NURTURE_MODEL`: nivel típico del monstruo por mapa (Arena 2 = 100 es dato, Gaint Drakan; el resto es estimación),
  20 kills/min del padrino contra 5 kills/min del protegido solo. **Con esos números** Hume (400) con un protegido
  de 100 en Arena 2 saca al protegido ~1,9× de lo que haría solo (`wardGain`) y el padrino también gana (~2,2×
  por kill, como en `duo.ts`). Si el protegido solo mata rápido (40/min) la crianza **no** conviene y la misión
  lo avisa. Medir y ajustar con `v_party`.
- Con un padrino de nivel muy alto y un protegido de nivel muy bajo el reparto por kill es **peor** que farmear
  solo (el promedio sube y el castigo por nivel alto del monstruo se come el pozo): lo que compensa es la
  velocidad del padrino. Por eso `nurtureOptions` compara exp/min y no exp/kill.
- Buffs de apoyo sobre aliados (Elf 26/27/28, DL 64): están en `data/skills.json` pero el bot nunca los tiró a un
  aliado. `squad-client.ts` los manda con `TargetedSkill` al id del aliado: **sin verificar en vivo**.
- `PartyList` (`C1 .. 42 01`): el stride se deduce del largo y solo se leen nombres; **sin verificar en vivo**.
  Salir de la party mandando kick con el propio índice: **sin verificar**.

## Cómo funciona

### Seguridad (lo que el usuario pidió)

1. La estación genera/lee una clave (`~/.mubot/squad.key`, 0600) y se la pasa **solo por entorno** a los bots que
   lanza (`MUBOT_SQUAD_KEY`, `MUBOT_SQUAD_URL`). Un bot lanzado antes (Hume hoy) **no la tiene: nunca obedece**;
   la tarjeta lo marca "sin clave: reiniciar el bot" y la misión se niega si no hay al menos 2 que obedezcan.
2. Cada bot consulta `GET /api/squad?char=<nombre>` (sin `Origin`, loopback) y recibe una asignación firmada
   (HMAC-SHA256) para él, con vigencia de **20 s** y número de secuencia creciente. Firma mala, vencida, vieja
   o para otro personaje = ignorada. Si la estación se cae, a los 20 s el bot vuelve solo a su rutina.
3. **Party**: con una escuadra vigente, `world.ts` acepta la invitación solo si el que invita está en la lista
   firmada (`decideInvite`). Sin escuadra queda la regla de siempre (compañeros por `MUBOT_MATES`; el personaje
   nuevo sigue aceptando a cualquiera: es anterior y no se tocó).
4. **Nada automático**: una misión solo nace de `squad-mission` con `confirm: true` (el parser rechaza lo demás) y
   al terminar no se encadena otra. La crianza con Hume de padrino se arma igual: solo cuando el usuario lo ordena
   y solo si Hume corre con la clave (hay que reiniciarlo a propósito).

### Misiones (máquinas de estados en `stepMission`)

Fases comunes: `travel` (warp escalonado: cada uno espera 2-22 s al azar, no viajan los 5 juntos) → `gather`
(punto de reunión = donde está el líder; 3 min de plazo, sigue con ≥ 2) → fase propia → `done`.
En cualquier fase: `retreat` (30 s hacia el punto de reunión) → `aborted`.

| Misión | Fases | Roles |
|---|---|---|
| **explore** | sweep → converge → done | uno al frente (explorador = el tanque de más nivel); celdas de 25×25 con terreno real, cada uno una celda libre cerca de sí y del explorador; los hallazgos (`/api/gold` y los de la estación) llevan a todos a puntos distintos alrededor |
| **golden** | search → engage → loot → search … | tanque (BK/MG) a 2 tiles del dorado, daño a 4, apoyo a 6; todos con el mismo `focus`; al salir de vista 15 s de cajas (la caja es del que más daño hizo y su party, 10 s) |
| **nurture** (campaña: `follow`, abajo) | farm → done | padrino = el de más nivel (o el elegido): su rutina de siempre; protegidos `hold` (se paran a salvo con `wardTile`, no pelean, cobran el reparto). Fin: todos los protegidos en el nivel meta, o el tiempo |

Roles por clase (`CLASS_KIT`): BK tanque (Death Stab/Rageful/Twisting, Swell Life a la party desde el 120); MG daño
(Twisting Slash); DW daño de área (Evil Spirit/Decay) + Soul Barrier al tanque; Elf apoyo (Greater Damage, Greater
Defense, Heal al que baja de 60 %); DL apoyo (Increase Critical Damage). Un apoyo por clase.

Abortos: ≥ 1 muerte en 10 min (explorar) o ≥ 2 (cazar, criar); ≥ 1/3 de la escuadra con < 35 % de vida; jugador
hostil a ≤ 15 tiles (el parámetro `hostiles` existe y está testeado, **pero la estación todavía no lo alimenta**: no
hay fuente de PK confiable; hoy cortan las muertes y la vida baja); padrino fuera de línea; quedan < 2 activos;
tiempo máximo (explorar 25 min, cazar 20, criar 90). Abortar a mano desde la tarjeta: retirada y release.

### Crianza en campaña (`nurture` con `follow: true`)

Idea del usuario: el FUERTE resetea, vuelve a nivel 1 con todos sus stats y su equipo, y desde ahí sube con el débil en
su party; con niveles parecidos el reparto de `partyShares` es parejo y el pozo crece rápido (el fuerte sube ~50 niveles/min).
Suben juntos por toda la ruta hasta el 400, el fuerte resetea otra vez y se repite, hasta que el débil aguanta solo.

- **Solicitud**: `squad-mission` `{kind:'nurture', follow:true, padrino:'<char>', confirm:true, untilResets?:1-20, targetLevel?:1-400, maxMin?:1-720}`.
  `follow` solo vale `true`, exige `padrino` y `confirm`, y no admite `warp`. Sin `follow` todo queda como antes (hold, un mapa).
- **Estados** (`Mission.phase`): `armed` (esperando reset) → `follow` (siguiendo) → `done` | `retreat` → `aborted`.
- **Valor** (`followDecision`): se evalúa con el NIVEL REAL del padrino al pedirla y de nuevo en cada reset. Rinde si
  `nivel padrino <= max(20, nivel del protegido más flojo / 0,5)`. Si no, queda `armed` y dice "esperá al próximo reset del
  padrino (nivel < X)": durante `armed` todos siguen con su rutina y no se invita a nadie. Arranca sola SOLO si el usuario la
  armó (misma solicitud confirmada) y el padrino resetea: sube su `resets` o su nivel cae >= 60 de golpe, y queda en nivel <= 20
  (ventana de 3 min por si el nivel tarda en actualizarse). Una armada vence a las 24 h; abortar una armada la desarma.
- **El padrino NUNCA espera**: su orden es siempre `farm`, también en retirada y mientras el protegido viaja o espera.
- **Protegido**: en el mismo mapa, orden `follow` con `tight` (correa de `FOLLOW_MISSION.LEASH_FAR` = 6 tiles, bolsillo detrás
  del padrino con `Follower`), con la posición del padrino por si no lo ve; no pelea salvo que le peguen. Si el padrino cambia
  de mapa y el protegido llega al nivel del warp (`SQUAD_MAPS`), viaja con el warp de siempre con espera de 2-22 s (nueva en cada
  viaje). Si no llega (o el mapa no tiene warp) espera en zona segura —si está en otro mapa, vuelve al último mapa compartido— y
  la estación lo anota ("no entra a Arena 2 (nivel 100)").
- **Party**: invita solo el padrino (`Assignment.leader` = padrino, el protegido nunca invita). Si se cae, `InviteScheduler`
  reinvita con 90 s de espera y tope de 4 intentos por vez.
- **Fin**: el protegido alcanza al padrino (solo después de que el padrino lo pasó, para no cortar al arrancar), todos los
  protegidos en `targetLevel`, el padrino reseteó `untilResets` veces, o tiempo máximo (8 h por defecto). **Abortos**: el
  protegido murió 2 veces en 10 min (las del padrino no cuentan), hostil a <= 15 tiles de un protegido, padrino fuera de línea,
  no queda ningún protegido. La retirada manda a los protegidos a Lorencia (o los deja quietos); la vida topada en 65.535
  (`hpPct` 0) se ignora. No hay corte por vida baja en esta misión.
- **Sin verificar en vivo**: que el padrino conserve la party al resetear, la lectura de `resets` en la estación como señal, el
  seguimiento tight entre mapas, y que el reset vuelva al padrino a Lorencia (se asume que el protegido lo alcanza con el warp o
  caminando). Las misiones armadas se pierden si se reinicia la estación. Hume (código viejo cargado) no obedece hasta reiniciarlo.

### Seguir y formación (`formation.ts`)

`Follower`: correa 2-9 tiles del líder, lugar propio en abanico detrás del líder (ángulo y radio al azar, se
vuelven a sortear cada 9-24 s), reacción humana de 0,7-2,6 s antes de volver, ninguno a menos de 2,5 tiles de otro.
El paso a paso es `walkTowards` (A* con el terreno real de `path.ts`/`terrain.ts`, respeta `WALK_PACE_MS`).

### Cuentas ("crear escuadra")

`planSquadAccounts`/`AccountRunner`: clases complementarias (2: BK+Elf, 3: +DW, 4: +MG, 5: +Elf), nombres de fantasía
(`names.ts`), una cuenta por personaje. **Ritmo**: primera a los 30 s-3 min, después una cada 12-40 min, a lo sumo 2
por hora y 8 por día, pausa de 1 h si el server contesta `throttled`, tope de 2 fallos seguidos. Solo la dispara el
usuario (`squad-accounts` mode `start`, con casilla de confirmación en la tarjeta); "Ver plan" no toca nada. Las
claves se generan al registrar y quedan solo en la base de la estación. Dark Lord no se puede crear desde el bot.

## Pendiente / no verificado en vivo

Nada de esto corrió contra el server (reloj simulado y mocks):

- PartyList, salir de la party, buffs sobre aliados, que `/api/gold` alcance como fuente de hallazgos.
- Que `GoldenRule` (farm-loop) pegue al dorado del `focus` y no a otro; hoy la orden `hunt` solo acerca al grupo.
- El comportamiento de los protegidos con monstruos que les pegan (vuelven a pelear si los golpean).
- Fuente de hostiles/PK para la retirada, y los hallazgos de la rutina exploradora (`/api/team` scouts) cuando
  exista: se enchufan como `Finding` en `squadSnapshot` (estacion.ts).
- Integrar `wingScore` al plan de equipo (`equip-plan.ts`/`item-score.ts` no estaban en la base de esta rama).
