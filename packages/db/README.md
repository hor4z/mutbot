# @mubot/db

La base del bot (ClickHouse, base `mubot_slow`): cliente, migrations y seeds. **Nada vive en archivos locales**: la configuración, el estado, los datos
del juego y la telemetría están acá. La base `mubot` del mismo servidor es el archivo de Fast y no se toca.

Conexión: copiar `.env.example` de la raíz a `.env.db` y completar (`MUBOT_DB_URL`, `MUBOT_DB_USER`, `MUBOT_DB_PASSWORD`, `MUBOT_DB_NAME`).

## Comandos (desde la raíz)

| Comando | Qué hace |
| --- | --- |
| `bun run db:migrate` | aplica las migrations pendientes (crea la base si falta) |
| `bun run db:seed` | carga los datos del juego (solo si cambiaron; `-- --force` recarga) |
| `bun run db:status` | qué está aplicado y qué falta |
| `bun run db:init` | migrate y seed |
| `bun run db:up` | ClickHouse local en Docker (`docker/`) |

## Migrations y seeds

- `migrations/NNNN_nombre.sql` se aplican en orden y **no se editan una vez aplicadas** (el runner lo rechaza): se agrega una nueva. `R__nombre.sql`
  son repetibles y se re-aplican cuando cambian (las vistas). Registro en `schema_migrations`.
- `seeds/*.json` son los datos del cliente web (monstruos con los custom del Slow, skills, ítems con sus datos de equipo, spawns). Cada seed llena una
  tabla nueva y la intercambia (`EXCHANGE TABLES`): nunca queda a medias. Solo corre si cambió el archivo o la `version` del seed en `src/cli.ts`.
  Registro en `schema_seeds`.

## Tablas

| Tabla | Qué guarda |
| --- | --- |
| `ticks`, `events`, `players_seen` | telemetría: foto cada 5 s; decisiones con su motivo, kills con su exp, muertes, avistamientos de monstruos |
| `directives`, `character`, `settings` | perillas en caliente; cuenta y personaje (la clave va en texto plano); `worker_url`, `proxy_token`, `wanted` |
| `monsters`, `skills`, `items`, `spawns` | datos del juego (seeds) |
| vistas | `v_cell_rate` (exp/min por zona de 16×16), `v_deaths`, `v_kill_value`, `v_skill_rate`, `v_outcome`, `v_monsters`… |

Las tablas de configuración son ReplacingMergeTree por `updated_at` y se leen con `argMax`; un borrado es una fila con `deleted = 1`.

## Uso desde código

`import { dbRows, dbInsert, readDirectives, readCharacter, readSettings } from '@mubot/db'` (`src/index.ts`).
