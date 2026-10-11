/**
 * Aprender de los datos: lee las vistas de db/views.sql, muestra las respuestas y escribe
 * ~/.mubot/knowledge.json (lo que los bots usan solos; ver knowledge.ts).
 * `bun run aprender` (usa .env.db).
 */
import { writeFileSync } from 'node:fs';
import { KNOWLEDGE_PATH, decideParty, type Knowledge, type PartyRow } from '../knowledge';
import { query } from './db';

const M = (n: number) => `${(n / 1e6).toFixed(0)}M`;
const table = (title: string, rows: Record<string, unknown>[]) => {
  console.log(`\n== ${title}`);
  if (!rows.length) console.log('  (sin datos todavía)');
  else console.table(rows);
};

const party = await query<PartyRow>('SELECT char, in_party, ticks, exp_min FROM v_party FORMAT JSONEachRow');
table('Party en el dúo (Arena 2, compañero cerca)', party.map((r) => ({ ...r, exp_min: M(r.exp_min) })));
table('Exp/min por lado de la esquina (Arena 2)', (await query<{ char: string; side: string; n: number; rate: number }>(
  "SELECT char, side, sum(ticks) AS n, round(sum(v_exp_spot.exp_min * v_exp_spot.ticks) / sum(v_exp_spot.ticks)) AS rate FROM v_exp_spot WHERE map = 83 AND side != '' GROUP BY char, side ORDER BY char, rate DESC FORMAT JSONEachRow",
)).map((r) => ({ char: r.char, side: r.side, ticks: r.n, exp_min: M(r.rate) })));
table('Skill confirmado por el server, con y sin rivales', (await query<{ exp_min: number }>('SELECT * FROM v_skill ORDER BY char, contested, exp_min DESC FORMAT JSONEachRow')).map((r) => ({ ...r, exp_min: M(r.exp_min) })));
table('Resultado de las decisiones (exp/min 5 min después contra 5 min antes)', (await query<{ avg_delta: number | null }>('SELECT char, decision, n, avg_delta, pct_better FROM v_outcome_type WHERE n >= 2 ORDER BY n DESC LIMIT 20 FORMAT JSONEachRow')).map((r) => ({ ...r, avg_delta: r.avg_delta == null ? '-' : M(r.avg_delta) })));
table('Pelea por el spot (mate_spot: 0 solo, 1 juntos, 2 separados)', (await query<{ exp_min: number }>('SELECT char, map, cx, cy, mate_spot, ticks, exp_min, pct_ours, main_rivals FROM v_spot_fight WHERE ticks >= 60 ORDER BY exp_min DESC LIMIT 20 FORMAT JSONEachRow')).map((r) => ({ ...r, exp_min: M(r.exp_min) })));
table('Ritmo de resets del ranking (hoy)', await query('SELECT name, pos, resets_gained, per_hour FROM v_rival_pace WHERE day = today() ORDER BY per_hour DESC LIMIT 15 FORMAT JSONEachRow'));
table('Quién nos mata', await query('SELECT killer, player, deaths, victims, last FROM v_killers ORDER BY deaths DESC LIMIT 15 FORMAT JSONEachRow'));
table('Rivales más vistos', await query('SELECT name, map, sum(seen) AS seen, max(last) AS last FROM v_rivals GROUP BY name, map ORDER BY seen DESC LIMIT 15 FORMAT JSONEachRow'));
table('Ciclos de reset', await query('SELECT * FROM v_cycles FORMAT JSONEachRow'));
table('Dorados vistos', await query('SELECT map, monster, sum(seen) AS seen FROM v_golden GROUP BY map, monster ORDER BY seen DESC FORMAT JSONEachRow'));

const k: Knowledge = { at: new Date().toISOString(), party: decideParty(party) };
writeFileSync(KNOWLEDGE_PATH, JSON.stringify(k, null, 1) + '\n');
console.log(`\nknowledge.json → party ${k.party!.use ? 'sí' : 'no'}: ${k.party!.reason}`);
