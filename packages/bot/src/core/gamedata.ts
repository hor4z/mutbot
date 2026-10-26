/**
 * Datos del juego (monstruos, skills, ítems, spawns): salen de la base (tablas sembradas con `bun run db:seed`, ver db/seeds/), no de archivos.
 * `loadGameData()` los lee una vez al arrancar (con reintentos: sin ellos el bot no sabe qué es un monstruo) y llena estos arreglos en el lugar,
 * así las referencias que ya tomó cada módulo siguen valiendo. Los módulos que arman tablas derivadas (nombres, vida máxima, skills por número…)
 * se suscriben con `onGameData` y las reconstruyen cuando llegan los datos. Núcleo: el cerebro recargable lo importa como externo.
 */
import { dbOn, dbRows } from '@mubot/db';
import { log, sleep } from './util';

export type MonsterRow = {
  Numb: number; Rate: number; Name: string; Level: number; HP: number; MP: number; MinDmg: number; MaxDmg: number; Def: number; MagDef: number;
  AttackSuccess: number; Move: number; AttType: number; Range: number; View: number; MoveSpeed: number; AttSpeed: number; Regen: number;
  Attri: number; ItemR: number; MoneyR: number; MaxI: number; ResWind: number; ResPois: number; ResIce: number; ResWater: number; ResFire: number;
};
export type SkillRow = { num: number; name: string; classes: string; damageType: string; damage: number; distance: number; ag: number; mana: number; level: number; energy: number; type: string; target: string; range: number };
/** Un ítem del cliente. `equipSlot`: dónde se usa (0 mano derecha, 1 izquierda, 2 casco, 3 armadura, 4 pantalón, 5 guantes, 6 botas, 7 alas, 8 mascota, 9 colgante, 10 y 11 anillos; -1 no es equipo). `cls`: clases que lo usan (1 caballero, 2 mago, 4 elfo, 8 gladiador). */
export type ItemRow = { grp: number; idx: number; name: string; w: number; h: number; equipSlot: number; reqLevel: number; cls: number; def: number; dmg: number; mag: number };
export type Spawn = { type: number; rect: [number, number, number, number]; qty: number };

const itemIndex = new Map<number, ItemRow>();
/** El ítem del cliente por grupo y número (undefined: no está en la tabla). */
export const itemRow = (group: number, num: number): ItemRow | undefined => itemIndex.get(group * 512 + num);

export const monsters: MonsterRow[] = [];
export const skills: SkillRow[] = [];
export const items: ItemRow[] = [];
/** Spawns por mapa (clave: número de mapa como texto). */
export const spawns: Record<string, Spawn[]> = {};

let loaded = false;
const subscribers = new Map<string, () => void>();

/** Avisa cuando los datos están (o ya están): `key` evita duplicar la suscripción si el módulo se recarga en caliente. */
export function onGameData(key: string, fn: () => void) {
  subscribers.set(key, fn);
  if (loaded) fn();
}

const num = (v: unknown) => Number(v);

/** Faltan datos en la base (no se corrió `bun run db:seed`): no se arregla reintentando. */
export class MissingGameDataError extends Error {}

/** Lee las cuatro tablas y avisa a los suscriptores. Tira si la base no responde o las tablas están vacías (falta `bun run db:seed`). */
export async function loadGameDataOnce(): Promise<void> {
  const [m, s, i, sp] = await Promise.all([
    dbRows<Record<string, unknown>>('SELECT * FROM monsters ORDER BY Numb'),
    dbRows<Record<string, unknown>>('SELECT * FROM skills ORDER BY num'),
    dbRows<Record<string, unknown>>('SELECT grp, idx, name, w, h, equip_slot, req_level, cls, def, dmg, mag FROM items'),
    dbRows<{ map: number; type: number; x1: number; y1: number; x2: number; y2: number; qty: number }>('SELECT map, type, x1, y1, x2, y2, qty FROM spawns'),
  ], );
  const vacias = [['monsters', m], ['skills', s], ['items', i], ['spawns', sp]].filter(([, rows]) => !(rows as unknown[]).length).map(([n]) => n);
  if (vacias.length) throw new MissingGameDataError(`las tablas ${vacias.join(', ')} están vacías: falta correr \`bun run db:seed\``);
  monsters.length = 0;
  for (const r of m) monsters.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'Name' ? String(v) : num(v)])) as unknown as MonsterRow);
  skills.length = 0;
  for (const r of s) skills.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ['name', 'classes', 'damageType', 'type', 'target'].includes(k) ? String(v) : num(v)])) as unknown as SkillRow);
  items.length = 0;
  for (const r of i) items.push({ grp: num(r.grp), idx: num(r.idx), name: String(r.name), w: num(r.w), h: num(r.h), equipSlot: num(r.equip_slot), reqLevel: num(r.req_level), cls: num(r.cls), def: num(r.def), dmg: num(r.dmg), mag: num(r.mag) });
  itemIndex.clear();
  for (const r of items) itemIndex.set(r.grp * 512 + r.idx, r);
  for (const k of Object.keys(spawns)) delete spawns[k];
  for (const r of sp) (spawns[String(num(r.map))] ??= []).push({ type: num(r.type), rect: [num(r.x1), num(r.y1), num(r.x2), num(r.y2)], qty: num(r.qty) });
  loaded = true;
  for (const fn of subscribers.values()) fn();
}

/** Carga los datos esperando a la base todo lo que haga falta (cada 5 s); si la base responde pero faltan los seeds, falla enseguida. */
export async function loadGameData(): Promise<void> {
  if (!dbOn()) throw new Error('falta MUBOT_DB_URL (.env.db): los datos del juego salen de la base');
  for (let n = 1; ; n++) {
    try {
      await loadGameDataOnce();
      log(`Datos del juego cargados de la base: ${monsters.length} monstruos, ${skills.length} skills, ${items.length} ítems, ${Object.values(spawns).reduce((t, l) => t + l.length, 0)} spawns.`);
      return;
    } catch (e) {
      if (e instanceof MissingGameDataError) throw e;
      if (n === 1 || n % 12 === 0) log(`Datos del juego: no pude leerlos de la base (${(e as Error).message}); reintento cada 5 s.`);
      await sleep(5_000);
    }
  }
}
