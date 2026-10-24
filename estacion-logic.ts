/**
 * Lógica pura de la estación (estacion.ts): qué personajes hay, con qué argumentos se lanza el bot,
 * qué órdenes del panel arman cada rutina y qué pedidos del navegador se aceptan. Sin red ni
 * procesos: se testea en estacion-tests.ts.
 */
import { isPanelCommand, type PanelCommand } from './panel-protocol';
import { validCharName } from './names';

/**
 * Un personaje: de un archivo de env (`.env`, `.env.melu`, ... con MUBOT_USER/PASS/CHAR) o del
 * de la base (`estacion-db.ts`; `envFile` = de qué `.env` se importó; `cls` si hay que crearlo al entrar).
 */
export type CharConfig = { key: string; envFile: string | null; user: string; char: string; cls?: CharClassKey };

/**
 * Lee un archivo de env (formato de Bun: KEY=valor, comentarios con #, comillas opcionales).
 * Solo devuelve lo que la estación necesita saber; la contraseña la lee el bot, no la estación.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Archivos de env que son personajes: `.env` y `.env.<algo>`, salvo `.env.example`. */
export function isCharEnvFile(name: string): boolean {
  return name === '.env' || (/^\.env\.[A-Za-z0-9_-]+$/.test(name) && name !== '.env.example');
}

/** Personaje de un archivo de env, o null si le falta usuario, contraseña o personaje. */
export function charFromEnv(envFile: string, text: string): CharConfig | null {
  const e = parseEnvFile(text);
  if (!e.MUBOT_USER || !e.MUBOT_PASS || !e.MUBOT_CHAR) return null;
  return { key: e.MUBOT_CHAR.toLowerCase(), envFile, user: e.MUBOT_USER, char: e.MUBOT_CHAR };
}

/** Servidor del juego: el de siempre (PLAN-SIN-NAVEGADOR.md), cambiable por env de la estación. */
export type GameServer = { proxy: string; csHost: string; csPort: number };
export const DEFAULT_SERVER: GameServer = { proxy: 'wss://mu.mormon.garden/ws', csHost: 'mu.mormon.garden', csPort: 44405 };

/**
 * Argumentos de `bun` para lanzar el bot de un personaje. La clave nunca va en la línea de comandos
 * (se ve en `ps`): la estación la pasa por MUBOT_PASS. `--exit-if-in-use`: si la cuenta ya está
 * conectada (la pestaña del navegador), el bot sale con código 3 en vez de insistir. Sin él (recién
 * desconectado desde la estación) espera y reintenta: el server tarda en soltar la sesión vieja.
 */
export function botArgs(c: CharConfig, wsPort: number, server: GameServer, botFile: string, exitIfInUse = true): string[] {
  // Cuenta y personaje de la base (estacion-db.ts) en la línea de comandos (no son secretos); la clave
  // va por MUBOT_PASS. `--env-file=/dev/null` para que Bun no cargue el `.env` de la raíz (otro personaje).
  const who = ['--env-file=/dev/null', 'run', botFile, '--user', c.user, '--char', c.char];
  return [
    ...who,
    '--allow-remote', '--proxy', server.proxy, '--cs-host', server.csHost, '--cs-port', String(server.csPort),
    '--auto-seconds', '0', '--ws-port', String(wsPort), ...(exitIfInUse ? ['--exit-if-in-use'] : []),
  ];
}

/** Rutinas que se eligen en la estación. Cada una es una secuencia de órdenes del panel. */
export type Routine =
  | { kind: 'farm' }
  | { kind: 'spot'; warp: number }
  /** cazar dorados (donde haya más vivos según 0xFD) */
  | { kind: 'hunt' }
  | { kind: 'pause' };

export const ROUTINE_KINDS = ['farm', 'spot', 'hunt', 'pause'] as const;

export function isRoutine(v: unknown): v is Routine {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r.kind === 'spot') return keys.every((k) => k === 'kind' || k === 'warp') && Number.isInteger(r.warp) && (r.warp as number) >= 0 && (r.warp as number) < 256;
  return (r.kind === 'farm' || r.kind === 'hunt' || r.kind === 'pause') && keys.length === 1;
}

/** Órdenes del panel que ponen al bot en esa rutina (todas pasan por isPanelCommand). */
export function routineCommands(r: Routine): PanelCommand[] {
  switch (r.kind) {
    case 'farm': return [{ cmd: 'farm' }];
    case 'spot': return [{ cmd: 'warp', warp: r.warp }];
    case 'hunt': return [{ cmd: 'hunt' }];
    case 'pause': return [{ cmd: 'pause' }];
  }
}

