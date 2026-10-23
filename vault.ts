/**
 * Baúl (pedido del usuario, 2026-10-23: armar el set con lo que hay en el baúl de la cuenta). Va a
 * Lorencia, busca a Baz (Storage Guard, NPC 240) entre los NPC de pueblo, le habla como a un mercader
 * (`C3 05 30 <id BE>`), lee la lista (StoreItemList C2 31, mismo formato que el inventario) y cierra
 * (`C1 03 31`, CloseNpcRequest). Solo lee: no mueve nada. Escribe el equipo, la bolsa y el baúl con
 * todas sus opciones en ~/.mubot/vault-<personaje>.json y un resumen al log.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rawPacket, step } from './actions';
import { WALK_PACE_MS } from './config';
import { sendToGS, waitFor } from './connection';
import { decide, panelLog } from './journal';
import { itemInfo } from './panel-logic';
import { buildCloseNpc, buildMoveItem, buildTalkNpc, decodeItemDetail, parseInventory, STORAGE, type ItemDetail } from './protocol097';
import { classKeyOf, type Fighter } from './item-rules';
import { classFamily } from './farming';
import { describeStep, planEquip, summarizePlan, type EquipPlan, type PlanItem } from './equip-plan';
import { move as moveInBag } from './equip';
import type { ItemSlot } from './state';
import { WARP_SPOTS, warpAndWait } from './route';
import { bot, world } from './state';
import { chebyshev, directionTowards, humanPace, log, sleep, toBytes } from './util';

export const VAULT_NPC = 240;
// Recorrido por el pueblo de Lorencia hasta ver a Baz (se ve a ~15 tiles).
const LORENCIA_WAYPOINTS: readonly [number, number][] = [[130, 125], [145, 112], [125, 108], [118, 132], [146, 134]];

export type VaultEntry = ItemDetail & { slot: number; name: string };
const entry = (slot: number, raw: Uint8Array): VaultEntry => {
  const d = decodeItemDetail(raw);
  return { slot, name: itemInfo(d.group, d.num).name, ...d };
};

/** Una línea legible: "Dragon Helm +9 luck +4 exc×3 anc armonía 2/5". */
export function describeItem(it: VaultEntry): string {
  return [
    `${it.name} +${it.level}`,
    it.skill ? 'skill' : '',
    it.luck ? 'luck' : '',
    it.option ? `+${it.option * 4}` : '',
    it.excCount ? `exc×${it.excCount}` : '',
    it.ancient ? 'ancient' : '',
    it.opt380 ? '380' : '',
    it.harmony ? `armonía ${it.harmony.option}/${it.harmony.level}` : '',
  ].filter(Boolean).join(' ');
}

async function walkTo(x: number, y: number, maxSteps = 60): Promise<boolean> {
  for (let i = 0; i < maxSteps && chebyshev(world.x, world.y, x, y) > 2; i++) {
    step(directionTowards(world.x, world.y, x, y));
    await sleep(humanPace(WALK_PACE_MS));
    if (bot.kicked) return false;
  }
  return chebyshev(world.x, world.y, x, y) <= 2;
}

const findBaz = () => [...world.townNpcs.values()].find((n) => n.type === VAULT_NPC) ?? null;

export type VaultFile = { char: string; at: string; equipped: VaultEntry[]; bag: VaultEntry[]; vault: VaultEntry[] };
/** Última lectura viva del baúl (con los bytes crudos del ítem, que el packet de mover lleva). */
let lastLive: { at: number; vault: (VaultEntry & { raw: Uint8Array })[] } | null = null;
export const vaultPath = () => join(homedir(), '.mubot', `vault-${bot.charName}.json`);

