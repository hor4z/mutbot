# mubot

Bot de MU Online 0.97d que hace progresar a tus personajes **solo y sin navegador**: farmea, sube de nivel, reparte puntos,
resetea en 400 y caza dorados, hablando el protocolo real del cliente y a ritmo humano. Se maneja desde la **estación**:
elegís un personaje, lo conectás o desconectás y mirás su mapa en vivo y los mensajes entre los bots.

Corre **solo contra infraestructura propia o con permiso**.

## Empezar
```bash
bun install
bun run db:up && bun run db:init   # ClickHouse en Docker (ver .env.db); el bot juega igual sin la base
bun run ui:build                   # la interfaz (estacion.html / panel.html se generan)
bun run tsc                        # chequeo de tipos (tiene que dar limpio)
bun run estacion                   # http://127.0.0.1:8787
```
Las cuentas y los personajes viven en `~/.mubot/mubot.db` (con claves: nunca por el repo ni por un chat). Los bots siguen jugando
aunque cierres la estación: al volver a abrirla, los encuentra solos. **Nunca** conectes un personaje con la cuenta abierta en el navegador.

## Dónde seguir
- `docs/arquitectura.md`: las partes, un tick del bot, cómo cooperan y dónde tocar para mejorar cada cosa.
- `AGENTS.md`: reglas del proyecto, trampas del protocolo 0.97d y límites (anti-cheat).
- `scripts/watch.ts`: monitor de la flota en consola (`bun run scripts/watch.ts`).
