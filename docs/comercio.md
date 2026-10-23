# Comercio: ver paneles de venta, vender, comprar y tradear

Capacidad del bot y del panel, **no un automatismo**: el loop no llama a nada de esto. Todo se hizo offline
(nada se compró, vendió ni tradeó, ni se tocó ningún bot en vivo). Código: `commerce-packets.ts` (bytes),
`commerce-plan.ts` (planificador y resúmenes), `commerce.ts` (órdenes y estado), `ui/src/Commerce.tsx`
(vista "Comercio" del panel del personaje), tests en `commerce-tests.ts` y `panel-tests.ts`.

## Qué hay que saber del server (fuentes)

| Hecho | Fuente |
|---|---|
| Canal de comercio desde nivel 20, un mensaje cada 15 s; tienda personal en la ciudad, precio 0 = de muestra, se cierra al teletransportarte; trade: pedidos sin respuesta se cancelan a los 20 s; Zen Chest de Lumen 500 M, tope de zen 2 mil M; pilas hasta 255 | guía "Comercio" (`/api/guides/1559306491767558264`) |
| `/trade`, `/purchase` (abrir la tienda de otro) con el cursor sobre un jugador | guía "Todos los comandos" |
| Cajas +1 a +5 se pueden vender en el Mercado; la referencia de precios muestra las últimas 10 publicaciones y 10 ventas | novedades 10-19 / 10-23 (docs/items-y-maquinas.md) |
| Armonía: no se vende | guía de Jewel of Harmony |
| Thompson (monedas) vende equipo y cajas con monedas, no con zen | guía "Reset, Gran Reset y la tienda de monedas" |
| **No hay guía del Mercado** (ubicación, comisión, moneda): NO PUBLICADO. El HANDOFF dice que cobra en Cristales; ninguna guía lo confirma. Por eso el bot **no lee ni opera el Mercado**: solo catálogos de NPC y tiendas personales | docs/items-y-maquinas.md |
| Cajas (14/11) y Cristales (14/31): no se venden, se guardan para el usuario. Las joyas "no valen nada" pero sirven para mezclas | HANDOFF.md |

## Packets

Verificado en vivo (otros módulos): ítems de 5/6 bytes, `C3 05 30 <id BE>` (hablar), `StoreItemList`
(`C2`, tipo @4, cuenta @5, `[casilla][ítem]` desde @6; leyó el baúl de Baz), `C1 03 31` (cerrar), mover ítem
`C3 24` inventario↔bolsa.

Del XML de OpenMU (clases generadas en `packets/`; **sin verificar en vivo** con un mercader real): comprar
`C3 04 32 <casilla>` → `ItemBought` (`C1 32 …`) o `NpcItemBuyFailed` (`C1 04 32 FF`); vender `C3 04 33 <casilla>` →
`NpcItemSellResult` (`C3 08 33 <ok> <zen u32 LE>`); `NpcWindowResponse` (`C3 .. 30 <ventana>`: 0/1 mercader, 2 baúl,
3 máquina). **El NPC no manda precios** (el cliente los calcula con su tabla; `data/items.json` no los trae):
el panel muestra "—" y el bot aprende el precio de lo que realmente compró/vendió (diferencia de zen).

**SIN VERIFICAR EN VIVO, de memoria de OpenMU/Webzen** (en `packets/routes.ts` están los códigos S2C pero no hay
clases generadas): tienda personal `0x3F` y trade `0x36-0x3D`. Layouts usados (`commerce-packets.ts`):

| Acción | Bytes |
|---|---|
| pedir lista de tienda | `C1 10 3F 05 <id BE> <nombre[10]>` |
| comprar en tienda | `C1 11 3F 06 <id BE> <nombre[10]> <casilla>` |
| cerrar diálogo | `C1 10 3F 07 <id BE> <nombre[10]>` |
| precio | `C1 09 3F 01 <casilla> <u32 BE>` |
| abrir / cerrar mi tienda | `C1 28 3F 02 <cartel[36]>` / `C1 04 3F 03` |
| pedir trade / responder | `C1 05 36 <id BE>` / `C1 06 37 <1/0> <id BE>` |
| zen / botón OK / cancelar | `C1 07 3A <u32 BE>` / `C1 04 3C <1/0>` / `C1 03 3D` |

Supuestos extra: mis ítems en venta viven en las casillas 76-107 del inventario (8×4, como el área de tienda de
OpenMU) y se ponen con el mismo `C3 24`; los ítems del trade van con `C3 24` al depósito 1. La lista de una tienda
ajena (`PlayerShopItemList`, `C2 3F 05`) se parsea probando tres layouts contra el largo exacto y **devuelve null**
si ninguno cierra; el bot guarda el **hex del primer packet** de cada tipo no verificado en `shops.notes` (se ve en
el panel, "notas para verificar packets") para poder fijar el layout real. Ítems de la tienda: `[casilla][ítem][precio u32 BE]`.

