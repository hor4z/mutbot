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

-- Resultado de cada decisión: exp/min de los 5 min antes contra los 5 min después (desde el minuto 1,
-- para no contar el viaje). Es lo que dice si una decisión conviene.
CREATE OR REPLACE VIEW v_outcome AS
SELECT e.char AS char, e.ts AS ts, e.kind AS kind, e.text AS text,
       round(avgIf(t.exp_min_1m, t.ts < e.ts)) AS before,
       round(avgIf(t.exp_min_1m, t.ts > e.ts + INTERVAL 1 MINUTE)) AS after,
       after - before AS delta,
       -- cruza un reset: cambia el contador, pasa por 'resetting' o el nivel baja (la exp/min de 1 min
       -- arrastra la de la esquina y compara peras con manzanas)
       max(t.resets) != min(t.resets) OR countIf(t.mode = 'resetting') > 0 OR
         maxIf(t.level, t.ts > e.ts) < minIf(t.level, t.ts < e.ts) AS crosses_reset
FROM events AS e
INNER JOIN ticks AS t ON t.session = e.session
WHERE e.kind IN ('decide', 'travel')
  AND t.ts >= e.ts - INTERVAL 5 MINUTE AND t.ts <= e.ts + INTERVAL 6 MINUTE
GROUP BY char, ts, kind, text;

-- Por tipo de decisión (números y coordenadas tapados): cuántas veces, cambio medio y % que mejoró.
CREATE OR REPLACE VIEW v_outcome_type AS
SELECT char, replaceRegexpAll(text, '[0-9]+', '#') AS decision, count() AS n,
       round(avg(delta)) AS avg_delta, round(100 * avg(delta > 0)) AS pct_better
-- (sin las que cruzan un reset: el nivel cae y compara la esquina con el arranque)
FROM v_outcome WHERE (before > 0 OR after > 0) AND NOT crosses_reset
GROUP BY char, decision;

-- Pelea por el spot: por personaje, mapa, celda de 8x8 y dónde está el compañero (0 no se ve, 1 mismo
-- spot, 2 otro spot): exp/min y qué parte de las kills del sector son nuestras.
CREATE OR REPLACE VIEW v_spot_fight AS
SELECT char, map, intDiv(x, 8) * 8 AS cx, intDiv(y, 8) * 8 AS cy, mate_spot,
       count() AS ticks, round(avg(exp_min_1m)) AS exp_min,
       sum(kills_me) AS mine, sum(kills_mate) AS mate, sum(kills_rival) AS rivals,
       round(100 * sum(kills_me + kills_mate) / greatest(1, sum(kills_me + kills_mate + kills_rival))) AS pct_ours,
       topKIf(3)(top_rival, top_rival != '') AS main_rivals
FROM ticks WHERE mode = 'farm'
GROUP BY char, map, cx, cy, mate_spot;

-- Ritmo de resets de cada jugador del ranking (resets por hora entre la primera y la última foto del día).
CREATE OR REPLACE VIEW v_rival_pace AS
SELECT name, toDate(ts) AS day, max(resets) - min(resets) AS resets_gained,
       round((max(resets) - min(resets)) / greatest(1, dateDiff('minute', min(ts), max(ts)) / 60), 2) AS per_hour,
       argMax(pos, ts) AS pos
FROM ranking GROUP BY name, day;
