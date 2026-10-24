# Aprendizajes de la base (hechos medidos)

Todo lo de acá sale de SELECT de solo lectura sobre ClickHouse (`events`, `ticks`, `players_seen`), medido el
**2026-10-23** (datos del 2026-10-11 al 2026-10-23). Horas en **UTC** salvo que diga ART (Argentina = UTC-3).
La muestra es **chica** (la cacería de dorados se mide recién desde el 2026-10-23): donde hay pocos datos lo digo
y el código exige un mínimo antes de moverse (`INSIGHT` en `insights.ts`). Si una cifra cambia con más datos, el
código la recalcula solo (cada 10 min); este archivo es la foto de hoy.

## 1. Hume clavado por PK: 83 minutos sin hacer nada

- El server contestó `Un PK no puede usar /move.` **68 veces**, una cada 15 s, de 16:28 a 17:51 UTC (13:28 a
  14:51 ART), más `PK: 2 kills, 10% probabilidad de drop.` cada ~3 min. En esa ventana Hume estuvo en el mapa 6,
  en **una sola posición**, 0 exp. A las 17:51:55 llegó `[/pkclear] Hume kills have been cleaned.` y a las 17:55 ya
  cazaba en Lorencia.
- El vigía que había (`long_cycle`) saltó 151 veces desde el 11/10, pero con `doing = conectando` en 66 de ellas:
  avisaba, no diagnosticaba. La reconexión por ceguera (3 min sin exp) se disparaba, pero el PK sobrevive a la
  reconexión: no había salida.
- **Decisión que cambia:** `recovery.ts` manda `/pkclear` solo (3 intentos, 20 s entre uno y otro, 30 min de
  descanso) con el aviso de PK o con 3 warps seguidos sin `MapChanged`; `watchdog.ts` diagnostica `pk`.

## 2. Invasiones: qué mapa tuvo el Golden Dragon

Del aviso `[Mapa] Golden invasion!` (inicio) y `[Mapa] Golden invasion has ended.` (cierre, a las :05) que vieron los
bots el 23/10: **Devias 12:50, Noria 13:50, Noria 14:50, Noria 15:50 y Noria 17:50** (5 invasiones; 4 de 5 en Noria).
No hay patrón por hora todavía (una sola vez cada hora).

- **Ojo con `golden_seen`:** solo se anota mientras el bot está cazando, así que "dorados vistos por hora" mide
  **cuándo cazó el bot**, no cuándo hay dorados (por eso las horas 1-4 UTC del 12/10 parecen "mejores"). No se usa
  para predecir horarios.
- **Decisión que cambia:** `predictDragonMap` (en `insights.ts`) devuelve el mapa del dragón por hora si hay ≥ 2
  invasiones esa hora con ≥ 60 % en el mismo mapa; si no, el más frecuente en total (≥ 4 invasiones, ≥ 60 %). Hoy
  da **Noria 80 %** (4/5). Se usa en `pickHuntMap` como desempate (un cuarto del bonus del dragón) **solo mientras el
  server no avisó el mapa de verdad**. El aviso real siempre manda.

## 3. Cajas por mapa y tiempo hasta la primera

Cacerías (`hunt_end` no rojas) y cajas propias (`loot_ok` 14/11):

| Mapa | Min cazados | Cajas propias | Dorados que mató Hume / otro |
|---|---|---|---|
| Lorencia | 23,9 (3 cacerías) | 6 | 5 / 1 |
| Devias | 6,9 (2) | 1 | 1 / 1 |
| Tarkan | 4,2 (1) | 0 | - |

- Lorencia dio **0,25 cajas por minuto cazado**. La muestra (35 min en total) es **demasiado chica** para mover el
  valor de un mapa: `huntFactor` exige ≥ 60 min cazados en total y ≥ 20 por mapa, y acota el efecto a ×0,7-1,3.
- Invasión de Lorencia de las 15:50 UTC: aviso 15:50:00, decisión de salir 15:50:05 (**5 s**), primer Budge Dragon
  muerto 15:51:27 (**87 s**), después 15:53:07, 15:54:43, 15:55:51 (uno cada ~90 s). El 5.º (15:56:11) lo mató otro
  jugador (`cluster`) y la caja fue suya (`loot_foreign`). Recoger una caja propia tardó **2,3 a 5,0 s** desde que
  cae (los 2 s de "The item is still falling" más caminar): el bot no pierde tiempo ahí.
- **Conclusión de tiempos:** el bot ya llega al mapa 5 s después del aviso; no hay margen en "llegar antes". El tiempo
  se pierde **buscando**: ver el punto siguiente.

## 4. La búsqueda a ciegas es lo caro

- Dos cacerías de Lorencia cortaron por `2 min sin ver un dorado`: la de las 15:02 a los **4,2 min con 0 dorados
  vistos** (había 3 vivos) y la de las 17:56 a los **4,7 min con 1 visto de 17 vivos**. Recorrer celdas de 25×25 a
  ciegas (incluido el pueblo, de zona segura, y las paredes) dejaba ver 1 de cada 17.
- **Decisión que cambia:** `HuntExplorer.useTerrain` (`panel-logic.ts`) arma las celdas con las casillas
  **alcanzables** desde la llegada (cruzando el pueblo pero sin recorrerlo), elige como destino una casilla
  caminable, saltea rincones (< 40 casillas), no repite celdas hasta terminar la vuelta, va **primero a las celdas con
  dorados vistos** (`zoneWeights`, dragones ×3) y **último a las celdas letales** (punto 6).