/** Warp a Lorencia, camina hasta Baz, le habla y espera la lista del baúl. NO cierra la ventana. */
async function openBaz(): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; msg: string }> {
  if (world.map !== 0) {
    const lorencia = WARP_SPOTS.find((s) => s.index === 2)!;
    if (!(await warpAndWait(lorencia))) return { ok: false, msg: 'no pude ir a Lorencia' };
    await sleep(1500);
  }
  let baz = findBaz();
  for (const [x, y] of LORENCIA_WAYPOINTS) {
    if (baz) break;
    bot.doing = `baúl: busco a Baz en Lorencia (${x},${y})`;
    await walkTo(x, y);
    await sleep(800);
    baz = findBaz();
  }
  if (!baz) return { ok: false, msg: 'no encontré a Baz (NPC 240) en Lorencia' };
  bot.doing = `baúl: voy a Baz (${baz.x},${baz.y})`;
  if (!(await walkTo(baz.x, baz.y))) return { ok: false, msg: `no llegué a Baz en (${baz.x},${baz.y})` };

  const list = waitFor('StoreItemList', 5000).catch(() => null);
  sendToGS(rawPacket([...buildTalkNpc(baz.id)]));
  const raw = await list;
  if (!raw) {
    sendToGS(rawPacket([...buildCloseNpc()]));
    return { ok: false, msg: 'Baz no contestó con la lista del baúl' };
  }
  return { ok: true, bytes: toBytes(raw) };
}
const closeBaz = () => sendToGS(rawPacket([...buildCloseNpc()]));
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Lee equipo, bolsa y baúl. Devuelve el resumen (o el motivo por el que no pudo). */
export async function readVault(): Promise<{ ok: boolean; msg: string }> {
  const o = await openBaz();
  if (!o.ok) return o;
  await sleep(humanPace(1500));
  closeBaz();
  const bytes = o.bytes;
  const stored = parseInventory(bytes);
  if (!stored) return { ok: false, msg: `lista del baúl con largo inesperado (${bytes.length} bytes)` };

  const vault = stored.filter((it) => it.raw).map((it) => entry(it.slot, it.raw!));
  lastLive = { at: Date.now(), vault: stored.filter((it) => it.raw).map((it) => ({ ...entry(it.slot, it.raw!), raw: it.raw! })) };
  const carried = [...world.inventory.values()].filter((it) => it.raw).map((it) => entry(it.slot, it.raw!));
  const equipped = carried.filter((it) => it.slot < 12);
  const bag = carried.filter((it) => it.slot >= 12);
  const withHex = (xs: VaultEntry[], raws: Map<number, Uint8Array>) => xs.map((x) => ({ ...x, rawHex: raws.has(x.slot) ? hex(raws.get(x.slot)!) : undefined }));
  const rawsOf = (xs: { slot: number; raw?: Uint8Array }[]) => new Map(xs.filter((x) => x.raw).map((x) => [x.slot, x.raw!] as const));
  const out = {
    char: bot.charName, at: new Date().toISOString(),
    equipped: withHex(equipped, rawsOf([...world.inventory.values()].filter((i) => i.slot < 12))),
    bag: withHex(bag, rawsOf([...world.inventory.values()].filter((i) => i.slot >= 12))),
    vault: withHex(vault, rawsOf(stored)),
  };
  const path = vaultPath();
  await Bun.write(path, JSON.stringify(out, null, 1));
  log(`Equipo:\n${equipped.map((it) => `  [${it.slot}] ${describeItem(it)}`).join('\n') || '  (nada)'}`);
  log(`Baúl (${vault.length}):\n${vault.map((it) => `  [${it.slot}] ${describeItem(it)}`).join('\n') || '  (vacío)'}`);
  const msg = `baúl leído: ${vault.length} ítem(s), ${equipped.length} puestos, ${bag.length} en la bolsa → ${path}`;
  decide(`Baúl: ${msg}.`);
  return { ok: true, msg };
}

// ---------------------------------------------------------------------------
// Equiparse con lo del baúl. `equipplan` solo calcula y muestra; `equip` lo ejecuta (solo si alguien manda
// la orden: nunca solo).
// ---------------------------------------------------------------------------
/** El personaje para las reglas de ítems (clase por classId; evolucionado = classId & 3 > 0, SIN verificar). */
export function currentFighter(): Fighter | null {
  const fam = classFamily(world.classId);
  if (!fam) return null;
  return { cls: classKeyOf(fam), evolved: ((world.classId ?? 0) & 3) > 0, level: world.level, stats: { ...world.stats } };
}

const toPlanItem = (e: VaultEntry & { raw?: Uint8Array }): PlanItem => ({ ...e });
const liveCarried = (): (VaultEntry & { raw: Uint8Array })[] =>
  [...world.inventory.values()].filter((it) => it.raw).map((it) => ({ ...entry(it.slot, it.raw!), raw: it.raw! }));