export function routineLabel(r: Routine): string {
  switch (r.kind) {
    case 'farm': return 'farmear por la ruta';
    case 'spot': return `farmear fijo en el warp ${r.warp}`;
    case 'hunt': return 'cazar dorados';
    case 'pause': return 'en pausa';
  }
}

/** Estado de un personaje en la estación. */
export type CharStatus = 'off' | 'starting' | 'on' | 'stopping' | 'in-use' | 'failed' | 'external';

/** Cómo se lee la salida del bot. */
export function exitStatus(code: number | null): { status: CharStatus; msg: string } {
  if (code === 6) return { status: 'failed', msg: 'el personaje no está en la cuenta (¿nombre mal escrito?) o el server no dejó crearlo (¿nombre tomado o clase bloqueada?). Mirá la consola.' };
  if (code === 3) return { status: 'in-use', msg: 'la cuenta ya está conectada en otro lado (¿la pestaña del navegador?). Cerrala y volvé a conectar.' };
  if (code === 4) return { status: 'failed', msg: 'el server bloqueó la cuenta (AccountBlocked): no la vuelvo a conectar. Consultá a los admins.' };
  if (code === 5) return { status: 'failed', msg: 'el server rechazó el login (clave, cuenta o versión): revisá el .env del personaje.' };
  if (code === 0 || code === null) return { status: 'off', msg: 'desconectado' };
  if (code === 2) return { status: 'failed', msg: 'el bot no arrancó: flag desconocido o servidor no local sin --allow-remote (mirá la consola)' };
  return { status: 'failed', msg: `el bot terminó con error (código ${code}); mirá la consola` };
}

/**
 * Pedido del navegador a la estación: `{ action, char, routine? }`. Todo lo demás se rechaza.
 * Las órdenes que no son de rutina (cazar, ir a un spot puntual) siguen yendo por el panel del bot.
 */
export type StationRequest =
  | { action: 'connect'; char: string; routine: Routine }
  | { action: 'disconnect'; char: string }
  | { action: 'routine'; char: string; routine: Routine }
  // Estrategia del personaje: se guarda y, si está en el juego, se aplica.
  | { action: 'role'; char: string; role: RoleAssign }
  | NewCharRequest
  | { action: 'add'; user: string; char: string; cls: CharClassKey | null }
  // Personajes de una cuenta del server (el bot entra con --list-chars y sale). Sin `pass`, la de la base.
  | { action: 'probe'; user: string; pass?: string }
  ;

/**
 * Personaje nuevo desde la estación: cuenta (se registra en el server salvo `existing`), nombre y
 * clase. Va al almacén de cuentas (`accounts.ts`) y el bot crea el personaje al entrar.
 */
export type NewCharRequest = { action: 'create'; user: string; pass: string; char: string; cls: CharClassKey | null; existing: boolean };

/**
 * Clases que se pueden crear en este server (0.97d) y su número de red (`CharacterClassNumber` del
 * cliente; el packet lo lleva corrido 2 bits). MG pide un personaje de nivel alto en la cuenta.
 */
export const CHAR_CLASSES = {
  dk: { id: 4, label: 'Dark Knight' },
  dw: { id: 0, label: 'Dark Wizard' },
  elf: { id: 8, label: 'Fairy Elf' },
  mg: { id: 12, label: 'Magic Gladiator' },
} as const;
export type CharClassKey = keyof typeof CHAR_CLASSES;
export const isCharClass = (v: unknown): v is CharClassKey => typeof v === 'string' && Object.hasOwn(CHAR_CLASSES, v);

/** Cuenta y clave como las valida el registro del cliente web. Devuelve el motivo o null. */
export function accountProblem(user: string, pass: string): string | null {
  if (!/^[A-Za-z0-9]{4,10}$/.test(user)) return 'la cuenta tiene que tener de 4 a 10 letras o números';
  if (pass.length < 4 || pass.length > 10) return 'la clave tiene que tener de 4 a 10 caracteres';
  if (!/^[!-~]+$/.test(pass)) return 'la clave solo puede tener caracteres visibles, sin espacios ni acentos';
  return null;
}


