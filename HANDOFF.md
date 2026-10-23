# Handoff: mubot (2026-10-23)

Para el próximo agente que tome el proyecto. Leé primero `CLAUDE.md` y `AGENTS.md`; este archivo dice
**qué busca el usuario, qué está decidido, dónde quedamos y qué sigue**. Si algo de acá choca con el
código, gana el código.

## El objetivo

**Conseguir un buen set de equipo para Hume.** El usuario lo dijo así: "sin ítems los resets no valen
de nada".

- Hume: cuenta `hume`, Blade Knight, unos 45 resets. Tiene los 4 stats en 65.535, el tope del juego: ya no
  sube por stats, solo por equipo.
- El equipo sale de las **Box of Kundun**. Las mejores (+4/+5) salen de los dorados (sobre todo los
  Golden Dragon), del Dragón Rojo, de Blood Castle, del Big Boss y de Aida.
- **Prioridad máxima: cazar dorados, "hasta que no quede ninguno".** El bot tiene que ser experto en eso
  y no puede fallar. Los dragones son lo más relevante.
- El rol del bot es **cazar y recolectar**. **No abre las cajas**: las abre el usuario.
- Lo que vale en este server: cajas (14/11) y **Cristales (14/31)**, que son la moneda del Mercado entre
  jugadores y del Alquimista; también los talismanes. Las joyas (Bless, Soul, Chaos…) **no valen nada**.
- **No hacer Gran Reset** por ahora: el usuario no quiere sacrificar los resets.
- El usuario no sabe mejorar ítems ("requiere mucho expertise"). Espera que el agente decida con las
  guías del juego y con lo que hay en el baúl. **Cada mezcla del Chaos Goblin hay que confirmarla con
  él**: una mezcla que falla puede quemar el ítem.

## Cómo trabajar con el usuario

- Escribe en español rioplatense, corto y mientras mira el panel en vivo. Responder igual: corto, con
  números.
- **No reconectar, reiniciar ni mandar órdenes a un bot sin preguntar.** Si un personaje aparece
  pausado o desconectado, suele ser que el usuario lo está jugando en el navegador. Así dijo: "no lo
  toques, estoy jugando".
- **No mandar la rutina "farm" después de conectar:** cancela una cacería en curso.
- **Sin compras** salvo pedido explícito. Están pendientes de autorización las pociones y la quest de
  Blade Knight; la quest ya está hecha, porque Hume ya es BK.
- Antes de dar algo por terminado: `bun run tsc` limpio y `bun run test` en verde. Después, PR a
  `main` en `hor4z/mutbot`, que es el repo personal del usuario (el usuario pidió PR y merge).

## Cómo se opera

- `bun run estacion` → http://127.0.0.1:8787/panel. Hume usa el panel del bot en el puerto 8792.
- API de la estación: `POST /api/do` con el header `Origin: http://127.0.0.1:8787` y un body JSON:
  - `{"action":"connect","char":"hume","routine":{"kind":"farm"}}`
  - `{"action":"disconnect","char":"hume"}`
  - `{"action":"routine",…}` para cambiar la rutina. La rutina `{"kind":"spot","warp":28}` fija un
    spot; 27 y 28 son Aida y Aida 2.
  - El estado se lee con `GET /api/state`.
- Órdenes directas al bot, por el WebSocket `ws://127.0.0.1:8792/`, con el header de origen del mismo
  puerto: `{"type":"command","id":1,"command":{...}}`. Las órdenes son `pause`, `resume`, `farm`,
  `hunt` (con `map`), `warp`, `say` y `vault`.
- Logs en `~/.mubot/logs/hume.log`. Los avisos del server aparecen como `Server: …` y los skills como
  `Tiro <skill>`.
- Base: ClickHouse en http://127.0.0.1:8123 (credenciales en `.env.db`). Las fechas están en **UTC**:
  las 15:00 de la base son las 12:00 de Argentina.

## Qué se hizo el 2026-10-23 (PR #46 y el siguiente)

- **Ítems de 6 bytes.** El server pasó de 5 a 6 bytes al sumar la Jewel of Harmony. Por eso el bot dejó
  de ver y levantar cajas sin dar ningún aviso. Está arreglado en los drops, el inventario, el ítem
  agregado y el mover ítem.
