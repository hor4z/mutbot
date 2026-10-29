/**
 * El asistente, dentro de la página del juego. Es lo mismo que hacía bot/src/attach.ts, pero sin proceso aparte: inject.ts le da cada frame que
 * entra y cada frame que sale del socket de la página, acá se lee el mundo con las piezas del bot (EventBus, world.ts) y el cerebro
 * (bot/src/brain/assist.ts) decide a quién pegarle, qué levantar y cuándo tomar una poción. Todo lo que se manda sale por el MISMO socket de la
 * página, cifrado con el mismo contador que los paquetes del cliente: es una sola secuencia, y como todo corre en el mismo hilo de la página
 * ningún paquete nuestro puede cruzarse con uno del usuario a mitad de camino.
 *
 * Nada sale de la máquina que no sea lo que ya manda el cliente al servidor del juego: ni puente local, ni base de datos.
 */
import './shim';
import { SimpleModulusDecryptor, Xor32Decryptor } from '../../bot/src/net/encryption';
import { EventBus } from '../../bot/src/net/eventBus';
import { createPacketReader } from '../../bot/src/net/socket';
import { XOR32_KEY_097D, attachFakeGameSocket, detachFakeGameSocket, resendPageFrame, syncGameCounter } from '../../bot/src/core/connection';
import { trackPanelPackets } from '../../bot/src/core/events';
import { assist, bot, world } from '../../bot/src/core/state';
import { onMapArrival, parseCharacterInformation097, parseCharacterList097, trackWorld, watchMoney } from '../../bot/src/core/world';
import { watchChat } from '../../bot/src/core/chat';
import { DIR_DELTA, log, sleep } from '../../bot/src/core/util';
import { GameServerEnteredPacket } from '../../bot/src/packets';
import * as bundledBrain from '../../bot/src/brain/assist';
import { HOST_MODS } from './host-mods';
import { loadEmbeddedGameData } from './seed-data';

type Brain = typeof bundledBrain;
/** El cerebro en uso: el que viene en la extensión o el que se cargó después con `window.__mu.swapBrain` (recarga en caliente, sin recargar la página). */
let brain: Brain = bundledBrain;

export type Status = {
  enabled: boolean; sniper: boolean; gold: boolean; inGame: boolean; name: string; hp: number; maxHp: number; mana: number; monsters: number;
  skill: string; target: number; loot: ReturnType<Brain['lootHint']>; error?: string;
};

export type Io = {
  /** Escribe bytes ya cifrados en el socket del juego de la página, con el `send` original (no vuelve a pasar por el gancho). */
  write(bytes: Uint8Array): void;
  /** Aprieta una tecla del hotbar en la página (pociones). */
  press(key: string): void;
};

let io: Io | null = null;
let characters: any[] = [];
let reader = createPacketReader('[asistente]');
const xor = new Xor32Decryptor();
xor.xor32Key = XOR32_KEY_097D;
let pageDecryptor = newPageDecryptor();
let started = false;

function newPageDecryptor() {
  const d = new SimpleModulusDecryptor();
  d.decryptionKeys = SimpleModulusDecryptor.DefaultServerKey;
  return d;
}

/**
 * Los C3 (skills, recoger ítems) llevan un contador que el server exige en orden. La página cuenta los suyos y nosotros los nuestros, así que si
 * salieran los dos tal cual se pisarían. Por eso TODOS los C3 de la página (con el asistente prendido o no) se descifran y se vuelven a cifrar con
 * un único contador, el nuestro, que arranca donde iba la página en el primero que se ve. Pasan por acá en el mismo hilo, sin esperas: una sola
 * secuencia, sin repetidos ni saltos, y apagar o prender el asistente no cambia nada del cifrado.
 */
let counterSynced = false;

/** Qué pasó con lo que mandó la página (`window.__mu.diag`): si un paquete tuyo no sale o sale distinto, acá queda anotado. */
export const diag = { c3: 0, c3Retained: 0, c3Raw: 0, errors: 0, dropped: 0, serverErrors: 0, lastError: '', lastErrorAt: 0 };
const fail = (what: string, e: unknown) => { diag.errors++; diag.lastError = `${what}: ${(e as Error)?.message ?? e}`; diag.lastErrorAt = Date.now(); log(`Asistente: ${diag.lastError}`); };

/** Un frame que la página va a mandar al servidor. true: ya salió por acá (con el contador compartido), el gancho no debe mandarlo. */
export function onPageSend(frame: Uint8Array): boolean {
  // Lo que la página manda tiene que salir SIEMPRE: si algo de acá falla, el paquete sale tal cual (nunca se traga un movimiento o un ataque).
  try {
    return onPageSendUnsafe(frame);
  } catch (e) {
    fail('error leyendo un paquete de la página, sale tal cual', e);
    return false;
  }
}

function onPageSendUnsafe(frame: Uint8Array): boolean {
  if (frame[0] === 0xc3 || frame[0] === 0xc4) {
    diag.c3++;
    try {
      // El contador viene dentro del paquete: así sirve aunque el asistente se haya enganchado con el juego ya empezado.
      const [count, plain] = (pageDecryptor as unknown as { DecryptC3(d: Uint8Array): [number, Uint8Array] }).DecryptC3(Uint8Array.from(frame));
      // El latido del cliente (C3 0E, cada 5 s) no es una acción tuya: si pausara al asistente, lo frenaba la mitad del tiempo.
      if (plain[2] !== 0x0e) bot.lastManualActionAt = Date.now();
      if (!counterSynced) { syncGameCounter(count); counterSynced = true; }
      resendPageFrame(plain);
      diag.c3Retained++;
      return true;
    } catch (e) { diag.c3Raw++; fail('no pude leer un C3 de la página, sale tal cual', e); }
    return false;
  }
  if (frame[0] !== 0xc1 || frame.length < 4) return false;
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
    const name = new TextDecoder('latin1').decode(p.subarray(4, 14)).replace(/\0.*$/, '');
    bot.charName = name;
    log(`Personaje elegido en el navegador: ${name}.`);
  }
  return false;
}

