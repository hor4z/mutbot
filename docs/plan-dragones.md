# Plan de caza de dragones (2026-10-23)

Horas en UTC (ART = UTC-3). Datos de `mubot.events`, solo lectura. Hay poco: lo no medido va marcado como supuesto.

## Medido

- La invasión avisa a las :50:00 (`[Mapa] Golden invasion!`) y cierra a las :05. Mapas avisados hoy: 17:50 Noria, 18:50 Devias.
- Golden Dragon (tipo 79) visto en `golden_seen`: Devias (mapa 2), Noria (3) y Lorencia (0). Posiciones:
  - Devias: x 190-240, y 80-236 (zonas fuertes (229,176) n=5, (192,159) n=3, (231,184) n=3, (217,83) n=2, (232,214) n=2).
  - Noria: x 40-165, y 114-206 (zonas fuertes (64,157) n=11, (112,173) n=5, (52,182) n=4, (90,170) n=4).
  - Lorencia: x 129-200, y 114-228 (zona (129,171) n=5, (184,136) n=3).
  - Son 52 zonas en `v_dragon_zones`; casi todas con 1-2 avistamientos: el previo es blando.
- Invasión de las 18:50 en Devias, Hume (BK 400): primer dorado muerto a los 27 s del aviso (18:50:27). Dragón 1 visto 18:51:50 (110 s del aviso) en (192,155), lo mató `camberra1` a las 18:52:51: **61 s** desde que se lo vio. Dragón 2 visto 18:53:39 en (217,83), lo mató `Dania` a las 18:54:48: **69 s**. Un Titan lo mató `Arcano`. Con competencia un dragón dura ~1 min a la vista.
- Hume mató 0 dragones en esas dos; en la de las 17:50/18:50 sus kills de dorados fueron comunes (Solider, Titan). Cajas: 31 `loot_ok`, 25 `loot_foreign` en el día.
- `hunt_end`: la de 18:58 cortó con "no quedan dorados vivos en Devias" a los 8,5 min con 7 dorados vistos.
- Skills (data/skills.json): Death Stab 43 daño 70, AG 12, nivel 160, alcance 2; Rageful Blow 42 daño 60, AG 20, nivel 170. A nivel 400 `goldenSkill` ya elige Death Stab: **no** hay una regla vieja de 160 en el camino (160 es el piso correcto de Death Stab; el 170 es de Rageful Blow, que además pega menos). Crescent Moon Slash (44, daño 90, alcance 4) no lo tiene el BK en la tabla (`AllKnights`, solo si lo aprendió); no se tocó.
- Señales de daño que existen: el 0x15 de 10 bytes (`ObjectHit` de 0.97d: id u16 BE, daño u16 BE) llega para cualquier golpe en el scope; no dice quién pegó. Nuestros golpes se cuentan al lanzar el skill (el server no confirma impacto). La vida del Golden Dragon viene de `monsters.json` (HP).

## Por qué Hume no llegó (hipótesis fuerte, no probada con trazas)

En la rama de pelea, el acercamiento al objetivo era **en línea recta** (`step(dir)` con giros a tientas) y a los 8 pasos sin avanzar el objetivo pasaba a `unreachable` (UNREACHABLE_MS): si hay una pared entre Hume y el dragón a 10 tiles, el dragón queda descartado, `stickyGolden` lo filtra y Hume cae a Solider/Titan. `walkTowards` (con `findPath` y terreno) existía pero solo se usaba sin objetivo. Con 61-69 s de vida del dragón a la vista, ese desvío alcanza para perderlo. `stickyGolden` en sí cumple "dragones primero" (tests de golden-tests.ts).

## Cambiado (aditivo)

1. `dragon_fight` (evento, sin tablas nuevas): por cada dragón a la vista, `DragonFight` (golden.ts) registra: segundos desde el aviso hasta verlo y hasta el primer golpe, desde verlo hasta el primer golpe/fin, golpes nuestros, daño visto (0x15), vida estimada restante, jugadores (no compañeros) a la vista, posición inicial/final, killer, si fue nuestro (`num2`=1) y `outcome` killed/lost (15 s sin verlo). Consulta: `SELECT ts, data FROM events WHERE kind='dragon_fight'`.
2. Acercamiento a dorados cazando con `walkTowards` (camino por terreno) y un dragón no se da por inalcanzable hasta 24 intentos sin avanzar (antes 8).
3. `dragonRush` (golden.ts): en los 3 min desde el aviso, en el mapa del dragón, sin dragón a la vista y con una zona de dragón sin visitar, la cacería no empieza dorados comunes nuevos ni va a recordados: va a las zonas. Sigue con el común que ya le pegó. Si algo falta (sin aviso, otro mapa, sin zonas), igual que antes.
4. Tests: golden-tests.ts (DragonFight, dragonRush), packet-tests.ts (parseHitDamage).

## Decisiones con datos / pendientes

- (c) Varios bots: la ayuda por dragón ya existe (`askHelp('golden', ...)` al ver uno nuevo). Que un bot sea scout puro y avise (scout.ts, /api/team) no se tocó: no hay `scout.ts` en este árbol y no hay datos de cuánto ahorra. Pendiente.
- (d) Pre-posicionarse antes de las :50: **no** se implementa. El mapa solo se sabe con el aviso (hoy Noria, luego Devias), la historia de los últimos días muestra los tres mapas y no hay una regla medida. Con el aviso a las :50:00, llegar tomó ~27 s al primer dorado; el costo grande fue el tiempo hasta ver al dragón (110 s), lo que `dragonRush` ataca. Revisar cuando haya `dragon_fight` de varias invasiones.
- Rastrillaje (docs/rastrillaje.md, en el checkout principal): orden de celdas de `HuntExplorer` por probabilidad ÷ costo con baja bayesiana por celda recorrida sin dorados, y suavizado de camino con línea de vista. **Pendiente**, no entró antes de las 16:50 ART. Prioridad: previo blando de `v_dragon_zones` mezclado con uniforme (pocos datos), sin tocar ritmos.
- No verificado: que el layout del 0x15 de 10 bytes sea exactamente id@3/daño@5 (solo hay el test con bytes inventados); nada corrió contra el server.
