# workers/edge

Worker de Cloudflare de la estación. Hace dos cosas:

1. **Alta de cuentas.** Formulario (`/`) que cifra usuario, personaje y clave en el navegador con la clave pública (RSA-OAEP).
   El worker guarda solo texto cifrado en KV (vence a los 7 días); la estación lo trae cada minuto, lo descifra con su clave
   privada (`~/.mubot/alta/private.jwk`, nunca sale del equipo) y agrega la cuenta con `db.addChar` (`alta-sync.ts`).
   La cuenta tiene que existir ya en el juego: si el personaje no existe, el bot lo informa al entrar.
2. **Proxy WebSocket.** `wss://<worker>/p/<PROXY_TOKEN>/ws?host=H&port=P` abre la conexión con el servidor (`UPSTREAM_HOST`,
   su `/ws`) y pasa los mensajes. Solo acepta los destinos de `ALLOWED_HOSTS`. La estación arma esa URL con los ajustes `worker_url` y
   `proxy_token` de la tabla `settings` de la base (el token queda en la línea de comandos de los bots, visible con `ps` para los usuarios de
   este equipo).

## Primer despliegue (lo hace el usuario; nada se publica solo)

```bash
bun install
bun run alta:keys                       # genera claves y tokens en ~/.mubot/alta/ (0600, no los imprime)
cd workers/edge
bunx wrangler login
bunx wrangler kv namespace create ALTAS # pegar el id en wrangler.toml
bunx wrangler secret put PUBLIC_KEY    < ~/.mubot/alta/public.jwk
bunx wrangler secret put STATION_TOKEN < ~/.mubot/alta/station-token
bunx wrangler secret put ALTA_TOKEN    < ~/.mubot/alta/form-token
bunx wrangler secret put PROXY_TOKEN   < ~/.mubot/alta/proxy-token
bun run deploy
```

Después, guardar la URL del worker y el token en la base (ajustes `worker_url` y `proxy_token` de la tabla `settings`; `bun run db:importar`
los pasa desde los archivos viejos `.env.alta` y `~/.mubot/alta/proxy-token`) y reiniciar la estación. La clave de acceso del formulario es
`~/.mubot/alta/form-token`.

Desarrollo local: `bun run edge:dev`. Typecheck: `bun run tsc` (raíz) corre también el del worker.
