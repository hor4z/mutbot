/**
 * Importa UNA vez la configuración que vivía en archivos locales a la base, y archiva esos archivos (no los borra; si un archivo está mal
 * formado se avisa y se deja donde está):
 *   ~/.mubot/personaje.json   → tabla `character`
 *   ~/.mubot/directivas.json  → tabla `directives`
 *   ~/.mubot/estado.json      → ajuste `wanted`
 *   ~/.mubot/alta/proxy-token → ajuste `proxy_token`
 *   .env.alta (MUBOT_ALTA_URL) → ajuste `worker_url`
 * Uso: `bun run db:importar` (después de `bun run db:migrate`). Los archivos se mueven a ~/.mubot/archivo-local/ para que no quede nada local.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readCharacter, readDirectives, writeCharacter, writeDirective, writeSetting } from '../db';

const DIR = join(homedir(), '.mubot');
const ARCHIVO = join(DIR, 'archivo-local');
const moved: string[] = [];
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
function archive(f: string) {
  mkdirSync(ARCHIVO, { recursive: true });
  renameSync(f, join(ARCHIVO, f.split('/').pop()!));
  moved.push(f);
}

const personaje = join(DIR, 'personaje.json');
if (existsSync(personaje)) {
  const p = readJson(personaje);
  if (p?.user && p?.pass && p?.char) { await writeCharacter({ user: p.user, pass: p.pass, char: p.char }); console.log(`personaje: ${p.char} (cuenta ${p.user}) a la base`); archive(personaje); }
  else console.log('personaje.json: le faltan user, pass o char; no lo importo');
}
const directivas = join(DIR, 'directivas.json');
if (existsSync(directivas)) {
  const d = readJson(directivas) ?? {};
  for (const [k, v] of Object.entries(d)) if (typeof v === 'number' || typeof v === 'boolean') { await writeDirective(k, v); console.log(`directiva ${k} = ${v}`); }
  archive(directivas);
}
const estado = join(DIR, 'estado.json');
if (existsSync(estado)) {
  await writeSetting('wanted', readJson(estado)?.wanted === true ? '1' : '0');
  archive(estado);
}
const token = join(DIR, 'alta', 'proxy-token');
if (existsSync(token)) { await writeSetting('proxy_token', readFileSync(token, 'utf8').trim()); console.log('proxy_token a la base'); archive(token); }
const envAlta = join(import.meta.dir, '..', '.env.alta');
if (existsSync(envAlta)) {
  const m = /^MUBOT_ALTA_URL=(.+)$/m.exec(readFileSync(envAlta, 'utf8'));
  if (m) { await writeSetting('worker_url', m[1]!.trim()); console.log(`worker_url: ${m[1]!.trim()}`); archive(envAlta); }
}
console.log(moved.length ? `archivados en ${ARCHIVO}: ${moved.map((f) => f.split('/').pop()).join(', ')}` : 'nada local que archivar');
const c = await readCharacter();
console.log(`en la base: personaje ${c?.char ?? 'ninguno'}, ${Object.keys(await readDirectives()).length} directiva(s)`);
