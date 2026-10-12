/**
 * Tests offline de estacion-logic.ts: personajes desde los .env, argumentos del bot, rutinas,
 * pedidos del navegador y detección de bots que ya corren. Sin red ni procesos.
 *
 *   bun run estacion-tests.ts
 */
import { isPanelCommand } from './panel-protocol';
import {
  parseTeamRequest,
  GOLD_TTL_MS, applyGoldSignal, freshGolds,
  DEFAULT_SERVER, botArgs, charFromEnv, exitStatus, isCharEnvFile, isRoutine, parseEnvFile, parseStationRequest,
  processRunsAccount, routineCommands, type CharConfig,
  accountProblem, type NewCharRequest,
} from './estacion-logic';
import { coolName, coolNames, joinParts, validCharName } from './names';
import { EstacionDb, MAX_CHARS_PER_ACCOUNT } from './estacion-db';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// --- .env ---------------------------------------------------------------------------------
{
  const e = parseEnvFile('# cuenta\nMUBOT_USER=cuenta1\nexport MUBOT_PASS="se cr=et"\n\nMUBOT_CHAR = \'Horaz\'\nbasura\n');
  ok('env: valores, comillas, export y espacios', e.MUBOT_USER === 'cuenta1' && e.MUBOT_PASS === 'se cr=et' && e.MUBOT_CHAR === 'Horaz', e);
  ok('env: archivos de personaje', isCharEnvFile('.env') && isCharEnvFile('.env.melu') && !isCharEnvFile('.env.example') && !isCharEnvFile('.envrc') && !isCharEnvFile('x.env'));
  const c = charFromEnv('.env.melu', 'MUBOT_USER=cuenta2\nMUBOT_PASS=x\nMUBOT_CHAR=Melu\n');
  ok('env: personaje con clave en minúscula', c?.key === 'melu' && c.char === 'Melu' && c.envFile === '.env.melu', c);
  ok('env: sin contraseña no es personaje', charFromEnv('.env', 'MUBOT_USER=a\nMUBOT_CHAR=b') === null);
}

// --- argumentos del bot -------------------------------------------------------------------
const horaz: CharConfig = { key: 'horaz', envFile: '.env', user: 'cuenta1', char: 'Horaz' };
{
  const a = botArgs(horaz, 8791, DEFAULT_SERVER, 'headless-bot.ts');
  ok('args: sin .env de la raíz, cuenta y personaje sin clave', a[0] === '--env-file=/dev/null' && a.join(' ').includes('--user cuenta1 --char Horaz') && !a.some((x) => /pass/i.test(x)), a);
  ok('args: panel, sin límite, remoto y salir si la cuenta está en uso',
    a.join(' ').includes('--ws-port 8791') && a.join(' ').includes('--auto-seconds 0') && a.includes('--allow-remote') && a.includes('--exit-if-in-use'), a);
  ok('args: recién desconectado no sale por cuenta en uso', !botArgs(horaz, 8791, DEFAULT_SERVER, 'headless-bot.ts', false).includes('--exit-if-in-use'));
}

// --- rutinas ------------------------------------------------------------------------------
{
  ok('rutina: farm', JSON.stringify(routineCommands({ kind: 'farm' })) === '[{"cmd":"farm"}]');
  ok('rutina: spot = warp fijo', JSON.stringify(routineCommands({ kind: 'spot', warp: 26 })) === '[{"cmd":"warp","warp":26}]');
  ok('rutina: atlas ya no existe', !isRoutine({ kind: 'atlas' }));
  ok('rutina: todas las órdenes pasan isPanelCommand',
    [{ kind: 'farm' }, { kind: 'spot', warp: 7 }, { kind: 'pause' }].every((r) => routineCommands(r as never).every(isPanelCommand)));
  ok('rutina: validación', isRoutine({ kind: 'farm' }) && isRoutine({ kind: 'spot', warp: 24 }) && !isRoutine({ kind: 'spot' })
    && !isRoutine({ kind: 'spot', warp: 300 }) && !isRoutine({ kind: 'farm', x: 1 }) && !isRoutine({ kind: 'hunt' }) && !isRoutine('farm'));
}

// --- pedidos del navegador -----------------------------------------------------------------
{
  ok('pedido: connect', parseStationRequest({ action: 'connect', char: 'horaz', routine: { kind: 'farm' } })?.action === 'connect');
  ok('pedido: disconnect', parseStationRequest({ action: 'disconnect', char: 'melu' })?.action === 'disconnect');
  ok('pedido: routine', parseStationRequest({ action: 'routine', char: 'horaz', routine: { kind: 'spot', warp: 26 } })?.action === 'routine');
  ok('pedido: campos de más se rechazan', parseStationRequest({ action: 'disconnect', char: 'melu', pid: 1 }) === null);
  ok('pedido: nombre raro se rechaza', parseStationRequest({ action: 'disconnect', char: '../x' }) === null);
  ok('pedido: acción desconocida', parseStationRequest({ action: 'exec', char: 'horaz' }) === null);
  ok('pedido: connect sin rutina', parseStationRequest({ action: 'connect', char: 'horaz' }) === null);
}

