# Bot sin navegador: estado y plan (2026-10-11)

Plan del usuario: dejar de depender de la pestaña del navegador. Primero se pule el bot sin
navegador (`headless-bot.ts`) con **Horaz** (DK, el caso simple) hasta que farmee igual o mejor que
el agente del navegador; después **Melu** (Soul Master: modo mago, Soul Barrier, más frágil).
El panel (`panel.html`) es la ventana para ver qué hace, en tiempo real, sin el juego abierto.

Orden pedido por el usuario: "de menos a más". Primero que farmee bien y haga todo bien; después
que el panel lo muestre perfecto. Nada de adornos (sacamos el modelo 3D y los ciclos del panel).

## Cómo correrlo

```bash
# Horaz (credenciales en .env, nunca en el código ni en el chat). Cerrar antes su pestaña del navegador:
bun run bot --allow-remote --proxy wss://mu.mormon.garden/ws --cs-host mu.mormon.garden --cs-port 44405 \
  --auto-seconds 0 --ws-port 8787
# Melu: lo mismo con  bun --env-file=.env.melu run headless-bot.ts ...
```

Más simple: `bun run estacion` y en `http://127.0.0.1:8787` Conectar con la rutina (ver AGENTS.md
"Estación"). A mano, panel en `http://127.0.0.1:8787/panel` (el 8788 lo usa `bun run agent`, el servidor del agente del
navegador). Para pararlo: matar el proceso `headless-bot.ts`. **Nunca** con la misma cuenta abierta
en el navegador.

## Lo que se arregló hoy (probado con Melu contra el server real)

| Problema | Causa | Arreglo |
|---|---|---|
| A los pocos minutos dejaba de ganar exp, la vida quedaba en 1 tras morir y no veía el respawn | El contador del cifrado C3 (`simpleModulus.ts`) no volvía a 0 después de 255: desde el paquete cifrado 256 todos daban "can't decrypt packet" | `Count = (Count + 1) & 0xff` (única diferencia con la copia del cliente; anotado en AGENTS.md) |
| Ciego en las Arenas (no veía Deathvim Knight, Phantom Knight, Gaint Drakan) | `MONSTER_TYPE_NUMBERS` filtraba `Move <= 50` | Sin tope de Move (los guardias ya los excluye el rango 200-299) |
| El mago no pegaba (Evil Spirit iba como skill dirigido) | No sabía qué skills son de área | `data/skills.json` (tabla del bundle del cliente: tipo y distancia); los `AreaSkill*` van por 0x1E; el mago tira desde su distancia (Evil Spirit 5) sin acercarse |
| Mandaba `/add` cada 2,5 s sin pelear | Fuerza y energía de Melu en el tope (65535): el server no los toma y los puntos vuelven | Stats en el tope se saltean (lo que sobra va al primero libre); si después de un reparto los puntos no bajan, 15 min sin repartir |
| Resets en 0 en el panel | No leía el packet de resets | Packet propio **0xFE**: `C1 06 FE <resets u16 BE> <grand>` |
| Loot | Juntaba joyas (se compran en Lorencia) y excelentes que no sirven | Solo cajas (14/11), igual que el agente del navegador |
| Panel sin info útil | Mostraba un punto en un minimapa que las Arenas no tienen | Terreno real del `.att` del cliente (`terrain.ts`, `/terrain/<mapa>`), monstruos, dorados, jugadores, drops, objetivo, rastro, zoom, sesión (kills, kills/min, niveles, skills, muertes), progreso al reset con ETA, alertas |

Medido después de los arreglos: Melu sin navegador en Arena 4, unos **80-86M de exp/min** (lo
mismo que en el navegador), 0 paquetes perdidos.

## Pendiente, en orden

