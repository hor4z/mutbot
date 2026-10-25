/**
 * Configuración del bot: flags de la línea de comandos (con su validación), el guard de "solo
 * local" y los ritmos humanos. Se evalúa al importarlo: un flag desconocido o un host no local
 * cortan el proceso antes de abrir ningún socket. Los flags están documentados en la cabecera de
 * headless-bot.ts.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Args + guard de "solo local"
// ---------------------------------------------------------------------------
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(argv[i], next);
      i++;
    } else args.set(argv[i], 'true');
  }
}

// Un flag mal escrito dejaba al bot con defaults colgado esperando LoginResponse: se rechaza al arrancar.
const KNOWN_FLAGS = new Set([
  '--proxy', '--cs-host', '--cs-port', '--user', '--pass', '--char', '--allow-remote', '--exit-if-in-use',
  '--auto-seconds', '--reset-level', '--stat-batch', '--heal-at', '--ws-port', 
]);
const unknownFlags = [...args.keys()].filter((k) => !KNOWN_FLAGS.has(k));
if (unknownFlags.length) {
  console.error(`Flag desconocido: ${unknownFlags.join(', ')}. Los válidos: ${[...KNOWN_FLAGS].join(' ')}`);
  process.exit(2);
}

export const PROXY = args.get('--proxy') ?? 'ws://127.0.0.1:3000';
export const CS_HOST = args.get('--cs-host') ?? '127.0.0.1';
export const CS_PORT = parseInt(args.get('--cs-port') ?? '44405');
// Credenciales: mejor en .env (Bun lo carga solo, está en .gitignore) que en
// la línea de comandos, donde quedan en el historial del shell.
export const USERNAME = args.get('--user') ?? process.env.MUBOT_USER ?? 'test1';
export const PASSWORD = args.get('--pass') ?? process.env.MUBOT_PASS ?? 'test1';
export const CHAR_NAME = args.get('--char') ?? process.env.MUBOT_CHAR ?? 'test1Dk';
// Personaje nuevo (lo escribe la estación en el .env): si CHAR_NAME no está en la cuenta, se crea
// con esta clase (dk, dw, elf, mg). Sin esto, entra con el primero de la lista, como siempre.
// Personaje pedido a propósito (--char o MUBOT_CHAR): si no está en la cuenta y no hay que crearlo,
// el bot corta en vez de entrar con otro (un nombre mal escrito jugaba con el primero de la lista).
export const CREATE_CLASS = process.env.MUBOT_CREATE_CLASS ?? '';
export const CHAR_EXPLICIT = args.has('--char') || !!process.env.MUBOT_CHAR;
const ALLOW_REMOTE = args.has('--allow-remote');

const LOCAL = /^(127\.|localhost$|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const proxyHost = new URL(PROXY).hostname;
if (!ALLOW_REMOTE && !(LOCAL.test(proxyHost) && LOCAL.test(CS_HOST))) {
  console.error(`Rechazado: ${proxyHost} / ${CS_HOST} no parecen locales. Agregá --allow-remote si es tuyo.`);
  process.exit(2);
}

// --exit-if-in-use (lo pasa la estación): ver main() en headless-bot.ts.
export const EXIT_IF_IN_USE = args.has('--exit-if-in-use');
// 0 = sin límite: farmea, resetea y reconecta con backoff.
export const AUTO_SECONDS = parseInt(args.get('--auto-seconds') ?? '600');
// Panel (ws-server.ts); sin el flag no se levanta.
export const WS_PORT_ARG = args.get('--ws-port');
// Diario de acciones en JSONL (journal.ts).

// ---------------------------------------------------------------------------
// Ritmos humanos, NO flood (ver SpeedHackDetectPlugIn: AttackSpeedBaseDelay
// 450ms + token bucket de 5). Ver AGENTS.md, "Anti-cheat": no bajarlos.
//      - paso de caminata: ~380ms (coincide con la velocidad base medida antes)
//      - golpe: ~500ms (por debajo de AttackSpeedBaseDelayMs=450 + margen del
//        token bucket de 5, para quedar cómodo del lado legítimo)
// ---------------------------------------------------------------------------
export const WALK_PACE_MS = 380;
export const ATTACK_PACE_MS = 500;
export const TARGET_NO_KILL_MS = 15_000;
export const UNREACHABLE_MS = 60_000;
export const SKILL_PACE_MS = 900;
// El cliente web tiene cooldown de chat; 2.5s entre comandos queda cómodo.
export const CHAT_PACE_MS = 2500;

// ---------------------------------------------------------------------------
// Farmeo
// ---------------------------------------------------------------------------
export type StatName = 'str' | 'agi' | 'vit' | 'ene';

// En MU el orden de los atributos es fijo: strength, agility, vitality, energy.
// IncreaseCharacterStatPoint.StatType usa exactamente esos mismos índices.
export const STAT_ORDER: StatName[] = ['str', 'agi', 'vit', 'ene'];

export const HEAL_AT_PCT = parseInt(args.get('--heal-at') ?? '60');
// --build str:50,ene:33,vit:17 → reparto proporcional de los puntos libres.
// Sin peso, cada stat pesa 1. Default: el reparto que usó el usuario en su
// tercer reset con un Dark Knight que pelea con Twisting Slash (la energía
// sube el daño de los skills del DK).
// Sin --build se usa planStats (farming.ts), el reparto del agente web.
// Con menos puntos que esto no vale la pena frenar a repartir (3 comandos de
// chat = ~7.5 s sin pelear). El agente web reparte de a 200.
export const STAT_BATCH_MIN = parseInt(args.get('--stat-batch') ?? '200');
export const RESET_LEVEL = parseInt(args.get('--reset-level') ?? '400');

// Skills de ataque configurables (números de skill, NO índices de lista).
// Los defaults son los de Dark Knight / Blade Knight del set clásico.
// Twisting Slash (41) primero: es el skill fijo de Horaz. Rageful Blow (42)
// fuera: el usuario lo descartó (lento). El resto queda para otros personajes.
// Después, los de Dark Wizard: Evil Spirit (9, área alrededor), Ice (7), Energy Ball (17),
// Fire Ball (4), Lightning (3), Meteorite (2), Inferno (14 — mismo número que un DK, se usa el
// que el personaje sepa). Sin esto Melu (DW) no conocía ninguno de la lista y nunca atacaba:
// 0 exp en Devias mientras los Yetis le pegaban (2026-10-10).
const DEFAULT_ATTACK_SKILLS = [41, 19, 49, 14, 15, 40, 43, 45, 46, 47, 50, 51, 55, 9, 7, 17, 4, 3, 2];
export const ATTACK_SKILL_POOL = DEFAULT_ATTACK_SKILLS;
