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
} from './estacion-logic';

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
  ok('args: env-file primero (credenciales fuera de la línea de comandos)', a[0] === '--env-file=.env' && !a.some((x) => /pass/i.test(x)), a);
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

console.log(fails ? `\n${fails} FALLARON` : '\nTodo OK');
if (fails) process.exit(1);