export function parseStationRequest(v: unknown): StationRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.action === 'create') {
    const keys = Object.keys(r).sort().join();
    if (keys !== 'action,char,cls,existing,pass,user') return null;
    if (typeof r.user !== 'string' || typeof r.pass !== 'string' || typeof r.char !== 'string' || typeof r.existing !== 'boolean') return null;
    // Clase null = el personaje ya existe en el server (solo con una cuenta que ya existe).
    if (accountProblem(r.user, r.pass) || !validCharName(r.char) || !(isCharClass(r.cls) || (r.cls === null && r.existing))) return null;
    return { action: 'create', user: r.user, pass: r.pass, char: r.char, cls: r.cls, existing: r.existing };
  }
  if (r.action === 'probe') {
    const keys = Object.keys(r).sort().join();
    if (keys !== 'action,user' && keys !== 'action,pass,user') return null;
    if (typeof r.user !== 'string') return null;
    if (keys === 'action,user') return /^[A-Za-z0-9]{4,10}$/.test(r.user) ? { action: 'probe', user: r.user } : null;
    if (typeof r.pass !== 'string' || accountProblem(r.user, r.pass)) return null;
    return { action: 'probe', user: r.user, pass: r.pass };
  }
  // Otro personaje en una cuenta que ya está en la base: la clave la pone la estación.
  if (r.action === 'add') {
    if (Object.keys(r).sort().join() !== 'action,char,cls,user') return null;
    if (typeof r.user !== 'string' || !/^[A-Za-z0-9]{4,10}$/.test(r.user) || typeof r.char !== 'string' || !validCharName(r.char) || !(isCharClass(r.cls) || r.cls === null)) return null;
    return { action: 'add', user: r.user, char: r.char, cls: r.cls };
  }
  if (typeof r.char !== 'string' || !/^[a-z0-9_]{1,10}$/.test(r.char)) return null;
  const keys = Object.keys(r);
  if (r.action === 'role') return keys.length === 3 && isRoleAssign(r.role) ? { action: 'role', char: r.char, role: r.role } : null;
  if (r.action === 'disconnect') return keys.length === 2 ? { action: 'disconnect', char: r.char } : null;
  if (r.action === 'connect' || r.action === 'routine') {
    if (keys.length !== 3 || !isRoutine(r.routine)) return null;
    return { action: r.action, char: r.char, routine: r.routine };
  }
  return null;
}

// --- Estrategias (roles) -------------------------------------------------------------------------

/**
 * Estrategia de un personaje. La estación la guarda (estacion-db.ts) y la traduce a una rutina
 * (`roleRoutine`); el explorador y el soporte además cumplen una función de equipo:
 *  - golden: cazador de dorados (`hunt`).
 *  - route: farmea por la ruta automática (`farm`).
 *  - spot: farmea fijo en un warp.
 *  - explorer: recorre campos por la ruta y AVISA lo que ve (POST /api/team con kind 'scout').
 *  - support: acompaña a los demás en party (la party entre compañeros ya es automática).
 */
export type RoleAssign =
  | { role: 'golden' | 'route' | 'explorer' | 'support' }
  | { role: 'spot'; warp: number };
export type RoleKey = RoleAssign['role'];

export const ROLES: Record<RoleKey, { label: string; short: string; hint: string }> = {
  golden: { label: 'Cazador de dorados', short: 'Dorados', hint: 'Va donde haya dorados e invasiones y los caza.' },
  route: { label: 'Farmeo por la ruta', short: 'Ruta', hint: 'Sigue la ruta automática de spots según su nivel.' },
  spot: { label: 'Spot fijo', short: 'Spot', hint: 'Se queda en un mapa elegido, sin cambiar.' },
  explorer: { label: 'Explorador', short: 'Explora', hint: 'Recorre campos y avisa a los otros qué hay: dorados, gente, zonas calientes.' },
  support: { label: 'Soporte / party', short: 'Soporte', hint: 'Juega en party con los compañeros y los acompaña.' },
};
export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

export function isRoleAssign(v: unknown): v is RoleAssign {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r.role === 'spot') return keys.every((k) => k === 'role' || k === 'warp') && Number.isInteger(r.warp) && (r.warp as number) >= 0 && (r.warp as number) < 256;
  return ROLE_KEYS.includes(r.role as RoleKey) && r.role !== 'spot' && keys.length === 1;
}

/** Rutina que ejecuta el bot para cada estrategia. */
export function roleRoutine(a: RoleAssign): Routine {
  switch (a.role) {
    case 'golden': return { kind: 'hunt' };
    case 'spot': return { kind: 'spot', warp: a.warp };
    default: return { kind: 'farm' };
  }
}