// --- bots que ya corren -------------------------------------------------------------------
{
  const melu: CharConfig = { key: 'melu', envFile: '.env.melu', user: 'cuenta2', char: 'Melu' };
  const bot = ['bun', 'run', 'headless-bot.ts', '--ws-port', '8787'];
  ok('proc: otro programa no cuenta', !processRunsAccount(['bun', 'run', 'proxy.ts'], [], horaz));
  ok('proc: --env-file del personaje', processRunsAccount(['bun', '--env-file=.env.melu', ...bot.slice(1)], [], melu)
    && !processRunsAccount(['bun', '--env-file=.env.melu', ...bot.slice(1)], [], horaz));
  ok('proc: --env-file con ruta', processRunsAccount(['bun', '--env-file', '/home/x/mubot/.env.melu', ...bot.slice(1)], [], melu));
  ok('proc: --user manda', processRunsAccount([...bot, '--user', 'cuenta2'], ['MUBOT_USER=cuenta1'], melu));
  ok('proc: --user y --char distinguen personajes de la misma cuenta',
    processRunsAccount([...bot, '--user', 'cuenta2', '--char', 'Melu'], [], melu) && !processRunsAccount([...bot, '--user', 'cuenta2', '--char', 'Otro'], [], melu));
  ok('proc: MUBOT_USER del entorno', processRunsAccount(bot, ['MUBOT_USER=cuenta2'], melu) && !processRunsAccount(bot, ['MUBOT_USER=cuenta2'], horaz));
  ok('proc: sin nada = .env de la raíz', processRunsAccount(bot, [], horaz) && !processRunsAccount(bot, [], melu));
}

// --- señales de dorados -------------------------------------------------------------------
{
  const golds = new Map();
  ok('dorado: visto', applyGoldSignal(golds, { from: 'Horaz', map: 2, x: 10, y: 20, name: 'Golden Goblin', id: 77, at: 1 }, 1000) && golds.size === 1);
  ok('dorado: se movió (misma clave)', applyGoldSignal(golds, { from: 'Horaz', map: 2, x: 11, y: 20, name: 'Golden Goblin', id: 77 }, 2000) && golds.size === 1 && freshGolds(golds, 2000)[0].x === 11);
  ok('dorado: gone lo borra', applyGoldSignal(golds, { from: 'Horaz', map: 2, id: 77, gone: true }, 3000) && golds.size === 0);
  ok('dorado: inválidos', !applyGoldSignal(golds, { from: 'H', map: 999, x: 1, y: 1, id: 1 }, 0) && !applyGoldSignal(golds, { from: '', map: 1, x: 1, y: 1, id: 1 }, 0)
    && !applyGoldSignal(golds, { from: 'H', map: 1, x: 300, y: 1, id: 1 }, 0) && !applyGoldSignal(golds, [], 0));
  applyGoldSignal(golds, { from: 'Melu', map: 3, x: 1, y: 1, name: 'x', id: 5 }, 0);
  ok('dorado: vence al minuto', freshGolds(golds, GOLD_TTL_MS + 1).length === 0 && golds.size === 0);
}

// --- equipo: pedidos de ayuda ---------------------------------------------------------------
{
  const r = parseTeamRequest({ from: 'Horaz', kind: 'corner', map: 83, x: 2, y: 10, note: '3 rivales' }, 5);
  ok('equipo: pedido válido', r?.from === 'Horaz' && r.kind === 'corner' && r.at === 5, r);
  ok('equipo: tipo desconocido o mapa fuera de rango → null', parseTeamRequest({ from: 'Horaz', kind: 'pk', map: 83, x: 1, y: 1 }, 0) === null &&
    parseTeamRequest({ from: 'Horaz', kind: 'golden', map: 300, x: 1, y: 1 }, 0) === null && parseTeamRequest([], 0) === null);
  ok('equipo: nombre saneado', parseTeamRequest({ from: '<Melu>', kind: 'golden', map: 2, x: 1, y: 1 }, 0)?.from === 'Melu');
}

// --- salida del bot -----------------------------------------------------------------------
ok('salida: 3 = cuenta abierta en otro lado', exitStatus(3).status === 'in-use');
ok('salida: 0 = desconectado', exitStatus(0).status === 'off');
ok('salida: 1 = error', exitStatus(1).status === 'failed');
ok('salida: 4 = cuenta bloqueada', exitStatus(4).status === 'failed' && exitStatus(4).msg.includes('bloqueó'));
ok('salida: 5 = login rechazado', exitStatus(5).status === 'failed' && exitStatus(5).msg.includes('rechazó'));

