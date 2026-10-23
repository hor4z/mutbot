# mubot

Bot de MU Online 0.97d que hace progresar a tus personajes **solo y sin navegador**. Farmea, sube de
nivel, reparte puntos, resetea en 400 y levanta cajas, hablando el protocolo real del cliente y a ritmo
humano. Todo se maneja y se mira desde un panel en el navegador, la **estación**.

Corre **solo contra infraestructura propia o con permiso**.

## Empezar

```bash
bun install
bun run estacion          # http://127.0.0.1:8787/panel
```

En la estación, el flujo es **cuenta → personaje → panel**:

1. **Elegí una cuenta** (cada una muestra su estado: *Activa* o *Bloqueada*) o creá una con
   **Nueva cuenta**: la registra en el server, con el mismo formulario que "Crear cuenta" del juego.
2. **Elegí un personaje** de esa cuenta o creá uno con **Nuevo personaje** (clase y nombre; el dado
   sugiere nombres de fantasía). El bot lo crea en el server al conectarlo y lo deja en pausa.
3. Elegí la rutina y tocá **Conectar**. Las rutinas son:

- farmear por la ruta;
- farmear fijo en un spot;
- quedar en pausa.

A la derecha se ve el panel del bot (mapa, nivel, exp, log) o su consola. **Desconectar** lo corta.

- **Antes de conectar, cerrá la pestaña del juego con esa cuenta.** El bot no entra si la cuenta ya
  está conectada en otro lado (lo muestra como "cuenta abierta").
- Los bots siguen jugando aunque cierres la estación. Al volver a abrirla, los encuentra solos.
- Para dejarla corriendo sin terminal abierta (todo el día):
  `setsid nohup bun run estacion >> ~/.mubot/logs/estacion.log 2>&1 < /dev/null &`. Si reiniciás la
  computadora, la base vuelve sola (Docker) pero la estación no: volvé a correrla y conectá a los
  personajes.
- Cuando quieras jugar vos en el navegador, desconectá el personaje desde la estación.

## Base de cuentas (SQLite)

Cuentas y personajes viven en una base SQLite local, **`~/.mubot/mubot.db`** (fuera del repo, permisos
600 porque tiene las claves; `MUBOT_DB_FILE` la cambia). La crea sola la estación con `bun:sqlite` (viene
con Bun, sin dependencias) y la actualiza con migraciones versionadas (`estacion-db.ts`).

| Tabla | Qué guarda |
|---|---|
| `servers` | Servidor del juego (proxy, connect server). Todo cuelga de uno, para sumar otros sin mezclar cuentas. |
| `accounts` | Cuenta (`username`, `password`) por server y su `status`: `active` o `blocked` (el server contestó AccountBlocked; vuelve a `active` al entrar). |
| `characters` | Personaje (nombre único, sin importar mayúsculas), cuenta, `class` (dk/dw/elf/mg, para crearlo), última rutina y de qué `.env` se importó. Hasta 5 por cuenta, uno jugando a la vez. |

- Los `.env` / `.env.<algo>` de la raíz (MUBOT_USER/PASS/CHAR) **se importan solos** al arrancar la
  estación; después manda la base. `bun run bot` (un bot suelto) sigue leyendo `.env`.
- La clave nunca va en la línea de comandos: la estación se la pasa al bot por variable de entorno.
- Mirarla: `sqlite3 ~/.mubot/mubot.db 'SELECT username, status FROM accounts'` (hay que instalar
  `sqlite3`) o cualquier visor de SQLite. Para cambiar el esquema, sumá una migración al final de
  `MIGRATIONS` (nunca edites una vieja).
- Los datos de juego (exp, muertes, rivales) van a ClickHouse: ver "Datos y aprendizaje".

## Cómo farmea

| Nivel | Dónde |
|---|---|
| 10 → 20 | Lorencia, grupo de Lich (132,200) |
| 20 → 100 | Devias 4 (el spot pegado a la llegada). Lleno o sin exp: otra entrada de Devias (3 o 2); Arena 1 solo si todas están llenas |
| 100 → 400 | La esquina (7,11) de Arena 2: skill de área al grupo más grande, espera la reaparición. Con la esquina llena: 5 min en la Arena de su nivel |
| Dúo | Horaz (DK) plantado en la esquina (2,10) y Melu (Soul Master) en el segundo spot, el medio (7,11), tirando **Decay**: así ganan el sector. Horaz invita a Melu a party; los datos deciden si conviene |
| 400 | `/reset`, vuelve a entrar y empieza otra vez |

