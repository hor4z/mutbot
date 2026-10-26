-- Datos del juego (tablas del cliente web) que el bot lee al arrancar. Se cargan con `bun run db:seed` desde db/seeds/; no se editan a mano.

-- Monstruos: la tabla del cliente (con los custom del Slow, tipos >= 300).
CREATE TABLE IF NOT EXISTS monsters (
  Numb Int64, Rate Int64, Name String, Level Int64, HP Int64, MP Int64, MinDmg Int64, MaxDmg Int64, Def Int64, MagDef Int64,
  AttackSuccess Int64, Move Int64, AttType Int64, Range Int64, View Int64, MoveSpeed Int64, AttSpeed Int64, Regen Int64, Attri Int64,
  ItemR Int64, MoneyR Int64, MaxI Int64, ResWind Int64, ResPois Int64, ResIce Int64, ResWater Int64, ResFire Int64
) ENGINE = MergeTree ORDER BY Numb;

-- Skills del cliente: tipo (DirectHit, AreaSkillAutomaticHits…), alcance, maná y nivel.
CREATE TABLE IF NOT EXISTS skills (
  num Int64, name String, classes String, damageType String, damage Int64, distance Int64, ag Int64, mana Int64, level Int64, energy Int64,
  type String, target String, range Int64
) ENGINE = MergeTree ORDER BY num;

-- Ítems del cliente: lo que el bot usa como columnas y la fila completa en `raw` (JSON).
CREATE TABLE IF NOT EXISTS items (
  grp Int64, idx Int64, name String, w Int64, h Int64, raw String
) ENGINE = MergeTree ORDER BY (grp, idx);

-- Dónde nacen los monstruos (rectángulo, cantidad), por mapa.
CREATE TABLE IF NOT EXISTS spawns (
  map Int64, type Int64, x1 Int64, y1 Int64, x2 Int64, y2 Int64, qty Int64, trigger Int64, wave Int64
) ENGINE = MergeTree ORDER BY (map, type);
