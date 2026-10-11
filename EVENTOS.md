# Eventos: cómo se entra y cuándo (2026-10-10)

Investigado en el cliente web (`~/self/mutest/assets/layout--UWzP455.js`, `boot-BuVoDwBX.js`)
y en el server OpenMU (`~/self/mutest/OpenMU/src`). Lo marcado *(inferido)* no se probó en vivo.

## Lo más importante para el bot

- **El server no exige estar al lado del NPC:** el paquete de entrada se puede mandar desde
  cualquier mapa mientras la entrada esté abierta. Sale con `__store.sendToGS(dataView)`.
- **Ticket:** su nivel tiene que ser **igual** al nivel del evento, y se gasta 1 de durabilidad.
  En el byte del slot del ticket, `0xFF` = "buscalo vos": el server lo busca en el inventario.
- **Rangos de nivel para Dark Knight:** el cliente trata al DK como clase "especial", pero el server
  no, y usa los rangos normales. **Calcular el nivel con la tabla del server, no con el botón que
  ilumina el cliente.**
- **Ventana de entrada:** DS y BC 1 min, CC 5 min *(timetable por defecto de OpenMU, inferido)*.

## Cuánto falta para cada evento (sirve igual sin navegador)

- **Pregunta:** `C1 05 91 <tipo> <nivel>`. Tipos: 1 = Devil Square, 2 = Blood Castle, 4 = Chaos Castle.
- **Respuesta** (`MiniGameOpeningState`, 0x91):

  | Byte | Contenido |
  |---|---|
  | 3 | tipo |
  | 4 | minutos que faltan para la entrada |
  | 5 | jugadores |
  | 6 | byte bajo de los minutos (solo CC) |

  | Valor de los minutos | Qué significa |
  |---|---|
  | 0 | abierto |
  | ≥ 255 | más de 4 h |
  | otro | abre en ese número de minutos |

  En CC los minutos son 16 bits: `b4<<8 | b6`.
- **Panel de la derecha:** muestra estas respuestas. El cliente pregunta cada 30 s a 5 min, y el agente lo lee de `.event-row`.
- **Aviso de cambio** (`UpdateMiniGameState`, 0x92): llega 30 s antes de cada cambio de estado.

  | Estado | DS | BC | CC |
  |---|---|---|---|
  | Cerrado | 0 | 3 | 10 |
  | Abierto | 1 | 4 | 11 |
  | Corriendo | 2 | — | — |
  | Terminando | — | 5 | 12 |
  | Terminado | — | 6 | 13 |

## Invasión dorada

- **Horario:** todas las horas a los **:50**, dura **15 min** (calendario fijo del cliente: `Xq=50`, `Mk=15`).
- **Paquete propio del server**, `C1 len FD`. El panel muestra "Lorencia: 5 · Devias: 2 · Noria: 27" a partir de esto.

  | Bytes | Contenido |
  |---|---|
  | 3 | estado (1 = activa, 2 = derrotada) |
  | 4–5 | total de vivos (u16 BE) |
  | 6 | cantidad de mapas |
  | 7 en adelante | por cada mapa: `<mapa> <vivos u16 BE>` |

- **Índices de mapa:** 0 Lorencia, 2 Devias, 3 Noria, 7 Atlans, 8 Tarkan.
- **Posiciones:** el server manda la posición de cada monstruo solo dentro de la vista (~15-20 tiles). Hay que recorrer el mapa.
- **Prueba (Noria, nivel 18):** 2 Golden Goblin = de 18 a 55 en un minuto, más una Box of Luck (14/11).
  En Devias los matan rápido (mucha gente). En Noria quedaban 27 sin tocar.

### Qué sale en cada mapa (GoldenInvasionPlugIn de OpenMU)

| Mapa | Dorados |
|---|---|
| Lorencia | Golden Budge Dragon |
| Noria | Golden Goblin |
| Devias | Golden Soldier, Golden Titan |
| Atlans (warp 11, nivel 70) | Golden Vepar, Golden Lizard King |
| Tarkan (warp 21, nivel 140) | Golden Wheel, Golden Tantallos |
| Lorencia / Noria / Devias, al azar | **Golden Dragon** (los "dragones") |

- Icarus no entra en la invasión.
- **Ojo con el nombre "Golden Dragon":** el cliente llama así a dos monstruos distintos. El **tipo 79** es
  el dorado de esta invasión. El **tipo 44** es el **Dragón Rojo** de la otra invasión (los dragones que
  se ven volar). El avistamiento de las 21:50 en Lorencia probablemente fue un tipo 44.
- Este server la corre cada hora (:50) y con más de 200 dorados; los valores por defecto de OpenMU son cada 4 h y 20/10 por tipo.
- Otra invasión activa en este server: **Dragón Rojo** (ver abajo). White Wizard (cada 2 h, de 12 a 23) no se vio todavía.

## Invasión del Dragón Rojo

- **Qué es:** `RedDragonInvasionPlugIn` de OpenMU. ~5 dragones (monstruo **tipo 44**, el cliente lo muestra
  como "Golden Dragon") en **uno solo** de Lorencia / Noria / Devias, elegido al azar.
- **Aviso:** mensaje dorado en el centro ("el dragón rojo está invadiendo"), sin decir el mapa.
- **Cómo saber el mapa:** paquete `MapEventState` `C1 05 0B <on> <tipo>` (tipo 1 = Dragón Rojo). Llega
  al arrancar y al terminar a los que están en ese mapa, y a cada uno que entra mientras dura.
  Medido 2026-10-10 23:23: Melu entró a Lorencia y llegó `c1 05 0b 01 01`.
