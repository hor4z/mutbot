/**
 * Bot de MU sin navegador: hace progresar a un personaje solo (pelea, sube nivel, reparte puntos,
 * resetea en 400, levanta cajas) hablando el protocolo real del cliente 0.97d, a ritmo humano.
 * Lo normal es lanzarlo desde la estación (`bun run estacion`), que le pasa todo esto.
 *
 * Solo contra infraestructura propia o con permiso (--allow-remote para hosts no locales).
 *
 *   bun run headless-bot.ts [opciones]      (credenciales en .env: MUBOT_USER/PASS/CHAR)
 *
 * Conexión:
 *   --proxy ws://127.0.0.1:3000          proxy WebSocket (WS -> TCP)
 *   --cs-host 127.0.0.1 --cs-port 44405  connect server
 *   --user u --pass p --char c           (mejor por .env)
 *   --allow-remote                       permite apuntar a hosts no locales
 *   --exit-if-in-use                     si la cuenta ya está conectada al entrar, sale con código 3
 *   (login rechazado: sale con 4 si la cuenta está bloqueada, 5 si la clave/cuenta/versión está mal)
 *
 * Farmeo:
 *   --auto-seconds 600   cuánto corre (0 = sin límite: farmea, resetea y reconecta con backoff)
 *   --reset-level 400    nivel del /reset
 *   --build str:50,ene:33,vit:17  reparto fijo de puntos (default: planStats)
 *   --max-stat 300       tope por atributo con --build
 *   --stat-batch 200     puntos mínimos para frenar a repartir
 *   --heal-at 60         usa poción con HP% <= esto
 *   --skills 41,42       skills de ataque, en orden de preferencia
 *   --spots 2,6,24       limita la ruta a esos warps
 *   --explore-dir 1      primera dirección a explorar desde el pueblo en mapas sin salida conocida
 *   --learn-file p.json  dónde guarda lo aprendido (default ~/.mubot/learning.json)
 *   --no-auto-hunt       sin el cazador automático de invasiones doradas
 *   --party-mates        acepta party de un compañero (por defecto se rechaza toda party)
 *
 * Panel:
 *   --ws-port 8791       panel en http://127.0.0.1:<puerto>/panel (ws-server.ts)
 *   --decision-log r.jsonl  diario de acciones en JSONL
 *
 * Este archivo solo arranca (panel, keepalives, sesiones con reconexión, señales). El resto:
 *   config.ts       flags, guard de "solo local", ritmos humanos
 *   state.ts        estado compartido: world (packets), bot (decisiones/panel), learned (aprendido)
 *   connection.ts   sockets, cifrado de salida, waitFor, login
 *   world.ts        parsers 0.97d, tracker del mundo, elegir personaje
 *   actions.ts      packets de salida (paso, golpe, skills, warp, chat, keepalives)
 *   combat.ts       elección de skill, alcance, pociones
 *   loot.ts         drops en scope y levantar lo valioso
 *   route.ts        warps, ruta fija por tramo, learning.json
 *   progress.ts     reparto de puntos y /reset
 *   events.ts       0x91 (aperturas), 0xFD (invasión), CharacterResets
 *   journal.ts      diario de acciones y log al panel
 *   panel.ts        modo, órdenes y estado del panel, señales de dorados
 *   farm-loop.ts    el loop autónomo (autonomousLoop)
 *   corner-step.ts  un tick en la esquina de Arena 2 (cornerStep)
 *   loop-ctx.ts     estado de una corrida del loop, caminar y cast en el camino
 *   util.ts         log, sleep, bytes, direcciones
 */
// Primero la configuración: valida los flags y el guard de "solo local" antes de abrir nada.
import { startTeamPolling } from './team';
import { startSquadPolling } from './squad-client';
import { resetStatTracking } from './progress';
import { watchChat } from './chat';
import { AUTO_SECONDS, CHAR_NAME, CS_HOST, CS_PORT, EXIT_IF_IN_USE, LIST_CHARS, PROXY, STAT_ORDER, USERNAME, WS_PORT_ARG } from './config';
import { sendEcho, sendPing } from './actions';
import { FATAL_LOGIN, LoginError, closeSockets, connectToConnectServer, connectToGameServer, getGameServerAddress } from './connection';
import { EVENT_POLL_TICK_MS, pollEvents, trackPanelPackets } from './events';
import { autonomousLoop, type LoopResult } from './farm-loop';
import { drops, lootState } from './loot';
import { LoginResponseLoginResultEnum } from './packets';
import { buildPanelState, handlePanelCommand, noteModeChange, updateTrail } from './panel';
import { Backoff } from './protocol097';
import { loadLearningState } from './route';
import { bot, world } from './state';
import { log, sleep } from './util';
import { CreateCharacterError, listCharacters, loginAndSelectCharacter, trackWorld } from './world';
import { startStatusServer } from './ws-server';

// ---------------------------------------------------------------------------
// Main: una sesión por conexión. Si se corta (kick, red, timeout), reconecta
// con backoff y retoma el ciclo desde el estado REAL: login → elegir personaje
// → leer nivel/mapa/puntos (CharacterInformation) → la ruta fija adopta el
// mapa si ya está en el del tramo, o warpea; a nivel 400 resetea. Nunca hay
// dos sesiones a la vez: se reconecta solo con la anterior ya cerrada.
// ---------------------------------------------------------------------------

