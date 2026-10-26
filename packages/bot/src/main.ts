/**
 * Bot de MU Online 0.97d para el servidor Slow: hace progresar a un personaje solo (pelea, sube nivel, reparte puntos, levanta botín)
 * hablando el protocolo real del cliente, a ritmo humano. Lo normal es lanzarlo desde la estación (`bun run estacion`), que le pasa todo esto.
 *
 * Solo contra infraestructura propia o con permiso (--allow-remote para hosts no locales).
 *
 * Conexión:
 *   --proxy wss://worker/p/<token>/ws    proxy WebSocket (WS -> TCP)
 *   --cs-host clasico --cs-port 44405    connect server del Slow
 *   --user u --char c                    cuenta y personaje (la clave va por MUBOT_PASS, nunca por argumentos)
 *   --allow-remote                       permite apuntar a hosts no locales
 *   --exit-if-in-use                     si la cuenta ya está conectada al entrar, sale con código 3
 *   (login rechazado: sale con 4 si la cuenta está bloqueada, 5 si la clave/cuenta/versión está mal; 6 si el personaje no existe)
 *
 * Farmeo:
 *   --auto-seconds 600   cuánto corre (0 = sin límite: farmea y reconecta con backoff)
 *   --heal-at 60         usa poción con HP% <= esto
 *
 * Estado y órdenes:
 *   --ws-port 8791       WebSocket local (ws-server.ts): estado cada 1 s y órdenes de lista cerrada; el panel lo sirve la estación
 *
 * Este archivo solo arranca (WebSocket, keepalives, sesiones con reconexión, señales). El resto:
 *   config.ts       flags, guard de "solo local", ritmos humanos
 *   state.ts        estado compartido: world (packets) y bot (decisiones/panel)
 *   connection.ts   sockets, cifrado de salida, waitFor, login
 *   world.ts        parsers 0.97d, tracker del mundo, elegir personaje
 *   actions.ts      packets de salida (paso, golpe, skills, warp, chat, keepalives)
 *   combat.ts       elección de skill, alcance, pociones
 *   loot.ts         drops en scope y levantar lo valioso
 *   area.ts         dónde farmear (zona aprendida), reparto de puntos, viajes; warps.ts los warps
 *   learning.ts     lo que aprende (rendimiento por zona, exp por tipo de monstruo)
 *   progress.ts     reparto de puntos con /add
 *   journal.ts      decisiones con su motivo (log, panel y base)
 *   panel.ts        modo, órdenes y estado del panel
 *   farm-loop.ts    el loop autónomo (autonomousLoop)
 *   loop-ctx.ts     estado de una corrida del loop, caminar y cast en el camino
 *   telemetry.ts    ticks y eventos a ClickHouse
 *   util.ts         log, sleep, bytes, direcciones
 */
// Primero la configuración: valida los flags y el guard de "solo local" antes de abrir nada.
import { iniciarDirectivas } from './core/directivas';
import { watchChat } from './core/chat';
import { AUTO_SECONDS, CHAR_NAME, CS_HOST, CS_PORT, EXIT_IF_IN_USE, PROXY, STAT_ORDER, USERNAME, WS_PORT_ARG } from './core/config';
import { sendEcho, sendPing } from './core/actions';
import { FATAL_LOGIN, LoginError, closeSockets, connectToConnectServer, connectToGameServer, getGameServerAddress } from './core/connection';
import { trackPanelPackets } from './core/events';
import { MissingGameDataError, loadGameData } from './core/gamedata';
import { revertBrain, takeBrain, watchBrain } from './core/hot';
import type { LoopResult } from './brain/farm-loop';
import { drops, lootState } from './core/loot-state';
import { LoginResponseLoginResultEnum } from './packets';
import { buildPanelState, handlePanelCommand, noteModeChange, updateTrail } from './core/panel';
import { Backoff } from './core/protocol097';
import { bot, world } from './core/state';
import { log, sleep } from './core/util';
import { CharNotFoundError, loginAndSelectCharacter, trackWorld } from './core/world';
import { startStatusServer } from './core/ws-server';

// ---------------------------------------------------------------------------
// Main: una sesión por conexión. Si se corta (kick, red, timeout), reconecta
// con backoff y retoma el ciclo desde el estado REAL: login → elegir personaje
// → leer nivel/mapa/puntos (CharacterInformation) → la ruta fija adopta el
// el spot que toca. Nunca hay
// dos sesiones a la vez: se reconecta solo con la anterior ya cerrada.
// ---------------------------------------------------------------------------

