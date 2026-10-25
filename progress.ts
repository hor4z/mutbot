/**
 * Progreso del personaje: repartir los puntos de atributo con /add y el /reset encadenado
 * (ver AGENTS.md, "Reset y stats" y "Reset encadenado").
 */
import { CHAR_NAME, CHAT_PACE_MS, STAT_BATCH_MIN, type StatName } from './config';
import { requestCharacterList, waitFor } from './connection';
import { sayChat } from './actions';
import { capStats, planStats, planByClass, classFamily } from './farming';
import { journal } from './journal';
import { strategy } from './strategy';
import { warp, warpAndWait } from './warps';
import { bot, world } from './state';
import { log, sleep } from './util';
import { trackEvent } from './telemetry';
import { selectCharacter } from './world';

// --- Estadísticas -----------------------------------------------------------
// Sube puntos de atributo siguiendo el orden de --build. El server responde con
// CharacterLevelUpdate (que actualiza levelUpPoints), así que no contamos a ciegas.
// Reparte TODOS los puntos libres con /add <stat> <n> (un comando por stat),
// proporcional a BUILD_WEIGHTS. Es como lo hace el usuario: confirmado que el
// server acepta str/ene/vit así (ver AGENTS.md, "Reset y stats").
const STAT_CMD: Record<StatName, string> = { str: 'str', agi: 'agi', vit: 'vit', ene: 'ene' };
// Si el server no los toma (stat en el tope: Melu con fuerza y energía en 65535), los puntos vuelven a
// aparecer en el próximo CharacterLevelUpdate y el bot repetía los /add cada pocos segundos sin pelear
// (2026-10-11: +13 niveles en 15 min). Si después de un reparto los puntos no bajaron, 15 min sin repartir.
let statTry: { points: number; at: number; level: number } | null = null;
let statOffUntil = 0;
/**
 * El seguimiento del último reparto (para detectar que el server no lo tomó: stats en el tope) arranca
 * de cero en cada reset y en cada conexión. Si sobrevivía al reset, comparaba contra el reparto viejo,
 * concluía "el server no tomó el reparto" y no repartía por 15 min (Melu, 21.000 puntos sin repartir).
 */
export function resetStatTracking() {
  statTry = null;
  statOffUntil = 0;
}

export async function investStatPoints(force = false): Promise<number> {
  const points = world.levelUpPoints;
  const family = classFamily(world.classId);
  if (points <= 0 || (!force && points < (strategy.statBatchMin ?? STAT_BATCH_MIN))) return 0;
  if (!force && Date.now() < statOffUntil) return 0;
  // Si subió de nivel desde el reparto, los puntos que hay son nuevos (no es que el server no lo tomó):
  // a un personaje nuevo que sube varios niveles por minuto lo frenaba 15 min sin repartir.
  if (statTry && world.level !== statTry.level) statTry = null;
  if (statTry && Date.now() - statTry.at > 3000 && points >= statTry.points) {
    statTry = null; statOffUntil = Date.now() + 15 * 60_000;
    log(`Stats: el server no tomó el reparto (siguen ${points} puntos libres; ¿stats en el tope?): no reparto por 15 min.`);
    return 0;
  }
  // DK: energía hasta fuerza − 2000, después mitad/mitad; 5 % vitalidad. Las demás clases, por porcentajes (farming.ts).
  // Tope de 65535 por stat (capStats): lo que no entra va a agilidad y vitalidad. Todo en el tope: no se reparte.
  const raw = strategy.statPlan ? strategy.statPlan(points, world.stats) : family === 'knight' || family == null ? planStats(points, world.stats.str, world.stats.ene) : planByClass(points, family);
  const capped = capStats(raw, world.stats);
  const plan = (['str', 'agi', 'vit', 'ene'] as StatName[]).map((k) => [k, capped[k]] as [StatName, number]).filter(([, n]) => n > 0);
  if (!plan.length) return 0;
  journal('stat', plan.filter(([, n]) => n > 0).map(([name, n]) => `+${n} ${name}`).join(', '), { points, plan: Object.fromEntries(plan) });
  statTry = { points, at: Date.now(), level: world.level };
  let spent = 0;
  for (const [name, n] of plan) {
    if (n <= 0) continue;
    sayChat(CHAR_NAME, `/add ${STAT_CMD[name]} ${n}`);
    world.stats[name] += n;
    world.levelUpPoints -= n;
    spent += n;
    await sleep(CHAT_PACE_MS);
  }
  return spent;
}

// Reparto en segundo plano (como el navegador: el /add no frena la pelea). Mientras uno corre no
// arranca otro; el loop sigue peleando. Devuelve true si arrancó uno.
let statsRunning = false;
export function investStatPointsInBackground(onSpent: (n: number) => void): boolean {
  if (statsRunning || bot.resetting) return false;
  statsRunning = true;
  void investStatPoints()
    .then((n) => { if (n) onSpent(n); })
    .catch((e) => log(`Stats: el reparto falló: ${(e as Error).message}`))
    .finally(() => { statsRunning = false; });
  return true;
}

// ---------------------------------------------------------------------------
// Reset (capturado del usuario): /reset por chat donde esté (si no lo acepta, en Lorencia) y el server
// lo devuelve a la selección de personaje. Hay que volver a elegir el personaje, repartir los puntos
// nuevos y salir a farmear.
// ---------------------------------------------------------------------------
export async function doReset(): Promise<boolean> {
  journal('reset', `/reset en nivel ${world.level}`, { level: world.level, stats: { ...world.stats } });
  bot.resetting = true;
  try {
    return await doResetSteps();
  } finally {
    bot.resetting = false;
  }
}

// Si el server no acepta /reset fuera de Lorencia, se recuerda (no se vuelve a probar en el lugar).
let resetNeedsLorencia = false;

// Manda /reset y espera la lista de personajes (el server nos manda a la selección).
async function sayReset(waitMs: number): Promise<any> {
  const listWaiter = waitFor('CharacterList', waitMs).catch(() => null);
  sayChat(CHAR_NAME, '/reset');
  return listWaiter;
}

async function doResetSteps(): Promise<boolean> {
  bot.doing = `reseteando en nivel ${world.level}`;
  // Como el navegador: sin repartir antes (los puntos sobrantes se suman a los del reset, ahorra ~8 s)
  // y /reset donde está; solo si el server no lo acepta fuera de Lorencia, warp y reintento.
  let list = world.map === 0 || !resetNeedsLorencia ? await sayReset(6000) : null;
  if (!list && world.map !== 0) {
    log('Reset: no lo aceptó acá; voy a Lorencia y reintento.');
    resetNeedsLorencia = true;
    await warpAndWait(warp(2)); // Lorencia
    await sleep(2000);
    list = await sayReset(8000);
  }
  if (!list) {
    // Por si el server nos dejó en la selección sin mandar la lista.
    const listWaiter = waitFor('CharacterList', 5000).catch(() => null);
    requestCharacterList();
    list = await listWaiter;
  }
  if (!list) {
    log('Reset: el server no nos mandó a la selección de personaje. ¿Requisitos (nivel, zen)?');
    return false;
  }
  log('Reset hecho. Vuelvo a entrar con el personaje.');
  resetStatTracking();
  bot.inGameAt = 0;
  world.npcs.clear();
  world.townNpcs.clear();
  bot.currentSpot = null;
  await selectCharacter(list);
  await sleep(2500);
  await investStatPoints(true);
  return true;
}
