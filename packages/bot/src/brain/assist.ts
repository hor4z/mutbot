/**
 * Cerebro del asistente de la extensión (attach.ts), recargable en caliente (hot.ts): el auto attack, las pociones por atajo y el Joyero.
 * attach.ts (el núcleo del asistente: socket con la extensión, paquetes de la página) nunca importa nada de acá más que el módulo ya cargado;
 * lo que el usuario prende vive en `assist` (core/state.ts) y sobrevive a cada recarga. Al cambiar un archivo de `src/brain/` los loops de acá
 * terminan limpio y arrancan los nuevos, sin cortar el juego.
 */
import { ATTACK_PACE_MS, CHAT_PACE_MS, HEAL_AT_PCT, SKILL_PACE_MS, type StatName } from '../core/config';
import { sayChat, sendHit, sendPickup, sendTargetedSkill } from '../core/actions';
import { drops } from '../core/loot-state';
import { itemInfo } from '../core/panel-logic';
import { assist, bot, world, type ComboMode } from '../core/state';
import { chebyshev, directionTowards, humanPace, log, sleep } from '../core/util';
import { SKILL_TABLE, castReach, pickAttackSkill, useSkill } from './combat';
import { capStats, isJewel, planStats } from './farming';
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

// Con el giro (Twisting Slash, 41) conectado, el modo (`assist.mode`, elegido con el select del flotante) decide
// cuánto más tira: liviano = nada más (lo de siempre); intermedio = un extra solo (menos llamativo: área si hay 2+
// monstruos cerca, sino el de mejor daño/maná); agresivo = los tres, área primero (pegan a todo el grupo) y
// después los de un solo objetivo para rematar. Rageful Blow ("la estrella") es de área igual que el giro;
// Death Stab (70 dmg/15 maná) y Fire Breath (30/9) son de un solo objetivo.
const RAGEFUL_BLOW = 42;
const DEATH_STAB = 43;
const FIRE_BASH = 49;
/** A partir de cuántos monstruos cerca del objetivo conviene un skill de área en vez de uno de un solo blanco. */
const GROUP_RADIUS = 3;
const GROUP_SIZE = 2;
function groupNear(x: number, y: number): number {
  let n = 0;
  for (const m of world.npcs.values()) if (chebyshev(x, y, m.x, m.y) <= GROUP_RADIUS) n++;
  return n;
}
/** No se loguea cada golpe (serían varios por segundo): un resumen del combo cada tanto, para verlo sin mirar la pantalla. */
const COMBO_LOG_GAP_MS = 4000;
let lastComboLogAt = 0;
/** Último combo tirado (se muestra en el recuadro flotante de la extensión: ver attach.ts `status()`). */
let lastCombo = '';
export const comboLabel = () => lastCombo;

/** Tira un skill de la lista si se lo conoce y el maná restante lo alcanza; devuelve lo gastado (0 si no tiró). */
function tryExtra(targetId: number, num: number, manaLeft: number, fired: string[]): number {
  const extra = world.skills.get(num);
  const cost = SKILL_TABLE.get(num)?.mana ?? 0;
  if (!extra || manaLeft < cost) return 0;
  useSkill(targetId, extra);
  fired.push(SKILL_TABLE.get(num)?.name ?? `skill ${num}`);
  return cost;
}

/** Un golpe o skill por ritmo humano al monstruo más cercano que esté al alcance (~1 casilla). No camina. */
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
        // Combo del usuario: el segundo poder del DK (capturado del click real del usuario en la página: TargetedSkill
        // con índice 146, no está en la lista de skills que manda el server, así que no se puede armar con useSkill).
        // El índice 146 es de esta sesión de login y puede cambiar en la próxima reconexión. El costo real de maná
        // no se sabe (no está en la tabla): se adivina igual al del giro, para no pasarse del presupuesto del resto.
        let manaLeft = world.mana;
        const fired: string[] = ['giro'];
        if (bestD <= 1 && manaLeft > 0) { sendTargetedSkill(146, best.id); manaLeft -= SKILL_TABLE.get(41)?.mana ?? 0; fired.push('golpe 146'); }
        const mode: ComboMode = assist.mode;
        if (mode === 'intermedio') {
          const num = groupNear(best.x, best.y) >= GROUP_SIZE ? RAGEFUL_BLOW : DEATH_STAB;
          manaLeft -= tryExtra(best.id, num, manaLeft, fired);
        } else if (mode === 'agresivo') {
          for (const num of [RAGEFUL_BLOW, DEATH_STAB, FIRE_BASH]) manaLeft -= tryExtra(best.id, num, manaLeft, fired);
        }
        lastCombo = fired.join(' + ');
        if (Date.now() - lastComboLogAt >= COMBO_LOG_GAP_MS) {
          lastComboLogAt = Date.now();
          log(`Combo (${mode}): ${lastCombo} (maná ${world.mana}/${world.maxMana}).`);
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

// --- Reparto de stats (botón "Repartir puntos" del flotante) --------------------------------------------------------------------------------
// Misma fórmula que el bot completo usaría para Twisting Slash (farming.ts planStats): energía hasta que
// fuerza − 2000 − energía llegue a 0 (ahí el giro rinde igual por punto en los dos), después mitad y mitad.
// Pedido del usuario (2026-10-29): sin vitalidad por ahora ("no es necesario"), así que VIT_SHARE en 0 acá
// (farming.ts la deja en 5 % para el reparto automático del bot completo, que sí la usa).
const STAT_CMD: Record<StatName, string> = { str: 'str', agi: 'agi', vit: 'vit', ene: 'ene' };
let investing = false;
/** Reparte TODOS los puntos libres con /add (un comando por stat, como hace el usuario a mano). No se dispara
 * solo: lo llama attach.ts cuando el usuario aprieta "Repartir puntos" en el flotante. */
export async function investStatsNow(): Promise<void> {
  if (investing) return;
  investing = true;
  try {
    const points = world.levelUpPoints;
    if (points <= 0) { log('Stats: no hay puntos sin repartir.'); return; }
    const raw = planStats(points, world.stats.str, world.stats.ene, { VIT_SHARE: 0, ENE_GAP: 2000 });
    const capped = capStats(raw, world.stats);
    const plan = (['ene', 'str', 'vit', 'agi'] as StatName[]).map((k) => [k, capped[k]] as [StatName, number]).filter(([, n]) => n > 0);
    if (!plan.length) { log('Stats: nada para repartir (¿stats en el tope?).'); return; }
    log(`Stats: repartiendo ${points} puntos (${plan.map(([k, n]) => `${n} ${k}`).join(', ')}).`);
    for (const [name, n] of plan) {
      sayChat(bot.charName, `/add ${STAT_CMD[name]} ${n}`);
      world.stats[name] += n;
      world.levelUpPoints -= n;
      await sleep(CHAT_PACE_MS);
    }
  } finally {
    investing = false;
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
