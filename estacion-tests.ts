/**
 * Tests offline de estacion-logic.ts: personajes desde los .env, argumentos del bot, rutinas,
 * pedidos del navegador y detección de bots que ya corren. Sin red ni procesos.
 *
 *   bun run estacion-tests.ts
 */
import { isPanelCommand } from './panel-protocol';
import {
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
  const e = parseEnvFile('# cuenta\nMUBOT_USER=horaz\nexport MUBOT_PASS="se cr=et"\n\nMUBOT_CHAR = \'Horaz\'\nbasura\n');
  ok('env: valores, comillas, export y espacios', e.MUBOT_USER === 'horaz' && e.MUBOT_PASS === 'se cr=et' && e.MUBOT_CHAR === 'Horaz', e);
  ok('env: archivos de personaje', isCharEnvFile('.env') && isCharEnvFile('.env.melu') && !isCharEnvFile('.env.example') && !isCharEnvFile('.envrc') && !isCharEnvFile('x.env'));
  const c = charFromEnv('.env.melu', 'MUBOT_USER=melu\nMUBOT_PASS=x\nMUBOT_CHAR=Melu\n');
  ok('env: personaje con clave en minúscula', c?.key === 'melu' && c.char === 'Melu' && c.envFile === '.env.melu', c);
  ok('env: sin contraseña no es personaje', charFromEnv('.env', 'MUBOT_USER=a\nMUBOT_CHAR=b') === null);
}

// --- argumentos del bot -------------------------------------------------------------------
const horaz: CharConfig = { key: 'horaz', envFile: '.env', user: 'horaz', char: 'Horaz' };
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
  ok('rutina: atlas corta lo anterior con farm', JSON.stringify(routineCommands({ kind: 'atlas' })) === '[{"cmd":"farm"},{"cmd":"atlas"}]');
  ok('rutina: todas las órdenes pasan isPanelCommand',
    [{ kind: 'farm' }, { kind: 'spot', warp: 7 }, { kind: 'atlas' }, { kind: 'pause' }].every((r) => routineCommands(r as never).every(isPanelCommand)));
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
  const melu: CharConfig = { key: 'melu', envFile: '.env.melu', user: 'melu', char: 'Melu' };
  const bot = ['bun', 'run', 'headless-bot.ts', '--ws-port', '8787'];
  ok('proc: otro programa no cuenta', !processRunsAccount(['bun', 'run', 'proxy.ts'], [], horaz));
  ok('proc: --env-file del personaje', processRunsAccount(['bun', '--env-file=.env.melu', ...bot.slice(1)], [], melu)
    && !processRunsAccount(['bun', '--env-file=.env.melu', ...bot.slice(1)], [], horaz));
  ok('proc: --env-file con ruta', processRunsAccount(['bun', '--env-file', '/home/x/mubot/.env.melu', ...bot.slice(1)], [], melu));
  ok('proc: --user manda', processRunsAccount([...bot, '--user', 'melu'], ['MUBOT_USER=horaz'], melu));
  ok('proc: MUBOT_USER del entorno', processRunsAccount(bot, ['MUBOT_USER=melu'], melu) && !processRunsAccount(bot, ['MUBOT_USER=melu'], horaz));
  ok('proc: sin nada = .env de la raíz', processRunsAccount(bot, [], horaz) && !processRunsAccount(bot, [], melu));
}

// --- salida del bot -----------------------------------------------------------------------
ok('salida: 3 = cuenta abierta en otro lado', exitStatus(3).status === 'in-use');
ok('salida: 0 = desconectado', exitStatus(0).status === 'off');
ok('salida: 1 = error', exitStatus(1).status === 'failed');

console.log(fails ? `\n${fails} FALLARON` : '\nTodo OK');
if (fails) process.exit(1);
