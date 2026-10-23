# Ítems y máquinas del server

Qué se sabe del sistema de ítems de MuWeb (mu.mormon.garden) y cómo lo usa el bot. **Hechos con fuente**:
cada dato dice de qué guía sale. Lo que el server no publica está marcado "NO PUBLICADO"; las estimaciones
del código van como estimación, nunca como hecho.

Fuentes (todas públicas, solo lectura, leídas el 2026-10-23):

| Sigla | Qué es | Fecha |
|---|---|---|
| **G-Subir** | guía "✨ Subir items: de +9 a +15" (`/api/guides/1559306517944209493`) | 2026-10-12 |
| **G-Alq** | guía "⚗️ El Alquimista: Cristales, Alquimia y Talismanes" (`…1559306528203345930`) | 2026-10-12 |
| **G-Harm** | guía "💎 Jewel of Harmony y Refine Stones" (`…1563053130852208670`) | 2026-10-23 |
| **G-Fen** | guía "🐺 Cómo hacer un Fenrir" (`…1562906687340421190`) | 2026-10-22 |
| **G-Kun** | guía "👑 Invasión Dorada y Cajas de Kundun" (`…1559306545047801878`) | 2026-10-12 |
| **G-Com** | guía "💰 Comercio: chat, tiendas, Zen Chest y pilas" (`…1559306491767558264`) | 2026-10-12 |
| **G-Caz** | guía "🎯 El Cazador" (`…1559306510738399373`) | 2026-10-12 |
| **G-Res** | guía "🔄 Reset, Gran Reset y la tienda de monedas" (`…1559306504417579029`) | 2026-10-12 |
| **N-xx** | novedades (`/api/news`), con la fecha: N-10-19 (cajas y sets, Mercado), N-10-22 (Kanturu, Talismán de Protección), N-10-23 (armonía, Mercado) | |
| **MANUAL** | `browser/MANUAL-CHAOS.md`: recetas del cliente (2026-10-10) y una prueba real; **más viejo que las guías: si chocan, mandan las guías** | |

No hay una guía de "Mercado" ni de "requisitos de equipo": lo que se sabe del Mercado sale solo de las
novedades (ver abajo) y los requisitos salen de `data/items.json`.

## Identidades de ítems (grupo/número)

De `data/items.json`. Ojo con los nombres: en este server **los Cristales son el ítem 14/31, que el JSON
llama "Jewel of Guardian"**.

| Qué | grupo/núm | Notas |
|---|---|---|
| Jewel of Chaos | 12/15 | |
| Bless / Soul / Life / Creation | 14/13, 14/14, 14/16, 14/22 | se apilan hasta 255 (G-Com); la **durabilidad del ítem es la cantidad** (visto en el baúl de Hume: Bless 74, Soul 11; supuesto razonable, sin verificar) |
| **Cristal** | 14/31 | moneda del Alquimista y del Mercado |
| Box of Kundun | 14/11 con nivel | el cliente la llama "Box of Luck +N": **Kundun +1 = nivel 8 … +5 = nivel 12** (N-10-21: "Box of Luck +12" = "Box of Kundun +5") |
| Talismán de Protección / +14 / +15 | 14/7, 14/12, 14/20 | según `farming.ts` (CURRENCY_ITEMS); nombres de items.json: Siege Potion, Heart, Remedy of Love |
| Gemstone, Jewel of Harmony, Lower/Higher Refining Stone | 14/41, 14/42, 14/43, 14/44 | |
| Fenrir: Splinter, Bless of Guardian, Claw, Piece (Fragment) of Horn, Broken Horn, Horn of Fenrir | 13/32, 13/33, 13/34, 13/35, 13/36, 13/37 | |

## Chaos Goblin (Chaos Machine) — Noria (180, 102)

Ubicación: G-Subir ("Noria (180, 102)"); MANUAL dice NPC 238 en (180,103). **Toda mezcla requiere
confirmación humana**: una que falla puede quemar el ítem.

### Subir de +9 a +13 (G-Subir)

