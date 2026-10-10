# Plan de farmeo: maximizar resets por día

Objetivo: **más de 100 resets por día** con Horaz (Dark Knight, Twisting Slash).
100/día = un ciclo cada **14,4 min**. Hoy: ~40 min el primer ciclo medido; el
ciclo actual llegó al 50 en 3,7 min (antes 11).

## 0. Cómo medimos (sin esto no hay mejora)

Todo cambio se juzga por **minutos por ciclo** y por **exp/min por tramo de nivel**.

| Métrica | Dónde | Meta |
|---|---|---|
| Minutos por ciclo | `__ai.cycles` | ≤ 14 |
| Tiempo por tramo (10→100, 100→200, 200→300, 300→400) | `__ai.samples` | ver §1 |
| % del tiempo peleando | `__ai.report().time.fight` | ≥ 90% |
| Kills/min y exp/kill | `expLog`, `expByType` | subir |
| Skills/min y golpes normales/min | captura de `sendToGS` | máx. skills, 0 golpes |
| Muertes por ciclo | `__ai.deaths` | 0 |
| Metros caminados sin pelear | `time.walk` + `time.idle` | ≤ 5% |

**Tarea 0.1:** registro de ciclo persistente (localStorage + export a
`~/.mubot/cycles.jsonl`): por ciclo, minutos por tramo, mapas usados,
campamentos, muertes, loot. Es la base de todas las comparaciones.

## 1. Presupuesto de tiempo por tramo (meta de 14 min)

La exp de un ciclo está ~90% arriba del 255. El presupuesto sale de eso:

| Tramo | Hoy | Meta | Palanca principal |
|---|---|---|---|
| 10 → 100 | ~6 min | **2 min** | ir directo a Devias 3/4, campamento conocido |
| 100 → 200 | ~4 min | **2 min** | Arena 2 directo al campamento conocido |
| 200 → 300 | ~3 min | **2,5 min** | Arena 3 abajo/adentro, sin competencia |
| 300 → 400 | ~20+ min | **7 min** | daño + densidad + 0 tiempo muerto |
| Reset | ~1 min | **0,5 min** | reset sin warp si el server lo permite |

**El tramo 300→400 decide todo.** Las fases siguientes atacan eso primero.

## 2. Combate: matar más por segundo

1. **Skill continuo (hecho):** recargar `castRequest` cada 50 ms. 0 golpes normales.
   - Medir skills/min reales y compararlo con la velocidad de ataque. Si el
     techo es la animación, la agilidad sube el techo → ver 2.4.
2. **Posicionamiento para el área:** Twisting Slash pega alrededor del DK. En vez
   de apuntar al "mejor monstruo", pararse en el **centro de masa del grupo**
   (punto que maximiza monstruos a ≤ 2 tiles) y castear ahí.
   - Implementar `bestCastPoint()`: grilla de candidatos alrededor del grupo,
     puntuar por suma de exp/s de los monstruos a ≤ 2 tiles.
   - Medir kills por cast antes/después.
3. **Pull/agrupado:** esperar 1–2 s a que los monstruos agresivos se acerquen
   antes del primer cast (en MU vienen solos al jugador). Experimento A/B.
4. **Reparto de stats (en curso):** energía hasta `ene ≈ fuerza − 2000`, después
   mitad/mitad; 15% vitalidad. Pendiente:
   - **Leer la energía real** del packet de stats en vez de estimarla del maná.
   - **A/B de builds por ciclo:** (a) actual, (b) +agilidad para velocidad de
     ataque, (c) 25% vitalidad. Juez: minutos del tramo 300→400.
5. **Nada de monstruos lentos:** `maxKillSec` y la estimación por `sqrt(vida)`
   ya están; el autoajuste afina el umbral.

## 3. Spots: llegar y quedarse donde rinde

1. **Memoria de campamentos (hecho):** posición + exp/min por mapa, persiste
   entre resets. Al llegar, ir directo al mejor a ≤ 40 tiles.
2. **Mapa de spots por entrada de warp:** cada warp (Devias 2/3/4, Arena 2/3/4)
   deja en un punto fijo. Guardar "mejor campamento desde esta entrada" y su
   ruta. Meta: < 15 s desde el warp hasta el primer cast.