export function roleLabel(a: RoleAssign): string {
  return a.role === 'spot' ? `${ROLES.spot.label} (warp ${a.warp})` : ROLES[a.role].label;
}

/** Estrategia que corresponde a una rutina vieja (personajes sin rol guardado). */
export function roleFromRoutine(r: Routine | null): RoleAssign {
  if (r?.kind === 'hunt') return { role: 'golden' };
  if (r?.kind === 'spot') return { role: 'spot', warp: r.warp };
  return { role: 'route' };
}

// --- Alertas de la flota ----------------------------------------------------------------------------

export type AlertKind = 'gold' | 'invasion' | 'death' | 'pk' | 'blocked' | 'bagfull' | 'stuck' | 'status' | 'level';
export type AlertTone = 'info' | 'good' | 'warn' | 'bad';
export type Alert = { id: number; at: number; kind: AlertKind; tone: AlertTone; char: string | null; text: string };
export const MAX_ALERTS = 120;
/** Un bot que farmea o caza y no se mueve ni cambia de actividad este tiempo, está trabado. */
export const STUCK_MS = 5 * 60_000;
/** Bolsa "llena": casillas ocupadas / 64. */
export const BAG_FULL = 0.92;

/** Lo que la estación mira de cada personaje para detectar cambios. */
export type CharSnap = {
  key: string; char: string; status: CharStatus; account: string;
  mode: string | null; doing: string | null; map: string | null; x: number | null; y: number | null;
  level: number | null; deaths: number | null; bag: number | null;
};

/** Casillas ocupadas de la bolsa (0-1) a partir de los ítems del bot (grilla de 8×8). */
export function bagUsage(items: { w?: number; h?: number }[] | undefined): number | null {
  if (!items) return null;
  return Math.min(1, items.reduce((n, i) => n + (i.w ?? 1) * (i.h ?? 1), 0) / 64);
}

/** Memoria del detector de alertas (la estación la guarda entre vueltas). */
export type AlertMemory = { prev: Map<string, CharSnap>; movedAt: Map<string, number>; stuck: Set<string> };
export const newAlertMemory = (): AlertMemory => ({ prev: new Map(), movedAt: new Map(), stuck: new Set() });

/** Compara el estado nuevo con el anterior y devuelve las alertas (sin id: lo pone `pushAlert`). */
export function diffAlerts(mem: AlertMemory, cur: CharSnap[], now: number): Omit<Alert, 'id'>[] {
  const out: Omit<Alert, 'id'>[] = [];
  const add = (kind: AlertKind, tone: AlertTone, char: string | null, text: string) => out.push({ at: now, kind, tone, char, text });
  for (const c of cur) {
    const p = mem.prev.get(c.key);
    if (p) {
      if (p.status !== c.status) {
        if (c.status === 'on') add('status', 'good', c.char, `${c.char} entró al juego`);
        else if (c.status === 'failed') add('blocked', 'bad', c.char, `${c.char} no pudo entrar`);
        else if (c.status === 'in-use') add('blocked', 'warn', c.char, `${c.char}: la cuenta está abierta en otro lado`);
        else if (c.status === 'off' && (p.status === 'on' || p.status === 'stopping')) add('status', 'info', c.char, `${c.char} se desconectó`);
      }
      if (c.account === 'blocked' && p.account !== 'blocked') add('blocked', 'bad', c.char, `La cuenta de ${c.char} quedó bloqueada por el server`);
      if (p.deaths != null && c.deaths != null && c.deaths > p.deaths) add('death', 'bad', c.char, `${c.char} murió${c.map ? ` en ${c.map}` : ''} (${c.deaths} en la sesión)`);
      if (p.level != null && c.level != null && c.level > p.level && c.level - p.level < 20) add('level', 'good', c.char, `${c.char} subió a nivel ${c.level}`);
      if (c.bag != null && c.bag >= BAG_FULL && (p.bag ?? 0) < BAG_FULL) add('bagfull', 'warn', c.char, `${c.char} tiene la bolsa casi llena`);
    }
    const active = c.status === 'on' && (c.mode === 'farm' || c.mode === 'hunt');
    const moved = !p || p.x !== c.x || p.y !== c.y || p.map !== c.map || p.doing !== c.doing || !active;
    if (moved || !mem.movedAt.has(c.key)) mem.movedAt.set(c.key, now);
    const frozen = active && now - (mem.movedAt.get(c.key) ?? now) >= STUCK_MS;
    if (frozen && !mem.stuck.has(c.key)) {
      mem.stuck.add(c.key);
      add('stuck', 'warn', c.char, `${c.char} parece trabado: hace ${Math.round(STUCK_MS / 60_000)} min que no se mueve`);
    } else if (!frozen) mem.stuck.delete(c.key);
    mem.prev.set(c.key, c);
  }
  return out;
}

