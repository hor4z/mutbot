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
  isRoleAssign, roleRoutine, roleFromRoutine, roleLabel, ROLE_KEYS, parseScoutReport, applyScout, freshScouts, scoutHeat, SCOUT_TTL_MS,
  newAlertMemory, diffAlerts, pushAlert, parseBotAlert, parseBotInsight, bagUsage, STUCK_MS, type CharSnap, type Alert,
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
    && !isRoutine({ kind: 'spot', warp: 300 }) && !isRoutine({ kind: 'farm', x: 1 }) && isRoutine({ kind: 'hunt' }) && !isRoutine('farm'));
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
  ok('crear: personaje que ya existe (sin clase) solo con cuenta existente',
    parseStationRequest({ ...base, cls: null, existing: true })?.action === 'create' && parseStationRequest({ ...base, cls: null }) === null);
  ok('probe: con o sin clave', parseStationRequest({ action: 'probe', user: 'cuenta9', pass: 'cl4ve!' })?.action === 'probe'
    && parseStationRequest({ action: 'probe', user: 'cuenta9' })?.action === 'probe'
    && parseStationRequest({ action: 'probe', user: 'c', pass: 'x' }) === null);
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
  ok('db: esquema migrado', db.version === 2, db.version);
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
  ok('db: sin rol al principio', db.chars().every((c) => c.role === null));
  db.setRole('Melu', { role: 'explorer' });
  db.setRole('Horaz', { role: 'spot', warp: 26 });
  ok('db: rol guardado', db.chars().find((c) => c.char === 'Melu')?.role?.role === 'explorer' && JSON.stringify(db.chars().find((c) => c.char === 'Horaz')?.role) === '{"role":"spot","warp":26}');
  db.close();
}

// --- Estrategias --------------------------------------------------------------------------
{
  ok('rol: los cinco son válidos', ROLE_KEYS.length === 5 && ROLE_KEYS.filter((k) => k !== 'spot').every((k) => isRoleAssign({ role: k })) && isRoleAssign({ role: 'spot', warp: 26 }));
  ok('rol: spot sin warp, rol raro o campos de más → no', !isRoleAssign({ role: 'spot' }) && !isRoleAssign({ role: 'dios' }) && !isRoleAssign({ role: 'golden', warp: 1 }) && !isRoleAssign(null) && !isRoleAssign({ role: 'spot', warp: 300 }));
  ok('rol: cada uno arma una rutina con órdenes válidas', ROLE_KEYS.every((k) => routineCommands(roleRoutine(k === 'spot' ? { role: k, warp: 2 } : { role: k })).every(isPanelCommand)));
  ok('rol: dorados = hunt, explorador = scout, spot = warp, el resto = farm', roleRoutine({ role: 'golden' }).kind === 'hunt' && roleRoutine({ role: 'spot', warp: 7 }).kind === 'spot' && roleRoutine({ role: 'explorer' }).kind === 'scout' && roleRoutine({ role: 'support' }).kind === 'farm');
  ok('rol: desde una rutina vieja', roleFromRoutine(null).role === 'route' && roleFromRoutine({ kind: 'hunt' }).role === 'golden' && roleFromRoutine({ kind: 'scout' }).role === 'explorer' && roleFromRoutine({ kind: 'scout' }).role === 'explorer' && roleFromRoutine({ kind: 'spot', warp: 3 }).role === 'spot');
  ok('rol: etiqueta', roleLabel({ role: 'spot', warp: 26 }).includes('26'));
  ok('rutina hunt válida', isRoutine({ kind: 'hunt' }) && !isRoutine({ kind: 'hunt', map: 1 }) && routineCommands({ kind: 'hunt' })[0].cmd === 'hunt');
  const rq = parseStationRequest({ action: 'role', char: 'melu', role: { role: 'explorer' } });
  ok('pedido: rol', rq?.action === 'role' && rq.role.role === 'explorer', rq);
  ok('pedido: rol inválido o con campos de más → null', parseStationRequest({ action: 'role', char: 'melu', role: { role: 'x' } }) === null && parseStationRequest({ action: 'role', char: 'melu', role: { role: 'route' }, extra: 1 }) === null && parseStationRequest({ action: 'role', char: 'Melu!', role: { role: 'route' } }) === null);
}

