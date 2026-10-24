/**
 * Ruta: los warps de farmeo, warpear y esperar el MapChanged, la RUTA FIJA por tramo
 * (chooseFixedRoute de learning.ts) y cargar/guardar lo aprendido en learning.json.
 */
import { CAMP, CampManager, CampMemory, Hunger } from './camp';
import { ALLOWED_SPOTS, CHAR_NAME, LEARN_FILE } from './config';
import { waitFor } from './connection';
import { warpTo } from './actions';
import { CycleLog, classFamily } from './farming';
import { journal } from './journal';
import { CROWDED_SPOT_MS, CROWD_FALLBACK, activeDryExclusions, chooseFixedRoute, loadLearning, saveLearningChar, type Spot } from './learning';
import { pin } from './intent';
import { isPriorityChar } from './knowledge';
import { farmMiddleware, statPower } from './farm-middleware';
import { bot, hotGrid, learned, pkGuard, typeStats, world } from './state';
import { queryDb } from './telemetry';
import { log } from './util';

// ---------------------------------------------------------------------------
// Mapas de farmeo: la RUTA del usuario (la que sigue el agente web, que es el
// que sube rápido), con índices del menú de warp del cliente (perfil v097d):
//   Lorencia (2) → Devias 3/4 (6, 7), si no Devias 2 (5) → Arena (1, nivel 50) → Arena 2 (24,
//   nivel 100) → Arena 3 (25, nivel 200) → Arena 4 (26, nivel 300).
// Devias 1 (warp 4) NO va: el usuario confirmó jugando que no sirve. Noria,
// Dungeon, Lost Tower, Atlans, etc. tampoco: no están en su ruta.
// Zen: los de Lorencia/Devias son los de la lista de warp; los de Arena no se
// capturaron todavía (0 = desconocido, el server igual valida y cobra).
// ---------------------------------------------------------------------------
// map = mapa al que deja el warp (Lorencia 0, Devias 2, Arenas 2/3/4 = 83/84/85
// según el agente web). La ruta FIJA por tramo está en learning.ts (FIXED_ROUTE).
export const WARP_SPOTS: Spot[] = [
  { index: 2, name: 'Lorencia', reqLevel: 10, zen: 1000, map: 0 },
  // Orden = preferencia entre spots del mismo nivel: Devias 3/4 antes que la 2.
  { index: 6, name: 'Devias 3', reqLevel: 20, zen: 2500, map: 2, arrival: { x: 226, y: 228 } },
  { index: 7, name: 'Devias 4', reqLevel: 20, zen: 2500, map: 2, arrival: { x: 70, y: 179 } },
  { index: 5, name: 'Devias 2', reqLevel: 20, zen: 2000, map: 2, arrival: { x: 24, y: 25 } },
  // Arena 1 (warp 1): monstruos flojos y dispersos, ~0 exp/min medido jugando.
  // Solo como plan B si todas las Devias están llenas de gente (nivel 50-99).
  { index: CROWD_FALLBACK.warp, name: 'Arena', reqLevel: 50, zen: 0, map: 6 },
  { index: 24, name: 'Arena 2', reqLevel: 100, zen: 0, map: 83 },
  { index: 25, name: 'Arena 3', reqLevel: 200, zen: 0, map: 84 },
  { index: 26, name: 'Arena 4', reqLevel: 300, zen: 0, map: 85 },
  // Aida (mapa 33, 2026-10-22): exp x6, 1 % de caja +4/+5 y 2 % de Cristal por monstruo. No está en la ruta
  // fija: se fija desde el panel o la estación (spot 27/28). Aida 2 = la zona Bloody.
  { index: 27, name: 'Aida', reqLevel: 140, zen: 8500, map: 33 },
  { index: 28, name: 'Aida 2', reqLevel: 170, zen: 9000, map: 33 },
];
/** El spot fijado manda solo si le da el nivel: después de un reset sigue la ruta hasta llegar. */
export const pinActive = (level = world.level) => { const p = pin.current(); return !!p && level >= p.reqLevel; };
export const zenTxt = (sp: Spot | null | undefined) => (sp?.zen ? `cuesta ${sp.zen} zen` : 'zen sin capturar');
export const LORENCIA_WARP = 2;
// Spot → cuándo se lo encontró "seco" (mapa entero sin monstruos DRY_MAP_MS).
// No se vuelve a elegir durante LEARN.DRY_EXCLUDE_MS (ver explore.ts).
export const dryAt = new Map<number, number>();
// Spot → cuándo se lo dejó por competencia (ruta fija: no volver enseguida).
export const crowdedAt = new Map<number, number>();