// Código de salida de --exit-if-in-use (la estación lo muestra como "cuenta abierta en otro lado").
const EXIT_IN_USE = 3;
// Login rechazado sin arreglo reintentando: 4 = cuenta bloqueada, 5 = clave, cuenta o versión mal.
const EXIT_BLOCKED = 4;
const EXIT_LOGIN_REFUSED = 5;
// El personaje no está en la cuenta: la estación lo muestra.
const EXIT_CREATE_FAILED = 6;
// Faltan los datos del juego en la base (db:seed): no se arregla reintentando.
const EXIT_NO_GAME_DATA = 7;

// Tras una sesión trabada (ciego), esto antes de volver a entrar.
const BLIND_WAIT_MS = 5_000;

let worldTracked = false;

function clearScope() {
  world.npcs.clear();
  world.hits.clear();
  world.townNpcs.clear();
  world.players.clear();
  drops.clear();
  lootState.looting = null;
  bot.currentSpot = null;
  bot.inGameAt = 0;
  bot.doing = 'conectando';
  bot.goalPoint = null;
}

const emptyResult = (): LoopResult => ({ kills: 0, totalExpGained: 0, potionsDrunk: 0, statPointsSpent: 0, skillsUsed: 0, deaths: 0 });

/**
 * Corre el loop del cerebro (hot.ts). Si cambia el cerebro, el loop termina limpio y se arranca el nuevo SIN reconectar; si el nuevo falla
 * al correr (en los primeros segundos), se vuelve al anterior.
 */
async function runBrain(deadline: number): Promise<LoopResult> {
  const total = emptyResult();
  let brain = await takeBrain();
  let fresh = false; // el cerebro actual es uno recargado (si falla al correr, se vuelve al anterior)
  while (true) {
    bot.reloadBrain = false;
    brain.install();
    const t0 = Date.now();
    try {
      const r = await brain.autonomousLoop(deadline);
      for (const k of Object.keys(total) as Array<keyof LoopResult>) total[k] += r[k];
    } catch (e) {
      // Solo se culpa al cerebro nuevo si falló enseguida y la conexión sigue viva: un corte de red o un kick se propaga para reconectar.
      const back = fresh && !bot.kicked && Date.now() - t0 < 15_000 ? revertBrain() : null;
      if (!back) throw e;
      log(`El cerebro nuevo falló al correr (${(e as Error).message}); vuelvo al anterior.`);
      brain = back;
      fresh = false;
      continue;
    }
    if (!bot.reloadBrain || bot.kicked) break;
    brain = await takeBrain();
    fresh = true;
  }
  return total;
}

async function session(deadline: number): Promise<LoopResult> {
  bot.kicked = false;
  clearScope();
  await connectToConnectServer();
  const { ip, port } = await getGameServerAddress();
  await connectToGameServer(ip, port);
  // A partir de acá el server empieza a mandar el estado del mundo, así que
  // enganchamos el tracker ANTES de seleccionar personaje para no perder
  // SkillListUpdate / CharacterInventory, que llegan justo después del login.
  // Una sola vez: los handlers del EventBus sobreviven a la reconexión.
  if (!worldTracked) {
    trackWorld();
    trackPanelPackets();
    watchChat();
    iniciarDirectivas((m) => log(m), 2000);
    worldTracked = true;
  }
  await loginAndSelectCharacter();

  // Damos un par de segundos a que lleguen skill list, inventario y NPCs
  // en scope antes de que el loop empiece a decidir.
  await sleep(2000);
  return runBrain(deadline);
}

