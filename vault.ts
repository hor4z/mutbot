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
import { decide } from './journal';
import { itemInfo } from './panel-logic';
import { decodeItemDetail, parseInventory, type ItemDetail } from './protocol097';
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

/** Lee equipo, bolsa y baúl. Devuelve el resumen (o el motivo por el que no pudo). */
export async function readVault(): Promise<{ ok: boolean; msg: string }> {
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
  sendToGS(rawPacket([0xc3, 0x05, 0x30, baz.id >> 8, baz.id]));
  const raw = await list;
  await sleep(humanPace(1500));
  sendToGS(rawPacket([0xc1, 0x03, 0x31]));
  if (!raw) return { ok: false, msg: 'Baz no contestó con la lista del baúl' };
  const bytes = toBytes(raw);
  const stored = parseInventory(bytes);
  if (!stored) return { ok: false, msg: `lista del baúl con largo inesperado (${bytes.length} bytes)` };

  const vault = stored.filter((it) => it.raw).map((it) => entry(it.slot, it.raw!));
  const carried = [...world.inventory.values()].filter((it) => it.raw).map((it) => entry(it.slot, it.raw!));
  const equipped = carried.filter((it) => it.slot < 12);
  const bag = carried.filter((it) => it.slot >= 12);
  const out = { char: bot.charName, at: new Date().toISOString(), equipped, bag, vault };
  const path = join(homedir(), '.mubot', `vault-${bot.charName}.json`);
  await Bun.write(path, JSON.stringify(out, null, 1));
  log(`Equipo:\n${equipped.map((it) => `  [${it.slot}] ${describeItem(it)}`).join('\n') || '  (nada)'}`);
  log(`Baúl (${vault.length}):\n${vault.map((it) => `  [${it.slot}] ${describeItem(it)}`).join('\n') || '  (vacío)'}`);
  const msg = `baúl leído: ${vault.length} ítem(s), ${equipped.length} puestos, ${bag.length} en la bolsa → ${path}`;
  decide(`Baúl: ${msg}.`);
  return { ok: true, msg };
}