// ---------------------------------------------------------------------------
// Lo aprendido (learning.ts): campamentos, tipos de monstruo, spots calientes, ciclos y la
// referencia del hambre, por personaje en ~/.mubot/learning.json (--learn-file).
// ---------------------------------------------------------------------------
export const SAVE_EVERY_MS = 2 * 60_000;

export async function loadLearningState() {
  const r = await loadLearning(LEARN_FILE);
  learned.char = r.data.chars[CHAR_NAME] ?? { resets: 0 };
  const learning = learned.char;
  farmMiddleware.load(learning.routeRoi);
  if (learning.types) {
    Object.assign(typeStats.expByType, learning.types.expByType);
    Object.assign(typeStats.killSecByType, learning.types.killSecByType);
  }
  if (learning.hot) hotGrid.load(learning.hot);
  learned.camps = new CampManager(CAMP, new CampMemory(CAMP, learning.camps ?? []), Math.random);
  learned.hunger = new Hunger(CAMP, learning.tierRef);
  learned.cycleLog = new CycleLog(Date.now(), learning.cycles ?? undefined);
  void seedCampsFromDb();
  if (r.status === 'corrupt') {
    log(`Aprendizaje: ${LEARN_FILE} ilegible (${r.error}); arranco de cero${r.backup ? `, el original quedó en ${r.backup}` : ''}.`);
  } else {
    log(`Aprendizaje: ${CHAR_NAME} en ${LEARN_FILE}${r.status === 'missing' ? ' (archivo nuevo)' : ''}.`);
  }
}

/**
 * Campamentos de Arena 3/4 medidos en la base: exp/min promedio por celda de 8×8 y tramo de 50
 * niveles, con >= 2 min de ticks. La posición es el promedio de donde estuvo (caminable), no el
 * centro de la celda. Arena 2 no: ahí manda la esquina (corner.ts). Sin base no hace nada.
 */
export async function seedCampsFromDb() {
  const char = CHAR_NAME.replace(/[^A-Za-z0-9_]/g, '');
  const rows = await queryDb<{ map: number; cx: number; cy: number; lv: number; n: number; rate: number }>(
    `SELECT map, round(avg(x)) AS cx, round(avg(y)) AS cy, intDiv(level, 50) * 50 + 25 AS lv,
            count() AS n, avg(exp_min_1m) AS rate
     FROM ticks WHERE char = '${char}' AND map IN (84, 85) AND mode = 'farm' AND ts > now() - INTERVAL 14 DAY
     GROUP BY map, intDiv(x, 8), intDiv(y, 8), lv HAVING n >= 24 FORMAT JSONEachRow`);
  // Dónde hay monstruos juntos en las Arenas (cualquier personaje): candidatos para explorar.
  const dens = await queryDb<{ map: number; ax: number; ay: number; d: number }>(
    `SELECT map, round(avg(x)) AS ax, round(avg(y)) AS ay, avg(monsters_near) AS d
     FROM ticks WHERE map IN (6, 83, 84, 85) AND ts > now() - INTERVAL 14 DAY
     GROUP BY map, intDiv(x, 12), intDiv(y, 12) HAVING count() >= 30 FORMAT JSONEachRow`);
  if (dens.length) {
    learned.camps.seedDensity(dens.map((r) => ({ map: Number(r.map), x: Number(r.ax), y: Number(r.ay), d: Number(r.d) })));
    log(`Aprendizaje: densidad de monstruos de ${dens.length} celdas de Arena en la base.`);
  }
  if (!rows.length) return;
  learned.camps.memory.seed(rows.map((r) => ({ map: Number(r.map), x: Number(r.cx), y: Number(r.cy), level: Number(r.lv),
    rate: Number(r.rate), n: Math.max(1, Math.round(Number(r.n) / 12)) })));
  log(`Aprendizaje: ${rows.length} campamentos de Arena 3/4 medidos en la base.`);
}

/**
 * Exp/min por mapa medida en la base con este personaje y resets parecidos (±3, los stats casi no
 * cambian entre resets y sí tras un grand reset), a nivel parecido. Siembra el selector de mapa.
 */
