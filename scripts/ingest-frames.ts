/**
 * Receptor de la sesión del cliente web: recibe los frames del WebSocket que registra la página (lotes NDJSON `{d, t, h}` por POST), los
 * decodifica al vuelo (mismo cifrado y layouts que el bot) y los guarda en ClickHouse con `server = 'slow'`: kills con su exp y monstruo,
 * subidas de nivel, drops, ítems recogidos, tiendas (lo que vende cada una), compras/ventas, mensajes del servidor y una foto cada 5 s.
 * También deja el crudo en un archivo para poder reprocesar.
 *   bun --env-file=.env.db scripts/ingest-frames.ts <personaje> <crudo.ndjson> [puerto=8898] [servidor=slow]
 * Sin MUBOT_DB_URL solo guarda el crudo.
 */
import { appendFileSync } from 'node:fs';
import { SimpleModulusDecryptor } from '../net/encryption';
import { getPacketSize, getSizeOfPacketType } from '../net/utils';
import { decodeItemDetail, parseItemAdded, parseItemsDropped } from '../protocol097';
import { itemInfo } from '../panel-logic';
import { monsterName } from '../state';

const [char, rawFile, portArg, serverArg] = process.argv.slice(2);
if (!char || !rawFile) { console.error('uso: bun --env-file=.env.db scripts/ingest-frames.ts <personaje> <crudo.ndjson> [puerto] [servidor]'); process.exit(2); }
const PORT = Number(portArg ?? 8898), SERVER = serverArg ?? 'slow';
const DB_URL = process.env.MUBOT_DB_URL ?? '', DB_USER = process.env.MUBOT_DB_USER ?? 'mubot', DB_PASSWORD = process.env.MUBOT_DB_PASSWORD ?? '';
const SESSION = `web-${Date.now().toString(36)}`;
const VERSION = 'cliente-web';

const decryptor = new SimpleModulusDecryptor();
decryptor.decryptionKeys = SimpleModulusDecryptor.DefaultClientKey;
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const u16 = (p: Uint8Array, i: number) => (p[i] << 8) | p[i + 1];
const u16le = (p: Uint8Array, i: number) => p[i] | (p[i + 1] << 8);
const hex = (p: Uint8Array) => [...p].map((b) => b.toString(16).padStart(2, '0')).join('');
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

type Row = Record<string, unknown>;
const pending = new Map<string, Row[]>();
const push = (table: 'events' | 'ticks', r: Row) => { const l = pending.get(table) ?? []; l.push(r); pending.set(table, l); };

// Estado de la sesión.
const t0 = Date.now(); // el reloj de la página (t) es relativo: se ancla al momento del primer lote
let anchor: number | null = null;
const typeById = new Map<number, number>();
let level = 0, hp = 0, hpMax = 0, mp = 0, mpMax = 0, expTotal = 0;
const expWindow: [number, number][] = [];
let lastExp: { id: number; t: number; sum: number; type: number } | null = null;
let lastKillAt = 0, kills = 0, lastTick = 0;

const ev = (t: number, kind: string, num1: number, num2: number, text: string, data: object = {}) =>
  push('events', { ts: chTime(anchor! + t), char, session: SESSION, kind, map: 0, x: 0, y: 0, level, resets: 0, num1, num2, text, data: JSON.stringify(data), version: VERSION, policy: '', server: SERVER });

function flushKill() {
  if (!lastExp) return;
  const { id, t, sum, type } = lastExp;
  lastExp = null;
  expTotal += sum; kills++;
  expWindow.push([t, sum]);
  ev(t, 'kill', sum, type, monsterName(type), { id, sinceLastMs: lastKillAt ? Math.round(t - lastKillAt) : null });
  lastKillAt = t;
}

