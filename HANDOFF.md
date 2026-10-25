# Handoff — sesión del 24 al 25 de octubre de 2026

Resumen para quien retome el proyecto (persona o agente). La referencia técnica sigue siendo [AGENTS.md](AGENTS.md); acá va el **estado,
lo aprendido y lo pendiente**. Todo lo de abajo se probó jugando en vivo salvo donde dice "sin probar".

> **Actualización 25/10:** el usuario pidió volver el algoritmo al de la tarde del 24 (PR #48). Se revirtieron `place.ts`, `farm-loop.ts`, `farming.ts`, `loot.ts`, `progress.ts`, `zones.ts`, `state.ts`, `help.ts` y `bus.ts` a `ff38ef1`: **no hay carreo, ni `follow`, ni zen obligatorio**; lo de abajo sobre eso describe `950e59e`. Lo demás (worker, proxy, panel, altas, creación de personaje) sigue.

## Estado al cortar

- **Estación:** `bun run estacion` (http://127.0.0.1:8787/panel). Si no responde, reiniciarla: los bots quedan vivos y los readopta.
- **Zamu:** desconectado a propósito (se probó contra el Slow y se lo apagó). Fuera de `~/.mubot/wanted.json`. Volver a conectarlo desde el panel.
- **Hume:** desconectado: el usuario lo juega a mano.
- **Buscapina** (elfa, cuenta `buscapina`, nivel ~135, creada hoy): conectada **por el proxy del worker** y con la orden "seguir a Hume"
  (`POST /api/do {action:'follow', char:'buscapina', target:'Hume'}`). **Esa orden vive en memoria de la estación: se pierde al reiniciarla.**
- **Mortael:** apagado (oculto en el panel, `HIDDEN` en `ui/src/Simple.tsx`).
- El vigía de la sesión era un script del scratchpad (no está en el repo); si se quiere vigilar, usar `/api/state` y ClickHouse.

## Qué se hizo (por tema)

1. **Party y poder por stats.** El poder es la suma de stats (`util.statPower`); ni el nivel ni los resets miden la fuerza. Es sombra quien
   tiene menos de la mitad del poder del líder. Party simétrica: invita el más fuerte y, a los 40 s, también el más débil; reintenta cada 15 s.
2. **Worker de Cloudflare** (`workers/edge`, Bun workspaces): alta de cuentas cifrada (RSA-OAEP, cola KV), registro de cuentas por el worker
   (5/hora) y proxy WebSocket a hosts permitidos. Publicado en la cuenta del usuario; secretos en `~/.mubot/alta/` (0600) y `MUBOT_ALTA_URL` en `.env.alta`.
3. **Panel:** "+ Agregar cuenta" en tres pestañas (cuenta → personaje → ya existe), selector de conexión Directa/Proxy por personaje
   (`~/.mubot/conn.json`), "Cancelar" y "Reintentar ahora" mientras un bot espera cupo, nombre del personaje en el título de cada mapa.
4. **Personajes nuevos** (lo que más se trabajó con Buscapina; ver "Aprendizajes").
5. **Carreo:** un personaje que no aguanta Arena 2 pide por el bus que su líder lo acompañe (`place.ts`, `CARRY_TIERS`).
6. **Seguir a un humano:** orden `follow` (el usuario juega a mano; el bot lo busca por el mapa que se le dé, lo invita a party y lo sigue).

## Aprendizajes que cuestan caro redescubrir

- **El proxy del worker se cortaba cada ~20 s** (`exceededCpu`, plan gratuito = 10 ms de CPU). Reenviar mensajes a mano con un `WebSocketPair`
  gasta CPU por mensaje. **Solución:** devolver el `fetch` del servidor tal cual: Cloudflare pasa los frames sin ejecutar el worker. Medido: más de 4 min sin cortes.
  **Ojo:** el uptime del *proceso* del bot no mide la conexión (reconecta por dentro); mirar `Sesión #N duró X s` en el log.
- **Personajes nuevos eran un desastre por cuatro bugs encadenados:** (a) puntos de atributo sin repartir (el lote era 200; ahora 10 si los stats son chicos);
  (b) el bot **no levantaba zen** a propósito (ahora siempre, a ≤ 6 casillas); (c) sin zen no hay warp (cuesta ~320) y el bucle reintentaba el warp para siempre;
  (d) al morir reaparecen en Lorencia, y con ~230 de vida Devias 4 los mata (`TIER_MIN_HP`).
- **Lugares sin monstruos:** `Roamer` en `place.ts` cambia de zona si en 25 s no gana exp ni mata. Las zonas salen de `ticks` (`zones.ts`, `lowLevelZones`).
- **El servidor deja 2 conexiones por dirección** (`ServerIsFull` al tercero). Por el proxy, un tercero **sí entró**: el límite parece ser por dirección de origen.
  No se activó el proxy para saltearlo sin confirmar que el servidor es del usuario; el selector Directa/Proxy es del usuario.
- **Un bot en estado "connecting" no cuenta para el orquestador:** si reconecta seguido, nadie lo sigue ni lo carrea.
- **`net/socket.ts` imprime la URL del WebSocket**, y con el proxy lleva el token en la ruta: queda en `~/.mubot/logs/*.log`. No se puede reescribir (copia del cliente): limpiar logs o rotar el token.
- **Servidor Slow (Beta):** proxy `wss://slow.mu.garden/ws`, connect server `clasico:44405`, game server `clasico:55901`; el handshake responde.
  Login de `zamu` → `NoChargeInfo` (9; familia de "sin suscripción"). **Hipótesis (sin confirmar): el Slow solo deja entrar a cuentas VIP.** Falta mirar el Discord o probar una cuenta VIP.

## Pendiente / ideas

- **Confirmar el Slow** (¿VIP?). Si se usa, la estación hoy está fija a un servidor (`SERVER` en `estacion.ts`); la base ya soporta varios (`servers`), el panel y el lanzador no.
- **Carreo:** el spot de Atlans/Tarkan sale de zonas aprendidas; se puede afinar (densidad de monstruos libres, más tiers). Falta probar el pase a Arena 2 cuando ella aguante (`canFarmMonster(…, 63)`).
- **Orden `follow` sin UI:** hoy solo por API. Falta una casilla en la tarjeta y que sobreviva a reiniciar la estación.
- **`refreshSlots` no pregunta por personajes borrados con bot corriendo**; las tarjetas viejas se limpian al reiniciar.
- **Sin tests automáticos** (se eliminaron el 23/10): validar con `bun run tsc` y en vivo. Lo de hoy se probó a mano; el caso feliz del registro de cuentas se ejecutó una sola vez.
- El caso de **tercera cuenta + Magic Gladiator**: el servidor pide un personaje de nivel alto en la cuenta; no se probó.

## Comandos útiles

```bash
bun run estacion                 # estación + panel
bun run tsc                      # typecheck de la raíz y del worker
bun run ui:build                 # recompila el panel (panel.html / estacion.html se versionan)
bun run alta:keys                # genera claves y tokens del worker en ~/.mubot/alta/
cd workers/edge && bunx wrangler deploy
curl -s localhost:8787/api/state # estado de todos (game.power = suma de stats que compara el orquestador)
```

API de la estación (todas con `Origin: http://127.0.0.1:8787` y JSON): `connect`, `disconnect`, `retry`, `routine`, `shadow`, `conn`, `follow` en `/api/do`;
`/api/cuenta`, `/api/personaje`, `/api/alta` para las altas.

## Reglas que dio el usuario

- Si un personaje aparece desconectado desde la UI, **es el usuario jugando a mano**: no reconectarlo.
- Los bots deben **siempre recolectar zen**.
- Nunca correr el bot con una cuenta que el usuario tenga abierta en el navegador.
