-- Base de conocimiento: respuestas fijas sobre los datos (scripts/aprender.ts las lee).
-- exp/min = promedio de exp_min_1m de los ticks farmeando (5 s cada uno: 12 ticks = 1 min medido).

-- Exp/min por personaje, mapa, lado de la esquina, party y hora del día.
CREATE OR REPLACE VIEW v_exp_spot AS
SELECT char, map, side, in_party, toHour(ts) AS hour,
       count() AS ticks, round(avg(exp_min_1m)) AS exp_min
FROM ticks WHERE mode = 'farm'
GROUP BY char, map, side, in_party, hour;

-- Dúo en la esquina de Arena 2 (map 83) con un compañero cerca: con party contra sin party.
CREATE OR REPLACE VIEW v_party AS
SELECT char, in_party, count() AS ticks, round(avg(exp_min_1m)) AS exp_min,
       round(quantileExact(0.5)(exp_min_1m)) AS exp_min_p50
FROM ticks WHERE mode = 'farm' AND map = 83 AND side != '' AND mates_near > 0
GROUP BY char, in_party;

-- Skill confirmado por el server según haya o no rivales cerca (Decay 38 contra Evil Spirit 9).
CREATE OR REPLACE VIEW v_skill AS
SELECT char, skill, rivals_near > 0 AS contested, count() AS ticks, round(avg(exp_min_1m)) AS exp_min
FROM ticks WHERE mode = 'farm' AND skill != 0
GROUP BY char, skill, contested;

-- Quién nos mata.
CREATE OR REPLACE VIEW v_killers AS
SELECT text AS killer, num2 = 1 AS player, count() AS deaths, groupUniqArray(char) AS victims,
       max(ts) AS last
FROM events WHERE kind = 'death'
GROUP BY killer, player;

-- Rivales a la vista: dónde y a qué hora aparecen.
CREATE OR REPLACE VIEW v_rivals AS
SELECT name, map, toHour(ts) AS hour, count() AS seen, min(ts) AS first, max(ts) AS last
FROM players_seen WHERE mate = 0 AND name != ''
GROUP BY name, map, hour;

-- Ciclos de reset (minutos) por personaje.
CREATE OR REPLACE VIEW v_cycles AS
SELECT char, count() AS cycles, round(avg(num1), 1) AS avg_min, min(num1) AS best_min, max(num1) AS worst_min,
       round(1440 / avg(num1)) AS resets_day
FROM events WHERE kind = 'cycle' AND num1 > 0
GROUP BY char;

-- Dorados vistos por mapa y hora.
CREATE OR REPLACE VIEW v_golden AS
SELECT map, text AS monster, toHour(ts) AS hour, count() AS seen
FROM events WHERE kind = 'golden_seen'
GROUP BY map, monster, hour;
