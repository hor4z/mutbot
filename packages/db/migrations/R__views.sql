-- Conocimiento del Slow: respuestas fijas sobre los datos (learning.ts las lee; también sirven para mirar a mano).
-- exp/min = promedio de exp_min_1m de los ticks farmeando (5 s cada uno: 12 ticks = 1 min medido).

-- Cuánto rinde cada zona (celda de 16×16 tiles, últimos 14 días): exp/min de los ticks farmeando. Es lo que decide dónde farmear.
CREATE OR REPLACE VIEW v_cell_rate AS
SELECT map, intDiv(x, 16) AS cx, intDiv(y, 16) AS cy, count() AS ticks, round(avg(exp_min_1m)) AS exp_min,
       round(quantileExact(0.5)(exp_min_1m)) AS exp_min_p50, uniq(session) AS sessions, max(ts) AS last
FROM ticks WHERE mode = 'farm' AND phase = 'fight' AND ts > now() - INTERVAL 14 DAY
GROUP BY map, cx, cy;

-- Muertes por zona (últimos 14 días) y quién mata.
CREATE OR REPLACE VIEW v_deaths AS
SELECT map, intDiv(x, 16) AS cx, intDiv(y, 16) AS cy, count() AS deaths, groupUniqArray(text) AS killers, max(ts) AS last
FROM events WHERE kind = 'death' AND ts > now() - INTERVAL 14 DAY
GROUP BY map, cx, cy;

-- Exp que dio cada tipo de monstruo por kill (evento `kill`: num1 = tipo, num2 = exp).
CREATE OR REPLACE VIEW v_kill_value AS
SELECT toUInt32(num1) AS type, any(text) AS name, count() AS n, round(avg(num2)) AS exp
FROM events WHERE kind = 'kill' AND num2 > 0
GROUP BY type;

-- Cuánto tarda cada nivel (minutos entre la primera y la última foto en ese nivel).
CREATE OR REPLACE VIEW v_level_time AS
SELECT char, level, min(ts) AS first, max(ts) AS last, dateDiff('minute', min(ts), max(ts)) AS minutes
FROM ticks WHERE mode = 'farm' GROUP BY char, level;

-- Resultado de cada decisión: exp/min de los 5 min antes contra los 5 min después (desde el minuto 1, para no contar el viaje).
-- Es lo que dice si una decisión (cambio de spot, reparto de puntos…) conviene. `data.kind` dice de qué tipo era.
CREATE OR REPLACE VIEW v_outcome AS
SELECT e.char AS char, e.ts AS ts, e.kind AS kind, JSONExtractString(e.data, 'kind') AS decision_kind, e.text AS text,
       round(avgIf(t.exp_min_1m, t.ts < e.ts)) AS before,
       round(avgIf(t.exp_min_1m, t.ts > e.ts + INTERVAL 1 MINUTE)) AS after,
       after - before AS delta,
       -- cruza una muerte o una pausa: la exp/min de 1 min arrastra lo anterior y compara peras con manzanas
       countIf(t.mode != 'farm') > 0 AS interrupted
FROM events AS e
INNER JOIN ticks AS t ON t.session = e.session
WHERE e.kind IN ('decide', 'travel')
  AND t.ts >= e.ts - INTERVAL 5 MINUTE AND t.ts <= e.ts + INTERVAL 6 MINUTE
GROUP BY char, ts, kind, decision_kind, text;

-- Por tipo de decisión (números y coordenadas tapados): cuántas veces, cambio medio y % que mejoró.
CREATE OR REPLACE VIEW v_outcome_type AS
SELECT char, decision_kind, replaceRegexpAll(text, '[0-9]+', '#') AS decision, count() AS n,
       round(avg(delta)) AS avg_delta, round(100 * avg(delta > 0)) AS pct_better
FROM v_outcome WHERE (before > 0 OR after > 0) AND NOT interrupted
GROUP BY char, decision_kind, decision;

-- El reparto de puntos: exp/min antes y después de cada /add (los puntos se juntan de a `statBatch`).
CREATE OR REPLACE VIEW v_stat_curve AS
SELECT char, ts, text, before, after, delta FROM v_outcome WHERE decision_kind = 'stat' AND NOT interrupted;

-- Monstruos vistos (registro `monster_seen`): qué hay en cada mapa, con la vida y el nivel de la tabla del cliente. `known = 0`: el tipo no
-- está en la tabla del cliente (revisar si el server agregó algo). Los jefes y custom (tipos >= 300) se ven acá antes que en cualquier otro lado.
CREATE OR REPLACE VIEW v_monsters AS
SELECT toUInt32(num1) AS type, any(text) AS name, toUInt16(num2) AS level, map, JSONExtractUInt(data, 'maxHp') AS max_hp,
       JSONExtractBool(data, 'known') AS known, count() AS sightings, min(ts) AS first, max(ts) AS last
FROM events WHERE kind = 'monster_seen'
GROUP BY type, level, map, max_hp, known;

-- Cuánto rinde cada skill de ataque (últimos 14 días): exp/min y ticks. Compara, por ejemplo, Cyclone (22) contra Impale (47) o Twisting Slash (41).
CREATE OR REPLACE VIEW v_skill_rate AS
SELECT skill, intDiv(level, 10) * 10 AS band, count() AS ticks, round(avg(exp_min_1m)) AS exp_min, round(quantileExact(0.5)(exp_min_1m)) AS exp_min_p50
FROM ticks WHERE mode = 'farm' AND phase = 'fight' AND ts > now() - INTERVAL 14 DAY
GROUP BY skill, band;
