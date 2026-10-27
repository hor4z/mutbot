# mubot

Bot de MU Online 0.97d para el servidor **Slow**: un personaje (Capitan) que progresa solo hablando el protocolo del cliente, y aprende dónde farmear y a
quién pegarle mientras juega. Monorepo de Bun: todo está en `packages/`, cada paquete con su doc.

| Paquete | Qué es | Doc |
| --- | --- | --- |
| `packages/bot` | bot (núcleo + cerebro recargable en caliente) y estación | [README](packages/bot/README.md), [protocolo](packages/bot/docs/protocolo.md) |
| `packages/panel` | panel React + Tailwind | [README](packages/panel/README.md) |
| `packages/db` | ClickHouse: cliente, migrations y seeds | [README](packages/db/README.md) |
| `packages/protocol` | tipos y órdenes entre bot y panel | [README](packages/protocol/README.md) |
| `packages/extension` | extensión de Chrome: auto attack en el juego a mano, alimentado por el bot local | [README](packages/extension/README.md) |
| `packages/edge` | worker de Cloudflare: proxy WebSocket al juego | [README](packages/edge/README.md) |

## Comandos (desde la raíz)

`bun install` · `bun run tsc` (los 6 paquetes; tiene que quedar limpio) · `bun run estacion` (`http://127.0.0.1:8787`) · `bun run asistente` (puerto 8792, para la extensión) · `bun run panel:build` / `panel:dev` ·
`bun run db:migrate` / `db:seed` / `db:status` · `bun run extract` (regenera `packets/`). La conexión a la base va en `.env.db` (copiar `.env.example`).

## Reglas

- Solo contra infraestructura propia. Ritmos humanos: **no bajarlos** (anti-cheat, ver el protocolo). Nunca flood ni dos sesiones de la misma cuenta; nunca
  correr el bot con una cuenta abierta en el navegador. Desconectar desde el panel es "voy a jugar yo": no reconectar.
- **Solo Slow.** Lo de Fast está archivado (tag `fast-final`, rama `archive/fast`): no traer estrategias de ahí sin medirlas en el Slow.
- **Nada en JSON ni archivos locales**: configuración, estado y datos del juego van a la base. El esquema cambia con una migration nueva (nunca editar una
  aplicada); los datos del juego, con seeds.
- El núcleo (`bot/src/core`) nunca importa el cerebro (`bot/src/brain`): se conectan por `hooks`. Cambios en el cerebro se aplican solos con el bot conectado;
  en el núcleo piden reiniciarlo.
- `bot/src/packets/` es generado; `bot/src/net/utils.ts` y `net/encryption/` son copias literales del cliente: no reescribirlas.
- Cada decisión del bot se explica con `decide()`. Sin flechas ni jerga en los mensajes del panel.
- El código gana sobre la doc: corregir la doc en el mismo cambio.