| Hacia | Ítem | Joyas |
|---|---|---|
| +10 | ítem +9 | 1 Chaos, 1 Soul, 1 Bless |
| +11 | ítem +10 | 1 Chaos, 2 Soul, 2 Bless |
| +12 | ítem +11 | 1 Chaos, 3 Soul, 3 Bless |
| +13 | ítem +12 | 1 Chaos, 4 Soul, 4 Bless |

- **Tasa: NO PUBLICADA.** La guía dice "cuanto más alto, menor el %" y que la ventana muestra el % antes de
  mezclar; "un ítem con luck suma +25 %". El MANUAL cita OpenMU (+10/+11 60 %, +12/+13 55 %, +25 con luck):
  referencia, no dato del server. `crafting.ts` la usa solo como estimación marcada (`assumed`).
- **Costo en zen: NO PUBLICADO** para estas subidas.
- **Si falla: la guía no lo dice.** OpenMU hace desaparecer el ítem (MANUAL). Tratarlo como pérdida.
- **Con Talismán de Protección** (G-Subir, "Tips"): "también sirve de +9 a +13: si falla, tu ítem queda como estaba".
- Sobre el MANUAL: su tabla vieja (con Creation desde +11) y su prueba real (el server no contestó) son
  anteriores a G-Subir; vale G-Subir.

### Fusión a +14 y +15 (G-Subir)

Solo **armas, escudos y partes de set**; los dos ítems tienen que ser iguales (mismo ítem).

| Fusión | Éxito | Zen | Talismán (hasta 2, del nivel) |
|---|---|---|---|
| dos +13 → +14 | **45 %** | 50.000.000 | +14: 55 % con 1, 65 % con 2 |
| dos +14 → +15 | **25 %** | 100.000.000 | +15: 35 % con 1, 45 % con 2 |

- **Sale bien:** queda **el mejor** de los dos (más excelentes, después luck, después opción más alta) y sube
  un nivel; el otro se quema.
- **Falla:** **se queman los dos**. Los talismanes puestos se gastan **salga bien o mal**.
- **Talismán de Protección** (opcional): si falla, se quema el talismán y **los dos ítems quedan intactos**; si
  sale bien no se gasta. **El zen se paga igual.**
- Para un +15 hacen falta **cuatro** +13 iguales (dos +14). Tip de G-Subir: juntar dos copias iguales antes de
  subirlas a +13. Un +14/+15 cristalizado da muchos Cristales.
- G-Alq dice que el talismán "suma +10 %" (cada uno): coincide con la tabla de G-Subir.

Cómo se opera (a mano, en el cliente): abrir la Chaos Machine del Chaos Goblin → poner los ítems (y
talismanes) → mirar el % que muestra la ventana → mezclar.

### Fenrir (G-Fen, N-10-22)

Materiales caen solo en Kanturu: Splinter of Armor 3 %, Bless of Guardian 3 % (cualquier monstruo), Claw of
Beast 1,5 % (de Genocider para arriba). Se apilan 20 por casilla (Claw 10).

| Fase | Entradas | Éxito | Zen |
|---|---|---|---|
| 1 Fragment of Horn | 20 Splinter + 20 Bless of Guardian + 1 Chaos | **70 %** | no se lista |
| 2 Broken Horn | 5 Fragment + 10 Claw + 1 Chaos | **50 %** | no se lista |
| 3 Horn of Fenrir (rojo) | 1 Broken Horn + 3 Life + 1 Chaos | **30 %** | **10.000.000** |
| 4 Mejora (negro = armas, azul = armaduras) | Horn + 1 Chaos + 5 Life + equipo +4 con opción | "hasta 79 %" según el valor del equipo; **sin tabla** | **10.000.000** |

Con **Talismán de Protección** en la bandeja, si falla se salvan los materiales, el Fenrir y el arma o
armadura; se pierden solo las joyas, el zen y **un** talismán. Sin talismán, "en promedio unos 950 Splinter,
950 Bless y 65 Claw". Con talismán en cada mezcla: exactamente 100 Splinter, 100 Bless y 10 Claw.

## Alquimista — Noria (junto al Chaos Goblin) y Lorencia (G-Alq)

Tres servicios, todos desde su ventana:

1. **Cristalizar**: quema equipo **excelente** (armas, escudos, partes de set; **alas no**) y paga Cristales.
   Hasta **8 ítems** por vez, hasta +15, **500.000 zen por tanda** (no por ítem). Cada ítem puede salir
   **CRÍTICO (x2)** o **JACKPOT (x10)**: **tasas NO PUBLICADAS**.
   Cristales por ítem: por opciones excelentes 1 → 1 · 2 → 3 · 3 → 8 · 4 → 20 · 5 o 6 → 50; ítem de grado bajo
   x0,5 · alto x1,5 · top x2; desde +9 x1,5 · +14 x4,5 · +15 x15; con luck +25 %. Ejemplo oficial: set top, 4
   opciones, +9, luck ≈ 75 (el test lo reproduce: 20 × 2 × 1,5 × 1,25). **Qué ítem es "bajo/alto/top" NO está
   publicado**: `item-score.ts` estima por el nivel que pide el ítem. Entre +10 y +13 la guía no da multiplicador
   propio (el código usa x1,5 desde +9 hasta +13).
2. **Alquimia (re-sortear excelentes)**: un solo ítem; se puede poner candado a las opciones a conservar (al menos
   una sin candado); siempre cambia algo y sale al menos una opción nueva. **60 Cristales + 20.000.000 zen por
   tirada, y 60 Cristales más por candado.** No se puede si el ítem ya tiene todas las opciones.
3. **Talismanes**: +14 = **100 Cristales**, +15 = **250**, Protección = **2.000** (en **cualquier** combinación
   del Chaos Goblin: si falla se quema el talismán y el ítem queda; las joyas y el zen se gastan igual).

Los Cristales salen también del Cazador (G-Caz), de Aida (2 % por monstruo, N-10-22) y de los premios
semanales (150/300/500, N-10-15).

## Jewel of Harmony y Refine Stones (G-Harm, N-10-23)

Sirve para cualquier **arma, escudo o pieza de set, menos ancient**. Una sola opción de armonía por ítem.

1. **Gemstone**: 1 % por monstruo de Kanturu.
2. **Elpis** (Kanturu3, `/move Kanturu3`): Gemstone → Jewel of Harmony, **80 %**.
3. **Jewel of Harmony sobre el ítem** (se arrastra como una Bless): **60 %** de poner una opción al azar. Si falla
   se gasta la joya y el ítem queda igual. Si ya tiene armonía no pasa nada y no se gasta. Opciones en
   armaduras y escudos: defensa, AG máxima, vida máxima, recuperación de vida y maná, defensa en PvP, menos daño
   recibido; en armas: daño mín/máx, daño, crítico, daño de skills, éxito PvP, menos fuerza/agilidad pedida.
4. **Refine Stones** suben el nivel de la opción: **Lower 20 %**, **Higher 80 %**; **si fallan, la opción vuelve a
   su nivel más bajo**. El nivel del ítem limita la opción (en gris = todavía no activa; a +13 llega al máximo).
5. **Osbourne** (campamento de Aida, `/move Aida`) fabrica piedras con equipo que no usás (+4 o más si es de lo
   básico): cada ítem común → 20 % de una Lower; cada excelente → 50 % de una Higher; la ventana muestra la
   chance de sacar al menos una. **Si falla se pierden los ítems.**
6. **Jerridon** (junto a Osbourne) **saca la opción** por zen: de **100.000 a 500.000 según el nivel de la
   opción** (tabla NO PUBLICADA). Sirve para volver a tirar una Jewel si no gustó la opción.
7. **Es de la cuenta**: pasa entre tus personajes por el baúl, se muestra en el chat y se le sortean los
   excelentes en el Alquimista; **no se tradea, vende, cristaliza ni tira** (ni se cae en PK). La Gemstone, la
   joya y las piedras sí se tradean y venden. Para vender el ítem, primero Jerridon.
8. Nada de SD (acá no hay SD).

Implicancia para el bot: **no cristalizar nunca un ítem con armonía** (el server no lo deja) y no ofrecerlo al
Mercado.