const SEED_MAP_SPOT: Record<number, number> = { 85: 26, 84: 25, 83: 24, 6: 1, 2: 7 };
export async function seedRouteFromDb(resets: number, level: number, power: number) {
  const char = CHAR_NAME.replace(/[^A-Za-z0-9_]/g, '');
  const rows = await queryDb<{ map: number; rate: number; lv: number; n: number }>(
    `SELECT map, avg(exp_min_1m) AS rate, round(avg(level)) AS lv, count() AS n
     FROM ticks WHERE char = '${char}' AND mode = 'farm' AND map IN (2, 6, 83, 84, 85) AND ts > now() - INTERVAL 3 DAY
       AND resets BETWEEN ${Math.max(0, resets - 3)} AND ${resets + 3} AND level BETWEEN ${level - 80} AND ${level + 80}
     GROUP BY map HAVING n >= 24 FORMAT JSONEachRow`);
  if (!rows.length) return;
  farmMiddleware.seed(rows.map((r) => ({ spot: SEED_MAP_SPOT[Number(r.map)], rate: Number(r.rate), level: Number(r.lv), n: Math.max(1, Math.round(Number(r.n) / 12)) })), power);
  log(`Aprendizaje: exp por mapa de la base (resets ${resets}±3): ${rows.map((r) => `${r.map}=${Math.round(Number(r.rate) / 1e6)}M`).join(' ')}.`);
}

// Los saves se encadenan (muerte y resumen pueden coincidir): uno a la vez.
let learnSaveChain: Promise<void> = Promise.resolve();
export function persistLearning(): Promise<void> {
  // Nunca frena el juego: si el disco falla, se pierde a lo sumo un tramo.
  const learning = learned.char;
  learning.types = typeStats.snapshot();
  learning.hot = hotGrid.dump().map(({ map, cx, cy, exp }) => ({ map, cx, cy, exp }));
  learning.camps = learned.camps.memory.dump();
  learning.cycles = { cur: learned.cycleLog.cur, done: learned.cycleLog.done.slice(-200) };
  learning.tierRef = { ...learned.hunger.ref };
  learning.routeRoi = { ...farmMiddleware.scores };
  learnSaveChain = learnSaveChain.then(() =>
    saveLearningChar(LEARN_FILE, CHAR_NAME, learned.char).catch((e) =>
      log(`Aprendizaje: no pude guardar ${LEARN_FILE}: ${(e as Error).message}`),
    ),
  );
  return learnSaveChain;
}

// El selector por exp medida (farm-middleware.ts) eligió `spot`. Devias tiene tres entradas del mismo
// mapa: si está en una, no cruza a otra salvo que esté llena o no rinda.
async function chooseMeasuredSpot(spot: number, why: string, sig: SpotSignals, now: number): Promise<boolean> {
  const cur = bot.currentSpot;
  const usable = (sp: Spot) => sp.reqLevel <= world.level && (!ALLOWED_SPOTS || ALLOWED_SPOTS.has(sp.index));
  let to = WARP_SPOTS.find((sp) => sp.index === spot && usable(sp));
  if (!cur && bot.canAdopt && to && to.map === world.map) {
    // Ya está en el mapa elegido (reconexión): adoptarlo sin warpear.
    bot.currentSpot = to;
    log(`Spot: ya estoy en ${to.name} (${why}).`);
    return false;
  }
  if (to?.map === 2 && cur?.map === 2) {
    if (!sig.crowded && !sig.mapDead) return false;
    if (sig.crowded) crowdedAt.set(cur.index, now);
    if (sig.mapDead) dryAt.set(cur.index, now);
    const exclude = activeDryExclusions(dryAt, now);
    to = WARP_SPOTS.find((sp) => sp.map === 2 && sp.index !== cur.index && usable(sp) && !exclude.has(sp.index) &&
      now - (crowdedAt.get(sp.index) ?? -Infinity) > CROWDED_SPOT_MS);
    why = `${cur.name} ${sig.crowded ? 'con mucha competencia' : 'sin monstruos'}`;
  }
  if (!to || to.index === cur?.index) return false;
  journal('travel', `${why} → ${to.name} (${zenTxt(to)})`, { from: cur?.name ?? null, level: world.level, reason: 'measured', warp: to.index });
  log(`Cambio de spot: ${cur?.name ?? '?'} → ${to.name} — ${why}`);
  const moved = await warpAndWait(to);
  if (moved) await persistLearning();
  return moved;
}

