/**
 * Los datos del juego (monstruos, skills, ítems) van dentro de la extensión, tomados de los mismos seeds que carga la base (packages/db/seeds),
 * con el mismo mapeo de columnas que db/src/cli.ts. Así la página no necesita ninguna base. Los spawns no se usan en el asistente.
 */
import { applyGameData } from '../../bot/src/core/gamedata';
import monstersJson from '../../db/seeds/monsters.json';
import skillsJson from '../../db/seeds/skills.json';
import itemsJson from '../../db/seeds/items.json';

export function loadEmbeddedGameData() {
  const items = (itemsJson as Record<string, any>[]).map((i) => ({
    grp: i.Group, idx: i.Index, name: i.ItemName, w: i.X || 1, h: i.Y || 1,
    equip_slot: i.ItemSlot ?? -1,
    req_level: i.ReqLvl ?? i.RequiredLvl ?? 0,
    cls: (i['DK/BK'] > 0 ? 1 : 0) | (i['DW/SM'] > 0 ? 2 : 0) | (i['Elf/ME'] > 0 ? 4 : 0) | (i.MG > 0 ? 8 : 0),
    def: Math.max(i.Def || 0, i.DefRate || 0), dmg: i.DmgMax || 0, mag: i.MagicPwr || 0,
  }));
  applyGameData(monstersJson as Record<string, unknown>[], skillsJson as Record<string, unknown>[], items, []);
}
