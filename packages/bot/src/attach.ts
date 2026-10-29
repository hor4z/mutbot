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
import { SimpleModulusDecryptor, Xor32Decryptor } from './net/encryption';
import { EventBus } from './net/eventBus';
import { createPacketReader } from './net/socket';
import { XOR32_KEY_097D, attachFakeGameSocket, detachFakeGameSocket, resendPageFrame, syncGameCounter } from './core/connection';
import { trackPanelPackets } from './core/events';
import { loadGameData } from './core/gamedata';
import { assist, bot, expLog, world } from './core/state';
import { hotEntry } from './core/hot';
import { onMapArrival, parseCharacterInformation097, parseCharacterList097, trackWorld, watchMoney } from './core/world';
import { watchChat } from './core/chat';
import { DIR_DELTA, chebyshev, log, sleep } from './core/util';
import { ExperienceGainedPacket, GameServerEnteredPacket } from './packets';
import { track } from './core/telemetry';

const PORT = 8792;
/** Solo la página del juego (la extensión corre ahí) y esta máquina pueden hablarle. */
const ALLOWED_ORIGINS = new Set(['https://mu.mormon.garden']);
const STATION = 'http://127.0.0.1:8787/api/state';

/**
 * El auto attack, las pociones y el Joyero viven en `brain/assist.ts`, que se recarga en caliente (hot.ts) cada vez que cambia un archivo de
 * `src/brain/`. Acá queda lo que no se recarga: el socket con la extensión, los paquetes de la página y el estado (`assist`, en core/state.ts).
 */
type AssistBrain = typeof import('./brain/assist');
const assistHot = hotEntry<AssistBrain>('assist.ts', 'assist');
let brain: AssistBrain | null = null;
let characters: any[] = [];
let client: { send(d: string | Uint8Array): void } | null = null;
let reader = createPacketReader('[asistente]');
const xor = new Xor32Decryptor();
xor.xor32Key = XOR32_KEY_097D;

/**
 * Los C3 (skills, recoger ítems) llevan un contador que el server exige en orden. Mientras el asistente está apagado la página manda sus
 * C3 sola y acá solo se lee el contador. Una vez prendido, la extensión retiene los C3 de la página (dirección 2) y salen de acá, con el mismo
 * contador que los nuestros: una sola secuencia, sin repetidos ni saltos.
 */
let pageDecryptor = newPageDecryptor();
function newPageDecryptor() {
  const d = new SimpleModulusDecryptor();
  d.decryptionKeys = SimpleModulusDecryptor.DefaultServerKey;
  return d;
}
function onPageC3(frame: Uint8Array, held: boolean) {
  // El contador viene dentro del paquete: así sirve aunque el asistente se haya enganchado con el juego ya empezado.
  const [count, plain] = (pageDecryptor as unknown as { DecryptC3(d: Uint8Array): [number, Uint8Array] }).DecryptC3(Uint8Array.from(frame));
  if (held) resendPageFrame(plain);
  else syncGameCounter(count + 1);
}