/** Agrega una alerta a la lista (la más nueva primero, tope MAX_ALERTS) numerándola. */
export function pushAlert(list: Alert[], a: Omit<Alert, 'id'>) {
  const id = (list[0]?.id ?? 0) + 1;
  list.unshift({ ...a, id });
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
}

/** Aviso de un bot (POST /api/alert, solo sin Origin): `{ from, kind: 'pk'|'bagfull'|'stuck', text }`. */
export function parseBotAlert(body: unknown, now: number): Omit<Alert, 'id'> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const from = typeof b.from === 'string' ? b.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) : '';
  if (!from || (b.kind !== 'pk' && b.kind !== 'bagfull' && b.kind !== 'stuck') || typeof b.text !== 'string') return null;
  const text = b.text.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120);
  if (!text) return null;
  return { at: now, kind: b.kind, tone: b.kind === 'pk' ? 'bad' : 'warn', char: from, text };
}

/** Puerto del panel de cada bot: 8791, 8792, ... (8787 la estación, 8788 el agente del navegador). */
export const BOT_PORT_BASE = 8791;

/**
 * ¿Ya corre un bot con esa cuenta? A partir del cmdline y del environ de un proceso (de /proc).
 * Bun carga el env-file por dentro (no aparece en /proc/<pid>/environ), así que se mira en orden:
 * `--user <u>`, `--env-file=<archivo>`, MUBOT_USER del entorno y, si no hay nada, el `.env` de la
 * raíz (lo que carga `bun run bot`).
 */
export function processRunsAccount(cmdline: string[], environ: string[], c: CharConfig): boolean {
  if (!cmdline.some((a) => a.endsWith('headless-bot.ts'))) return false;
  const u = cmdline.indexOf('--user');
  if (u >= 0) {
    const ch = cmdline.indexOf('--char');
    return cmdline[u + 1] === c.user && (ch < 0 || cmdline[ch + 1] === c.char);
  }
  const ef = cmdline.findIndex((a) => a === '--env-file' || a.startsWith('--env-file='));
  if (ef >= 0) {
    const file = cmdline[ef].includes('=') ? cmdline[ef].slice('--env-file='.length) : cmdline[ef + 1] ?? '';
    return file.split('/').pop() === c.envFile;
  }
  const env = environ.find((e) => e.startsWith('MUBOT_USER='));
  if (env) return env === `MUBOT_USER=${c.user}`;
  return c.envFile === '.env';
}

// Sanity: las órdenes de las rutinas tienen que pasar el filtro del bot.
for (const r of [{ kind: 'farm' }, { kind: 'spot', warp: 26 }, { kind: 'hunt' }, { kind: 'pause' }] as Routine[])
  for (const c of routineCommands(r)) if (!isPanelCommand(c)) throw new Error(`rutina ${r.kind}: orden inválida ${JSON.stringify(c)}`);

/** Tras desconectar desde la estación, cuánto se considera que la sesión vieja puede seguir abierta. */
export const RECENT_STOP_MS = 90_000;

/** Señal de dorado (de un bot sin navegador o del navegador si el usuario juega ahí). */
export type GoldSignal = { from: string; map: number; x: number; y: number; name: string; id: number; at: number };
export const GOLD_TTL_MS = 60_000;
/** Origen del juego en el navegador: puede mandar señales (POST /api/gold) con CORS. */
export const GAME_ORIGIN = 'https://mu.mormon.garden';

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Aplica una señal `{ from, map, x, y, name, id }` (visto/movido) o `{ from, map, id, gone: true }` al
 * registro de avistamientos (clave from:id). Devuelve false si el cuerpo no es válido.
 */
export function applyGoldSignal(golds: Map<string, GoldSignal>, body: unknown, now: number): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const g = body as Record<string, unknown>;
  const from = typeof g.from === 'string' ? g.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20) : '';
  if (!from || !num(g.map, 0, 255) || !num(g.id, 0, 65535)) return false;
  const key = `${from}:${g.id}`;
  if (g.gone === true) {
    golds.delete(key);
    return true;
  }
  if (!num(g.x, 0, 255) || !num(g.y, 0, 255)) return false;
  golds.set(key, { from, map: g.map, x: g.x, y: g.y, name: String(g.name ?? '').slice(0, 40), id: g.id, at: now });
  return true;
}

