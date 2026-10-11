-- Datos del bot (ClickHouse). Se aplica con `bun run db:init` (idempotente).
-- Cada fila trae el personaje y la sesión (un proceso del bot = una sesión).

-- Foto de cada personaje cada 5 s.
CREATE TABLE IF NOT EXISTS ticks (
  ts DateTime64(3),
  char LowCardinality(String),
  session String,
  map UInt16, x UInt8, y UInt8,
  level UInt16, resets UInt32,
  exp_total UInt64, exp_min_1m Float64,
  hp UInt32, mp UInt32,
  mode LowCardinality(String), phase LowCardinality(String),
  side LowCardinality(String),
  rivals_near UInt8, mates_near UInt8, monsters_near UInt16,
  in_party UInt8, skill UInt16,
  doing String
) ENGINE = MergeTree ORDER BY (char, ts) TTL toDateTime(ts) + INTERVAL 90 DAY;

-- Lo que pasa una vez: decide, journal, death, kill, cast, golden_seen, party, warp, reset, cycle.
CREATE TABLE IF NOT EXISTS events (
  ts DateTime64(3),
  char LowCardinality(String),
  session String,
  kind LowCardinality(String),
  map UInt16, x UInt8, y UInt8,
  level UInt16, resets UInt32,
  num1 Float64, num2 Float64,
  text String,
  data String
) ENGINE = MergeTree ORDER BY (char, kind, ts) TTL toDateTime(ts) + INTERVAL 365 DAY;

-- Jugadores a la vista cada 10 s (rivales y compañeros).
CREATE TABLE IF NOT EXISTS players_seen (
  ts DateTime64(3),
  char LowCardinality(String),
  map UInt16, x UInt8, y UInt8,
  name String, mate UInt8
) ENGINE = MergeTree ORDER BY (map, ts) TTL toDateTime(ts) + INTERVAL 60 DAY;

-- Para tablas ya creadas con otro TTL.
ALTER TABLE ticks MODIFY TTL toDateTime(ts) + INTERVAL 90 DAY;
ALTER TABLE players_seen MODIFY TTL toDateTime(ts) + INTERVAL 60 DAY;
ALTER TABLE events MODIFY TTL toDateTime(ts) + INTERVAL 365 DAY;
