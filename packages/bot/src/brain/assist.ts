/**
 * Cerebro del asistente de la extensión (attach.ts), recargable en caliente (hot.ts): el auto attack, las pociones por atajo y el Joyero.
 * attach.ts (el núcleo del asistente: socket con la extensión, paquetes de la página) nunca importa nada de acá más que el módulo ya cargado;
 * lo que el usuario prende vive en `assist` (core/state.ts) y sobrevive a cada recarga. Al cambiar un archivo de `src/brain/` los loops de acá
 * terminan limpio y arrancan los nuevos, sin cortar el juego.
 */
import { ATTACK_PACE_MS, HEAL_AT_PCT, SKILL_PACE_MS } from '../core/config';
import { sendHit, sendPickup, sendTargetedSkill } from '../core/actions';
import { drops } from '../core/loot-state';
import { itemInfo } from '../core/panel-logic';
import { assist, bot, world } from '../core/state';
import { chebyshev, directionTowards, humanPace, log, sleep } from '../core/util';
import { SKILL_TABLE, castReach, pickAttackSkill, useSkill } from './combat';
import { isJewel } from './farming';
import { bagRoom, watchDrops } from './loot';

// --- Pociones por atajo ---------------------------------------------------------------------------------------------------------------------
/** Teclas del hotbar del juego: lo que el usuario tenga ahí se toma, como si apretara la tecla (sin buscar casilleros en el inventario). */
const HEAL_KEY = 'q';
const MANA_KEY = 'w';
/** Con menos maná que esto se toma una poción azul: antes de quedarse sin skill. */
const MANA_LOW_PCT = 40;
/** Entre una poción y la siguiente de la misma clase (el server las espacia). */
const POTION_GAP_MS = 1500;
let lastHealAt = 0;
let lastManaAt = 0;

/** Toma la poción de vida o de maná con el atajo si hace falta. true si apretó una tecla. */
function drinkIfNeeded(): boolean {
  if (!assist.press) return false;
  const now = Date.now();
  if (world.maxHp > 0 && (world.hp / world.maxHp) * 100 <= HEAL_AT_PCT && now - lastHealAt >= POTION_GAP_MS) {
    lastHealAt = now;
    log(`Asistente: vida ${world.hp}/${world.maxHp}, aprieto ${HEAL_KEY.toUpperCase()}.`);
    assist.press(HEAL_KEY);
    return true;
  }
  if (world.maxMana > 0 && (world.mana / world.maxMana) * 100 <= MANA_LOW_PCT && now - lastManaAt >= POTION_GAP_MS) {
    lastManaAt = now;
    log(`Asistente: maná ${world.mana}/${world.maxMana}, aprieto ${MANA_KEY.toUpperCase()}.`);
    assist.press(MANA_KEY);
    return true;
  }
  return false;
}

// Si el usuario mandó algo a mano hace menos de esto, el asistente no ataca ni pide ítems: evita que su C3/C4
// y el del usuario compartan el contador de cifrado al mismo tiempo (eso desincronizaba el descifrado de la
// página y terminaba descartando los clicks del usuario en silencio). Las pociones por atajo (drinkIfNeeded)
// no cuentan: van por teclado, no por C3, así que no compiten por el contador.
const MANUAL_PAUSE_MS = 2500;

// --- Auto attack ------------------------------------------------------------------------------------------------------------------------------
/** Un golpe o skill por ritmo humano al monstruo más cercano que esté al alcance. No camina. */
async function assistLoop() {
  while (!assist.reload) {
    await sleep(150);
    if (!assist.enabled || !bot.inGameAt || bot.kicked || world.hp <= 0) continue;
    if (Date.now() - bot.lastManualActionAt < MANUAL_PAUSE_MS) continue;
    if (drinkIfNeeded()) await sleep(150);
    const skill = pickAttackSkill();
    const reach = skill ? castReach(skill.number) : 1;
    let best: { id: number; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const n of world.npcs.values()) {
      const d = chebyshev(world.x, world.y, n.x, n.y);
      if (d <= reach && d < bestD) { best = n; bestD = d; }
    }
    if (!best) { assist.target = 0; continue; }
    assist.target = best.id;
    if (skill && useSkill(best.id, skill)) {
      // Combo del usuario: con el Twisting Slash (41) ya tirado, suma el segundo poder del DK (capturado del
      // click real del usuario en la página: TargetedSkill con índice 146, no está en la lista de skills que
      // manda el server, así que no se puede armar con useSkill). Mismo objetivo, mismo instante. El índice
      // 146 es de esta sesión de login y puede cambiar en la próxima reconexión.
      if (skill.number === 41 && bestD <= 1 && world.mana > 0) sendTargetedSkill(146, best.id);
      await sleep(humanPace(SKILL_PACE_MS));
    }
    else if (bestD <= 1) { sendHit(best.id, directionTowards(world.x, world.y, best.x, best.y)); await sleep(humanPace(ATTACK_PACE_MS)); }
  }
}

