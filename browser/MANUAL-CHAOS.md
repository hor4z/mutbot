# Máquina de Chaos: recetas de este server

Extraídas del cliente web (`layout--*.js`, textos `mix.*` del idioma inglés) el
2026-10-10. Son las recetas que el cliente sabe mostrar; las **tasas de éxito no
vienen en el cliente** (las define el server, OpenMU). En MU, si una subida de
+10 a +15 falla, el ítem normalmente se destruye; confirmar la regla del server.

## Subir nivel de ítems

| Receta | Ingredientes |
|---|---|
| +9 → +10 | ítem +9 + Chaos + Bless + Soul |
| +10 → +11 | ítem +10 + Chaos + Bless + Soul |
| +11 → +12 | ítem +11 + Chaos + Bless + Soul + Creation |
| +12 → +13 | ítem +12 + Chaos + Bless + Soul + Creation |
| +13 → +14 | ítem +13 + Chaos + Bless + Soul + Creation |
| +14 → +15 | ítem +14 + Chaos + Bless + Soul + Creation |
| Fusión a +14 / +15 | (recetas propias de este server, sin detalle en el cliente) |

## Alas y capas

| Receta | Ingredientes |
|---|---|
| Alas nivel 1 | arma Chaos (+4 o más) + Jewel(s) of Chaos |
| Alas nivel 2 | alas 1 + Loch's Feather + Chaos (+ ítem excelente) |
| Capa de Lord / Fighter | alas 1 + Crest of Monarch + Chaos |
| **Alas nivel 3, etapa 1** | alas 2 o capa + ítem **ancient** + Chaos + 5 Bless + 5 Soul |
| **Alas nivel 3, etapa 2** | Flame of Condor + Feather of Condor + ítem excelente + Chaos |

## Armas y mascotas

| Receta | Ingredientes |
|---|---|
| Arma Chaos | arma + Chaos (+ Bless / Soul) |
| Dinorant | 10 Horns of Uniria + Chaos |
| Dark Horse | Spirit of Dark Horse + 5 Bless + 5 Soul + Chaos + Creation |
| Dark Raven | Spirit of Dark Raven + 5 Bless + 5 Soul + Chaos + Creation |
| Fenrir 1 | 20 Pieces of Horn + 5 Claws of Beast + Chaos |
| Fenrir 2 | 10 Broken Horns + 5 Claws of Beast + Chaos |
| Fenrir 3 | Broken Horn + 3 Jewels of Life + Chaos |
| Mejora de Fenrir | Horn of Fenrir + 5 Bless + 5 Soul + Chaos + arma/armadura |

## Eventos (entradas)

| Receta | Ingredientes |
|---|---|
| Devil's Invitation (Devil Square) | Devil's Eye + Devil's Key + Chaos |
| Cloak of Invisibility (Blood Castle) | Blood Bone + Scroll of Archangel + Chaos |
| Illusion Temple | Old Scroll + Illusion Sorcerer Covenant + Chaos |
| Secromicon completo | los 6 fragmentos + Chaos |

## Consumibles y otros

| Receta | Ingredientes |
|---|---|
| Fruta (puntos de stat) | Creation + Life |
| Potion of Bless / Soul | Jewel of Bless / Soul |
| Poción de escudo chica / media / grande | 3 pociones de vida chicas / medias / grandes + Bless |
| Life Stone | 5 Guardian + 5 Bless + 5 Soul + Chaos + Creation |
| Opción Guardian (nivel 380) | ítem nivel 380 + Harmony + Guardian |

## Para Horaz (2026-10-10)

- Arma derecha 0/13 **+15 exc**: ya al tope.
- **Alas 12/5 +9**: siguiente paso +10 (Chaos + Bless + Soul). Tiene 1 Chaos y 1
  Soul; **falta Bless**. Riesgo de destruirlas si falla.
- **Alas nivel 3** (etapa 1): alas 2 + ítem ancient + Chaos + 5 Bless + 5 Soul.
  Es la mejora grande de verdad; hace falta un ancient y juntar joyas.
- **Le faltan los guantes** (10/1) para completar el set.
- **Frutas** (Creation + Life): dan puntos de stat extra. Tiene 1 Creation.

## Prueba real: armadura Dragon +11 → +12 (2026-10-10, 22:45)

- Receta según el cliente: ítem +11 + Chaos + Bless + Soul + Creation (tipo de mezcla 22).
- **El botón "Combinar" del cliente responde "Estos objetos no se combinan así"**: valida contra el tipo
  de mezcla seleccionado (por defecto "Arma Chaos") y no manda nada.
- **Mandando el paquete con el tipo correcto** (`C1 05 86 16 00`, lo mismo que manda el botón): el server
  no respondió y no cambió nada (ni ítems ni zen). Este server, con el perfil 0.97d, parece tener solo
  las subidas a +10 y +11 de OpenMU (Version095d/ChaosMixes.cs). Las piezas +13 de Horaz salieron de otro lado.
- Sin pérdidas: todo volvió al inventario y la armadura se volvió a equipar.
- Chances en OpenMU, por si el server las tiene: +10/+11 60 % (SeasonSix; 50/45 % en 0.95d), +12/+13 55 %,
  +14/+15 50 %, más 25 % con luck. **Si falla, el ítem desaparece** (MixResult.Disappear).
- Cómo se opera desde el bot: Chaos Goblin (NPC 238, Noria 180,103) → `talkToNpc` → `__store.autoMoveItem(0, slot, 3)`
  por ítem → paquete de mezcla → `autoMoveItem(3, i, 0)` para sacar.