function handle(t: number, p: Uint8Array, code: number, sub: number) {
  if (code === 0x13) { // AddNpcsToScope (layout 0.95/0.97: 12 bytes por NPC desde @5)
    for (let i = 0; i < p[4] && 5 + i * 12 + 12 <= p.length; i++) typeById.set(u16(p, 5 + i * 12), p[5 + i * 12 + 2]);
  } else if (code === 0x16) {
    const id = u16(p, 3), add = u16(p, 5);
    if (lastExp && lastExp.id === id && t - lastExp.t < 1500) { lastExp.sum += add; lastExp.t = t; }
    else { flushKill(); lastExp = { id, t, sum: add, type: typeById.get(id) ?? -1 }; }
  } else if (code === 0xf3 && sub === 0x05) {
    level = u16le(p, 4);
    ev(t, 'level_up', level, u16le(p, 6), `nivel ${level}`, { points: u16le(p, 6), maxHp: u16le(p, 8), maxMp: u16le(p, 10) });
  } else if (code === 0xf3 && sub === 0x06) ev(t, 'stat_add', 0, 0, 'puntos', { raw: hex(p) });
  else if (code === 0x26 && sub === 0xff) hp = u16(p, 4);
  else if (code === 0x26 && sub === 0xfe) hpMax = u16(p, 4);
  else if (code === 0x27 && sub === 0xff) mp = u16(p, 4);
  else if (code === 0x27 && sub === 0xfe) mpMax = u16(p, 4);
  else if (code === 0x20) {
    for (const d of parseItemsDropped(p) ?? []) ev(t, 'drop', d.group * 512 + d.num, d.level, itemInfo(d.group, d.num).name, { group: d.group, num: d.num, x: d.x, y: d.y, exc: d.excellent });
  } else if (code === 0x22) {
    const it = parseItemAdded(p);
    if (it) ev(t, 'item_added', it.group * 512 + it.num, it.slot, itemInfo(it.group, it.num).name, { group: it.group, num: it.num, level: it.level, exc: it.excellent });
  } else if (code === 0x31 && p[0] === 0xc2) {
    const items: object[] = [];
    for (let i = 0; i < p[5]; i++) {
      const o = 6 + i * 7;
      if (o + 7 > p.length) break;
      const it = decodeItemDetail(p.slice(o + 1, o + 7));
      items.push({ slot: p[o], group: it.group, num: it.num, name: itemInfo(it.group, it.num).name, level: it.level, luck: it.luck, option: it.option, exc: it.excCount, dur: it.durability });
    }
    ev(t, 'shop_list', items.length, 0, 'tienda', { items });
  } else if (code === 0x32) ev(t, sub === 0xff ? 'shop_buy_failed' : 'shop_buy', sub, 0, 'compra', { raw: hex(p) });
  else if (code === 0x33) ev(t, 'shop_sell', 0, 0, 'venta', { raw: hex(p) });
  else if (code === 0x1c) ev(t, 'map_change', 0, 0, 'cambio de mapa', { raw: hex(p) });
  else if (code === 0x0d) ev(t, 'server_msg', p[3], 0, new TextDecoder().decode(p.slice(4)).replace(/\0.*$/s, ''));
  else if (code === 0x00 && p.length > 14) ev(t, 'chat', 0, 0, new TextDecoder().decode(p.slice(3)).replace(/\0/g, ' ').trim().slice(0, 200));
}

function tick(now: number, t: number) {
  if (now - lastTick < 5000) return;
  lastTick = now;
  while (expWindow.length && t - expWindow[0][0] > 60_000) expWindow.shift();
  push('ticks', { ts: chTime(anchor! + t), char, session: SESSION, map: 0, x: 0, y: 0, level, resets: 0, exp_total: expTotal, exp_min_1m: expWindow.reduce((n, [, e]) => n + e, 0), hp, mp, mode: 'browser', phase: '', side: '', rivals_near: 0, mates_near: 0, monsters_near: 0, in_party: 0, skill: 0, doing: `${kills} kills`, version: VERSION, policy: '', server: SERVER });
}

function ingest(line: string) {
  const o = JSON.parse(line) as { d: string; t: number; h?: string };
  if (o.d !== 'in' || !o.h) return;
  anchor ??= Date.now() - o.t;
  let bytes = hexBytes(o.h);
  while (bytes.length > 1) {
    const type = bytes[0], len = getPacketSize(bytes);
    if (type < 0xc1 || type > 0xc4 || !len || len > bytes.length) break;
    let p = bytes.slice(0, len);
    if (type >= 0xc3) { const [, dec] = decryptor.Decrypt(p); if (dec.length < 4) { bytes = bytes.slice(len); continue; } p = Uint8Array.from(dec); }
    const ci = getSizeOfPacketType(type) === 3 ? 3 : 2;
    try { handle(o.t, p, p[ci], p[ci + 1]); } catch { /* un paquete raro no frena la sesión */ }
    tick(Date.now(), o.t);
    bytes = bytes.slice(len);
  }
}

async function flush() {
  if (lastExp && lastKillAt && Date.now() - (anchor ?? 0) - lastExp.t > 2000) flushKill();
  if (!DB_URL) { pending.clear(); return; }
  for (const [table, rows] of [...pending]) {
    if (!rows.length) continue;
    pending.set(table, []);
    try {
      const r = await fetch(`${DB_URL}/?database=${process.env.MUBOT_DB_NAME ?? 'mubot_slow'}&query=${encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`)}`, { method: 'POST', body: rows.map((x) => JSON.stringify(x)).join('\n'), headers: { 'X-ClickHouse-User': DB_USER, 'X-ClickHouse-Key': DB_PASSWORD }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
      stats.rows += rows.length;
    } catch (e) { pending.set(table, [...rows, ...(pending.get(table) ?? [])]); console.error('no pude guardar:', (e as Error).message); }
  }
}
const stats = { lines: 0, rows: 0 };
setInterval(() => void flush(), 3000);

Bun.serve({
  hostname: '127.0.0.1', port: PORT,
  async fetch(req) {
    if (req.method === 'POST') {
      const body = await req.text();
      if (body) {
        appendFileSync(rawFile, body.endsWith('\n') ? body : body + '\n');
        for (const l of body.split('\n')) if (l.startsWith('{')) { stats.lines++; try { ingest(l); } catch { /* línea rota */ } }
      }
    }
    return new Response(JSON.stringify({ ...stats, kills, level, expTotal }), { headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } });
  },
});
console.log(`ingest: ${char} (${SERVER}) en 127.0.0.1:${PORT}, crudo en ${rawFile}, base ${DB_URL ? 'sí' : 'no'}`);
