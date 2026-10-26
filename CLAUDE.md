# CLAUDE.md

Bot autónomo de **MU Online 0.97d para el servidor Slow** (un solo personaje, Capitan): hace progresar al personaje sin GUI, hablando el
protocolo real del cliente, y aprende dónde farmear y a quién pegarle mientras juega. Proyecto independiente en Bun; no depende del
cliente MU JS en runtime.

Las instrucciones del proyecto están en **[AGENTS.md](AGENTS.md)**. Leé ese archivo antes de tocar el bot. Contiene:

- el alcance y los límites (solo infraestructura propia, ritmos humanos, qué no tocar)
- los comandos y la estructura en **núcleo** (siempre conectado) y **cerebro** (se recarga en caliente, sin desconectar)
- cómo decide el bot y cómo aprende (zonas por exp/min medido, valor por tipo de monstruo, muertes y zonas vacías)
- la estación, el panel y la base (ClickHouse `mubot_slow`): **nada vive en JSON locales**, todo con migrations y seeds (`bun run db:migrate`, `db:seed`)
- las trampas de protocolo: packets donde los parsers generados están mal para 0.97d y el bot queda ciego sin avisar

Para "correlo", "arrancalo", "ponelo a jugar": `bun run estacion` (`http://127.0.0.1:8787`) y Conectar, o
`POST /api/do` con `{"action":"connect"}` (ver "Estación y panel" en AGENTS.md). Un cambio en el cerebro se aplica solo con el bot
conectado; un cambio en el núcleo pide reiniciarlo.

**Solo Slow.** Lo del servidor Fast está archivado (tag `fast-final`, rama `archive/fast`, datos en `~/.mubot/archivo-fast/`): no traer
estrategias de ahí sin medirlas en el Slow.

Reglas rápidas:

- `packets/` es generado: no se edita a mano, se regenera con `MU_SRC=~/self/mu/src bun run extract`.
- `net/utils.ts` y `net/encryption/` son copias literales del cliente. No reescribirlas: una versión "más limpia" ya rompió el cifrado y
  el parseo de skills.
- El esquema se cambia con una migration nueva en `db/migrations/` (nunca editando una ya aplicada) y los datos del juego con seeds en `db/seeds/`. No agregar archivos JSON de configuración ni de estado.
- Antes de dar algo por terminado: `bun run tsc` limpio. Los tests se eliminaron a pedido del usuario (2026-10-23, están en el historial).
- Nunca correr el bot con una cuenta que el usuario tenga abierta en su navegador. Una cuenta desconectada desde el panel es el usuario
  jugando: no reconectarla.
- El núcleo nunca importa el cerebro (se conectan por `hooks` en `state.ts`); un archivo nuevo del cerebro se suma a `BRAIN` en `hot.ts`.

Si algo de `AGENTS.md` quedó desactualizado respecto del código, el código gana: corregí el doc en el mismo cambio.