// Entre warps: el agente web espera 15 s (que cargue el mapa y aparezcan los
// monstruos) antes de volver a evaluar.
export const WARP_COOLDOWN_MS = 15_000;

export async function warpAndWait(spot: Spot): Promise<boolean> {
  const waiter = waitFor('MapChanged075', 6000).catch(() => null);
  warpTo(spot.index);
  bot.lastWarpAt = Date.now();
  const ok = !!(await waiter);
  pkGuard.onWarp(ok, Date.now());
  if (ok) bot.currentSpot = spot;
  else log(`Warp a ${spot.name} sin respuesta (¿nivel, zen o PK?).`);
  return ok;
}

// La RUTA FIJA por tramo (chooseFixedRoute, learning.ts): cambia de mapa solo al cruzar un tramo,
// con el mapa vacío (90 s) o por competencia que bajó la exp (campamentos abandonados por gente, o
// "hambre"). Si ya está en el mapa del tramo al entrar al mundo, lo adopta sin warpear.
type SpotSignals = { mapDead?: boolean; crowded?: boolean };
export async function maybeChangeSpot(sig: SpotSignals = {}): Promise<boolean> {
  const now = Date.now();
  if (now - bot.lastWarpAt < WARP_COOLDOWN_MS || bot.pendingWarp) return false; // un warp pedido ya viaja: no duplicarlo
  // Sin stats ni vida todavía (primer tick tras entrar al mundo) el chequeo de "personaje limitado" está apagado y la ruta
  // lo mandaba al tramo de su nivel (Zamu, nivel 353 con 1.300 de vida, a Arena 4: 6 muertes). Se espera a conocerlos.
  if (!(world.maxHp > 0) || !(statPower({ family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp }) > 0)) return false;
  // Spot fijado por la orden `warp` del panel: la ruta no lo cambia hasta la orden `farm`. Si murió
  // o lo sacaron, vuelve ahí.
  const pinnedSpot = pin.current();
  if (pinnedSpot && pinActive()) {
    if (bot.currentSpot?.index === pinnedSpot.index) return false;
    journal('travel', `vuelvo al spot fijado (${pin.owner()}): ${pinnedSpot.name} (${zenTxt(pinnedSpot)})`, { warp: pinnedSpot.index, reason: 'panel' });
    return warpAndWait(pinnedSpot);
  }
  const exclude = activeDryExclusions(dryAt, now);
  const currentSpot = bot.currentSpot;
  const profile = farmMiddleware.profile({ family: classFamily(world.classId) ?? 'knight', stats: world.stats, maxHp: world.maxHp }, world.level, world.skills.has(41), now);
  if (profile.spot != null) return chooseMeasuredSpot(profile.spot, profile.why, sig, now);
  const routeLevel = profile.routeLevel;
  const choice = chooseFixedRoute({
    noFallback: isPriorityChar(bot.charName),
    spots: WARP_SPOTS.filter((sp) => !exclude.has(sp.index) || sp.index === currentSpot?.index),
    level: routeLevel,
    realLevel: world.level,
    allowed: ALLOWED_SPOTS,
    current: currentSpot,
    currentMap: bot.canAdopt ? world.map : -1,
    pos: { x: world.x, y: world.y },
    mapDead: !!sig.mapDead,
    crowded: !!sig.crowded,
    crowdedAt,
    now,
    prefer: bot.lastSpotIndex,
  });
  if (choice.reason === 'crowd' && currentSpot) crowdedAt.set(currentSpot.index, now);
  if (sig.crowded) learned.camps.crowdLeaves = [];
  if (choice.reason === 'adopt' && choice.spot) {
    // Ya está en el mapa del tramo: seguir acá sin warpear.
    log(`Spot: ${choice.what}.`);
    bot.currentSpot = choice.spot;
    return false;
  }
  if (!choice.warp || !choice.spot || choice.spot.index === currentSpot?.index) return false;
  const best = choice.spot;
  const what = `${choice.what} (${zenTxt(best)})`;
  journal('travel', what, { from: currentSpot?.name ?? null, level: world.level, reason: choice.reason, tier: choice.tier, warp: best.index, ...(exclude.size ? { dry: [...exclude] } : {}) });
  log(`Cambio de spot: ${currentSpot?.name ?? '?'} → ${best.name} — ${what}`);
  const moved = await warpAndWait(best);
  if (moved) await persistLearning();
  return moved;
}