/** Lo que mandó la página (C1 con xor32): se lee el paso y el personaje elegido para saber dónde está y quién es. */
function onClientFrame(frame: Uint8Array, held = false) {
  if (frame[0] === 0xc3 || frame[0] === 0xc4) {
    // Solo esto comparte el contador de cifrado con el bot (ver core/connection.ts): el asistente se pausa un
    // rato después de un C3/C4 de verdad (brain/assist.ts), no con cualquier cosa que mande la página (el
    // caminar, por ejemplo, es C1 y no comparte nada: pausar con eso lo dejaba frenado todo el tiempo).
    bot.lastManualActionAt = Date.now();
    try { onPageC3(frame, held); } catch { log('Asistente: no pude leer un C3 de la página.'); }
    return;
  }
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

/** Corre el cerebro del asistente. Al cambiar el código termina limpio y arranca el nuevo; si el nuevo falla enseguida, vuelve al anterior. */
async function runAssist() {
  let fresh = false;
  brain = await assistHot.take();
  while (true) {
    assist.reload = false;
    const t0 = Date.now();
    try {
      await brain.run();
    } catch (e) {
      const back = fresh && Date.now() - t0 < 15_000 ? assistHot.revert() : null;
      log(`El cerebro del asistente falló al correr (${(e as Error).message}); ${back ? 'vuelvo al anterior' : 'reintento'}.`);
      if (back) { brain = back; fresh = false; continue; }
      await sleep(3000);
      continue;
    }
    brain = await assistHot.take();
    fresh = true;
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

/**
 * Registro de lo que se juega a mano: cada 5 s un tick con la posición, los monstruos cerca y la exp/min, igual que los del bot (modo 'farm',
 * spot 'manual'). Así `v_cell_rate` y el aprendizaje ven los spots que el usuario descubre jugando, con el asistente prendido o no.
 */
const TICK_MS = 5_000;
let expTotal = 0;
function recordManualPlay() {
  EventBus.on('ExperienceGained', (raw: any) => {
    const added = new ExperienceGainedPacket(raw).AddedExperience;
    expTotal += added;
    expLog.add(added, Date.now());
  });
  setInterval(() => {
    if (!bot.inGameAt || !client || world.maxHp <= 0 || world.hp <= 0) return;
    const near = [...world.npcs.values()].filter((m) => chebyshev(m.x, m.y, world.x, world.y) <= 8).length;
    const now = Date.now();
    track('ticks', {
      map: world.map, x: world.x, y: world.y, level: world.level, exp_total: expTotal, exp_min_1m: expLog.perMin(now, 60_000),
      hp: Math.max(0, world.hp), mp: Math.max(0, world.mana), mode: 'farm', phase: near > 0 ? 'fight' : 'walk', spot: 'manual',
      skill: assist.enabled ? brain?.skillNumber() ?? 0 : 0, monsters_near: near, doing: assist.enabled ? 'auto attack (extensión)' : 'a mano',
    }, now);
  }, TICK_MS);
}

function status(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'status', enabled: assist.enabled, inGame: !!bot.inGameAt, name: bot.charName, hp: world.hp, maxHp: world.maxHp, mana: world.mana,
    x: world.x, y: world.y, map: world.map, monsters: world.npcs.size, target: assist.target, skill: brain?.skillName() ?? 'golpe', sniper: assist.sniper, loot: brain?.lootHint() ?? null, ...extra,
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
  watchChat(); // los avisos del server ("no es tuyo", "sin lugar") quedan en el log: dicen por qué un pedido de ítem no entra
  EventBus.on('ItemAddedToInventory', (raw: any) => { const b = Uint8Array.from(raw instanceof Uint8Array ? raw : (raw?.buffer ? new Uint8Array(raw.buffer) : [])); if (assist.sniper) log(`Joyero: el server respondió ${b[3] === 0xff ? 'no se pudo' : b[3] === 0xfe ? 'zen' : 'ítem al inventario'}.`); });
  assistHot.watch(() => { assist.reload = true; });
  void runAssist();
  recordManualPlay();

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
        assist.enabled = false;
        assist.sniper = false;
        assist.press = (key) => { try { ws.send(JSON.stringify({ type: 'key', key })); } catch { /* cliente caído */ } };
        pageDecryptor = newPageDecryptor();
        reader = createPacketReader('[asistente]'); // contador de descifrado nuevo: cada carga de la página empieza el suyo desde cero
        bot.inGameAt = 0;
        world.npcs.clear();
        attachFakeGameSocket((b) => { try { ws.send(b); } catch { /* cliente caído */ } });
        log('Asistente: la extensión se conectó.');
      },
      async message(ws, raw) {
        if (typeof raw === 'string') {
          let m: { type?: string; on?: boolean; sniper?: boolean } = {};
          try { m = JSON.parse(raw); } catch { return; }
          if (m.type !== 'set') return;
          if ((m.on || m.sniper) && (await capitanOnline())) { ws.send(status({ error: 'Capitan está conectado desde la estación: desconectalo antes (son dos sesiones de la misma cuenta).' })); return; }
          if ((m.on || m.sniper) && !bot.inGameAt) { ws.send(status({ error: 'Todavía no vi la entrada al mundo: recargá la página del juego con el asistente andando.' })); return; }
          if (m.on !== undefined) { assist.enabled = !!m.on; log(`Asistente ${assist.enabled ? 'prendido' : 'apagado'}.`); }
          if (m.sniper !== undefined) { assist.sniper = !!m.sniper; log(`Joyero ${assist.sniper ? 'prendido' : 'apagado'}.`); }
          ws.send(status());
          return;
        }
        const b = new Uint8Array(raw as Buffer);
        if (b[0] === 0) reader.push(b.subarray(1));
        else if (b[0] === 1 || b[0] === 2) onClientFrame(b.subarray(1), b[0] === 2);
      },
      close(ws) {
        if (client === ws) client = null;
        assist.enabled = false;
        assist.sniper = false;
        assist.press = null;
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
