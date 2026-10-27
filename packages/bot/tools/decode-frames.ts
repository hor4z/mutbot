/**
 * Decodifica los frames del WebSocket que registra el cliente web del juego (NDJSON `{d:'in'|'out', t, h}` con h en hex) con el mismo
 * cifrado y la misma tabla de rutas que el bot (net/socket.ts). Sirve para ver qué hace el cliente real y pasarlo al bot.
 *   bun scripts/decode-frames.ts frames.ndjson            # resumen por paquete
 *   bun scripts/decode-frames.ts frames.ndjson --list     # un renglón por paquete entrante
 *   bun scripts/decode-frames.ts frames.ndjson --code 17  # vuelca en hex los paquetes de ese code
 * Solo los entrantes (servidor → cliente) se descifran; los salientes se cuentan por tipo de cabecera.
 */
import { readFileSync } from 'node:fs';
import { SimpleModulusDecryptor } from '../src/net/encryption';
import { getPacketSize, getSizeOfPacketType } from '../src/net/utils';
import { S2C_ROUTES, type PacketRoute } from '../src/packets/routes';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('uso: bun scripts/decode-frames.ts <frames.ndjson> [--list] [--code <hex>]'); process.exit(2); }
const list = rest.includes('--list');
const dumpCode = rest.includes('--code') ? parseInt(rest[rest.indexOf('--code') + 1], 16) : null;

const routesByCode: PacketRoute[][] = [];
for (const r of S2C_ROUTES) (routesByCode[r.Code] ??= []).push(r);
const decryptor = new SimpleModulusDecryptor();
decryptor.decryptionKeys = SimpleModulusDecryptor.DefaultClientKey;

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const counts = new Map<string, number>();
let outCount = 0, bad = 0, desync = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  const { d, t, h } = JSON.parse(line) as { d: string; t?: number; h?: string };
  if (!h) continue;
  if (d === 'out') { outCount++; continue; }
  let bytes = hexBytes(h);
  while (bytes.length > 1) {
    const type = bytes[0];
    if (type < 0xc1 || type > 0xc4) { bad++; break; }
    const len = getPacketSize(bytes);
    if (!len || len > bytes.length) { bad++; break; }
    let p = bytes.slice(0, len);
    if (type >= 0xc3) {
      const [ok, dec] = decryptor.Decrypt(p);
      // `ok` compara el contador de secuencia desde el inicio de la conexión: registrando a mitad de sesión nunca coincide, pero el contenido es válido.
      if (!ok) desync++;
      if (dec.length < 4) { bad++; bytes = bytes.slice(len); continue; }
      p = Uint8Array.from(dec);
    }
    const ci = getSizeOfPacketType(type) === 3 ? 3 : 2;
    const code = p[ci], sub = p[ci + 1];
    const def = routesByCode[code]?.find((r) => r.SubCode == null || r.SubCode === sub);
    const name = def?.Name ?? `?`;
    const key = `${code.toString(16).padStart(2, '0')}${def?.SubCode != null ? '/' + sub.toString(16).padStart(2, '0') : ''} ${name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (list) console.log(`${((t ?? 0) / 1000).toFixed(1)}s ${key} len=${p.length}`);
    if (dumpCode === code) console.log(`${((t ?? 0) / 1000).toFixed(1)}s ${key}: ${[...p].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    bytes = bytes.slice(len);
  }
}
if (!list && dumpCode == null) {
  console.log(`salientes: ${outCount}  ilegibles: ${bad}  contador desfasado (contenido válido): ${desync}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), k);
}
