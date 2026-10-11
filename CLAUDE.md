# CLAUDE.md

Bot autónomo de MU Online 0.97d (OpenMU): hace progresar a un personaje solo,
sin GUI, hablando el protocolo real del cliente. Proyecto independiente en Bun;
no depende del cliente MU JS en runtime.

Las instrucciones de este proyecto están en **[AGENTS.md](AGENTS.md)**.
Leé ese archivo antes de tocar `headless-bot.ts`. Contiene:

- el alcance y los límites (solo infraestructura propia, ritmos humanos, qué no tocar)
- los comandos (`bun run test`, `bun run tsc`, `bun run proxy`, `bun run bot`)
- la estructura y por qué `net/`, `packets/` y `data/` son copias del cliente
- las trampas de protocolo: packets donde los parsers generados están mal para
  0.97d y el bot queda ciego sin avisar
- el flujo de economía con merchants y la capa de decisión
- el estado del combate (bloqueante para jugar solo) y lo pendiente

Para "correlo", "arrancalo", "ponelo a jugar": skill **`correr-agente`**
(`.claude/skills/correr-agente/SKILL.md`). Arranca `bun run agent` y carga `bg-timers.js` →
`browser-agent.js` → `tuner.js` en la pestaña del juego. Los pasos para el usuario están en `README.md`.

Bot sin navegador (lo próximo): estado, lo aprendido y el plan en **[PLAN-SIN-NAVEGADOR.md](PLAN-SIN-NAVEGADOR.md)**.
Primero Horaz, después Melu. Para conectarlos y elegir la rutina desde el navegador:
`bun run estacion` (`http://127.0.0.1:8787`, ver "Estación" en AGENTS.md).

Reglas rápidas:

- `packets/` es generado: no se edita a mano, se regenera con
  `MU_SRC=~/self/mu/src bun run extract`.
- `net/utils.ts` y `net/encryption/` son copias literales del cliente. No
  reescribirlas: una versión "más limpia" ya rompió el cifrado y el parseo de skills.
- Antes de dar algo por terminado: `bun run tsc` limpio y `bun run test` en verde.
- Nunca correr el bot con una cuenta que el usuario tenga abierta en su navegador.

Si algo de `AGENTS.md` quedó desactualizado respecto del código, el código gana:
corregí el doc en el mismo cambio.
