/**
 * Progreso del personaje: repartir los puntos de atributo con /add (el Slow no resetea).
 */
import { CHAR_NAME, CHAT_PACE_MS, type StatName } from './config';
import { D } from './directivas';
import { sayChat } from './actions';
import { capStats } from './farming';
import { decide } from './journal';
import { statPlan } from './area';
import { bot, world } from './state';
import { log, sleep } from './util';

// --- Estadísticas -----------------------------------------------------------
// Sube puntos de atributo siguiendo el orden de --build. El server responde con
// CharacterLevelUpdate (que actualiza levelUpPoints), así que no contamos a ciegas.
// Reparte TODOS los puntos libres con /add <stat> <n> (un comando por stat),
// proporcional a BUILD_WEIGHTS. Es como lo hace el usuario: confirmado que el
// server acepta str/ene/vit así (ver AGENTS.md).
const STAT_CMD: Record<StatName, string> = { str: 'str', agi: 'agi', vit: 'vit', ene: 'ene' };
// Si el server no los toma (stat en el tope: Melu con fuerza y energía en 65535), los puntos vuelven a
// aparecer en el próximo CharacterLevelUpdate y el bot repetía los /add cada pocos segundos sin pelear
// (2026-10-11: +13 niveles en 15 min). Si después de un reparto los puntos no bajaron, 15 min sin repartir.
let statTry: { points: number; at: number; level: number } | null = null;
let statOffUntil = 0;
/**
 * El seguimiento del último reparto (para detectar que el server no lo tomó: stats en el tope) arranca
 * de cero en cada conexión. Si sobrevivía, comparaba contra el reparto viejo,
 * concluía "el server no tomó el reparto" y no repartía por 15 min (Melu, 21.000 puntos sin repartir).
 */
export function resetStatTracking() {
  statTry = null;
  statOffUntil = 0;
}

export async function investStatPoints(force = false): Promise<number> {
  const points = world.levelUpPoints;
  if (points <= 0 || (!force && points < D.statBatch)) return 0;
  if (!force && Date.now() < statOffUntil) return 0;
  // Si subió de nivel desde el reparto, los puntos que hay son nuevos (no es que el server no lo tomó):
  // a un personaje nuevo que sube varios niveles por minuto lo frenaba 15 min sin repartir.
  if (statTry && world.level !== statTry.level) statTry = null;
  if (statTry && Date.now() - statTry.at > 3000 && points >= statTry.points) {
    statTry = null; statOffUntil = Date.now() + 15 * 60_000;
    log(`Stats: el server no tomó el reparto (siguen ${points} puntos libres; ¿stats en el tope?): no reparto por 15 min.`);
    return 0;
  }
  // Tope de 65535 por stat (capStats): lo que no entra va a agilidad y vitalidad. Todo en el tope: no se reparte.
  const raw = statPlan(points, world.stats);
  const capped = capStats(raw, world.stats);
  const plan = (['str', 'agi', 'vit', 'ene'] as StatName[]).map((k) => [k, capped[k]] as [StatName, number]).filter(([, n]) => n > 0);
  if (!plan.length) return 0;
  const NAMES: Record<StatName, string> = { str: 'fuerza', agi: 'agilidad', vit: 'vitalidad', ene: 'energía' };
  const parts = plan.map(([name, n]) => `${n} en ${NAMES[name]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : parts[0]!;
  decide(`Repartí ${points} puntos: ${list}.${world.stats.agi < D.agiTarget ? ` Primero agilidad, hasta ${D.agiTarget}.` : ''}`, { points, plan: Object.fromEntries(plan), kind: 'stat' as const });
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
  if (statsRunning) return false;
  statsRunning = true;
  void investStatPoints()
    .then((n) => { if (n) onSpent(n); })
    .catch((e) => log(`Stats: el reparto falló: ${(e as Error).message}`))
    .finally(() => { statsRunning = false; });
  return true;
}

