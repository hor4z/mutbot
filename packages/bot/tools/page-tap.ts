/**
 * Tap del WebSocket del cliente web (se inyecta en la página del juego, ya compilado a un IIFE): engancha el socket de la página, descifra los
 * frames del servidor con el mismo cifrado del bot y arma en `window.__tap` una tabla en vivo de lo que pasa: monstruos en escena con su
 * posición, drops de zen, vida y maná propios, kills. Solo lee: no manda nada al servidor.
 *
 *   bun build tools/page-tap.ts --target=browser --format=iife --outfile=/tmp/page-tap.js
 *
 * Los offsets son los de ingest-frames.ts y world.ts (0.97d): AddNpcsToScope 0x13 (count @4, 12 bytes por NPC desde @5: id BE @0, tipo @2, x @6, y @7),
 * ExperienceGained 0x16, drops 0x20, CurrentHealth 0x26 y CurrentMana 0x27 (valor u16 BE @4 con el byte 3 en 0xFF actual y 0xFE máximo).
 */
import { SimpleModulusDecryptor } from '../src/net/encryption';
import { getPacketSize, getSizeOfPacketType } from '../src/net/utils';

type Npc = { id: number; type: number; x: number; y: number; at: number };
type Frame = { code: number; sub: number; len: number; hex: string; at: number };

const W = window as unknown as { __tap?: Record<string, any> };
W.__tap?.off?.();

const dec = new SimpleModulusDecryptor();
dec.decryptionKeys = SimpleModulusDecryptor.DefaultClientKey;
const u16 = (p: Uint8Array, i: number) => (p[i] << 8) | p[i + 1];
const hex = (p: Uint8Array) => [...p].map((b) => b.toString(16).padStart(2, '0')).join('');

const tap = {
  npcs: new Map<number, Npc>(),
  drops: new Map<number, { id: number; x: number; y: number; zen: number; at: number }>(),
  counts: {} as Record<string, number>,
  samples: {} as Record<string, string[]>,
  hp: 0, hpMax: 0, mp: 0, mpMax: 0, kills: 0, frames: 0, errors: 0,
  recent: [] as Frame[],
  sock: null as WebSocket | null,
  off: () => {},
};
W.__tap = tap;

function handle(p: Uint8Array, code: number, sub: number) {
  const key = `${code.toString(16)}/${sub.toString(16)}`;
  tap.counts[key] = (tap.counts[key] ?? 0) + 1;
  const s = (tap.samples[key] ??= []);
  if (s.length < 3) s.push(hex(p));
  const now = Date.now();
  if (code === 0x13) {
    for (let i = 0; i < p[4] && 5 + i * 12 + 12 <= p.length; i++) {
      const o = 5 + i * 12;
      const id = u16(p, o) & 0x7fff;
      tap.npcs.set(id, { id, type: p[o + 2], x: p[o + 6], y: p[o + 7], at: now });
    }
  } else if (code === 0x26 && sub === 0xff) tap.hp = u16(p, 4);
  else if (code === 0x26 && sub === 0xfe) tap.hpMax = u16(p, 4);
  else if (code === 0x27 && sub === 0xff) tap.mp = u16(p, 4);
  else if (code === 0x27 && sub === 0xfe) tap.mpMax = u16(p, 4);
  tap.recent.push({ code, sub, len: p.length, hex: hex(p).slice(0, 80), at: now });
  if (tap.recent.length > 400) tap.recent.shift();
}

function onFrame(buf: Uint8Array) {
  tap.frames++;
  let bytes = buf;
  while (bytes.length > 1) {
    const type = bytes[0], len = getPacketSize(bytes);
    if (type < 0xc1 || type > 0xc4 || !len || len > bytes.length) break;
    let p = bytes.slice(0, len);
    if (type >= 0xc3) {
      const [, d] = dec.Decrypt(p);
      if (d.length < 4) { bytes = bytes.slice(len); continue; }
      p = Uint8Array.from(d);
    }
    const ci = getSizeOfPacketType(type) === 3 ? 3 : 2;
    try { handle(p, p[ci], p[ci + 1]); } catch { tap.errors++; }
    bytes = bytes.slice(len);
  }
}

// El socket de la página: se captura cuando el cliente manda algo (cada pocos segundos, el ping).
let chain: Promise<void> = Promise.resolve();
const onMessage = (e: MessageEvent) => {
  const d = e.data;
  if (typeof d === 'string') return;
  chain = chain.then(async () => onFrame(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(await (d as Blob).arrayBuffer())));
};
const origSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
  if (!tap.sock) { tap.sock = this; this.addEventListener('message', onMessage); }
  return origSend.apply(this, args);
};
tap.off = () => {
  WebSocket.prototype.send = origSend;
  tap.sock?.removeEventListener('message', onMessage);
};