// --- Exploración --------------------------------------------------------------------------
{
  const r = parseScoutReport({ from: 'Melu', kind: 'scout', map: 3, x: 100, y: 50, players: 6, monsters: 40, golds: 1, note: 'campo lleno' }, 1000);
  ok('scout: reporte válido', r?.from === 'Melu' && r.players === 6 && r.golds === 1 && r.at === 1000, r);
  ok('scout: los contadores son opcionales', parseScoutReport({ from: 'Melu', kind: 'scout', map: 3, x: 1, y: 1 }, 0)?.players === 0);
  ok('rutina scout válida y su orden pasa el filtro', isRoutine({ kind: 'scout' }) && !isRoutine({ kind: 'scout', map: 1 }) && JSON.stringify(routineCommands({ kind: 'scout' })) === '[{"cmd":"scout"}]');
  const gt = parseScoutReport({ from: 'Melu', kind: 'scout', map: 2, x: 5, y: 6, golds: 2, goldTypes: ['Golden Goblin', 7, 'Golden Titan'] }, 0);
  ok('scout: goldTypes opcional, solo textos', JSON.stringify(gt?.goldTypes) === '["Golden Goblin","Golden Titan"]' && parseScoutReport({ from: 'Melu', kind: 'scout', map: 2, x: 5, y: 6 }, 0)?.goldTypes === undefined);
  ok('scout: inválidos → null', parseScoutReport({ from: 'Melu', kind: 'golden', map: 3, x: 1, y: 1 }, 0) === null && parseScoutReport({ from: 'Melu', kind: 'scout', map: 999, x: 1, y: 1 }, 0) === null && parseScoutReport({ from: 'Melu', kind: 'scout', map: 3, x: 1, y: 1, players: -2 }, 0) === null && parseScoutReport({ from: 'Melu', kind: 'scout', map: 3, x: 1, y: 1, golds: 'a' }, 0) === null && parseScoutReport(null, 0) === null);
  const m = new Map();
  applyScout(m, r!);
  applyScout(m, { ...r!, players: 0, at: 2000 });
  applyScout(m, { ...r!, map: 4, at: 1500 });
  const f = freshScouts(m, 3000);
  ok('scout: uno por explorador y mapa, el último gana, más nuevo primero', f.length === 2 && f[0].map === 3 && f[0].players === 0 && f[1].map === 4, f);
  ok('scout: vencen', freshScouts(m, 2000 + SCOUT_TTL_MS + 1).length === 0);
  ok('scout: competencia', scoutHeat({ players: 0 }) === 'free' && scoutHeat({ players: 3 }) === 'busy' && scoutHeat({ players: 9 }) === 'crowded');
}

// --- Alertas ------------------------------------------------------------------------------
{
  const snap = (o: Partial<CharSnap> = {}): CharSnap => ({ key: 'horaz', char: 'Horaz', status: 'on', account: 'active', mode: 'farm', doing: 'farmeando', map: 'Arena 4', x: 10, y: 10, level: 300, deaths: 0, bag: 0.2, ...o });
  const mem = newAlertMemory();
  ok('alertas: la primera vuelta no inventa nada', diffAlerts(mem, [snap()], 0).length === 0);
  const kinds = (a: { kind: string }[]) => a.map((x) => x.kind).join();
  ok('alertas: muerte', kinds(diffAlerts(mem, [snap({ deaths: 1, x: 11 })], 1000)) === 'death');
  ok('alertas: nivel y bolsa llena', kinds(diffAlerts(mem, [snap({ deaths: 1, level: 301, bag: 0.95, x: 12 })], 2000)) === 'level,bagfull');
  ok('alertas: la bolsa llena no se repite', diffAlerts(mem, [snap({ deaths: 1, level: 301, bag: 0.97, x: 13 })], 3000).length === 0);
  ok('alertas: salto grande de nivel (reset) no avisa', diffAlerts(mem, [snap({ deaths: 1, level: 5, bag: 0.5, x: 14 })], 4000).length === 0);
  ok('alertas: desconexión', kinds(diffAlerts(mem, [snap({ status: 'off', mode: null })], 5000)) === 'status');
  ok('alertas: cuenta bloqueada', kinds(diffAlerts(mem, [snap({ status: 'failed', account: 'blocked', mode: null })], 6000)) === 'blocked,blocked');
  // Trabado: quieto STUCK_MS farmeando.
  const m2 = newAlertMemory();
  diffAlerts(m2, [snap()], 0);
  ok('alertas: quieto poco tiempo no es trabado', diffAlerts(m2, [snap()], STUCK_MS - 1).length === 0 && !m2.stuck.has('horaz'));
  const t = diffAlerts(m2, [snap()], STUCK_MS + 1);
  ok('alertas: trabado a los 5 min, una sola vez', kinds(t) === 'stuck' && m2.stuck.has('horaz') && diffAlerts(m2, [snap()], STUCK_MS + 2000).length === 0);
  diffAlerts(m2, [snap({ x: 99 })], STUCK_MS + 3000);
  ok('alertas: si se mueve deja de estar trabado', !m2.stuck.has('horaz'));
  const m3 = newAlertMemory();
  diffAlerts(m3, [snap({ mode: 'paused' })], 0);
  ok('alertas: en pausa no es trabado', diffAlerts(m3, [snap({ mode: 'paused' })], STUCK_MS * 3).length === 0);
  const list: Alert[] = [];
  for (let i = 0; i < 130; i++) pushAlert(list, { at: i, kind: 'gold', tone: 'info', char: null, text: String(i) });
  ok('alertas: tope y orden (la nueva primero, ids crecientes)', list.length === 120 && list[0].id === 130 && list[0].text === '129' && list[1].id === 129);
  ok('alertas: aviso de un bot', parseBotAlert({ from: 'Horaz', kind: 'pk', text: 'PK a mi lado' }, 5)?.tone === 'bad' && parseBotAlert({ from: 'Horaz', kind: 'bagfull', text: 'llena' }, 5)?.tone === 'warn');
  ok('alertas: aviso inválido → null', parseBotAlert({ from: 'Horaz', kind: 'otra', text: 'x' }, 0) === null && parseBotAlert({ from: 'Horaz', kind: 'pk', text: '  ' }, 0) === null && parseBotAlert([], 0) === null);
  ok('bolsa: uso por casillas', bagUsage(undefined) === null && bagUsage([{ w: 2, h: 4 }, {}]) === 9 / 64 && bagUsage(Array(80).fill({})) === 1);
}

