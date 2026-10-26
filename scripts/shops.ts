/**
 * Qué vende cada tienda: lee los StoreItemList (C2 0x31) de una sesión registrada del cliente web (ver scripts/decode-frames.ts) y
 * lista los ítems con su nombre. El paquete trae [slot][ítem de 6 bytes] por entrada (count en el byte 5); no trae precios (los calcula el
 * cliente con la tabla de ítems).
 *   bun scripts/shops.ts frames.ndjson
 */
import { readFileSync } from 'node:fs';
import { decodeItemDetail } from '../protocol097';
import { itemInfo } from '../panel-logic';
import { loadGameData } from '../gamedata';

// Los datos del juego salen de la base (tablas sembradas con `bun run db:seed`).
await loadGameData();

const file = process.argv[2];
if (!file) { console.error('uso: bun scripts/shops.ts <frames.ndjson>'); process.exit(2); }
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const seen = new Set<string>();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  const o = JSON.parse(line) as { d: string; t: number; h?: string };
  if (o.d !== 'in' || !o.h) continue;
  for (let b = hexBytes(o.h); b.length > 3;) {
    const len = b[0] === 0xc2 || b[0] === 0xc4 ? (b[1] << 8) | b[2] : b[1];
    if (!len || len > b.length) break;
    if (b[0] === 0xc2 && b[3] === 0x31) {
      const key = [...b.slice(0, len)].join(',');
      if (!seen.has(key)) {
        seen.add(key);
        const count = b[5];
        const items: string[] = [];
        for (let i = 0; i < count; i++) {
          const o2 = 6 + i * 7;
          if (o2 + 7 > len) break;
          const it = decodeItemDetail(b.slice(o2 + 1, o2 + 7));
          items.push(`${String(b[o2]).padStart(2)}: ${itemInfo(it.group, it.num).name}${it.level ? ` +${it.level}` : ''}${it.luck ? ' +Luck' : ''}${it.option ? ' +Opt' : ''}${it.excCount ? ' Exc' : ''}`);
        }
        console.log(`Tienda ${(o.t / 1000).toFixed(0)}s (${count} ítems):\n  ${items.join('\n  ')}`);
      }
    }
    b = b.slice(len);
  }
}
if (!seen.size) console.log('No hay StoreItemList en la sesión: abrí una tienda mientras se registra.');
