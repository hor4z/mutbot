/**
 * Ruta: los warps de farmeo, warpear y esperar el MapChanged, la RUTA FIJA por tramo
 * (chooseFixedRoute de learning.ts) y cargar/guardar lo aprendido en learning.json.
 */
import { CAMP, CampManager, CampMemory, Hunger } from './camp';
import { ALLOWED_SPOTS, CHAR_NAME, LEARN_FILE } from './config';
import { waitFor } from './connection';
import { warpTo } from './actions';
import { CycleLog } from './farming';
import { journal } from './journal';
import { CROWD_FALLBACK, activeDryExclusions, chooseFixedRoute, loadLearning, saveLearningChar, type Spot } from './learning';
import { isPriorityChar } from './knowledge';
import { bot, hotGrid, learned, typeStats, world } from './state';
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
  { index: CROWD_FALLBACK.warp, name: 'Arena', reqLevel: 50, zen: 0 },
  { index: 24, name: 'Arena 2', reqLevel: 100, zen: 0, map: 83 },
  { index: 25, name: 'Arena 3', reqLevel: 200, zen: 0, map: 84 },
  { index: 26, name: 'Arena 4', reqLevel: 300, zen: 0, map: 85 },
];
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
  if (learning.types) {
    Object.assign(typeStats.expByType, learning.types.expByType);
    Object.assign(typeStats.killSecByType, learning.types.killSecByType);
  }
  if (learning.hot) hotGrid.load(learning.hot);
  learned.camps = new CampManager(CAMP, new CampMemory(CAMP, learning.camps ?? []));
  learned.hunger = new Hunger(CAMP, learning.tierRef);
  learned.cycleLog = new CycleLog(Date.now(), learning.cycles ?? undefined);
  if (r.status === 'corrupt') {
    log(`Aprendizaje: ${LEARN_FILE} ilegible (${r.error}); arranco de cero${r.backup ? `, el original quedó en ${r.backup}` : ''}.`);
  } else {
    log(`Aprendizaje: ${CHAR_NAME} en ${LEARN_FILE}${r.status === 'missing' ? ' (archivo nuevo)' : ''}.`);
  }
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
  learnSaveChain = learnSaveChain.then(() =>
    saveLearningChar(LEARN_FILE, CHAR_NAME, learned.char).catch((e) =>
      log(`Aprendizaje: no pude guardar ${LEARN_FILE}: ${(e as Error).message}`),
    ),
  );
  return learnSaveChain;
}

// Entre warps: el agente web espera 15 s (que cargue el mapa y aparezcan los
// monstruos) antes de volver a evaluar.
export const WARP_COOLDOWN_MS = 15_000;

export async function warpAndWait(spot: Spot): Promise<boolean> {
  const waiter = waitFor('MapChanged075', 6000).catch(() => null);
  warpTo(spot.index);
  bot.lastWarpAt = Date.now();
  const ok = !!(await waiter);
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
  if (now - bot.lastWarpAt < WARP_COOLDOWN_MS) return false;
  // Spot fijado por la orden `warp` del panel: la ruta no lo cambia hasta la orden `farm`. Si murió
  // o lo sacaron, vuelve ahí.
  const pinnedSpot = bot.pinnedSpot;
  if (pinnedSpot) {
    if (bot.currentSpot?.index === pinnedSpot.index) return false;
    journal('travel', `vuelvo al spot fijado por el panel: ${pinnedSpot.name} (${zenTxt(pinnedSpot)})`, { warp: pinnedSpot.index, reason: 'panel' });
    return warpAndWait(pinnedSpot);
  }
  const exclude = activeDryExclusions(dryAt, now);
  const currentSpot = bot.currentSpot;
  const choice = chooseFixedRoute({
    noFallback: isPriorityChar(bot.charName),
    spots: WARP_SPOTS.filter((sp) => !exclude.has(sp.index) || sp.index === currentSpot?.index),
    level: world.level,
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