3. **Ronda exploratoria controlada:** un ciclo cada N (o a pedido), 60 s por mapa
   recorriendo lo no visitado y registrando densidad. Los demás ciclos, cero
   exploración.
4. **Rotación de campamentos según respawn:** tener los 2–3 mejores campamentos
   de cada mapa y rotar cuando uno se vacía, en vez de esperar. Medir el tiempo
   de respawn por campamento y volver justo cuando reaparecen.
5. **Lo que dijo el usuario, como reglas fijas:**
   - Lorencia → Devias 3/4 (2 si no) → Arena 2 → 3 → 4. Devias 1 y Arena 1 nunca.
   - En Arena, los buenos están adentro, no en la entrada.
   - En niveles altos, Arena 4 hacia abajo en pantalla (+x, −z) tiene los
     monstruos de 3–4M exp.
6. **Cambio de mapa por tramo, no solo por nivel mínimo:** aprender "a qué nivel
   conviene saltar a Arena 3/4" (puede convenir antes o después del mínimo).
   Bandit sobre el nivel de salto, juez: minutos del tramo.

## 4. Competencia y otros jugadores

1. Detectar jugadores (hecho: `playersQuery`) y penalizar objetivos y
   campamentos con gente.
2. **Mapa de ocupación:** registrar a qué horas y en qué campamentos hay gente;
   preferir los que suelen estar vacíos.
3. Si un mapa entero está ocupado, pasar al de abajo/arriba según exp/min, no
   pelear por los mismos monstruos.

## 5. Tiempo muerto: llevarlo a cero

1. Repartir puntos sin frenar (hecho).
2. **Reset sin warp previo:** probar `/reset` desde Arena. Si el server lo acepta,
   ahorra ~10 s por ciclo.
3. **Selección de personaje instantánea** tras el reset (hecho: auto-select).
4. **Cargas de mapa:** minimizar warps (cada uno ~5–8 s de carga). Contar warps
   por ciclo y penalizarlos en las decisiones de cambio de mapa.
5. Pociones: comprar automáticamente antes de quedarse sin stock (Amy en
   Lorencia), aprovechando el paso por Lorencia del reset.

## 6. Loot

1. Levantar solo lo valioso (hecho): cajas, joyas, excelentes.
2. Abrir/usar Box of Kundun y vender o guardar joyas en un momento sin costo
   (en Lorencia, durante el reset).
3. Inventario: si se llena, no levantar más y avisar; nunca frenar el farmeo.

## 7. Robustez (para correr 24 h)

1. **Bot sin navegador** con reconexión, reanudación de ciclo y watchdog.
   - **Portado al headless, sin probar en vivo:** reconexión con backoff y
     reanudación desde el estado real (ver AGENTS.md, "Port del agente web"),
     más todo lo del agente web: exp por segundo, ruta fija por tramo, correa
     en Devias, zona de abajo en Arenas (default (91,13): el headless no tiene
     grilla de caminables), campamentos con vara por promedio móvil, pelea y
     skill en el camino, memoria de campamentos persistente, curiosidad,
     Twisting Slash fijo, `planStats`, rechazo de party, loot valioso, registro
     de tramos con proyección resets/día y hambre.
   - Falta: watchdog (proceso vivo sin exp N min → reiniciar) y la prueba en
     vivo con una cuenta que no esté abierta en el navegador.
2. Agente web: auto-retomar desde selección de personaje (hecho), detectar
   pestaña colgada, memoria acotada (sin capturas grandes).
3. Alertas: si en 5 min no subió exp, si murió 2 veces, si el ciclo pasa de
   30 min → registrar y cambiar de estrategia.

## 8. Autoajuste (aprendizaje)

1. **A/B intercalado (hecho):** 8 parámetros, ventanas de 3 min, adopta lo que
   gana > 5%.
2. **Siguiente:** ampliar el espacio a decisiones discretas (posicionamiento por
   centro de masa sí/no, esperar pull sí/no, nivel de salto de mapa, build).
