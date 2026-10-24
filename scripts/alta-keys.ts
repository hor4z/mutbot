/**
 * Genera las claves del worker (workers/edge) en ~/.mubot/alta/ con permisos 0600. No imprime ningún secreto:
 *   private.jwk    clave privada RSA-OAEP: la usa la estación para descifrar las altas
 *   public.jwk     clave pública: va al worker (PUBLIC_KEY)
 *   station-token  la estación se identifica con el worker (STATION_TOKEN)
 *   form-token     el formulario de alta se identifica con el worker (ALTA_TOKEN)
 *   proxy-token    el bot se identifica con el proxy del worker (PROXY_TOKEN)
 * No pisa nada: si ya existen, se niega (borrá la carpeta para rotar todo).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ALTA_DIR } from '../alta-sync';

if (existsSync(join(ALTA_DIR, 'private.jwk'))) {
  console.error(`Ya hay claves en ${ALTA_DIR}. Para rotarlas, borrá esa carpeta y volvé a correr esto (y volvé a cargar los secretos en el worker).`);
  process.exit(1);
}
mkdirSync(ALTA_DIR, { recursive: true, mode: 0o700 });
const save = (name: string, text: string) => writeFileSync(join(ALTA_DIR, name), text, { mode: 0o600, flag: 'wx' });

const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
save('private.jwk', JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)));
save('public.jwk', JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)));
for (const t of ['station-token', 'form-token', 'proxy-token']) save(t, randomBytes(32).toString('hex'));

console.log(`Listo: claves y tokens en ${ALTA_DIR} (no se muestran).
Siguiente paso, desde workers/edge (ver su README): cargar los secretos al worker con
  bunx wrangler secret put PUBLIC_KEY    < ~/.mubot/alta/public.jwk
  bunx wrangler secret put STATION_TOKEN < ~/.mubot/alta/station-token
  bunx wrangler secret put ALTA_TOKEN    < ~/.mubot/alta/form-token
  bunx wrangler secret put PROXY_TOKEN   < ~/.mubot/alta/proxy-token`);