/** Avistamientos vigentes (los de más de GOLD_TTL_MS se borran). */
export function freshGolds(golds: Map<string, GoldSignal>, now: number): GoldSignal[] {
  for (const [k, g] of golds) if (now - g.at > GOLD_TTL_MS) golds.delete(k);
  return [...golds.values()].sort((a, b) => b.at - a.at);
}

/** Pedido de ayuda entre personajes propios (equipo, ver team.ts). */
export type TeamRequest = { from: string; kind: 'golden'; map: number; x: number; y: number; note: string; at: number };
export const TEAM_REQUEST_TTL_MS = 2 * 60_000;

/** Valida un pedido de ayuda de un bot; null si no es válido. */
export function parseTeamRequest(body: unknown, now: number): TeamRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const from = typeof b.from === 'string' ? b.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) : '';
  if (!from || b.kind !== 'golden' || !num(b.map, 0, 255) || !num(b.x, 0, 255) || !num(b.y, 0, 255)) return null;
  return { from, kind: b.kind, map: b.map, x: b.x, y: b.y, note: String(b.note ?? '').slice(0, 80), at: now };
}

// --- Insights de los bots (POST /api/team con kind 'insight') ----------------------------------------

export type InsightSummary = {
  from: string; at: number; note: string;
  dragon: { map: number; name: string; n: number; share: number; scope: string } | null;
  hunt: { map: number; name: string; minutes: number; boxes: number; factor: number }[];
  thieves: { name: string; n: number }[];
  lethal: { map: number; name: string; cells: string[] }[];
};
export type BotInsight =
  | { topic: 'pk' | 'stuck'; alert: Omit<Alert, 'id'> }
  | { topic: 'data'; summary: InsightSummary };

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max) : '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * Valida un insight de un bot (`{from,kind:'insight',topic,note,data,at}`); null si no es válido.
 * pk/stuck → una alerta del feed; data → el resumen (dragón probable, cacería por mapa, ladrones, celdas letales)
 * con todo acotado y copiado campo por campo (nada del bot pasa tal cual). `data` malo o ausente → resumen vacío.
 */
export function parseBotInsight(body: unknown, now: number): BotInsight | null {
  if (!isObj(body) || body.kind !== 'insight') return null;
  const from = typeof body.from === 'string' ? body.from.replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) : '';
  const note = clean(body.note, 120);
  if (!from) return null;
  if (body.topic === 'pk' || body.topic === 'stuck') {
    if (!note) return null;
    return { topic: body.topic, alert: { at: now, kind: body.topic, tone: body.topic === 'pk' ? 'bad' : 'warn', char: from, text: note } };
  }
  if (body.topic !== 'data') return null;
  const d = isObj(body.data) ? body.data : {};
  const dr = isObj(d.dragon) ? d.dragon : null;
  const summary: InsightSummary = {
    from, at: now, note,
    dragon: dr && fin(dr.map, 0, 255) ? { map: dr.map, name: clean(dr.name, 24) || `mapa ${dr.map}`, n: fin(dr.n, 0, 1e6) ? dr.n : 0, share: fin(dr.share, 0, 1) ? dr.share : 0, scope: clean(dr.scope, 12) } : null,
    hunt: [], thieves: [], lethal: [],
  };
  for (const h of list(d.hunt, 12)) {
    if (isObj(h) && fin(h.map, 0, 255)) summary.hunt.push({ map: h.map, name: clean(h.name, 24) || `mapa ${h.map}`, minutes: fin(h.minutes, 0, 1e7) ? h.minutes : 0, boxes: fin(h.boxes, 0, 1e7) ? h.boxes : 0, factor: fin(h.factor, 0, 10) ? h.factor : 1 });
  }
  for (const t of list(d.thieves, 5)) {
    const name = isObj(t) ? clean(t.name, 16) : '';
    if (name && isObj(t) && fin(t.n, 0, 1e6)) summary.thieves.push({ name, n: t.n });
  }
  for (const l of list(d.lethal, 8)) {
    if (!isObj(l) || !fin(l.map, 0, 255)) continue;
    const cells = list(l.cells, 12).filter((c): c is string => typeof c === 'string' && /^\d{1,3},\d{1,3}$/.test(c));
    summary.lethal.push({ map: l.map, name: clean(l.name, 24) || `mapa ${l.map}`, cells });
  }
  return { topic: 'data', summary };
}