// --- Joyero ---------------------------------------------------------------------------------------------------------------------------------
/** Hasta dónde se pide el ítem sin caminar (el bot camina hasta 1; acá no se camina, así que se prueba un poco más lejos) y hasta dónde se avisa. */
const SNIPE_REACH = 2;
const ALERT_TILES = 20;
const SNIPE_RETRY_MS = 600;
/** Zen (siempre, no ocupa lugar en la bolsa), joyas, piezas de alas y excelentes (el Broken Sword de la quest ya no: se consiguió). */
const wantedDrop = (d: { group: number; num: number; isMoney?: boolean; excellent?: boolean }) =>
  d.isMoney || (!(d.group === 14 && d.num === 24) && (isJewel(d) || !!d.excellent));
const askedAt = new Map<number, number>();

function nearestWanted() {
  let best: { id: number; x: number; y: number; group: number; num: number; isMoney: boolean; d: number } | null = null;
  for (const dr of drops.values()) {
    if (!wantedDrop(dr)) continue;
    const d = chebyshev(world.x, world.y, dr.x, dr.y);
    if (!best || d < best.d) best = { id: dr.id, x: dr.x, y: dr.y, group: dr.group, num: dr.num, isMoney: !!dr.isMoney, d };
  }
  return best;
}

async function sniperLoop() {
  while (!assist.reload) {
    await sleep(100);
    if (!assist.sniper || !bot.inGameAt || bot.kicked || world.hp <= 0) continue;
    if (Date.now() - bot.lastManualActionAt < MANUAL_PAUSE_MS) continue;
    const t = nearestWanted();
    if (!t || t.d > SNIPE_REACH || (!t.isMoney && bagRoom() <= 0)) continue;
    const now = Date.now();
    if (now - (askedAt.get(t.id) ?? 0) < SNIPE_RETRY_MS) continue;
    askedAt.set(t.id, now);
    log(`Joyero: pido ${t.isMoney ? 'Zen' : itemInfo(t.group, t.num).name} (a ${t.d} casillas).`);
    sendPickup(t.id);
  }
}

// --- Lo que attach.ts le muestra a la extensión -----------------------------------------------------------------------------------------------
// El reparto de stats ("Repartir puntos" del flotante) no pasa por acá: la extensión clickea los íconos reales
// del panel de personaje (packages/extension/src/inject.ts, investStatsNow), sin mandar ningún paquete por el
// bot. Eso evita compartir el contador de cifrado con lo que el usuario hace a mano (ver attach.ts, onPageC3).
export function lootHint() {
  const t = nearestWanted();
  if (!t || t.d > ALERT_TILES) return null;
  const dx = t.x - world.x, dy = t.y - world.y;
  const dir = (dy < 0 ? 'N' : dy > 0 ? 'S' : '') + (dx > 0 ? 'E' : dx < 0 ? 'O' : '');
  return { id: t.id, name: t.isMoney ? 'Zen' : itemInfo(t.group, t.num).name, dist: t.d, dir };
}

export function skillName(): string {
  const s = pickAttackSkill();
  return s ? SKILL_TABLE.get(s.number)?.name ?? `skill ${s.number}` : 'golpe';
}

export const skillNumber = () => pickAttackSkill()?.number ?? 0;

/** Corre los loops hasta que cambie el cerebro (`assist.reload`). */
export async function run(): Promise<void> {
  const stopWatchingDrops = watchDrops();
  try {
    await Promise.all([assistLoop(), sniperLoop()]);
  } finally {
    stopWatchingDrops();
  }
}