- **En el bot (`hunter.js`, con `auto`):** con el anuncio, cada pestaña recorre los 3 mapas (warp cada
  7 s, en órdenes opuestos) hasta recibir el paquete; el mapa se comparte por `localStorage`
  (`mubot:red`) y los dos cazan ahí hasta que el server diga que terminó (o 12 min). Los dragones a la
  vista se avisan por `/gold`.

## Devil Square

| | |
|---|---|
| Ticket | Devil's Invitation **14/19**, nivel del ítem = nivel del DS |
| NPC | Charon (237) abre la ventana de elegir nivel, pero no hace falta ir |
| Entrada | `C1 05 90 <nivelDS-1> FF`: **el nivel va desde 0** |
| Respuesta (0x90, byte 3) | 0 ok, 1 sin invitación, 2 cerrado, 3 nivel alto, 4 nivel bajo, 5 lleno |
| Rangos DK | DS1 15–130 · DS2 131–180 · DS3 181–230 · DS4 231–280 · DS5 281–330 · DS6 331–400 |
| Se arma | Devil's Eye (14/17) + Devil's Key (14/18) + Chaos |
| Horaz | +1, +2, +3, +4 |

## Blood Castle

| | |
|---|---|
| Ticket | Invisibility Cloak **13/18**, nivel = nivel del castillo |
| NPC | Messenger of Archangel (233 *(inferido)*) |
| Entrada | `C1 05 9A <nivelBC> FF`: **el nivel va desde 1** |
| Respuesta (0x9A) | 0 ok, 1 capa incorrecta, 2 cerrado, 3 alto, 4 bajo, 5 lleno, 6 veces por día |
| Rangos DK | 15–80, 81–130, 131–180, 181–230, 231–280, 281–330, 331–400 |
| Se arma | Blood Bone (13/17) + Scroll of Archangel (13/16) + Chaos |
| Horaz | no tiene |

## Chaos Castle

| | |
|---|---|
| Ticket | Armor of Guardsman **13/29** |
| NPC | no hay: se entra con clic derecho en la armadura |
| Entrada | `C1 06 AF 01 <nivelArmadura> <slot real>`: el server elige el castillo por el nivel del personaje |
| Costo | CC1–7: 25k / 80k / 150k / 250k / 400k / 650k / 1M zen |
| Respuesta (`AF 01`, byte 4) | 0 ok, 1 falló, 2 cerrado, 5 lleno, 7 sin zen, 8 PK |
| Rangos DK | 15–49, 50–119, 120–179, 180–239, 240–299, 300–400 |
| Horaz | no tiene |

## Al terminar

- **Resultados:** llegan en `MiniGameScoreTable` (0x93) y en `BloodCastleScore`, con exp y zen extra.
- **Salida:** no hay paquete para salir. El server te saca al terminar (DS 3 min, BC y CC 1 min) *(inferido)*.

## Para el agente (pendiente)

1. Leer las aperturas (0x91 o el panel). Ya lo hace: `__ai.eventTimers()` y `__ai.events`.
2. Unos 2 min antes de que abra DS, elegir la invitación del nivel que va a tener en ese momento y
   mandar `C1 05 90 <n-1> FF` apenas se abre la ventana (1 min).
3. Medir la exp ganada adentro contra farmear el mismo tiempo. Si no gana, no entrar.
4. Invasión dorada: a los :50 elegir el mapa con más vivos al alcance (paquete 0xFD) y cazar.
   Prioridad: los mapas con poca gente (Noria). **Cortar apenas el 0xFD diga que en ese mapa no
   quedan vivos** (o la invasión pase a "derrotada"): Horaz siguió barriendo las esquinas de Noria
   con 1 dorado vivo en todo el server. Primera cacería real: nivel 18 → 90 en 5 min y 2 Box of Luck.

## Lecciones de las prácticas de caza (2026-10-10)

- **21:50:** Melu vio un Golden Dragon en Lorencia (149,168) en el primer segundo, pero Horaz solo
  seguía avisos de su mapa (estaba en Devias) y llegó un minuto tarde: ya no estaba. Arreglado:
  un aviso de dragón en otro mapa al alcance lo hace cambiar de mapa al instante.
- **Los grandes duran menos de un minuto;** a los 2-3 min cada mapa está casi limpio. Hay que estar
  parado en el mapa antes de que arranque (hh:49:20) y buscar solo los primeros 3 min.
- **Los últimos ~20 no se buscan:** quedan en rincones o lugares a los que no se llega caminando.
  Melu barrió Noria entera con 7-8 vivos y no vio ninguno.
- **Plan de las invasiones:** Horaz espera en Devias (225,225) y salta entre las 4 entradas; Melu
  espera en Lorencia (149,168) y, si en 12 s no ve nada, pasa a Noria y después a Devias.
- **Hipótesis del usuario: los dragones salen cerca** (de las llegadas o de lugares fijos). Se
  confirma o descarta con la memoria de dorados (`mubot-gold:<pj>`) después de 2-3 invasiones.
- **22:50, primera invasión con el plan:** Melu vio 2 Golden Budge Dragons en Lorencia (153,192) a
  los 50 s y avisó; Horaz (nivel 17, en Noria) cambió solo de mapa, los mató y levantó 2 Box of Luck
  (y subió 17 → 34). La coordinación por avisos funciona. El Golden Dragon grande no apareció en las
  zonas recorridas.