console.log(fails ? `\n${fails} FALLARON` : '\nTodo OK');
// --- Personaje nuevo ----------------------------------------------------------------------
{
  const base = { action: 'create', user: 'cuenta9', pass: 'cl4ve!', char: 'Umbrion', cls: 'dk', existing: false };
  const r = parseStationRequest(base);
  ok('crear: pedido válido', r?.action === 'create' && (r as NewCharRequest).cls === 'dk', r);
  ok('crear: clase desconocida', parseStationRequest({ ...base, cls: 'sum' }) === null);
  ok('crear: nombre corto o raro', parseStationRequest({ ...base, char: 'Abc' }) === null && parseStationRequest({ ...base, char: 'Ñandú1' }) === null);
  ok('crear: campo de más', parseStationRequest({ ...base, x: 1 }) === null);
  ok('sumar: personaje a cuenta guardada (sin clave)', parseStationRequest({ action: 'add', user: 'cuenta9', char: 'Lythgard', cls: 'elf' })?.action === 'add');
  ok('sumar: con clave de más se rechaza', parseStationRequest({ action: 'add', user: 'cuenta9', pass: 'x', char: 'Lythgard', cls: 'elf' }) === null);
  ok('crear: sin existing', parseStationRequest({ action: 'create', user: 'cuenta9', pass: 'cl4ve!', char: 'Umbrion', cls: 'dk' }) === null);
  ok('cuenta: largo y caracteres', accountProblem('abc', 'clave') !== null && accountProblem('cuenta9', 'abc') !== null && accountProblem('cuenta 9', 'clave') !== null);
  ok('cuenta: válida', accountProblem('cuenta9', 'cl4ve!') === null);
}

// --- Nombres ------------------------------------------------------------------------------
{
  ok('nombres: unir sin vocales dobles', joinParts('umbra', 'ion') === 'Umbrion' && joinParts('drak', 'ar') === 'Drakar', [joinParts('umbra', 'ion'), joinParts('drak', 'ar')]);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const many = Array.from({ length: 500 }, () => coolName(rand));
  ok('nombres: todos válidos para el server', many.every(validCharName), many.filter((n) => !validCharName(n)));
  const list = coolNames(8, ['Umbrion'], rand);
  ok('nombres: 8 distintos', list.length === 8 && new Set(list.map((n) => n.toLowerCase())).size === 8, list);
  ok('nombres: no repite los tomados', coolNames(50, many.slice(0, 40), rand).every((n) => !many.slice(0, 40).includes(n)));
  ok('nombres: azar extremo también vale', validCharName(coolName(() => 0)) && validCharName(coolName(() => 0.9999)));
}

// --- Base local (SQLite en memoria) -------------------------------------------------------
{
  const db = new EstacionDb(DEFAULT_SERVER, ':memory:');
  ok('db: esquema migrado', db.version === 1, db.version);
  const imported = db.importEnv([
    { envFile: '.env', user: 'cuenta1', pass: 'x1', char: 'Horaz' },
    { envFile: '.env.melu', user: 'cuenta2', pass: 'x2', char: 'Melu' },
  ]);
  ok('db: importa los .env', imported.join() === 'Horaz,Melu', imported);
  ok('db: importar de nuevo no duplica', db.importEnv([{ envFile: '.env', user: 'cuenta1', pass: 'x1', char: 'Horaz' }]).length === 0 && db.chars().length === 2);
  const h = db.chars().find((c) => c.char === 'Horaz');
  ok('db: personaje importado (origen, sin clase, activa)', h?.envFile === '.env' && h.cls === undefined && h.status === 'active' && h.key === 'horaz', h);
  ok('db: clave por personaje', db.passFor('Horaz') === 'x1' && db.passFor('melu') === 'x2' && db.passFor('Nadie') === null);
  ok('db: nuevo personaje en cuenta nueva', db.addChar('cuenta9', 'cl4ve', 'Cinderax', 'dk') === null && db.chars().find((c) => c.char === 'Cinderax')?.cls === 'dk');
  ok('db: nombre repetido (sin importar mayúsculas)', db.addChar('cuenta9', 'cl4ve', 'CINDERAX', 'dw') !== null);
  ok('db: cuenta existente con otra clave', db.addChar('Cuenta9', 'otra', 'Lythgard', 'dw') !== null);
  ok('db: segundo personaje en la misma cuenta', db.addChar('Cuenta9', 'cl4ve', 'Lythgard', 'elf') === null && db.chars().filter((c) => c.user === 'cuenta9').length === 2);
  for (const n of ['Tyrael', 'Drakgar', 'Duskon']) db.addChar('cuenta9', 'cl4ve', n, 'dk');
  ok('db: tope de personajes por cuenta', db.addChar('cuenta9', 'cl4ve', 'Sexto', 'dk') !== null && db.chars().filter((c) => c.user === 'cuenta9').length === MAX_CHARS_PER_ACCOUNT);
  db.setAccountStatus('CUENTA1', 'blocked');
  ok('db: cuenta bloqueada', db.chars().find((c) => c.char === 'Horaz')?.status === 'blocked' && db.chars().find((c) => c.char === 'Melu')?.status === 'active');
  db.setRoutine('Horaz', { kind: 'spot', warp: 24 });
  ok('db: última rutina', JSON.stringify(db.chars().find((c) => c.char === 'Horaz')?.lastRoutine) === '{"kind":"spot","warp":24}');
  ok('db: nombre inválido', db.addChar('cuenta8', 'clave', 'ab', 'dk') !== null);
  db.close();
}

if (fails) process.exit(1);