Además, en cualquier nivel:

- avisa a la estación los monstruos dorados que ve (la estación los muestra en "Dorados vistos");
- no le pega a monstruos parados en zona segura;
- se reconecta solo si se corta la conexión.

## Panel

- **Radar 3D** con el mapa real del server. Con el modo **Cámara** se sigue al personaje de cerca, con
  el nombre de cada monstruo y jugador (★ = compañero), el objetivo que late y lo que hace abajo.
- **Decisiones**: qué decide el personaje y por qué (cooperar, cambiar de lado, quién lo mató…).
- **Chat** del personaje y **Ranking** (resets y ELO del server) en la estación.

## Datos y aprendizaje

Los bots guardan lo que pasa en una base **ClickHouse local** (Docker, solo `127.0.0.1`), para aprender
qué conviene y mejorar solos sin retroceder.

```bash
bun run db:up       # levanta la base (credenciales en .env.db, no se commitea)
bun run db:init     # tablas y vistas
bun run aprender    # respuestas de los datos y ~/.mubot/knowledge.json (la estación lo corre cada 30 min)
```

- Consola web: http://127.0.0.1:8123/play (usuario y clave de `.env.db`). Una consulta por vez, sin
  `;`. `SHOW TABLES FROM mubot` lista todo.
- Qué se guarda y por qué, las vistas y las perillas que el bot ajusta solo: "Datos y aprendizaje" en
  `AGENTS.md`. El plan de mejora continua está en `PLAN-SIN-NAVEGADOR.md`.

## Comandos

```bash
bun run test        # tests offline (no tocan el server)
bun run tsc         # typecheck
bun run estacion    # la estación (panel y control de personajes)
bun run aprender    # qué dicen los datos (ver "Datos y aprendizaje")
bun run bot         # un bot suelto, sin estación (ver flags en la cabecera de headless-bot.ts)
bun run proxy       # proxy WebSocket → TCP para un server local
```

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `estacion.ts`, `estacion.html`, `estacion-logic.ts` | La estación: cuentas, personajes, conectar/desconectar, rutinas, dorados vistos. |
| `estacion-db.ts` | La base de cuentas y personajes (SQLite, ver "Base de cuentas"). |
| `names.ts` | Generador de nombres de fantasía para personajes nuevos. |
| `headless-bot.ts` y sus módulos | El bot: entrada (`headless-bot.ts`), conexión, mundo, combate, ruta, reset, panel y el loop de farmeo (`farm-loop.ts`). Ver la tabla de `AGENTS.md`. |
| `corner.ts` | La esquina de Arena 2. |
| `camp.ts`, `explore.ts`, `farming.ts`, `learning.ts` | Campamentos, exploración, exp por segundo, ruta fija y lo que aprende (`~/.mubot/learning.json`). |
| `protocol097.ts` | Parsers y builders del 0.97d (ítems de 5 bytes, daño, party). |
| `panel.html`, `panel-protocol.ts`, `panel-logic.ts`, `ws-server.ts` | El panel de cada bot y su contrato. |
| `browser/` | El agente que jugaba dentro de la pestaña del juego (archivado; es la referencia de las reglas). |
| `AGENTS.md` | Referencia técnica: protocolo, trampas del 0.97d, estructura, reglas para tocar el código. |
| `PLAN-SIN-NAVEGADOR.md` | Estado y pendientes. |

`net/`, `packets/` y `data/` son copias del cliente MU JS (ver `AGENTS.md`).

## Reglas

- Solo contra infraestructura propia o con permiso. `--allow-remote` es obligatorio para hosts no
  locales.
- Ritmos humanos a propósito (caminata 380 ms, golpe 500 ms, skill 900 ms). **No bajarlos.**
- Nunca dos sesiones de la misma cuenta. Nada de flood ni brute force.
- La estación y los paneles escuchan solo en 127.0.0.1. No exponerlos con ngrok ni similares.
- El bot no compra ni vende nada.