## Cajas de Kundun (G-Kun, N-10-19)

Todos los dorados sueltan una Box of Kundun; siempre dan **un ítem excelente, nunca zen**. Dónde: Noria Golden
Goblin +1; Lorencia Golden Budge Dragon +2; Devias Golden Soldier/Titan +2; Atlans Vepar +3, Lizard King +4;
Tarkan Wheel +3, Tantallos +5; Golden Dragon (Lorencia/Noria/Devias) +5; Dragón Rojo +4. Otras fuentes: Blood
Castle (+5 al que entrega el arma y su party), Big Boss (tres +5), Devil Square, Cazador, **Thompson** (monedas:
+1…+5 por 5/10/15/20/25), Aida (1 % por monstruo de +4 o +5).

**Calidad de la caja**: la guía vieja (G-Kun) dice +1 → +0 a +2 … +5 → +7 a +9. **N-10-19 (más nueva) la
reemplaza**: +1 → +5 a +7 · 1 exc · 20 % luck; +2 → +6 a +8 · 1-2 exc · 35 %; +3 → +7 a +9 · 2 exc · 50 %;
+4 → +8 a +10 · 2-3 exc · 65 %; +5 → +9 a +11 · 3-4 exc · 80 %. Además cada caja tira **65 % lo de siempre / 35 %
sets**: los sets top (Great Dragon, Dark Soul, Hurricane, Red Spirit, Divine, Grand Soul, Dark Phoenix…) salen
solo de +4 y +5. Lo que cae de una caja es del dueño y su party 10 s; las cajas, Cristales y excelentes tardan
2 s en poder levantarse y se sortean (N-10-18). **El bot no abre cajas.**

## Mercado entre jugadores (solo N-10-19, N-10-21, N-10-23 y G-Com)

- Se pueden **vender Box of Kundun +1 a +5** (N-10-19); sus nombres se ven correctos desde N-10-21.
- Al vender, la referencia de precios muestra las **últimas 10 publicaciones** de ese ítem y sus **últimas 10
  ventas** (N-10-23).
- Los ítems con **armonía no se pueden vender** (G-Harm).
- Moneda: el HANDOFF dice que el Mercado cobra en **Cristales**; **ninguna guía ni novedad lo confirma** ni da
  comisión, ubicación o forma de publicar: NO PUBLICADO.
- Aparte, G-Com describe tienda personal (precio 0 = de muestra), trade (pedidos sin respuesta a los 20 s),
  canal de comercio (desde nivel 20, un mensaje cada 15 s), Zen Chest de Lumen (500 M, tope de zen 2 mil M) y
  pilas hasta 255.
- El bot **no compra ni vende** (AGENTS.md, Economía): el planificador no genera operaciones de Mercado.

## Baúl (Baz, Lorencia) y VIP (guía "👑 Membresía VIP")

Baz es el NPC 240 de Lorencia. `/baul` abre el baúl desde cualquier lado con VIP Plata o más; VIP Oro suma una 2ª
página (si se vence la VIP se puede sacar de la 2ª página pero no guardar). Todas las casillas del baúl son de la cuenta (se comparten entre personajes).

## Requisitos de equipo: qué dice `data/items.json` y por qué no es de fiar

Las columnas del JSON están **corridas** y de dos formas distintas según la fila (ver cabecera de
`item-rules.ts`). Deducido cruzando sets conocidos (Great Dragon = DK, Hurricane/Storm Crow = MG, Grand Soul =
DW, Plate = DK+MG, Vine = Elf, Dark Master/Light Plate = DL); los tests lo fijan, pero **no está verificado
contra el server**:

- Filas "nuevas" (`Def > 0`, sets altos): defensa = `Def`; clases en `[DK/BK, Elf/ME, MG, DL, SUM]` =
  `[DW, DK, Elf, MG, DL]`; fuerza pedida = columna `Agi`, agilidad pedida = `Ene`; nivel = `ReqLvl`.
- Filas "viejas" (`Def = 0`, sets básicos): defensa = `DefRate`; clases en `[Elf/ME, MG, DL, SUM]` = `[DW, DK,
  Elf, MG]`; fuerza pedida = `Ene`, agilidad = `Vit`.