## Contrato nuevo

Órdenes (`panel-protocol.ts`, aditivas; el panel manda `{type:'command', id, command}`):

- `{cmd:'shops', npc?: id, player?: id}` — **solo lectura**. Sin campos: refresca vendedores/jugadores a la vista.
  `npc`: habla con ese NPC (≤ 6 casillas), lee el catálogo y cierra. `player`: pide la lista de su tienda.
  Mínimo 2 s entre lecturas; no necesita pausa.
- `{cmd:'commerce', op}` — mueve zen o ítems. `op.kind`: `buy`, `sell`, `shop-open`, `shop-close`, `shop-buy`, `trade`,
  `trade-accept`, `trade-ok`, `trade-cancel`. Cada una (salvo `shop-close` y `trade-cancel`) exige:
  1. forma exacta (`isCommerceOp`, campos de más = rechazo; máx. 8 ítems a vender, 20 compras, 32 en tienda, 16 en trade);
  2. `confirm === commerceToken(op)` (`commerce-packets.ts`): el panel lo arma recién al confirmar el diálogo con ítem,
     cantidad y TOTAL; cambiar cualquier campo lo invalida;
  3. el bot **en pausa** (así el loop no camina ni pelea en el medio);
  4. cada casilla debe seguir teniendo el ítem visto (`group/num/level`), y en `shop-buy` el precio leído debe coincidir con
     el de la orden y con una relectura fresca; en `buy` el catálogo no puede haber cambiado.
  Nunca se vende/pone en tienda una caja ni Cristales (`neverSell`/`neverShop`); la venta a NPC además rechaza joyas,
  talismanes, consumibles, lo puesto, excelentes, ancient, +13, armonía, alas/anillos/mascotas. **Trade sí puede pasar
  cajas y Cristales** (mulas). `buy` lleva `maxZen`, el tope: corta cuando la próxima compra se pasaría.
  Ritmos humanos (`humanPace`) entre acciones; una operación por vez, 2 s entre una y otra.
- La estación **no** reenvía estas órdenes (`isBotOrder` sin cambios): se mandan desde el panel del personaje.

Estado: `PanelState.shops?: ShopsView` (null hasta que alguien usa la vista): `vendors`, `players` (con cartel si el server
lo avisó), `shops` (lo leído, con `verified:false` en todos), `mine`, `trade`, `equipped`/`bag` con todas las opciones,
`history`, `plan` (planificador) y `notes`.

El **trade entrante nunca se acepta solo**: llega como `trade.state:'incoming'` y hace falta `trade-accept` (con
confirmación) y después `trade-ok` tras revisar lo que pone el otro. Para pasarle algo a una mula, ambos personajes
tienen que estar en pausa, a ≤ 6 casillas, uno ofrece (`trade`) y el otro acepta.

## Planificador de ventas (`planSales`)

Propone, nunca ejecuta (`executable:false`, `needsConfirmation:true`). Por cada ítem de la bolsa (con `judgeItem` de
`item-score.ts`): mejora lo puesto → guardar para equipar; excelente con ≥ 3 Cristales → cristalizar (y candidato de
tienda si no es para este personaje y vale ≥ 8); caja, Cristales, talismán, joya, consumible, armonía → guardar; el
resto de armas/armaduras que no mejoran nada → **vender al NPC** más cercano a la vista. Los zen salen de ventas ya
observadas (el server no publica lo que paga un NPC): `null` = no se sabe. Con la bolsa real de Hume
(`fixtures/hume-vault.json`: 9 cajas, Cristales, joyas) no propone vender nada. El puntaje es la heurística de
`item-score.ts` (solo armaduras; en la UI las otras muestran "—").

## UI

Pestaña "Comercio" en el panel del personaje (`Panel.tsx`: un import, una entrada de pestañas y un `Tabs.Panel`).
Subvistas: Catálogos y tiendas (leer, filtrar por ítem/precio/puntaje/excelente/"mejora lo puesto", ordenar, comparar con
el equipo, comprar con diálogo), Bolsa y plan, Mi tienda, Trade. Demo: `bun run ui:dev` y `/?demo&view=comercio`
(estado simulado; ninguna orden sale a ningún bot).

## Qué falta verificar en vivo (en orden)

1. Leer un catálogo de mercader (Amy, 253) y que `NpcWindowResponse`/`StoreItemList` lleguen como se espera.
2. Una compra y una venta de una sola unidad barata: `ItemBought`/`NpcItemSellResult`, y el zen.
3. El hex de `PlayerShops`/`PlayerShopItemList` contra una tienda real (notas del panel) para fijar el layout.
4. Abrir tienda: área 76-107, precio, `PlayerShopOpenSuccessful`; comprar en una tienda; cierre del diálogo.
5. Trade entre dos personajes propios: códigos, `TradeFinished`, depósito 1 del mover ítem.
