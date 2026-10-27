/**
 * Modo asistente: el auto attack de la extensión del navegador. La extensión (packages/extension) engancha el socket de la página del juego y
 * le manda a este proceso, por WebSocket local, cada frame que entra y cada frame que sale. Acá se lee el mundo con las mismas piezas del bot
 * (EventBus, world.ts) y, con el asistente prendido, se decide a quién pegarle y con qué skill (brain/combat.ts); el paquete vuelve a la
 * extensión, que lo escribe en el socket de la página. No hay login ni conexión propia: es la sesión del usuario en su navegador.
 *
 *   bun run asistente        (y abrir el juego con la extensión instalada; hay que cargar la página DESPUÉS de arrancar esto)
 *
 * Mensajes: binario cliente→acá = <0 | 1> + frame (0: del server, 1: lo que mandó la página); acá→cliente binario = bytes a escribir en el socket
 * de la página. JSON cliente→acá: { type: 'set', on: boolean }; acá→cliente: { type: 'status', ... } cada 1 s.
 */
import { Xor32Decryptor } from './net/encryption';
import { EventBus } from './net/eventBus';
import { createPacketReader } from './net/socket';
import { ATTACK_PACE_MS, SKILL_PACE_MS } from './core/config';
import { XOR32_KEY_097D, attachFakeGameSocket, detachFakeGameSocket } from './core/connection';
import { trackPanelPackets } from './core/events';
import { loadGameData } from './core/gamedata';
import { bot, world } from './core/state';
import { onMapArrival, parseCharacterInformation097, parseCharacterList097, trackWorld, watchMoney } from './core/world';
import { sendHit } from './core/actions';
import { SKILL_TABLE, castReach, checkSurvival, pickAttackSkill, useSkill } from './brain/combat';
import { DIR_DELTA, chebyshev, directionTowards, humanPace, log, sleep } from './core/util';
import { GameServerEnteredPacket } from './packets';

const PORT = 8792;
/** Solo la página del juego (la extensión corre ahí) y esta máquina pueden hablarle. */
const ALLOWED_ORIGINS = new Set(['https://mu.mormon.garden']);
const STATION = 'http://127.0.0.1:8787/api/state';

let enabled = false;
let target = 0;
let characters: any[] = [];
let client: { send(d: string | Uint8Array): void } | null = null;
const reader = createPacketReader('[asistente]');
const xor = new Xor32Decryptor();
xor.xor32Key = XOR32_KEY_097D;

/** Lo que mandó la página (C1 con xor32): se lee el paso y el personaje elegido para saber dónde está y quién es. */
function onClientFrame(frame: Uint8Array) {
  if (frame[0] !== 0xc1 || frame.length < 4) return;
  const p = xor.Decrypt(Uint8Array.from(frame))[1];
  if (p[2] === 0x10 && p.length >= 6) {
    // WalkRequest075: C1 len 10 <x> <y> <rot<<4 | pasos> <direcciones de a dos por byte>
    let x = p[3], y = p[4];
    const n = p[5] & 15;
    for (let i = 0; i < n; i++) {
      const d = (p[6 + (i >> 1)] >> (i % 2 === 0 ? 4 : 0)) & 15;
      const delta = DIR_DELTA[d];
      if (delta) { x += delta[0]; y += delta[1]; }
    }
    world.x = x;
    world.y = y;
  } else if (p[2] === 0xf3 && p[3] === 0x03 && p.length >= 14) {
    const name = Buffer.from(p.subarray(4, 14)).toString('latin1').replace(/\0.*$/, '');
    bot.charName = name;
    log(`Personaje elegido en el navegador: ${name}.`);
  }
}

function applyCharacterInfo(raw: any) {
  const info = parseCharacterInformation097(raw);
  const mine = characters.find((c) => c.Name === bot.charName) ?? characters[0];
  Object.assign(world, {
    x: info.x, y: info.y, map: info.map, hp: info.hp, maxHp: info.maxHp, mana: info.mana, maxMana: info.maxMana,
    level: mine?.Level ?? world.level, classId: mine?.ClassId ?? null, levelUpPoints: info.levelUpPoints, exp: info.exp, expForNext: info.expForNext,
    stats: { str: info.str, agi: info.agi, vit: info.vit, ene: info.ene },
  });
  bot.lastMoney = info.money;
  bot.inGameAt = Date.now();
  bot.kicked = false;
  onMapArrival();
  log(`Asistente: ${bot.charName} en (${info.x},${info.y}) mapa ${info.map}, nivel ${world.level}.`);
}

