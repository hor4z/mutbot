-- Datos del bot Slow (ClickHouse). Se aplica con `bun run db:init` (idempotente).
-- Un solo servidor y un solo personaje: no hay columna de servidor. Lo del Fast quedó archivado (~/.mubot/archivo-fast, rama archive/fast).
-- Cada fila trae el personaje y la sesión (un proceso del bot = una sesión).

-- Foto del personaje cada 5 s. `spot` = el lugar donde farmea (spots.ts), no el warp.
CREATE TABLE IF NOT EXISTS ticks (
  ts DateTime64(3),
  char LowCardinality(String),
  session String,
  version LowCardinality(String),
  map UInt16, x UInt8, y UInt8,
  level UInt16,
  exp_total UInt64, exp_min_1m Float64,
  hp UInt32, mp UInt32,
  mode LowCardinality(String), phase LowCardinality(String),
  spot LowCardinality(String),
  monsters_near UInt16,
  doing String
) ENGINE = MergeTree ORDER BY (char, ts) TTL toDateTime(ts) + INTERVAL 180 DAY;

-- Lo que pasa una vez: decide (con su motivo), death, kill, flee, travel, walk_stuck, pickup, server_msg, party…
CREATE TABLE IF NOT EXISTS events (
  ts DateTime64(3),
  char LowCardinality(String),
  session String,
  version LowCardinality(String),
  kind LowCardinality(String),
  spot LowCardinality(String),
  map UInt16, x UInt8, y UInt8,
  level UInt16,
  num1 Float64, num2 Float64,
  text String,
  data String
) ENGINE = MergeTree ORDER BY (char, kind, ts) TTL toDateTime(ts) + INTERVAL 730 DAY;

-- Jugadores a la vista (quién más farmea en nuestros spots).
CREATE TABLE IF NOT EXISTS players_seen (
  ts DateTime64(3),
  char LowCardinality(String),
  map UInt16, x UInt8, y UInt8,
  name String
) ENGINE = MergeTree ORDER BY (map, ts) TTL toDateTime(ts) + INTERVAL 60 DAY;

-- Skill de ataque que usaba (número del juego; 0 = pegaba a mano): para comparar rendimientos entre skills (v_skill_rate).
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS skill UInt16;