3. **Juez por ciclo:** para cosas que solo se ven en un ciclo entero (build,
   ruta), comparar ciclos completos con la misma variante.

## 9. Orden de ejecución

| # | Tarea | Impacto esperado | Esfuerzo |
|---|---|---|---|
| 1 | Registro de ciclos y tramos (§0.1) | habilita todo | bajo |
| 2 | Posicionamiento al centro del grupo (§2.2) | alto en 300→400 | medio |
| 3 | Mejor campamento por entrada de warp (§3.2) | alto en todos los tramos | medio |
| 4 | Rotación por respawn (§3.4) | medio-alto | medio |
| 5 | Leer energía real + A/B de build (§2.4) | medio | medio |
| 6 | Reset sin warp (§5.2) | bajo pero gratis | bajo |
| 7 | Pociones y loot en el paso por Lorencia (§5.5, §6.2) | robustez | medio |
| 8 | Bot sin navegador 24 h (§7.1) | multiplica todo | alto |
| 9 | Party con mago/elfo (otras dinámicas) | a evaluar | alto |

Criterio para pasar a "otras dinámicas" (party, eventos, equipo): **3 ciclos
seguidos con fight ≥ 90%, 0 muertes y tramo 300→400 estable** (variación < 10%).

## 10. Roadmap: otras dinámicas (después de pulir farmeo y reset)

Pedidas por el usuario el 2026-10-10. Van después del criterio de §9.

1. **Eventos.** Devil Square (Horaz tiene 4 invitaciones, 14/19 nivel 1 a 4), Blood
   Castle y Chaos Castle: el juego muestra los temporizadores. Ir cuando abren si el
   evento da más exp/min que el farmeo del momento. Medir exp por evento.
2. **Invasión dorada (cada hora) y "lluvia de Kundun".** Leer el aviso del server
   en el chat e ir. Monstruos dorados: mucha exp y Box of Kundun.
3. **Cazar dragones y criaturas especiales** (jefes, dorados, Kundun): detectar por
   TypeNumber cuando aparecen en scope y priorizarlos si su exp/s lo justifica.
4. **Mejorar armas y equipo en la Máquina de Chaos.** Hoy: arma +15 exc (tope),
   alas 12/5 +9, armadura exc +11, resto +13. Mayor impacto: alas +10..+13 (riesgo
   de destruirlas si falla; ver Talisman of Luck). Juntar joyas con el loot.
5. **Skill según la situación.** Grupo → el AoE ganador del A/B (41/42/alternado);
   monstruo duro solo → Death Stab (43). Siempre al ritmo del cliente.
6. **Anillo de transformación (Elite Skeleton)** y otros bonus: A/B con y sin.
7. **Reset antes del 400** si el server lo permite: averiguar reglas (nivel, puntos,
   zen, grand reset). Del 350 al 400 se va casi la mitad de la exp del ciclo.
8. **Benchmark** con el ranking público (`/api/ranking`): techo realista de resets/día.

## 11. Roadmap: equipo (2026-10-10)

Horaz tiene **4 slots vacíos**: mascota, collar y los dos anillos (además de los guantes).

| Prioridad | Mejora | Por qué | Cómo |
|---|---|---|---|
| 1 | **Imp (13/1)** en mascota | +30% de daño en 0.97: kill más rápido | mercado / NPC |
| 2 | Collar excelente (daño % / vel. ataque) | más daño y más skills por minuto | mercado / drops |
| 3 | 2 anillos excelentes | aguante en Arena 4 | mercado / drops |
| 4 | Guantes 10/1 | set completo + defensa | loot (activo) / mercado |
| 5 | Arma izquierda +7 → +9 | el DK pega con las dos manos | 2 Bless + 1-2 Soul (sin riesgo de destrucción) |
| 6 | Alas 12/5 +9 → +10 | más daño y absorción | Chaos + Bless + Soul (riesgo) |
| 7 | Alas nivel 3 | salto grande de daño | alas 2 + ancient + Chaos + 5 Bless + 5 Soul |
| 8 | Frutas | puntos de stat extra | Creation + Life |

Recetas en `MANUAL-CHAOS.md`. Comprar o arriesgar ítems: siempre con confirmación del usuario.
