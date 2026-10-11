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
table('Exp/min por lado de la esquina (Arena 2)', (await query<{ char: string; side: string; ticks: number; exp_min: number }>(
  "SELECT char, side, sum(ticks) AS ticks, round(sum(exp_min * ticks) / sum(ticks)) AS exp_min FROM v_exp_spot WHERE map = 83 AND side != '' GROUP BY char, side ORDER BY char, exp_min DESC FORMAT JSONEachRow",
)).map((r) => ({ ...r, exp_min: M(r.exp_min) })));
table('Skill del mago con y sin rivales', (await query<{ exp_min: number }>('SELECT * FROM v_skill ORDER BY char, contested, exp_min DESC FORMAT JSONEachRow')).map((r) => ({ ...r, exp_min: M(r.exp_min) })));
table('Quién nos mata', await query('SELECT killer, player, deaths, victims, last FROM v_killers ORDER BY deaths DESC LIMIT 15 FORMAT JSONEachRow'));
table('Rivales más vistos', await query('SELECT name, map, sum(seen) AS seen, max(last) AS last FROM v_rivals GROUP BY name, map ORDER BY seen DESC LIMIT 15 FORMAT JSONEachRow'));
table('Ciclos de reset', await query('SELECT * FROM v_cycles FORMAT JSONEachRow'));
table('Dorados vistos', await query('SELECT map, monster, sum(seen) AS seen FROM v_golden GROUP BY map, monster ORDER BY seen DESC FORMAT JSONEachRow'));

const k: Knowledge = { at: new Date().toISOString(), party: decideParty(party) };
writeFileSync(KNOWLEDGE_PATH, JSON.stringify(k, null, 1) + '\n');
console.log(`\nknowledge.json → party ${k.party!.use ? 'sí' : 'no'}: ${k.party!.reason}`);