/** Plan con el baúl de la última lectura viva o, si no hay, el archivo vault-<pj>.json. */
export async function equipPlanNow(): Promise<{ ok: true; plan: EquipPlan; source: 'vivo' | 'archivo' } | { ok: false; msg: string }> {
  const fighter = currentFighter();
  if (!fighter) return { ok: false, msg: 'no sé la clase del personaje todavía (classId)' };
  let vault: PlanItem[];
  let source: 'vivo' | 'archivo';
  if (lastLive) {
    vault = lastLive.vault.map(toPlanItem);
    source = 'vivo';
  } else {
    try {
      const f = (await Bun.file(vaultPath()).json()) as VaultFile;
      vault = f.vault.map(toPlanItem);
      source = 'archivo';
    } catch {
      return { ok: false, msg: 'no tengo el baúl leído: mandá primero la orden vault' };
    }
  }
  const carried = liveCarried().map(toPlanItem);
  const plan = planEquip({ fighter, equipped: carried.filter((i) => i.slot < 12), bag: carried.filter((i) => i.slot >= 12), vault });
  return { ok: true, plan, source };
}

const STEP_GAP_MS = 900;

/**
 * Ejecuta el plan: va a Baz, relee el baúl (la foto puede estar vieja), arma el plan con los datos de
 * ahora, saca las piezas, cierra y las equipa de a una con pausa humana. Para en el primer fallo y lo
 * cuenta; no deshace nada (mover es reversible a mano). SIN verificar en vivo: sacar del baúl (de=2).
 */
export async function runEquip(): Promise<{ ok: boolean; msg: string }> {
  const fighter = currentFighter();
  if (!fighter) return { ok: false, msg: 'no sé la clase del personaje todavía (classId)' };
  const o = await openBaz();
  if (!o.ok) return o;
  const stored = parseInventory(o.bytes);
  if (!stored) { closeBaz(); return { ok: false, msg: `lista del baúl con largo inesperado (${o.bytes.length} bytes)` }; }
  const vaultRaw = new Map(stored.filter((i) => i.raw).map((i) => [i.slot, i.raw!] as const));
  const vault = stored.filter((i) => i.raw).map((i) => toPlanItem({ ...entry(i.slot, i.raw!), raw: i.raw! }));
  const carried = liveCarried().map(toPlanItem);
  const plan = planEquip({ fighter, equipped: carried.filter((i) => i.slot < 12), bag: carried.filter((i) => i.slot >= 12), vault });
  plan.steps.forEach((s, i) => panelLog(`Equipo: ${describeStep(s, i + 1)}`));
  if (!plan.steps.length) { closeBaz(); return { ok: true, msg: `nada que hacer: ${summarizePlan(plan)}` }; }

  let done = 0;
  const fail = (why: string) => ({ ok: false, msg: `paro en el paso ${done + 1}/${plan.steps.length}: ${why}` });
  // 1) sacar del baúl (ventana abierta)
  for (const s of plan.steps) {
    if (s.kind !== 'take') continue;
    const raw = vaultRaw.get(s.fromVault);
    if (!raw) { closeBaz(); return fail(`el ítem de la casilla ${s.fromVault} ya no está en el baúl`); }
    const reply = waitFor('ItemMoved', 3000).catch(() => null);
    sendToGS(rawPacket([...buildMoveItem(STORAGE.vault, s.fromVault, raw, STORAGE.inventory, s.toBag)]));
    const r = await reply;
    const b = r ? toBytes(r) : null;
    if (!b || b[3] === 0xff) { closeBaz(); return fail(`el server no dejó sacar ${s.item.name} del baúl`); }
    const d = decodeItemDetail(raw);
    world.inventory.set(s.toBag, { slot: s.toBag, group: d.group, num: d.num, level: d.level, excellent: d.excellent, raw });
    done++;
    await sleep(humanPace(STEP_GAP_MS));
  }
  closeBaz();
  await sleep(humanPace(1500));
  // 2) vestirse
  for (const s of plan.steps) {
    if (s.kind === 'take') continue;
    const from = s.kind === 'unequip' ? s.fromSlot : s.fromBag;
    const to = s.kind === 'unequip' ? s.toBag : s.toSlot;
    const it = world.inventory.get(from) as ItemSlot | undefined;
    if (!it) return fail(`no encuentro ${s.item.name} en la casilla ${from}`);
    if (!(await moveInBag(it, to))) return fail(`el server rechazó mover ${s.item.name} a ${to} (requisitos, clase o lugar)`);
    done++;
    await sleep(humanPace(STEP_GAP_MS));
  }
  const msg = `equipo listo: ${summarizePlan(plan)}`;
  decide(`Baúl: ${msg}.`);
  return { ok: true, msg };
}
