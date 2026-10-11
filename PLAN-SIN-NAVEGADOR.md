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

## Hecho el 2026-10-11 (tarde), probado en vivo con Horaz

- **Estación** (`bun run estacion`): conectar/desconectar, rutinas, consola, dorados vistos.
- **Esquina de Arena 2** (`corner.ts`, port de `corner.js`): desde el 100, ~30-35 niveles/min contra
  ~10 de las Arenas 3/4. Primer ciclo con esquina: 10 → 100 en 3,6 min.
- **Ítems de 5 bytes**: inventario, equipo y drops (las cajas se reconocen). Verificado con bytes reales.
- Arreglos que lo trababan: no atacar en zona segura (Lord centurion en el pueblo de Lorencia); el
  daño 0x15 de 10 bytes no es movimiento; objetivo que no muere en 15 s se abandona; "hambre" sin
  referencia solo con 0 exp; Devias lleno → Arena 1 desde el 50.
- **Sin compras ni ventas** (pedido del usuario). Fuera buscador, atlas, ruta libre y la capa de decisión.

## Pendiente, en orden

1. **Igualar al agente del navegador regla por regla** (usuario: "habíamos pulido todas estas
   cuestiones"). Se está armando la lista completa de diferencias contra `browser/*.js`; lo conocido:
   lados adaptativos de la esquina (esquina/medio/este con exp medida), focos de reaparición,
   competir o irse cuando un jugador está en el spot, aggro (pegarle primero a quien le pega),
   defensa propia (`defense.js`), regla fuerte de dorados (matar lo que se vea, dragones primero, no
   resetear hasta levantar las cajas), salida variada de Lorencia, campamento de Devias 4 en (69,181).
   Medir cada cambio en minutos por ciclo contra el navegador (mejor: 10,4 min; esquina: ~5-7).
2. **Melu (SM)**: modo mago completo (quieta en la esquina, Evil Spirit, Soul Barrier), ceder el spot
   a Horaz por resets.
3. **Panel**: el mapa confunde (grilla norte-arriba sin brújula ni escala, leyenda incompleta); chat
   (leer ChatMessage/ServerMessage y susurros, mandar desde el panel).
4. **Partir `headless-bot.ts`** en módulos (conexión, mundo, combate, ruta, reset, panel).
5. **Caza** y cooperación entre bots (después).

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
