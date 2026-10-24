/**
 * Reporte de la flota desde ClickHouse: por personaje, en los últimos N minutos (default 60): niveles y resets ganados,
 * exp/min por mapa (y en party o solo), muertes, dorados matados y trabas. Para decidir con datos qué mejorar.
 * Uso: `bun --env-file=.env.db scripts/report.ts [minutos]`.
 */
const MIN = Number(process.argv[2] ?? 60);
const url = process.env.MUBOT_DB_URL ?? 'http://127.0.0.1:8123';
const auth = 'Basic ' + Buffer.from(`${process.env.MUBOT_DB_USER ?? 'default'}:${process.env.MUBOT_DB_PASSWORD ?? ''}`).toString('base64');
async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await fetch(`${url}/?database=mubot&default_format=JSONEachRow`, { method: 'POST', body: sql, headers: { authorization: auth } });
  const t = await r.text();
  if (!r.ok) throw new Error(t.slice(0, 200));
  return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const since = `ts > now() - INTERVAL ${MIN} MINUTE`;
console.log(`=== Reporte de los últimos ${MIN} min ===`);
const prog = await q<{ char: string; l0: number; l1: number; r0: number; r1: number; n: number }>(
  `SELECT char, argMin(level, ts) l0, argMax(level, ts) l1, argMin(resets, ts) r0, argMax(resets, ts) r1, count() n FROM ticks WHERE ${since} GROUP BY char ORDER BY char`);
for (const p of prog) console.log(`${p.char}: nivel ${p.l0} → ${p.l1}, resets ${p.r0} → ${p.r1} (${Math.round((p.n * 5) / 60)} min con datos)`);
console.log('\n-- exp/min medio por mapa y party (min = minutos ahí) --');
const maps = await q<{ char: string; map: number; party: number; min: number; expM: number }>(
  `SELECT char, map, in_party party, round(count()*5/60,1) min, round(avg(exp_min_1m)/1e6,1) expM FROM ticks WHERE ${since} GROUP BY char, map, in_party HAVING min >= 1 ORDER BY char, min DESC`);
for (const m of maps) console.log(`${m.char.padEnd(8)} mapa ${String(m.map).padEnd(3)} ${m.party ? 'party' : 'solo '} ${String(m.min).padStart(6)} min  ${String(m.expM).padStart(7)}M/min`);
console.log('\n-- eventos --');
const ev = await q<{ char: string; kind: string; n: number }>(
  `SELECT char, kind, count() n FROM events WHERE ${since} AND kind IN ('death','golden_kill','walk_stuck','hunt_end','cycle') GROUP BY char, kind ORDER BY char, kind`);
for (const e of ev) console.log(`${e.char.padEnd(8)} ${e.kind.padEnd(12)} ${e.n}`);
const gk = await q<{ char: string; mine: number; n: number }>(`SELECT char, num2 = 1 AS mine, count() n FROM events WHERE ${since} AND kind = 'golden_kill' GROUP BY char, mine ORDER BY char`);
for (const g of gk) console.log(`${g.char.padEnd(8)} dorados ${g.mine ? 'míos' : 'ajenos'}: ${g.n}`);
const near = await q<{ char: string; pct: number }>(`SELECT char, round(100*avg(mates_near > 0), 0) pct FROM ticks WHERE ${since} GROUP BY char ORDER BY char`);
console.log('\n% del tiempo con un compañero a <= 15 tiles:', near.map((n) => `${n.char} ${n.pct}%`).join(' · '));