/** Un frame que el servidor le manda a la página. */
export function onServerFrame(bytes: Uint8Array) {
  try {
    reader.push(bytes);
  } catch (e) {
    diag.serverErrors++;
    fail('error procesando un paquete del servidor', e);
  }
}

/** La página abrió (o reabrió) el socket del juego: se empieza de cero, cada conexión lleva su propio contador. */
export function onGameSocket() {
  assist.enabled = false;
  assist.sniper = false;
  assist.gold = false;
  pageDecryptor = newPageDecryptor();
  counterSynced = false;
  reader = createPacketReader('[asistente]');
  bot.inGameAt = 0;
  world.npcs.clear();
  attachFakeGameSocket((b) => io?.write(b));
}

export function onGameSocketClosed() {
  assist.enabled = false;
  assist.sniper = false;
  assist.gold = false;
  bot.inGameAt = 0;
  detachFakeGameSocket();
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

/** Corre el cerebro; cuando termina (cambió el cerebro: `assist.reload`) arranca el nuevo, y si se cae lo reintenta. */
async function runBrain() {
  while (true) {
    assist.reload = false;
    try { await brain.run(); } catch (e) { log(`El asistente falló al correr (${(e as Error).message}); reintento.`); await sleep(3000); }
  }
}

/**
 * Recarga en caliente del cerebro: `code` es el resultado de `bun run brain` (dist/brain.js). Se evalúa en la página, usa el estado vivo del núcleo
 * (`window.__mu.mods`) y reemplaza al cerebro actual sin cortar el juego ni recargar. Devuelve un error si el cerebro nuevo no carga.
 */
function swapBrain(code: string): string | null {
  const w = window as unknown as { __muNext?: Brain };
  try {
    w.__muNext = undefined;
    (0, eval)(code);
    const next = w.__muNext as Brain | undefined;
    if (!next || typeof (next as { run?: unknown }).run !== 'function') return 'el código no trae un cerebro válido';
    brain = next;
    w.__muNext = undefined;
    assist.reload = true; // los loops del cerebro anterior terminan limpio y runBrain arranca el nuevo
    log('Cerebro del asistente recargado en caliente.');
    return null;
  } catch (e) {
    return `el cerebro nuevo no carga: ${(e as Error).message}`;
  }
}

/** Arranca el asistente (una vez por página). */
export function startAssistant(deps: Io) {
  io = deps;
  if (started) return;
  started = true;
  assist.press = (key) => io?.press(key);
  (window as unknown as { __mu?: unknown }).__mu = { mods: HOST_MODS, swapBrain, state: { world, bot, assist }, status: () => status(), diag };
  loadEmbeddedGameData();
  trackWorld();
  trackPanelPackets();
  watchMoney();
  EventBus.on('CharacterList', (raw: any) => { characters = parseCharacterList097(raw); });
  EventBus.on('CharacterInformation', applyCharacterInfo);
  EventBus.on('GameServerEntered', (raw: any) => { bot.playerId = new GameServerEnteredPacket(raw).PlayerId & 0x7fff; });
  watchChat(); // los avisos del server ("no es tuyo", "sin lugar") quedan en la consola: dicen por qué un pedido de ítem no entra
  EventBus.on('ItemAddedToInventory', (raw: any) => {
    const b = Uint8Array.from(raw instanceof Uint8Array ? raw : (raw?.buffer ? new Uint8Array(raw.buffer) : []));
    if (assist.sniper) log(`Joyero: el server respondió ${b[3] === 0xff ? 'no se pudo' : b[3] === 0xfe ? 'zen' : 'ítem al inventario'}.`);
  });
  void runBrain();
}

/** Prende o apaga el auto attack / el Joyero. Devuelve el motivo si no se pudo. */
export function setAssist(change: { on?: boolean; sniper?: boolean; gold?: boolean }): string | null {
  if ((change.on || change.sniper || change.gold) && !bot.inGameAt) return 'Todavía no vi la entrada al mundo: esperá a estar dentro del juego.';
  if ((change.on || change.sniper || change.gold) && !counterSynced) return 'Esperá unos segundos: todavía no vi el primer paquete del cliente para sincronizar el cifrado.';
  if (change.on !== undefined) { assist.enabled = change.on; log(`Asistente ${assist.enabled ? 'prendido' : 'apagado'}.`); }
  if (change.sniper !== undefined) { assist.sniper = change.sniper; log(`Joyero ${assist.sniper ? 'prendido' : 'apagado'}.`); }
  if (change.gold !== undefined) { assist.gold = change.gold; log(`Oro ${assist.gold ? 'prendido' : 'apagado'}.`); }
  return null;
}

export function status(): Status {
  return {
    enabled: assist.enabled, sniper: assist.sniper, gold: assist.gold, inGame: !!bot.inGameAt, name: bot.charName, hp: world.hp, maxHp: world.maxHp, mana: world.mana,
    monsters: world.npcs.size, skill: brain.skillName(), target: assist.target, loot: brain.lootHint(),
  };
}
