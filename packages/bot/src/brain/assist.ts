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
import { assist, bot, expLog, world } from '../core/state';
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

// --- Auto attack ----------------------------------------------------------------------------------------------------------------------------
// Índice de red del segundo poder del DK (capturado del click real del usuario en la página, confirmado
// contra el server: TargetedSkill 146. No está en la lista de skills que manda el server, así que no se
// puede armar con useSkill. Es de esta sesión de login y puede cambiar en la próxima reconexión).
const COMBO_SKILL_INDEX = 146;
/** Fire Breath (pedido del usuario como "fire bash", no hay exacto con ese nombre en la tabla de skills: 49 es
 * el candidato más cercano del DK, AllKnights nivel 110). */
const FIRE_BASH = 49;
/** Rageful Blow ("la estrella"): el único de los candidatos que es de área de verdad (AreaSkillAutomaticHits). */
const RAGEFUL_BLOW = 42;
/** Death Stab: el de mejor daño por maná contra un solo objetivo (70/15), sin área. */
const DEATH_STAB = 43;

// --- Estrategia automática de combos ---------------------------------------------------------------------------------------------------------
// Pedido del usuario: "implementa una estrategia de farmeo eficiente con combinaciones de skill y ejecutala". Prueba cada combinación durante un
// bloque de tiempo, mide la exp/min real que dio (con el expLog que ya alimenta attach.ts) y al terminar la ronda se queda con la que más rindió.
// Sigue reevaluando cada tanto (COMBO_RETEST_MS) por si cambia el spot o el nivel y conviene otra.
type ComboPlan = { id: string; combo: boolean; extra: number | null };
const COMBOS: ComboPlan[] = [
  { id: 'giro + combo', combo: true, extra: null },
  { id: 'giro + combo + fire breath', combo: true, extra: FIRE_BASH },
  { id: 'giro + combo + rageful blow', combo: true, extra: RAGEFUL_BLOW },
  { id: 'giro + combo + death stab', combo: true, extra: DEATH_STAB },
];
const COMBO_BLOCK_MS = 2 * 60_000;
const COMBO_RETEST_MS = 3 * 60 * 60_000;
const comboState = ((globalThis as { __comboTrial?: { start: number; last: number; rates: Record<string, number> } }).__comboTrial ??= {
  start: Date.now(),
  last: -1,
  rates: {},
});
function bestComboId(): string | undefined {
  return Object.entries(comboState.rates).sort((a, b) => b[1] - a[1])[0]?.[0];
}
function currentCombo(): ComboPlan {
  const sinceStart = Date.now() - comboState.start;
  const totalTrialMs = COMBOS.length * COMBO_BLOCK_MS;
  const inTrial = sinceStart < totalTrialMs;
  const block = inTrial ? Math.floor(sinceStart / COMBO_BLOCK_MS) : -1; // -1: ronda de pruebas terminada, se asentó en la ganadora

  // Cambió de bloque (o terminó la ronda): cierra el bloque anterior y anota cuánto rindió, ANTES de decidir el plan actual (si no,
  // el último bloque probado se pierde al pasar al modo asentado).
  if (comboState.last !== block && comboState.last >= 0 && comboState.last < COMBOS.length) {
    const prev = COMBOS[comboState.last]!;
    const rate = expLog.rateSince(comboState.start + comboState.last * COMBO_BLOCK_MS, Date.now());
    comboState.rates[prev.id] = rate;
    log(`Estrategia de combos: "${prev.id}" dio ${Math.round(rate)} exp/min.`);
  }

  if (inTrial) {
    if (comboState.last !== block) {
      comboState.last = block;
      log(`Estrategia de combos: ahora pruebo "${COMBOS[block]!.id}" durante ${COMBO_BLOCK_MS / 60_000} min.`);
    }
    return COMBOS[block]!;
  }

  const winner = COMBOS.find((c) => c.id === bestComboId()) ?? COMBOS[0]!;
  if (comboState.last !== -1) {
    comboState.last = -1;
    log(`Estrategia de combos: probadas todas, me quedo con "${winner.id}" (la de más exp/min). La vuelvo a probar en ${COMBO_RETEST_MS / 3_600_000} h.`);
  }
  // Pasado el tiempo de reevaluación, arranca una ronda nueva de pruebas desde cero.
  if (sinceStart > totalTrialMs + COMBO_RETEST_MS) {
    comboState.start = Date.now();
    comboState.last = -1;
    comboState.rates = {};
  }
  return winner;
}

/** Un golpe o skill por ritmo humano al monstruo más cercano que esté al alcance. No camina. */
async function assistLoop() {
  while (!assist.reload) {
    await sleep(150);
    if (!assist.enabled || !bot.inGameAt || bot.kicked || world.hp <= 0) continue;
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
      if (skill.number === 41) {
        const plan = currentCombo();
        if (plan.combo && bestD <= 1 && world.mana > 0) sendTargetedSkill(COMBO_SKILL_INDEX, best.id);
        if (plan.extra != null) {
          const extra = world.skills.get(plan.extra);
          if (extra && world.mana >= (SKILL_TABLE.get(plan.extra)?.mana ?? 0)) {
            const near = [...world.npcs.values()].filter((n) => chebyshev(world.x, world.y, n.x, n.y) <= castReach(plan.extra!)).length;
            if (near >= 2) useSkill(best.id, extra);
          }
        }
      }
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
/** Joyas, piezas de alas y excelentes (el Broken Sword de la quest ya no: se consiguió). */
const wantedDrop = (d: { group: number; num: number; isMoney?: boolean; excellent?: boolean }) =>
  !d.isMoney && !(d.group === 14 && d.num === 24) && (isJewel(d) || !!d.excellent);
const askedAt = new Map<number, number>();

function nearestWanted() {
  let best: { id: number; x: number; y: number; group: number; num: number; d: number } | null = null;
  for (const dr of drops.values()) {
    if (!wantedDrop(dr)) continue;
    const d = chebyshev(world.x, world.y, dr.x, dr.y);
    if (!best || d < best.d) best = { id: dr.id, x: dr.x, y: dr.y, group: dr.group, num: dr.num, d };
  }
  return best;
}

async function sniperLoop() {
  while (!assist.reload) {
    await sleep(100);
    if (!assist.sniper || !bot.inGameAt || bot.kicked || world.hp <= 0) continue;
    const t = nearestWanted();
    if (!t || t.d > SNIPE_REACH || bagRoom() <= 0) continue;
    const now = Date.now();
    if (now - (askedAt.get(t.id) ?? 0) < SNIPE_RETRY_MS) continue;
    askedAt.set(t.id, now);
    log(`Joyero: pido ${itemInfo(t.group, t.num).name} (a ${t.d} casillas).`);
    sendPickup(t.id);
  }
}

// --- Lo que attach.ts le muestra a la extensión -----------------------------------------------------------------------------------------------
export function lootHint() {
  const t = nearestWanted();
  if (!t || t.d > ALERT_TILES) return null;
  const dx = t.x - world.x, dy = t.y - world.y;
  const dir = (dy < 0 ? 'N' : dy > 0 ? 'S' : '') + (dx > 0 ? 'E' : dx < 0 ? 'O' : '');
  return { id: t.id, name: itemInfo(t.group, t.num).name, dist: t.d, dir };
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
