/**
 * Analiza una sesión registrada del cliente web (`frames.ndjson`, ver scripts/decode-frames.ts): exp por kill y por tipo de monstruo,
 * exp/min, subidas de nivel y drops. Sirve para medir qué rinde en el Slow y alimentar `slowStrategy`.
 *   bun scripts/analyze-session.ts frames.ndjson
 * Layouts 0.97d (AGENTS.md): ExperienceGained C3 0x16 → KilledObjectId u16 BE @3, AddedExperience u16 BE @5 (un kill grande llega
 * partido en tramos de 65535 con el mismo id: se suman los que llegan en < 1,5 s); AddNpcsToScope 0x13 → count @4 y 12 bytes por NPC
 * desde @5 (Id BE @0, Type @2, X @6, Y @7); CharacterLevelUpdate F3 05 → nivel u16 LE @4.
 */
import { readFileSync } from 'node:fs';
import { SimpleModulusDecryptor } from '../net/encryption';
import { getPacketSize, getSizeOfPacketType } from '../net/utils';
import { monsterName } from '../state';
import { loadGameData } from '../gamedata';

// Los datos del juego salen de la base (tablas sembradas con `bun run db:seed`).
await loadGameData();

const file = process.argv[2];
if (!file) { console.error('uso: bun scripts/analyze-session.ts <frames.ndjson>'); process.exit(2); }
const decryptor = new SimpleModulusDecryptor();
decryptor.decryptionKeys = SimpleModulusDecryptor.DefaultClientKey;
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const u16 = (p: Uint8Array, i: number) => (p[i] << 8) | p[i + 1];

type Ev = { t: number; code: number; sub: number; p: Uint8Array };
const evs: Ev[] = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  const o = JSON.parse(line) as { d: string; t: number; h?: string };
  if (o.d !== 'in' || !o.h) continue;
  let bytes = hexBytes(o.h);
  while (bytes.length > 1) {
    const type = bytes[0];
    const len = getPacketSize(bytes);
    if (type < 0xc1 || type > 0xc4 || !len || len > bytes.length) break;
    let p = bytes.slice(0, len);
    if (type >= 0xc3) { const [, dec] = decryptor.Decrypt(p); if (dec.length < 4) { bytes = bytes.slice(len); continue; } p = Uint8Array.from(dec); }
    const ci = getSizeOfPacketType(type) === 3 ? 3 : 2;
    evs.push({ t: o.t / 1000, code: p[ci], sub: p[ci + 1], p });
    bytes = bytes.slice(len);
  }
}
evs.sort((a, b) => a.t - b.t);

const typeById = new Map<number, number>();
const kills = new Map<string, { n: number; exp: number }>();
let lastExp: { id: number; t: number; sum: number; type: number } | null = null;
const perMin = new Map<number, number>();
const levels: { t: number; level: number }[] = [];
let dropPackets = 0;
let totalExp = 0, killCount = 0;
const flush = () => {
  if (!lastExp) return;
  const name = monsterName(lastExp.type);
  const k = kills.get(name) ?? { n: 0, exp: 0 };
  k.n++; k.exp += lastExp.sum; kills.set(name, k);
  killCount++; totalExp += lastExp.sum;
  perMin.set(Math.floor(lastExp.t / 60), (perMin.get(Math.floor(lastExp.t / 60)) ?? 0) + lastExp.sum);
  lastExp = null;
};
for (const { t, code, sub, p } of evs) {
  if (code === 0x13) {
    const n = p[4];
    for (let i = 0; i < n && 5 + i * 12 + 12 <= p.length; i++) typeById.set(u16(p, 5 + i * 12), p[5 + i * 12 + 2]);
  } else if (code === 0x16) {
    const id = u16(p, 3), add = u16(p, 5);
    if (lastExp && lastExp.id === id && t - lastExp.t < 1.5) { lastExp.sum += add; lastExp.t = t; }
    else { flush(); lastExp = { id, t, sum: add, type: typeById.get(id) ?? -1 }; }
  } else if (code === 0xf3 && sub === 0x05) levels.push({ t, level: p[4] | (p[5] << 8) });
  else if (code === 0x20) dropPackets++;
}
flush();

const span = (evs.at(-1)?.t ?? 0) - (evs[0]?.t ?? 0);
console.log(`sesión: ${(span / 60).toFixed(1)} min, ${killCount} kills con exp, ${totalExp.toLocaleString()} exp (${Math.round(totalExp / Math.max(1, span / 60)).toLocaleString()} exp/min)`);
console.log('\nPor monstruo (kills · exp/kill):');
for (const [name, k] of [...kills].sort((a, b) => b[1].exp - a[1].exp)) console.log(`  ${name.padEnd(22)} ${String(k.n).padStart(4)} · ${Math.round(k.exp / k.n).toLocaleString()}`);
console.log('\nExp por minuto de sesión:');
for (const [m, e] of [...perMin].sort((a, b) => a[0] - b[0])) console.log(`  min ${String(m).padStart(3)}: ${e.toLocaleString()}`);
console.log('\nSubidas de nivel:', levels.map((l) => `${l.level}@${Math.round(l.t)}s`).join(' '));
console.log(`Paquetes de drops: ${dropPackets}`);
