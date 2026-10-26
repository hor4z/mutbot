# @mubot/bot

Bot de MU Online 0.97d para el servidor Slow: un personaje (Capitan) que progresa solo, sin navegador, hablando el protocolo del cliente, y la
**estación** que lo lanza, lo mantiene vivo y sirve el panel. Aprende dónde farmear y a quién pegarle mientras juega.

```
panel (@mubot/panel) ── /api ──▶ estación (src/station) ── WebSocket local ──▶ bot (src/main.ts)
                                                                                 ├─ núcleo: src/core   (siempre conectado)
                                                                                 └─ cerebro: src/brain (se recarga en caliente)
        worker de Cloudflare (@mubot/edge): proxy WebSocket al servidor del juego      ClickHouse (@mubot/db): telemetría, configuración y datos
```

## Estructura

| Carpeta | Qué hay |
| --- | --- |
| `src/main.ts` | arranque: WebSocket del panel, sesiones con reconexión y backoff, señales |
| `src/core/` | núcleo: `config`, `state` (`world`, `bot`, `hooks`), `connection`, `world` (parsers 0.97d), `actions`, `protocol097`, `terrain`, `gamedata`, `telemetry`, `journal`, `panel`, `directivas`, `hot`… |
| `src/brain/` | cerebro: `brain` (entrada), `farm-loop`, `area`, `learning`, `combat`, `power`, `loot`, `loop-ctx`, `progress`, `shop-scout`, `path`, `farming`, `spawns`, `warps` |
| `src/station/` | `estacion` (un personaje, API HTTP, reconexión) y `estacion-logic` |
| `src/net/`, `src/packets/` | copias del cliente: `packets/` es generado (`bun run extract`); `net/utils.ts` y `net/encryption/` son literales, no reescribir (una versión "más limpia" ya rompió el cifrado) |
| `tools/` | `extract-packets`, `decode-frames`, `ingest-frames`, `analyze-session`, `shops` (sesiones del cliente web) y `report` (resumen desde la base) |
| `docs/protocolo.md` | trampas del protocolo y anti-cheat |

## Recarga en caliente del cerebro

El núcleo queda conectado; el cerebro (`src/brain/`) se recompila con `Bun.build` (`core/hot.ts`) y se recarga al cambiar un archivo, **sin desconectar**
(el log dice `Cambió el cerebro: lo recargo sin desconectar`). Si el cerebro nuevo no compila o falla al correr, el bot vuelve al anterior. Un cambio en
`src/core/` o `src/station/` sí pide reiniciar. El núcleo nunca importa el cerebro: lo que el panel y la telemetría necesitan lo instala `brain.ts`
(`install`) en `hooks` (`core/state.ts`). El estado que tiene que sobrevivir a la recarga (zona elegida, lo aprendido) vive en `globalThis`.

## Cómo decide (un tick de `farm-loop.ts`)

1. Salud: ciego (3 min sin monstruos ni exp: reconecta), trabado (15 s sin moverse), poca vida (huye al pueblo y descansa hasta el 70 %), pausa.
2. Repartir puntos (`progress.ts`; plan en `area.ts`: agilidad hasta 90, después 45/30/15/10; otras clases, el de `farming.ts`).
3. Ir a la zona elegida (`area.ts`). 4. Levantar botín (`loot.ts`). 5. Pegarle al monstruo de más `valor / (distancia + 8)` dentro de la zona.

**Sin spots fijos.** `area.ts` elige y aprende la zona:
- candidatas: celdas de spawns que el personaje aguanta (`power.ts`) más lo que ve en pantalla (los monstruos custom no están en `spawns`);
- con zonas medidas elige la de más exp/min y a veces prueba una sin medir; se re-decide cada 20 min; el mapa solo cambia si otro rindió claramente más o por una exploración ocasional;
- una zona vacía 45 s se evita 10 min; donde murió, 1 h; **sin ganar exp 2,5 min** se deja el mapa por 1 h y se vuelve al mejor medido;
- al arrancar el mapa base es el que mejor rindió, no donde haya quedado el personaje.

`learning.ts` mide la exp real por tipo de monstruo (`valueOf`, desde 3 kills) y lee de la base el rendimiento por zona (`v_cell_rate`).
Cada decisión se explica con `decide()` (`core/journal.ts`): log, panel y base.

## Botín y skills

Solo se levanta: **zen, joyas** (Bless, Soul, Life, Creation, Cristales, Chaos), **ítems excelentes** y **ítems que mejoran el equipo puesto** (misma clase,
nivel alcanzado, más de un 5 % mejor por defensa, daño o poder mágico; +3 por cada +1 y 20 % extra si es excelente). Lo demás se deja. Sin lugar en la bolsa
solo se levanta zen. Skills: `combat.ts` usa el primero de `ATTACK_SKILL_POOL` (`core/config.ts`) que se conozca **y alcance el maná** (Twisting Slash 41, Cyclone 22…);
sin maná, pega a mano.

## Estación y API

Un personaje (tabla `character`), solo 127.0.0.1; los POST exigen el Origin propio y JSON. Desconectar desde el panel es "voy a jugar yo": no se reconecta solo.

| Ruta | Qué |
| --- | --- |
| `GET /` | el panel compilado (`../panel/dist/estacion.html`; sin compilar responde 503) |
| `GET /api/state` | estado de la estación y del bot (`PanelState`, `@mubot/protocol`) |
| `POST /api/do` | `connect`, `disconnect`, `retry` u `order` (`pause`, `resume`, `town`) |
| `GET/POST /api/directivas` | perillas en caliente (tabla `directives`; el bot la relee cada 5 s) |
| `GET /api/log`, `/terrain/<mapa>` | últimas líneas del log; terreno para el radar |

## Dónde tocar

| Quiero… | Toco |
| --- | --- |
| cambiar cómo elige zona o mapa | `brain/area.ts` |
| cambiar a quién pega | `brain/learning.ts` (`valueOf`), `brain/farm-loop.ts` (`bestIn`) |
| cambiar qué levanta | `brain/farming.ts` (`lootReason`), `brain/loot.ts` (`isUpgrade`) |
| cambiar el skill | `core/config.ts` (`ATTACK_SKILL_POOL`), `brain/combat.ts` |
| cambiar el plan de puntos | `brain/area.ts` (`statPlan`), directiva `agiTarget` |
| ver qué decidió y por qué | el feed del panel, `GET /api/log`, `events` con `kind = 'decide'` |
| medir si una decisión sirvió | vistas `v_outcome`, `v_skill_rate`; `tools/report.ts` |