/** El auto attack: un golpe o skill por ritmo humano al monstruo más cercano que esté al alcance. No camina. */
async function assistLoop() {
  while (true) {
    await sleep(150);
    if (!enabled || !bot.inGameAt || bot.kicked || world.hp <= 0) continue;
    if (checkSurvival()) { await sleep(300); continue; }
    const skill = pickAttackSkill();
    const reach = skill ? castReach(skill.number) : 1;
    let best: { id: number; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const n of world.npcs.values()) {
      const d = chebyshev(world.x, world.y, n.x, n.y);
      if (d <= reach && d < bestD) { best = n; bestD = d; }
    }
    if (!best) { target = 0; continue; }
    target = best.id;
    if (skill && useSkill(best.id, skill)) await sleep(humanPace(SKILL_PACE_MS));
    else if (bestD <= 1) { sendHit(best.id, directionTowards(world.x, world.y, best.x, best.y)); await sleep(humanPace(ATTACK_PACE_MS)); }
  }
}

/** Con Capitan conectado desde la estación no se prende: serían dos sesiones de la misma cuenta. */
async function capitanOnline(): Promise<boolean> {
  try {
    const r = (await (await fetch(STATION)).json()) as { pid?: number | null };
    return r.pid != null;
  } catch {
    return false;
  }
}

function skillName(): string {
  const s = pickAttackSkill();
  return s ? SKILL_TABLE.get(s.number)?.name ?? `skill ${s.number}` : 'golpe';
}

function status(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'status', enabled, inGame: !!bot.inGameAt, name: bot.charName, hp: world.hp, maxHp: world.maxHp, mana: world.mana,
    x: world.x, y: world.y, map: world.map, monsters: world.npcs.size, target, skill: skillName(), ...extra,
  });
}

async function main() {
  await loadGameData();
  trackWorld();
  trackPanelPackets();
  watchMoney();
  EventBus.on('CharacterList', (raw: any) => { characters = parseCharacterList097(raw); });
  EventBus.on('CharacterInformation', applyCharacterInfo);
  EventBus.on('GameServerEntered', (raw: any) => { bot.playerId = new GameServerEnteredPacket(raw).PlayerId & 0x7fff; });
  void assistLoop();

  Bun.serve<Record<string, never>>({
    hostname: '127.0.0.1',
    port: PORT,
    fetch(req, srv) {
      const origin = req.headers.get('origin');
      if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response('Origen no permitido.', { status: 403 });
      if (srv.upgrade(req, { data: {} })) return;
      return new Response('Solo WebSocket.', { status: 400 });
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        client = ws;
        // Mundo nuevo: se empieza de cero (la página se recargó) y lo que se mande sale por esta conexión.
        enabled = false;
        bot.inGameAt = 0;
        world.npcs.clear();
        attachFakeGameSocket((b) => { try { ws.send(b); } catch { /* cliente caído */ } });
        log('Asistente: la extensión se conectó.');
      },
      async message(ws, raw) {
        if (typeof raw === 'string') {
          let m: { type?: string; on?: boolean } = {};
          try { m = JSON.parse(raw); } catch { return; }
          if (m.type !== 'set') return;
          if (m.on && (await capitanOnline())) { ws.send(status({ error: 'Capitan está conectado desde la estación: desconectalo antes (son dos sesiones de la misma cuenta).' })); return; }
          if (m.on && !bot.inGameAt) { ws.send(status({ error: 'Todavía no vi la entrada al mundo: recargá la página del juego con el asistente andando.' })); return; }
          enabled = !!m.on;
          log(`Asistente ${enabled ? 'prendido' : 'apagado'}.`);
          ws.send(status());
          return;
        }
        const b = new Uint8Array(raw as Buffer);
        if (b[0] === 0) reader.push(b.subarray(1));
        else if (b[0] === 1) onClientFrame(b.subarray(1));
      },
      close(ws) {
        if (client === ws) client = null;
        enabled = false;
        bot.inGameAt = 0;
        detachFakeGameSocket();
        log('Asistente: la extensión se desconectó.');
      },
    },
  });
  setInterval(() => { try { client?.send(status()); } catch { /* sin cliente */ } }, 1000);
  log(`Asistente escuchando en ws://127.0.0.1:${PORT} (solo la página del juego).`);
}

void main();
