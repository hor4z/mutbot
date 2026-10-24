# Arquitectura (una página)

**Bot (un proceso por personaje)** — `headless-bot.ts` conecta y lanza `farm-loop.ts`. Cada tick: ciego/vigía → buffs →
sobrevivir → pausa/PK → warp pedido → escuadra → baúl/equipo → cacería → defensa → dorados → reset → esquina/spot → loot →
objetivo → pelear. El orden exacto está en la cabecera de `farm-loop.ts`.

**Quién manda sobre el spot** — `intent.ts`. Un pin por dueño (`panel` > `squad` > `town`); manda el de mayor prioridad y
soltar el propio nunca toca el de otro. `requestWarp` admite un solo warp pendiente; `maybeChangeSpot` no warpea con uno
pendiente. Cada cambio queda en el diario (dueño + motivo). La sombra de una escuadra (`squadShadow`) no resetea, no cae
a Lorencia a esperar, no persigue dorados ni hace de guardián.

**Estación (un proceso para toda la flota)** — `estacion.ts`: conecta/desconecta bots, sirve el panel y las órdenes firmadas
de escuadra (`squad.ts`, HMAC). `director.ts` mira la flota cada 15 s y propone la misión de cada escuadra libre:
dorado avisado → `golden`; padrino alcanzable → crianza (`nurture`, `follow`). Solo la lanza con `MUBOT_DIRECTOR=auto`.

**Datos** — ClickHouse (`db/`): `insights.ts` lo lee para elegir mapa; `telemetry.ts` escribe. `learning.ts` guarda lo
aprendido por personaje en `~/.mubot/learning.json`.

**Fases del grupo** — LEVEL (ruta fija + crianza) → GEAR (dorados / eventos según reloj) → RESET (frenado :30–:05 por la
invasión). Ideas pendientes con su verificación: `docs/ideas-dinamicas.md`.

**Historia** — el agente del navegador y los tests viven en el tag `pre-cerebro`.
