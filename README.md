# mubot

Bot de MU Online 0.97d para el servidor Slow. Monorepo de Bun (`packages/*`); empezar por [AGENTS.md](AGENTS.md).

```bash
cp .env.example .env.db      # completar la clave de la base
bun install
bun run db:init              # migrations y seeds
bun run panel:build
bun run estacion             # http://127.0.0.1:8787
```
