/**
 * Reporte de Capitan desde ClickHouse, en los últimos N minutos (default 60): niveles ganados, exp/min por spot, muertes, huidas, trabas
 * y las decisiones que más cambiaron el rendimiento. Para decidir con datos qué mejorar.
 * Uso: `bun --env-file=.env.db scripts/report.ts [minutos]`.
 */
const MIN = Number(process.argv[2] ?? 60);
const url = process.env.MUBOT_DB_URL ?? 'http://127.0.0.1:8123';
const auth = 'Basic ' + Buffer.from(`${process.env.MUBOT_DB_USER ?? 'default'}:${process.env.MUBOT_DB_PASSWORD ?? ''}`).toString('base64');
async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await fetch(`${url}/?database=${process.env.MUBOT_DB_NAME ?? 'mubot_slow'}&default_format=JSONEachRow`, { method: 'POST', body: sql, headers: { authorization: auth } });
  const t = await r.text();
  if (!r.ok) throw new Error(t.slice(0, 200));
  return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const since = `ts > now() - INTERVAL ${MIN} MINUTE`;
console.log(`=== Reporte de los últimos ${MIN} min ===`);
const prog = await q<{ char: string; l0: number; l1: number; n: number }>(
  `SELECT char, argMin(level, ts) l0, argMax(level, ts) l1, count() n FROM ticks WHERE ${since} GROUP BY char ORDER BY char`);
for (const p of prog) console.log(`${p.char}: nivel ${p.l0} a ${p.l1} (${Math.round((p.n * 5) / 60)} min con datos)`);
console.log('\n-- exp/min medio por spot (min = minutos ahí) --');
const spots = await q<{ spot: string; min: number; exp: number }>(
  `SELECT spot, round(count()*5/60,1) min, round(avg(exp_min_1m)) exp FROM ticks WHERE ${since} AND mode = 'farm' AND spot != '' GROUP BY spot HAVING min >= 1 ORDER BY min DESC`);
for (const m of spots) console.log(`${m.spot.padEnd(34)} ${String(m.min).padStart(6)} min  ${String(m.exp).padStart(10)} exp/min`);
console.log('\n-- eventos --');
const ev = await q<{ kind: string; n: number }>(
  `SELECT kind, count() n FROM events WHERE ${since} AND kind IN ('death','kill','flee','walk_stuck','travel') GROUP BY kind ORDER BY kind`);
for (const e of ev) console.log(`${e.kind.padEnd(12)} ${e.n}`);
console.log('\n-- decisiones (exp/min antes y después) --');
const dec = await q<{ text: string; before: number; after: number }>(
  `SELECT text, before, after FROM v_outcome WHERE ${since} AND NOT interrupted AND (before > 0 OR after > 0) ORDER BY abs(delta) DESC LIMIT 8`);
for (const d of dec) console.log(`${String(d.before).padStart(9)} antes, ${String(d.after).padStart(9)} después  ${d.text.slice(0, 90)}`);
