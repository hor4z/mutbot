# Arquitectura

Bot de MU Online 0.97d para el servidor Slow. **Un personaje, un proceso**; una **estación** lo lanza, lo mantiene vivo y sirve el panel.
Los detalles y las reglas están en [AGENTS.md](../AGENTS.md); acá, el mapa de las partes.

```
panel (ui/, React + Tailwind)  ◀── GET /api/state, POST /api/do ──▶  estación (estacion.ts)
                                                                        │  lanza / corta / adopta
                                                                        ▼  WebSocket local (estado 1 s, órdenes)
┌──────────────────────── bot (headless-bot.ts) ─────────────────────────┐        ClickHouse mubot_slow
│ núcleo: conexión · protocolo · mundo · panel · telemetría ─────────────┼──────▶  ticks · events · vistas
│ cerebro (se recarga en caliente): farm-loop · area · learning · combat │◀────── v_cell_rate · v_kill_value …
└─────────────────────────────────────────────────────────────────────────┘
        ▲ worker de Cloudflare (workers/edge): proxy WebSocket → servidor del juego
```

## 1. Las partes

- **Núcleo del bot** (siempre conectado): `connection.ts` (sockets, cifrado, login), `world.ts` (parsers 0.97d y estado del mundo),
  `actions.ts` (packets de salida), `protocol097.ts`, `terrain.ts`, `panel.ts` (estado y órdenes del panel), `telemetry.ts` (base),
  `journal.ts` (decisiones con su motivo), `directivas.ts` (perillas en caliente) y `hot.ts` (la recarga).
- **Cerebro** (`brain.ts` y lo que reúne): `farm-loop.ts` (el tick), `area.ts` (zonas y viajes), `learning.ts` (lo que aprende),
  `combat.ts` (skill y pociones), `power.ts` (qué aguanta el personaje), `loot.ts`, `progress.ts` (puntos), `path.ts`, `spawns.ts`, `warps.ts`.
- **Estación** (`estacion.ts`, `estacion-logic.ts`): un personaje, reconexión con espera creciente, adopta el bot que ya corre.
- **Panel** (`ui/src`): estado y vitales, radar táctico (`Radar.tsx`, `Tactical.tsx`) y feed de decisiones (`App.tsx`). Tema de sherpa en
  `index.css`; piezas base en `components.tsx`.
- **Datos** (`db/`): `schema.sql` y `views.sql` de la base `mubot_slow`; `scripts/` (informe, ingesta del cliente web, análisis).

## 2. Un tick del bot (`farm-loop.ts`)

1. Salud del bot: ciego, trabado, poca vida (huye al pueblo y descansa), pausa.
2. Repartir puntos.
3. Zona: `choosePlace()` → ir al área (warp si es otro mapa, caminar si es el mismo).
4. Botín: levantar lo valioso (joyas, cajas, excelentes).
5. Objetivo: el de más `valor / (distancia + 8)` dentro del área; pelear con el skill que alcance el maná, o a mano.

## 3. Cómo aprende

- **Valor por monstruo:** la exp real de cada kill propio se atribuye al tipo (`noteKill` / `noteExp`); desde 3 kills manda la media
  medida, antes rige `nivel × 100` solo para ordenar.
- **Zonas:** `v_cell_rate` da exp/min por celda de 16×16; con 5 min medidos se elige la mejor, y con probabilidad 0,2 se prueba una sin
  medir. Se re-decide cada 20 min. Zona vacía 45 s → se evita 10 min; muerte → se evita 1 h.
- **Qué falta:** el reparto de puntos hoy es un plan fijo (Agi hasta 90, después 45/30/15/10) que se registra pero no se adapta;
  `v_stat_curve` y `v_outcome` son la base para medirlo.

## 4. Dónde tocar para mejorar el bot

| Quiero… | Toco |
| --- | --- |
| cambiar cómo elige zona o mapa | `area.ts` (`candidatesIn`, `pickCell`, `pickMap`) |
| cambiar a quién pega | `learning.ts` (`valueOf`) y `farm-loop.ts` (`bestIn`) |
| cambiar el skill de ataque | `config.ts` (`ATTACK_SKILL_POOL`) y `combat.ts` (`pickAttackSkill`) |
| cambiar el plan de puntos | `area.ts` (`statPlan`) y la directiva `agiTarget` |
| ver qué decidió y por qué | el feed del panel, el log (`/api/log`) o `events` con `kind = 'decide'` |
| medir si una decisión sirvió | `v_outcome`, `v_outcome_type`, `scripts/report.ts` |

Los cambios del cerebro se aplican solos con el bot conectado; los del núcleo piden reiniciarlo.

## 5. Qué se quitó

Todo lo del servidor Fast (resets, cacería de dorados, la esquina de Arena 2, sombras, orquestador, varias cuentas, bus entre bots) está
en el tag `fast-final` y la rama `archive/fast`.