## 5. Competencia (jugadores a la vista por foto, `players_seen`)

Rivales por foto de 10 s, mapas de cacería (Lorencia, Devias, Noria) por hora ART, 30 días:

- **Más gente:** 15-17 h (3,7 / 2,8 / **4,8**) y 21-23 h (2,7-3,1). **Menos:** 5-9 h (1,1-1,6).
- Por mapa (todas las horas): Lorencia 3,0; Noria 3,0; Devias 2,0; Arena 2 (83) 2,9; Arena 4 (85) 1,9.
- **Decisión que cambia:** `huntFactor` baja hasta ×0,7 un mapa con más rivales que el promedio a esta hora (≥ 30
  fotos de esa hora y mapa). Hoy casi no mueve nada por falta de fotos en Noria/Atlans/Tarkan.
- **Ladrones de cajas:** 2 dorados muertos por otro en 30 días (uno con nombre, `cluster`) y 1 `loot_foreign`.
  Muy poco para señalar a nadie: `insights.thieves` lo junta y lo manda a la estación; no se usa para decidir.

## 6. Dónde y cuándo mueren (nivel >= 300, 28 muertes en 12 días)

- **71 % por jugadores** (20/28), 29 % por monstruos. Por mapa: Arena 4 (85) 9 (5 por jugadores), Arena 2 (83) 6 (las 6
  en la **misma celda de 25x25, la esquina (0,0)**, 5 por jugadores; Horaz, Hume y Melu), Devias 5 (todas por
  jugadores), Noria 3 (jugadores), Aida 3 (0 por jugadores), Lorencia 1, mapa 6 1.
- Celdas con repetición: esquina de Arena 2 (6), Arena 4 celda (3,4) (4 por jugadores, Hume y Melu), Arena 4 celda (3,0)
  (3 por monstruos, Hume, el 18/10: Spirit Beast/Sorcerer cerca de (85,14-22)) y Aida celda (4,0) (2).
- **Aida (33):** 3 muertes de Hume en 4 minutos (Hydra, Silver Valkyrie x2), 13:32-13:36 UTC, con 7 min de exposición
  en total: la mayor tasa por hora de todos los mapas. Ya estaba anotado en HANDOFF ("Aida le queda grande").
- Por hora: las muertes por jugadores se concentran en 17-18 y 0-4 UTC (14-15 y 21-01 ART), que coincide con más
  rivales a la vista (punto 5).
- **Decisión que cambia:** `avoidCells` marca como letal toda celda de 25x25 con >= 2 muertes y el recorrido de
  cacería la visita **última**; `huntFactor` suma un descuento (x0,6-1,1) por muertes por hora de exposición frente
  al promedio global, con >= 60 min de exposición en el mapa. En los mapas de cacería (Lorencia, Noria, Devias,
  Atlans, Tarkan) hoy no hay ninguna celda con 2 muertes: las celdas repetidas son de Arena 2/4 y Aida, donde no se
  caza. El mecanismo queda listo para cuando haya.

## 7. La vida de 16 bits se da vuelta (HANDOFF "pendiente #4")

- Hume (nivel > 350, `mode = farm`, 11.777 fotos): **30 %** de las lecturas entre 57.344 y 65.535 y el máximo
  informado es 65.535 (`hp = 65535` en el 20 % de todas las fotos).
- **38 fotos con `hp < 300` (14 de ellas con > 10M exp/min)**, y las lecturas **141, 143, 146, 146** se repiten
  en horas distintas del 23/10 con 57M-500M exp/min en la esquina de Arena 2 y Arena 4: peleando a pleno rendimiento no
  se está a 146 de vida. Es lo que da un máximo real de ~65.682 leído en 16 bits (65.682 - 65.536 = 146).
- Es una **inferencia de los datos, no una captura del packet**: hay que confirmarla con el log del bot nuevo (aparece
  `HP: la lectura de 16 bits se dio vuelta…` y el evento `hp_wrap` en la base).
- **Decisión que cambia:** `HpTracker` (`health.ts`) des-envuelve por continuidad (un salto de ≥ 55.000 entre dos
  lecturas seguidas no es un golpe), sube `world.maxHp` a lo visto y deja `world.hp` con la vida real estimada:
  pociones (`checkSurvival`) y la huida de `defense.ts` ("vida < 35 %") dejan de ver un 0,2 % falso. La muerte (0)
  nunca se des-envuelve y sin máximo cerca del tope no toca nada.

## 8. Rendimiento general (contexto)

- Ciclo de reset de Hume (últimos 10 días): **102 min en promedio** (50 ciclos).
- El vigía de ciclo largo (`long_cycle`) salta con `conectando` en 66 de 151 casos: el estado de reconexión no es
  "ciclo largo". El vigía nuevo (`watchdog.ts`) se apaga en `connecting`/`dead`/`paused`/`resetting`.

## Cómo repetirlo

```bash
# solo lectura; las credenciales las toma Bun del archivo, no se imprimen
bun --env-file=/ruta/.env.db scripts/aprender.ts
```

Las consultas de `insights.ts` (`SQL`) son las mismas que sirvieron para este documento.
