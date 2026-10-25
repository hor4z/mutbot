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

-- Versión del bot y política activa (perillas/experimento), para la línea base desde el día 1.
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS version LowCardinality(String);
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS policy LowCardinality(String);
ALTER TABLE events ADD COLUMN IF NOT EXISTS version LowCardinality(String);
ALTER TABLE events ADD COLUMN IF NOT EXISTS policy LowCardinality(String);
-- Pelea por el spot: kills en scope en los últimos 5 s (nuestras, del compañero, de rivales) y el rival
-- que más mató; dónde está el compañero (0 = no se ve, 1 = mismo spot a <= 8, 2 = a la vista, otro spot).
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS kills_me UInt16;
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS kills_mate UInt16;
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS kills_rival UInt16;
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS top_rival String;
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS mate_spot UInt8;

-- Servidor del juego (fast / slow): las cuentas valen en los dos, los datos no se mezclan. Lo anterior es todo Fast.
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS server LowCardinality(String) DEFAULT 'fast';
ALTER TABLE events ADD COLUMN IF NOT EXISTS server LowCardinality(String) DEFAULT 'fast';
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS server LowCardinality(String) DEFAULT 'fast';

-- Ranking del server cada hora (lo guarda la estación): ritmo de resets de los rivales.
CREATE TABLE IF NOT EXISTS ranking (
  ts DateTime64(3),
  name String,
  class UInt8,
  resets UInt32,
  grand_resets UInt16,
  level UInt16,
  pos UInt16
) ENGINE = MergeTree ORDER BY (name, ts) TTL toDateTime(ts) + INTERVAL 365 DAY;
ALTER TABLE ranking ADD COLUMN IF NOT EXISTS server LowCardinality(String) DEFAULT 'fast';
