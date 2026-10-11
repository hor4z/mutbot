# mubot

Bot headless de MU. Hace que un personaje **progrese solo** —pelea, sube exp y
stats, recoge loot, vende basura, repone pociones— sin GUI, hablando el protocolo
real del cliente.

Corre **solo contra la infraestructura propia**, y a ritmo humano a propósito.

## Quick start

```bash
bun install

# 1. Tests offline (no tocan el server)
bun run test

# Estación: conectar personajes (.env, .env.melu) y elegir su rutina en http://127.0.0.1:8787/panel
bun run estacion

# Proxy WebSocket -> TCP hacia tu server (127.0.0.1:3000)
bun run proxy

# 2. El bot: login + loop autónomo que hace progresar al personaje
bun run bot --user <u> --pass <p> --char <c> \
  --auto-seconds 600 \
  --build str,vit \
  --decision-log /tmp/decisiones.jsonl
```

El `--decision-log` escribe cada decisión como JSONL, una por línea. Es el punto
de enganche para una UI que quiera decidir.

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `headless-bot.ts` | El bot: login, mundo, loop autónomo, economía, capa de decisión. |
| `packet-tests.ts` | 25 tests offline de packets. Sin red. |
| `AGENTS.md` | Referencia técnica: protocolo, economía, anti-cheat, limitaciones. |

**Leé `AGENTS.md` antes de tocar el código.** La sección "Trampas de protocolo"
documenta packets donde los parsers generados del repo están mal para 0.97d y el
bot queda ciego sin avisar.

## Estado

Funciona y está verificado: login 0.97d, selección de personaje, entrada al
mundo, movimiento, stats, loot, pociones y los packets de venta/compra de NPC.

**Bloqueante para jugar solo:** el golpe (`HitRequest`) no produce efecto
contra el server real, así que el bot no mata nada todavía. Detalle en
`AGENTS.md` → "Combate".

## Reglas

- Solo contra infraestructura propia. `--allow-remote` es obligatorio para hosts
  no locales.
- Ritmos humanos y deliberados (caminata 380ms, ataque 500ms, skills 900ms). **No
  bajarlos.** El server tiene `SpeedHackDetectPlugIn` con delay base de 450ms y
  token bucket de 5.
- No tocar `SpeedHackDetectPlugIn` ni la config del server para que el bot vaya
  más rápido. El objetivo es saber si el server valida, no hacerlo pasar.
- Nada de flood, brute force ni sesiones simultáneas de la misma cuenta.

Es un proyecto independiente: `net/`, `packets/` y `data/` son copias del
cliente MU JS, así que no necesita ese repo para correr (solo para regenerar
`packets/`, ver `AGENTS.md`).