// Código de salida de --exit-if-in-use (la estación lo muestra como "cuenta abierta en otro lado").
const EXIT_IN_USE = 3;
// Login rechazado sin arreglo reintentando: 4 = cuenta bloqueada, 5 = clave, cuenta o versión mal.
const EXIT_BLOCKED = 4;
const EXIT_LOGIN_REFUSED = 5;
// No se pudo crear el personaje nuevo (MUBOT_CREATE_CLASS): la estación lo muestra.
const EXIT_CREATE_FAILED = 6;

// Tras una sesión trabada (ciego), esto antes de volver a entrar.
const BLIND_WAIT_MS = 5_000;

let worldTracked = false;

function clearScope() {
  world.npcs.clear();
  world.townNpcs.clear();
  world.players.clear();
  drops.clear();
  lootState.looting = null;
  bot.currentSpot = null;
  bot.inGameAt = 0;
  bot.doing = 'conectando';
  bot.goalPoint = null;
}

async function session(deadline: number): Promise<LoopResult> {
  bot.kicked = false;
  clearScope();
  resetStatTracking();
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
    startTeamPolling();
    startSquadPolling();
    worldTracked = true;
  }
  await loginAndSelectCharacter();

  // Damos un par de segundos a que lleguen skill list, inventario y NPCs
  // en scope antes de que el loop empiece a decidir.
  await sleep(2000);
  return autonomousLoop(deadline);
}

/**
 * --list-chars: entra, imprime `MUBOT_CHARS <json>` con los personajes de la cuenta y sale (0). La
 * estación lo usa para mostrar los personajes de una cuenta que ya existe. Login rechazado: 3
 * (conectada en otro lado), 4 (bloqueada) o 5 (clave/cuenta).
 */
async function listAndExit(): Promise<never> {
  let code = 0;
  try {
    await connectToConnectServer();
    const { ip, port } = await getGameServerAddress();
    await connectToGameServer(ip, port);
    console.log(`MUBOT_CHARS ${JSON.stringify(await listCharacters())}`);
  } catch (e) {
    const r = e instanceof LoginError ? e.result : -1;
    code = r === LoginResponseLoginResultEnum.AccountAlreadyConnected ? EXIT_IN_USE
      : r === LoginResponseLoginResultEnum.AccountBlocked ? EXIT_BLOCKED
      : e instanceof LoginError && FATAL_LOGIN.has(r) ? EXIT_LOGIN_REFUSED : 1;
    console.error(`No pude leer los personajes: ${(e as Error).message}`);
  }
  closeSockets();
  process.exit(code);
}

async function main() {
  if (LIST_CHARS) await listAndExit();
  console.log(`\nBot headless contra proxy=${PROXY} connectServer=${CS_HOST}:${CS_PORT}`);
  console.log(`Cuenta=${USERNAME} Personaje=${CHAR_NAME}\n`);

  if (WS_PORT_ARG) {
    const wsPort = parseInt(WS_PORT_ARG);
    bot.statusServer = startStatusServer({ port: wsPort });
    bot.statusServer.onCommand(handlePanelCommand);
    log(`Panel en http://127.0.0.1:${wsPort}/panel (WebSocket ws://127.0.0.1:${wsPort}, solo esta máquina)`);
    setInterval(() => {
      const now = Date.now();
      updateTrail(now);
      noteModeChange();
      bot.statusServer?.broadcastPanelState(buildPanelState(now));
    }, 1000);
    setInterval(pollEvents, EVENT_POLL_TICK_MS);
  }

  // Lo aprendido (memoria de campamentos, ciclos, tipos) antes de entrar: la
  // llegada al mundo ya usa la memoria de campamentos.
  await loadLearningState();

  // Keepalives como el cliente web (ver sendPing/sendEcho en actions.ts). sendToGS no
  // manda nada si el socket está cerrado.
  setInterval(() => !bot.kicked && sendPing(), 5000);
  setInterval(() => !bot.kicked && sendEcho(), 2000);

  const deadline = AUTO_SECONDS > 0 ? Date.now() + AUTO_SECONDS * 1000 : 0;
  const total: LoopResult = { kills: 0, totalExpGained: 0, potionsDrunk: 0, statPointsSpent: 0, skillsUsed: 0, resets: 0, deaths: 0 };
  const backoff = new Backoff();
  let first = true;
  let sessions = 0;
  while (true) {
    const t0 = Date.now();
    let alreadyConnected = false;
    try {
      sessions++;
      const r = await session(deadline);
      for (const k of Object.keys(total) as Array<keyof LoopResult>) total[k] += r[k];
    } catch (e) {
      if (e instanceof CreateCharacterError) {
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
    }
    first = false;
    closeSockets();
    if (deadline && Date.now() >= deadline) break;
    // Sesión trabada (ciego): esperar a que el server suelte la vieja antes de volver a entrar.
    const wait = bot.blind ? Math.max(BLIND_WAIT_MS, backoff.next(Date.now() - t0, alreadyConnected)) : backoff.next(Date.now() - t0, alreadyConnected);
    bot.blind = false;
    if (deadline && Date.now() + wait >= deadline) break;
    log(`Reconecto en ${Math.round(wait / 1000)} s (sesión #${sessions} duró ${Math.round((Date.now() - t0) / 1000)} s).`);
    await sleep(wait);
  }

  console.log(`\n=== Resumen ===`);
  console.log(`Duración: ${AUTO_SECONDS}s, ${sessions} sesión(es), sin GUI, ritmo humano.`);
  console.log(`Kills: ${total.kills}  Exp: ${total.totalExpGained}  Pociones: ${total.potionsDrunk}`);
  console.log(`Puntos repartidos: ${total.statPointsSpent}  Skills usadas: ${total.skillsUsed}  Resets: ${total.resets}  Muertes: ${total.deaths}`);
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
