/**
 * Combate: qué skill de ataque usar (tabla del cliente, área o directo, alcance de cast), tirarlo
 * contra un objetivo, y sobrevivir con pociones. Lo que decide A QUIÉN pegarle está en farm-loop.ts.
 */
import { ConsumeItemRequest075Packet } from './packets';
import { ATTACK_SKILL_POOL, HEAL_AT_PCT } from './config';
import { sendToGS } from './connection';
import { sendAreaSkill, sendTargetedSkill } from './actions';
import { world, type ItemSlot, type SkillInfo } from './state';
import { directionTowards, log } from './util';
import { onGameData, skills as skillsData } from './gamedata';

// --- Pociones ---------------------------------------------------------------
// Las pociones del set clásico están en el Group 14 (curación 1-3, mana 4-6,
// SD 35-37) y el Group 13 (Potion of Illusion). Salen de la tabla `items` de la base.
// Para un bot que solo necesita sobrevivir, la Small Healing Potion (14/1) es
// la mejor: se compra barata, se stacks (X=1 Y=1) y alcanza para todo el farm.
const POTION_GROUP = 14;
const HEAL_POTION_NUMS = new Set([1, 2, 3]); // small / normal / large healing

let lastPotionAt = 0;
const POTION_COOLDOWN_MS = 1500;

// Busca la mejor poción de curación que tengamos en el inventario (primero las
// grandes: menos packets = menos tráfico) y la consume. Las pociones son
// stackeables (X=1 Y=1), así que el slot NO se saca del inventario al beber:
// el server manda ItemAddedToInventory/CharacterInventory cuando cambia.
function useHealingPotion(): boolean {
  if (Date.now() - lastPotionAt < POTION_COOLDOWN_MS) return false;
  let best: ItemSlot | undefined;
  for (const it of world.inventory.values()) {
    if (it.group !== POTION_GROUP || !HEAL_POTION_NUMS.has(it.num)) continue;
    if (!best || it.num > best.num) best = it;
  }
  if (!best) return false;
  const p = ConsumeItemRequest075Packet.createPacket();
  p.ItemSlot = best.slot;
  p.TargetSlot = 0xff; // sin item objetivo (pociones)
  sendToGS(p.buffer);
  lastPotionAt = Date.now();
  log(`Pocion consumida: slot=${best.slot} item=${best.group}/${best.num} (HP ${world.hp}/${world.maxHp})`);
  return true;
}

// Devuelve true SOLO si tomó una poción. Si está bajo pero no tiene, devuelve
// false para que el loop siga con el resto de la prioridades en vez de
// quedarse girando en un busy-loop.
let noPotionWarned = false;
export function checkSurvival(): boolean {
  if (world.maxHp <= 0) return false;
  const pct = (world.hp / world.maxHp) * 100;
  if (pct > HEAL_AT_PCT) return false;
  if (useHealingPotion()) {
    noPotionWarned = false;
    return true;
  }
  if (!noPotionWarned) {
    log(`HP ${world.hp}/${world.maxHp} (${pct.toFixed(0)}%) bajo y NO hay pocion de curacion en el inventario.`);
    noPotionWarned = true;
  }
  return false;
}

// --- Skills -----------------------------------------------------------------
// TargetedSkill095 manda el NÚMERO de skill (no el índice de lista), confirmado
// contra TargetedSkillHandlerPlugIn de OpenMU, que resuelve SkillId contra
// player.Skills. Se usan solo las que el server nos mandó Y tenemos mana.
// Skills de área (AreaSkill 0x1E). El resto se manda como TargetedSkill.
// 41 (Twisting Slash) verificado en una captura del cliente real; 42 (Rageful
// Blow) es área en OpenMU, sin verificar todavía.
// Tabla de skills del cliente web (tabla `skills` de la base, sacada del bundle de mu.mormon.garden): tipo
// (DirectHit / AreaSkillAutomaticHits / AreaSkillExplicitTarget / Buff / Other) y distancia de cast.
// Sin esto Evil Spirit (9) e Inferno (14) iban como TargetedSkill y el server no hacía nada: Melu sin
// navegador caminaba entre monstruos sin ganar exp (2026-10-11).
type SkillRow = { num: number; name: string; type: string; distance: number; damage: number; mana: number; level?: number; ag?: number };
export const SKILL_TABLE = new Map<number, SkillRow>();
export const AREA_SKILLS = new Set<number>([41, 42]);
// Se arman con la tabla de skills del cliente (base, gamedata.ts) cuando llega y si se recarga.
onGameData('combat', () => {
  SKILL_TABLE.clear();
  AREA_SKILLS.clear();
  for (const r of skillsData) SKILL_TABLE.set(r.num, r);
  for (const n of [41, 42]) AREA_SKILLS.add(n);
  for (const r of skillsData) if (r.type.startsWith('AreaSkill')) AREA_SKILLS.add(r.num);
});
// Mago (DW/SM): Evil Spirit primero (pedido del usuario), después Decay, Inferno, Hellfire...
const MAGE_ATTACK_SKILLS = [9, 38, 14, 10, 12, 13, 5, 17, 11, 7, 4, 3, 2, 1];
export const isMage = () => world.skills.has(9) || world.skills.has(14) || world.skills.has(38);
// Distancia desde la que se tira cada skill. Los de área de mago se tiran sin acercarse al cuerpo a
// cuerpo (el browser mide ~5 tiles útiles para Evil Spirit); los de DK, pegado.
export function castReach(num: number): number {
  const r = SKILL_TABLE.get(num);
  if (!r) return 1;
  if (num === 9) return 5;
  if ([41, 42, 43, 19].includes(num)) return 1;
  return Math.max(1, Math.min(r.distance, 5));
}
// Con menos maná que esto no se tira el skill "en el camino" (agente web skillMinMp).
export const SKILL_MIN_MANA = 0.15;

