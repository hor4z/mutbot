# Protocolo 0.97d: lo que hay que saber

Verificado contra el server real (cliente web `v097d`: OpenMU con inicializador `Version095d` y un adaptador propio que reescribe los packets
antes de mandarlos). Los parsers generados de `src/packets/` (season 6) fallan en varios casos: el síntoma típico es que el bot queda ciego sin
avisar. Ante la duda, mirar el tráfico real con `tools/decode-frames.ts`.

## Lo que sale por el cable (no lo que arma el cliente)

| Acción | Packet |
| --- | --- |
| Golpe | `C1 07 15 <id BE> <anim 78/79 alternado> <dir>` (no `0x11`: así dio 0 kills) |
| Caminar | `C1 10` (dirs de a 2 por byte desde el 6; nibble bajo del 5 = pasos, alto = rotación) |
| Skill a objetivo | `C3 06 19 <ÍNDICE en la lista> <id BE>` (índice, no número) |
| Skill de área | `C3 07 1E <índice> x y rot`, o `C3 09 1E <índice> x y rot <id BE>` con objetivo |
| Warp por menú | `C1 0A 8E 02 00 00 00 00 <índice LE u16>` (Lorencia = 2) |
| Levantar drop | `C3 05 22 <id BE>` |
| Ping | `C3 0C 0E 00 <TickCount LE u32> <AttackSpeed LE u16> 00 00` cada 5 s; eco `C1 04 FB 02` cada 2 s |
| Chat | `C1 len 00 <nombre 10 bytes> <texto>` (party con `~`, guild con `@`, comandos con `/`); susurro `C1 len 02 <destino 10> <texto>` |

Los skills van por índice con el mapa número a índice de `SkillListUpdate075` (3 bytes por entrada: índice, número, nivel). Los skills normales
tienen nivel 0: no filtrar por `level > 0`. Cifrado: xor32 propio (`XOR32_KEY_097D`) y SimpleModulus con las claves del cliente
(`net/encryption/`); con la clave de season 6 el server descarta el login en silencio.

## Eventos que se emiten con otro nombre

`SkillListUpdate` llega como `SkillAdded` (F3/11), `ObjectWalked` como `ObjectWalked075` (0x10), `MapChanged` como `MapChanged075` (C3/0x1C).
Escuchar el nombre "correcto" deja un listener muerto. `SkillAdded` se desambigua por `Count` (lista completa, alta o baja) y hay que clampearlo al
tamaño real del buffer: sin eso el parser lee fuera de rango y tira el proceso.

## Layouts que el parser generado rompe

- **ItemsDropped y MoneyDropped075** comparten `C2/0x20`: un drop de dinero llega siempre como `ItemsDropped`. Se distingue por tamaño
  (`5 + 16·N` ítems, 14 fijo dinero). El zen del suelo también llega como ítem 14/15.
- **Ítems de 5, 6 o 12 bytes** (6 desde la Jewel of Harmony): bytes 0 a 3 iguales; `e[4] & 0x10` es el bit 5 del número, `e[4] & 0x20` la opción
  380, `e[5]` la armonía. Con un parser de 5 bytes el bot descarta inventario y drops sin otro aviso. `protocol097.ts` acepta los tres.
- **CharacterList**: 0.97d manda el chico (26 bytes por personaje, count en el índice 4); el parser generado desborda. Se lee a mano (`parseCharacterList097`).
- **ServerListResponse (F4/06)** no trae dirección: sale siempre de `--cs-host`.
- **Endianness**: `NpcItemSellResult.Money` little endian; `InventoryMoneyUpdate.Money` y los ids big endian; `OpenNpcDialog.NpcNumber` little en el índice 4.
- **0x15 de 10 bytes** es el daño de un golpe (no un movimiento); **0x11 de 8 bytes** es "estás en (x, y)" (corrección de posición del server); el
  **0x11 de 16 bytes** (`ObjectHitExtended`) trae la vida que le queda al blanco en fracciones de 1/250 (sin verificar con bytes reales).
- **Ids de NPC** vienen con el bit alto puesto: enmascarar siempre con `& 0x7fff` (si no, el golpe apunta a un id que el server no encuentra).
- **Respuestas de levantar**: `C3 22 <casilla> <ítem>` (entró al inventario), `C3 08 22 FE <zen total u32 BE>` (zen), `C3 04 22 FF` (no se pudo).
- **Mover ítem** `C3 0C 24 <depósito> <casilla> <ítem> <depósito> <casilla>` (depósito 0 inventario, equipo 0 a 11, bolsa 12 a 75); responde `ItemMoved` con
  la casilla nueva o `0xFF`. Probado en vivo.
- **Reaparición** `RespawnAfterDeath075` (C1 F3 04): X @4, Y @5, mapa @6. Hay que actualizar posición y mapa o el bot camina desde donde murió.
- **Stats** por chat: `/add <str|agi|vit|ene> <n>`; tope 65535 por stat. Puntos y vida llegan en un `CharacterInformation` (F3/03).

## Anti-cheat

`SpeedHackDetectPlugIn`: delay base de ataque 450 ms y token bucket de 5. Ritmos del bot: caminata 380 ms, ataque 500 ms, skills 900 ms, chat 2,5 s.
**Son deliberados: no bajarlos** ni tocar la configuración del server para que el bot vaya más rápido.
