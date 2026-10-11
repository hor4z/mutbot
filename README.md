# mubot

Bot de MU Online 0.97d que hace progresar a tus personajes **solo y sin navegador**. Farmea, sube de
nivel, reparte puntos, resetea en 400 y levanta cajas, hablando el protocolo real del cliente y a ritmo
humano. Todo se maneja y se mira desde un panel en el navegador, la **estación**.

Corre **solo contra infraestructura propia o con permiso**.

## Empezar

```bash
bun install

# Credenciales: un archivo de env por personaje en la raíz (están en .gitignore, nunca en el código)
#   .env        → MUBOT_USER=...  MUBOT_PASS=...  MUBOT_CHAR=Horaz
#   .env.melu   → MUBOT_USER=...  MUBOT_PASS=...  MUBOT_CHAR=Melu

bun run estacion          # http://127.0.0.1:8787/panel
```

En la estación, elegí la rutina del personaje y tocá **Conectar**. Las rutinas son:

- farmear por la ruta;
- farmear fijo en un spot;
- quedar en pausa.

A la derecha se ve el panel del bot (mapa, nivel, exp, log) o su consola. **Desconectar** lo corta.

- **Antes de conectar, cerrá la pestaña del juego con esa cuenta.** El bot no entra si la cuenta ya
  está conectada en otro lado (lo muestra como "cuenta abierta").
- Los bots siguen jugando aunque cierres la estación. Al volver a abrirla, los encuentra solos.
- Cuando quieras jugar vos en el navegador, desconectá el personaje desde la estación.

## Cómo farmea

| Nivel | Dónde |
|---|---|
| 10 → 20 | Lorencia, grupo de Lich (132,200) |
| 20 → 100 | Devias 4 (el spot pegado a la llegada). Con 3+ jugadores encima: Arena 1 desde el 50, otra entrada de Devias antes |
| 100 → 400 | La esquina (7,11) de Arena 2: skill de área al grupo más grande, espera la reaparición. Con la esquina llena: 5 min en la Arena de su nivel |
| 400 | `/reset`, vuelve a entrar y empieza otra vez |

Además, en cualquier nivel:

- avisa a la estación los monstruos dorados que ve (la estación los muestra en "Dorados vistos");
- no le pega a monstruos parados en zona segura;
- se reconecta solo si se corta la conexión.

## Comandos

```bash
bun run test        # tests offline (no tocan el server)
bun run tsc         # typecheck
bun run estacion    # la estación (panel y control de personajes)
bun run bot         # un bot suelto, sin estación (ver flags en la cabecera de headless-bot.ts)
bun run proxy       # proxy WebSocket → TCP para un server local
```

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `estacion.ts`, `estacion.html`, `estacion-logic.ts` | La estación: personajes, conectar/desconectar, rutinas, dorados vistos. |
| `headless-bot.ts` | El bot: conexión, mundo, loop de farmeo, reset, panel. |
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