// --- Órdenes puntuales al bot ---------------------------------------------------------------
{
  const bot = (command: unknown) => parseStationRequest({ action: 'bot', char: 'horaz', command });
  ok('bot: equipplan, equip y /pkclear pasan', bot({ cmd: 'equipplan' })?.action === 'bot' && bot({ cmd: 'equip' })?.action === 'bot' && bot({ cmd: 'say', text: '/pkclear' })?.action === 'bot');
  ok('bot: el resto no pasa', bot({ cmd: 'say', text: 'hola' }) === null && bot({ cmd: 'say', text: '/pkclear', to: 'x' }) === null && bot({ cmd: 'warp', warp: 2 }) === null && bot({ cmd: 'hunt' }) === null && bot({ cmd: 'say', text: '/move lorencia' }) === null);
  ok('bot: sin char válido o con claves de más → null', parseStationRequest({ action: 'bot', char: 'Ho raz', command: { cmd: 'equip' } }) === null && parseStationRequest({ action: 'bot', char: 'horaz', command: { cmd: 'equip' }, x: 1 }) === null);
}

// --- Insights de los bots ---------------------------------------------------------------------
{
  const msg = (o: object) => ({ from: 'Horaz', kind: 'insight', at: 1, ...o });
  const pk = parseBotInsight(msg({ topic: 'pk', note: 'PK: /pkclear intento 1', data: { tryNo: 1 } }), 9);
  ok('insight: pk → alerta mala', pk?.topic === 'pk' && pk.alert.kind === 'pk' && pk.alert.tone === 'bad' && pk.alert.char === 'Horaz' && pk.alert.at === 9, pk);
  const st = parseBotInsight(msg({ topic: 'stuck', note: 'trabado 6 min: pared → reintentar', data: null }), 9);
  ok('insight: stuck → alerta warn', st?.topic === 'stuck' && st.alert.kind === 'stuck' && st.alert.tone === 'warn', st);
  ok('insight: pk sin nota → null', parseBotInsight(msg({ topic: 'pk', note: '  ' }), 0) === null);
  const d = parseBotInsight(msg({
    topic: 'data', note: 'dragón Devias',
    data: {
      dragon: { map: 2, name: 'Devias', n: 5, share: 0.8, scope: 'hora' },
      hunt: [{ map: 2, name: 'Devias', minutes: 40.5, boxes: 12, factor: 1.2 }, { map: 'x' }],
      thieves: [{ name: 'Ladron', n: 3 }, { name: '', n: 1 }],
      lethal: [{ map: 3, name: 'Noria', cells: ['4,5', 'malo', '12,3'] }],
      extra: 'no pasa',
    },
  }), 9);
  ok('insight: data completo, filtrado campo por campo', d?.topic === 'data' && d.summary.dragon?.map === 2 && d.summary.hunt.length === 1 && d.summary.thieves.length === 1 && d.summary.lethal[0].cells.join() === '4,5,12,3' && !('extra' in d.summary), d);
  const empty = parseBotInsight(msg({ topic: 'data', note: 'sin datos', data: null }), 9);
  ok('insight: data nulo (el bot recortó por tamaño) → resumen vacío', empty?.topic === 'data' && empty.summary.dragon === null && empty.summary.hunt.length === 0, empty);
  ok('insight: inválidos → null', parseBotInsight(msg({ topic: 'otro', note: 'x' }), 0) === null && parseBotInsight({ from: '', kind: 'insight', topic: 'pk', note: 'x' }, 0) === null && parseBotInsight([], 0) === null && parseBotInsight({ from: 'A', kind: 'corner', topic: 'pk', note: 'x' }, 0) === null);
  const big = parseBotInsight(msg({ topic: 'data', note: 'x'.repeat(500), data: { hunt: Array.from({ length: 100 }, (_, i) => ({ map: i, minutes: 1, boxes: 1, factor: 1 })), thieves: Array.from({ length: 50 }, () => ({ name: 'a', n: 1 })) } }), 0);
  ok('insight: topes de tamaño', big?.topic === 'data' && big.summary.hunt.length === 12 && big.summary.thieves.length === 5 && big.summary.note.length === 120, big);
}

if (fails) process.exit(1);