- **Levantar.** El server traba la caja 2 s ("The item is still falling") y después la sortea entre los
  que la piden. El bot reintenta hasta 20 s y suelta enseguida la caja de otro ("This item doesn't
  belong to you"; es del que más daño hizo).
- **Invasión dorada:**
  - el aviso `[Mapa] Golden invasion!` dice el mapa del Golden Dragon (el de cierre, "…has ended", no
    cuenta);
  - se agregaron Atlans y Tarkan;
  - el mapa se elige por vivos × valor de caja, y un mapa sin zonas conocidas vale ×0,25;
  - caza hasta 0 y encadena mapas;
  - si pasan 2 min sin ver un dorado y otro mapa tiene más vivos, se va a ese.
- **Pelea:**
  - no suelta al dorado que le está pegando, salvo por un dragón;
  - elige por valor de caja;
  - recuerda al dragón 6 s cuando sale de la vista;
  - pega con Death Stab respetando el nivel 160 (Rageful Blow pide 170);
  - Swell Life siempre activo;
  - cazando no pelea con comunes.
- **Dragón Rojo:** es el **tipo 44** (el cliente también lo llama "Golden Dragon"; el 79 es el de la
  invasión dorada). Ahora se caza con el aviso `[Mapa] Red Dragon invasion!`. Probado: lo mató y la caja
  fue suya.
- **Reset:** no resetea entre :30 y :05, y no caza debajo del 380.
- **Recolección:** cajas, Cristales y talismanes siempre; excelentes si hay lugar; joyas no. Avisa con
  la bolsa casi llena.
- **Datos para la cacería:** `server_msg`, `golden_kill` (con quién lo mató), `loot_ok`,
  `loot_foreign` y `hunt_end`.
- **Panel:** tarjeta "Dorados" y colores (vos en blanco, Golden Dragon naranja, Dragón Rojo rojo).
- **Otros:** Aida fijable; la orden `vault` lee el baúl; el README tiene la instalación en otra máquina.

**Medido:** desde las 09:50 entraron 18 cajas propias y 4 fueron de otro (en su mayoría las de los
Golden Dragon). La invasión de las 10:50 dio 7 cajas.

## Lo que sabemos del juego (todo verificado)

- Las guías del server son públicas: `GET https://mu.mormon.garden/api/guides` y `/api/guides/<id>`.
  Las novedades, en `/api/news`. Ahí están los horarios, las cajas, el Alquimista y el Chaos Goblin.
- Los jugadores vacían un mapa de dorados en unos 3 min. Los Golden Dragon se ven solo entre las :50 y
  las :54. Hay más competencia de día.
- **Aida le queda grande a Hume:** murió 3 veces en 10 min (2 Cristales). Pelea **sin armadura** y sin
  pociones.
- El bot lee la vida con tope en 65.535, pero el server manda el valor real en otro packet. Por eso cree
  que tiene menos margen del real. Es un bug pendiente.
- El baúl (`~/.mubot/vault-Hume.json`, 27 ítems) tiene:
  - Great Dragon casco, armadura, pantalones y botas, todos +9 con luck, +16 y 3 opciones excelentes;
  - Dragon Knight Armor +10 (set 380);
  - piezas de Hurricane y Storm Crow (MG), Grand Soul (DW) y otras.
  Hume lleva puestos **solo** la Dark Breaker +9 y las Wings of Dragon +9.

## Qué sigue (en orden)

1. **Explorador de cacería con el terreno real.** Hoy recorre celdas de 25×25 a ciegas y "da vueltas".
   Hume conoce 21 a 37 de las ~100 celdas de cada mapa. Ya existen `terrain.ts` (`walkableFor`) y
   `path.ts` (`findPath`): falta recorrer las celdas caminables sin repetir, primero las que tuvieron
   dorados.
2. **Resumen por invasión desde la base:** vistos, matados por Hume y por otros (y por quién), cajas
   propias y de otros, y el tiempo desde el aviso hasta el primer golpe. Ajustar con eso, invasión por
   invasión.
3. **Equipar a Hume con el Great Dragon del baúl.** (Hecho en código, sin correr en vivo: órdenes `equipplan` y `equip`, ver AGENTS.md "Ítems y baúl"; falta verificar sacar del baúl con el packet `C3 0D 24 02 …` y mandar `equip` a mano.) Es lo que más sube su daño y su aguante, y hace que
   las cajas de los dragones sean suyas. Hace falta mover del baúl al inventario y equipar: el packet
   C3 24 con el depósito del baúl, sin verificar. Mostrarle el plan al usuario antes.
4. **Leer la vida real** (sin el tope de 65.535).
5. **Pociones,** solo si el usuario lo autoriza. Sin pociones muere contra dorados duros y en Aida.
6. **Blood Castle:** una caja +5 asegurada por hora. Es el próximo proyecto grande: armar la capa,
   entrar, romper el portón y entregar el arma.
7. **El Cazador:** misiones diarias que dan Cristales y cajas, sin competencia.

## Archivos clave para la cacería

- `farm-loop.ts`: el loop (cacería, encadenado, Dragón Rojo, reset).
- `golden.ts`: `stickyGolden`, `GOLDEN_VALUE`, `DRAGON_TYPES`.
- `panel-logic.ts`: `pickHuntMap`, `huntDryOut`, `HUNT_MAPS` y los avisos del server.
- `zones.ts`: zonas donde se vieron dorados.
- `loot.ts` y `farming.ts`: `isValuableDrop`.
- `combat.ts`: `goldenSkill`.
- `chat.ts`: los avisos del server.
- `vault.ts`: la orden `vault`.

La memoria del usuario para Claude está en `~/.claude/projects/-home-horaz-self-mubot/memory/`. En una
máquina nueva no existe: este archivo la reemplaza.