async function main() {
  // Con el proxy del worker el token va en la ruta (/p/<token>/ws): no se escribe en el log.
  console.log(`\nBot headless contra proxy=${PROXY.replace(/\/p\/[^/]+\//, '/p/***/')} connectServer=${CS_HOST}:${CS_PORT}`);
  console.log(`Cuenta=${USERNAME} Personaje=${CHAR_NAME}\n`);

  if (WS_PORT_ARG) {
    const wsPort = parseInt(WS_PORT_ARG);
    bot.statusServer = startStatusServer({ port: wsPort });
    bot.statusServer.onCommand(handlePanelCommand);
    log(`Estado y órdenes por WebSocket ws://127.0.0.1:${wsPort} (solo esta máquina; el panel lo sirve la estación).`);
    setInterval(() => {
      const now = Date.now();
      updateTrail(now);
      noteModeChange();
      bot.statusServer?.broadcastPanelState(buildPanelState(now));
    }, 1000);
  }

  // Los datos del juego (monstruos, skills, ítems, spawns) salen de la base: sin ellos el bot no sabe qué es un monstruo. El panel ya está arriba
  // (la estación ve que el bot vive y qué espera); si la base responde pero faltan los seeds, se sale enseguida.
  bot.doing = 'esperando los datos del juego (base)';
  try {
    await loadGameData();
  } catch (e) {
    if (!(e instanceof MissingGameDataError)) throw e;
    console.error(`${e.message}. No arranco.`);
    process.exit(EXIT_NO_GAME_DATA);
  }
  bot.doing = 'conectando';

  watchBrain();

  // Keepalives como el cliente web (ver sendPing/sendEcho en actions.ts). sendToGS no
  // manda nada si el socket está cerrado.
  setInterval(() => !bot.kicked && sendPing(), 5000);
  setInterval(() => !bot.kicked && sendEcho(), 2000);

  const deadline = AUTO_SECONDS > 0 ? Date.now() + AUTO_SECONDS * 1000 : 0;
  const total = emptyResult();
  const backoff = new Backoff();
  let first = true;
  let sessions = 0;
  while (true) {
    const t0 = Date.now();
    let alreadyConnected = false;
    let whyOff = '';
    try {
      sessions++;
      const r = await session(deadline);
      for (const k of Object.keys(total) as Array<keyof LoopResult>) total[k] += r[k];
    } catch (e) {
      if (e instanceof CharNotFoundError) {
        console.error(`${e.message} No reintento.`);
        closeSockets();
        process.exit(EXIT_CREATE_FAILED);
      }
      if (e instanceof LoginError && FATAL_LOGIN.has(e.result)) {
        console.error(`${e.message}: no reintento.`);
        closeSockets();
        process.exit(e.result === LoginResponseLoginResultEnum.AccountBlocked ? EXIT_BLOCKED : EXIT_LOGIN_REFUSED);
      }
      alreadyConnected = e instanceof LoginError && e.result === LoginResponseLoginResultEnum.AccountAlreadyConnected;
      // --exit-if-in-use (lo pasa la estación): si en el PRIMER login la cuenta ya está conectada, es
      // otra sesión (el navegador): no se insiste. Después de un corte sí se reintenta, porque el
      // server tarda en soltar la sesión vieja del propio bot.
      if (first && alreadyConnected && EXIT_IF_IN_USE) {
        console.error('La cuenta ya está conectada en otro lado (¿la pestaña del navegador?): no entro.');
        closeSockets();
        process.exit(EXIT_IN_USE);
      }
      log(`Sesión #${sessions} terminó con error: ${(e as Error).message}`);
      // Lo que ve el panel mientras espera para reintentar (la estación lo muestra en la tarjeta).
      whyOff = e instanceof LoginError
        ? e.result === LoginResponseLoginResultEnum.ServerIsFull ? 'Servidor lleno' : `Login rechazado (${LoginResponseLoginResultEnum[e.result] ?? e.result})`
        : `Error: ${(e as Error).message.slice(0, 80)}`;
    }
    first = false;
    closeSockets();
    if (deadline && Date.now() >= deadline) break;
    // Sesión trabada (ciego): esperar a que el server suelte la vieja antes de volver a entrar.
    const wait = bot.blind ? Math.max(BLIND_WAIT_MS, backoff.next(Date.now() - t0, alreadyConnected)) : backoff.next(Date.now() - t0, alreadyConnected);
    bot.blind = false;
    if (deadline && Date.now() + wait >= deadline) break;
    log(`Reconecto en ${Math.round(wait / 1000)} s (sesión #${sessions} duró ${Math.round((Date.now() - t0) / 1000)} s).`);
    if (whyOff) bot.doing = `${whyOff}: reintento en ${Math.round(wait / 1000)} s`;
    await sleep(wait);
  }

  console.log(`\n=== Resumen ===`);
  console.log(`Duración: ${AUTO_SECONDS}s, ${sessions} sesión(es), sin GUI, ritmo humano.`);
  console.log(`Kills: ${total.kills}  Exp: ${total.totalExpGained}  Pociones: ${total.potionsDrunk}`);
  console.log(`Puntos repartidos: ${total.statPointsSpent}  Skills usadas: ${total.skillsUsed}  Muertes: ${total.deaths}`);
  console.log(`Stats finales: ${STAT_ORDER.map((s) => `${s}=${world.stats[s]}`).join(' ')}`);
  console.log(`Skills conocidos: ${[...world.skills.values()].map((s) => `${s.number}(lv${s.level})`).join(', ') || 'ninguno'}`);
  closeSockets();
  process.exit(0);
}

// Ctrl+C / kill (la estación desconecta con SIGTERM).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    closeSockets();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