1. **Ítems de 5 bytes (bloqueante).** Este server manda cada ítem en **5 bytes**; el cliente web los
   convierte a 12 antes de leerlos (`i=5, f=12` y la función `v()` del bundle `index-*.js`). El bot
   los lee como de 12, así que el **inventario, la tienda (`StoreItemList`) y los drops** salen mal
   ("packet de drop con layout inesperado", catálogos con ítems como `4/143`). Consecuencias: no
   encuentra pociones para comprar y no reconoce las cajas en el piso. Conversión del cliente
   (wire `e` desde `o`): `r = e[0] | (e[3] & 0x80) << 1`, grupo `r >> 5`, número `r & 31`, nivel en
   `e[1]` (bits 3-6), opciones excelentes `e[3] & 0x7f`. Detectar el formato por largo: inventario y
   tienda `6 + n*(1+5)`, drops `5 + n*(4+5)`, ítem agregado `4+5`.
2. **Pociones: sin compras** (pedido del usuario, 2026-10-11). El bot no compra nada salvo con
   `--buy-potions` (viaje a Lorencia farmeando, merchant en scope, antes del atlas). Antes Horaz iba y
   volvía de Arena 2 a Lorencia cada 5 min sin poder comprar.
3. **Horaz (DK) sin navegador**: lo que el agente del navegador ya hace y el headless no, por orden de
   impacto:
   - la esquina de Arena 2 (`corner.js`): quedarse en (5,11), Twisting Slash al grupo más grande,
     lados adaptativos, irse si está llena;
   - ruta de reset: Lorencia Lich (134,202) → Devias 4 (69,181) → Arena 2 → 3 → 4 por nivel, con la
     salida de Lorencia variada;
   - reset a 400 y repartir puntos como en el navegador (`/add agi`/`/add vit`);
   - defensa propia (`defense.js`: Death Stab + Swell Life a quien le pega);
   - regla fuerte de dorados: cualquier dorado a la vista se mata (dragones primero) y no se cambia
     de mapa ni se resetea hasta levantar las cajas.
   - Medir cada cambio contra el navegador: minutos por reset (el navegador hizo 5-7 min con la
     pestaña recién cargada).
4. **Melu (SM)**: modo mago completo (quieta en la esquina, Evil Spirit, Soul Barrier cada ~50 s; ya
   está el skill de área y el Soul Barrier), ceder el spot a Horaz por resets.
5. **Panel**: que todo lo de arriba se vea en tiempo real (ya están el mapa, la sesión y las alertas).
   **Conectar/desconectar y rutinas:** hecho con la estación (`bun run estacion`, ver AGENTS.md
   "Estación"). Falta probarla en vivo contra el server.
6. **Caza** (después de que el farmeo esté bien): ver "Caza conjunta" en EVENTOS.md.

## Lo que aprendimos del agente del navegador (para no repetirlo)

- **Memoria de la pestaña:** crece ~6-8 MB/min. A ~4 GB Chrome la recarga, el agente queda apagado y
  se pierden horas (Horaz: 6:15-9:04). Además se va poniendo lento: los resets pasaron de 10-12 a
  18-22 min antes del crash; recién cargada, 5-7 min. Es una razón más para ir sin navegador.
- **Recargar solo `hunter.js`** dejaba el envoltorio viejo atado al `__hunt` anterior (ya arreglado:
  los envoltorios se reemplazan). Recargar `browser-agent.js` desconecta el resto: cargar todo.
- **Dragón Rojo:** se reconoce por tipo (44), no por el nombre. La invasión dura 30 min y el server la
  reanuncia al entrar al mapa; buscar más de 3 min sin verlo es perder tiempo.
- **Invasión dorada:** los demás jugadores limpian todo en ~2 min. Si no se llega en el primer minuto,
  no vale la pena. Cazando no hay que pelear con comunes (cada golpe frena ~1 s) ni armar campamento.
- **El teleport de mago** dejaba al personaje parado: apagado (`__corner.teleport`).
- **Party automática** entre Horaz y Melu: sacada, cada uno farmea solo y el de menos resets cede.
- **Loot:** solo cajas. Joyas y excelentes llenaban el inventario y al tirarlos se volvían a levantar.