- Valor de clase: 1 = clase base y evolucionadas, 2 = solo evolucionada (BK/SM/ME).
- **Armas, alas, anillos y mascotas: sin reglas de clase fiables** (otras columnas corridas): el plan no las
  toca. Dark Breaker y Wings of Dragon de Hume quedan como están.
- La armonía puede bajar los requisitos (G-Harm): no se modela.

El server tiene la última palabra: `equip.ts` recuerda lo que rechaza y no lo reintenta.

## Cómo puntúa el bot un ítem (`item-score.ts`)

Heurística nuestra (puntos de defensa equivalentes), no datos del juego: defensa base + bonus por nivel (tabla
de OpenMU 0,3,6…27 en +9, 31 en +10 … 66 en +15) + 4 por punto de opción + excelentes (daño recibido −4 % pesa 25,
éxito de defensa 10, reflejo 8, vida 6, maná 4, zen 3; el **orden de bits es el del MU original, sin verificar
acá**) + luck 4 + ancient 20 + armonía. Con eso arma el plan de equipo, puntúa drops (`makeDropJudge`, apagado
por defecto) y decide qué cristalizar (`judgeItem`).

## Protocolo: qué está verificado y qué falta

| Acción | Packet | Estado |
|---|---|---|
| Mover bolsa ↔ equipo | `C3 0C 24 00 <de> <5 bytes> 00 <a>` (`C3 0D` con ítem de 6) | **probado en vivo** (Hume, 2026-10-12) |
| Hablar con un NPC | `C3 05 30 <id BE>`; cerrar `C1 03 31` | probado en vivo con Baz (`vault.ts`) |
| Lista del baúl | `StoreItemList` (C2 31), mismo formato que el inventario | probado en vivo (vault-Hume.json) |
| **Sacar del baúl a la bolsa** | `C3 0D 24 02 <casilla baúl> <6 bytes> 00 <casilla bolsa>` | **SIN VERIFICAR**: deposito 2 = baúl sale del cliente web (`placePickedItem(slot, 2)` al guardar, `browser-agent.js`); el HANDOFF decía "C3 24, sin verificar"; nunca se mandó desde el headless. Falta confirmar la respuesta (`ItemMoved`, byte 3 = casilla o 0xFF) |
| Mover a la Chaos Machine | `autoMoveItem(0, slot, 3)`: depósito 3 | sin verificar desde el headless |
| Mezclar | `C1 05 86 <tipo> 00` (tipo 22 = 0x16, subida) según MANUAL | el MANUAL anota que **el server no contestó** a la prueba del 2026-10-10 (antes de que existieran las recetas actuales); respuesta `ChaosMachineMixResponse` sin parsear |
| NPC Chaos Goblin | NPC 238 (Noria, 180-103) | `talkToNpc` del cliente; el bot headless nunca le habló |
| Alquimista, Elpis, Osbourne, Jerridon | — | **no hay nada**: ni NPC ni packets; ventanas custom del server |

**Hueco**: no hay ejecución de mezclas en el bot. `crafting.ts` solo propone (siempre `needsConfirmation: true`,
`executable: false`). Para implementarla hace falta, con un humano mirando y un ítem descartable: capturar con el
cliente web los packets de abrir la máquina, mover a depósito 3, mezclar y la respuesta, y verificar que el
Talismán de Protección entra por el mismo camino.

## Qué hace el bot hoy con todo esto

- `equipplan` (orden del panel, solo muestra) y `equip` (ejecuta, solo si alguien la manda): ver AGENTS.md,
  "Ítems y baúl".
- `crafting.ts` → `planCrafts(holdings, fighter)`: ordena por valor esperado y deja explícito el riesgo.
  Regla que sale de los números: **una subida +9→+10 de una pieza de ~200 puntos gana ~4 puntos y arriesga todo
  el ítem sin Talismán de Protección** (2.000 Cristales): sin él, no conviene. Cristalizar lo que sobra es lo
  único con valor esperado positivo seguro; el re-sorteo cuesta 60 Cristales + 20 M por tirada.