// Mago: Decay (38, el más poderoso) cuando hay que ganar el spot o se coopera: un rival a <= 8 o un
// compañero a <= 15. Farmeando solo, Evil Spirit (limpia más rápido sin competencia). Usuario: "usa
// evil cuando está solo farmeando, pero si están cooperando en los spots o debe ganarle a alguien, lo
// más poderoso".
// También en un spot cerrado (usuario: "si el spot es muy cerrado conviene Decay"): si un tiro de Decay
// (radio ~3,5 alrededor del objetivo) agarra al menos el 80 % de lo que agarra Evil Spirit (radio ~5
// alrededor mío), Decay rinde más (95 de daño contra 45).
export function mageNeedsPower(monsters: Iterable<{ x: number; y: number }> = world.npcs.values()): boolean {
  for (const q of world.players.values()) {
    const d = Math.hypot(q.x - world.x, q.y - world.y);
    if (d <= 8) return true;
  }
  return spotIsTight([...monsters], { x: world.x, y: world.y });
}

/** ¿Los monstruos a tiro están tan juntos que un Decay agarra casi lo mismo que un Evil Spirit? */
export function spotIsTight(monsters: readonly { x: number; y: number }[], me: { x: number; y: number }, evilR = 5, decayR = 3.5, decayReach = 6): boolean {
  const evil = monsters.filter((m) => Math.hypot(m.x - me.x, m.y - me.y) <= evilR).length;
  if (evil < 3) return false;
  let decay = 0;
  for (const t of monsters) {
    if (Math.hypot(t.x - me.x, t.y - me.y) > decayReach) continue;
    decay = Math.max(decay, monsters.filter((m) => Math.hypot(m.x - t.x, m.y - t.y) <= decayR).length);
  }
  return decay >= 0.8 * evil;
}

/** `prefer`: skill a usar si se lo conoce. Por defecto, para el mago: Decay con competencia o compañero. */
export function pickAttackSkill(prefer: number | undefined = isMage() && mageNeedsPower() ? 38 : undefined): SkillInfo | undefined {
  if (world.mana <= 0) return undefined;
  // Solo se elige un skill que el maná alcance: si el preferido (o el primero de la lista) no alcanza, baja al siguiente y, sin ninguno, pega a mano.
  const affordable = (num: number) => world.mana >= (SKILL_TABLE.get(num)?.mana ?? 0);
  const preferred = prefer != null ? world.skills.get(prefer) : undefined;
  if (preferred && affordable(preferred.number)) return preferred;
  // El nivel viene en 0 para skills normales, así que no se filtra por nivel.
  for (const num of isMage() ? MAGE_ATTACK_SKILLS : ATTACK_SKILL_POOL) {
    const known = world.skills.get(num);
    if (known && affordable(num)) return known;
  }
  return undefined;
}

/** ¿Le da el nivel para el skill? (los del Blade Knight piden 160/170). */
export const skillLevelOk = (num: number, level = world.level) => level >= (SKILL_TABLE.get(num)?.level ?? 0);

export function useSkill(targetId: number, skill = pickAttackSkill()): boolean {
  const t = world.npcs.get(targetId);
  if (skill == null || !t) return false;
  if (AREA_SKILLS.has(skill.number)) {
    sendAreaSkill(skill.index, t.x, t.y, directionTowards(world.x, world.y, t.x, t.y), targetId);
  } else {
    sendTargetedSkill(skill.index, targetId);
  }
  return true;
}
