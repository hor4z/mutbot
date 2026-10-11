/**
 * Contrato entre el bot (headless-bot.ts, vía ws-server.ts) y el panel (panel.html).
 * Todo sale del protocolo del juego: el panel funciona igual sin navegador.
 *
 *   bot ── ws://127.0.0.1:<--ws-port> ──> panel
 *        <── órdenes (lista cerrada) ───
 *
 * El panel nunca manda código: solo `PanelCommand` con un `cmd` de la lista. El bot valida y
 * contesta con `command-result`.
 */

/** Qué está haciendo el bot, en una palabra (para el panel y el log). */
export type BotMode = 'farm' | 'hunt' | 'paused' | 'resetting' | 'connecting' | 'dead';

export type MapName = string; // "Lorencia", "Devias", "Arena 4", ... (o "mapa N")

export type EventKey = 'devilSquare' | 'bloodCastle' | 'chaosCastle';

/** Respuesta a la pregunta 0x91 (MiniGameOpeningState). */
export type EventTimer = {
  key: EventKey;
  /** minutos para que abra la entrada; 0 = abierta; null = más de 4 h / desconocido */
  minutes: number | null;
  /** hora absoluta estimada de apertura (ms epoch), o null */
  opensAt: number | null;
  users: number;
  /** cuándo se recibió la respuesta (ms epoch) */
  at: number;
};

/** Paquete propio 0xFD (InvasionMonsters). */
export type Invasion = {
  status: 'active' | 'defeated' | 'none';
  total: number;
  maps: { map: number; name: MapName; alive: number }[];
  at: number;
  /** próxima invasión según el calendario fijo (todas las horas a los :50, 15 min) */
  nextAt: number;
};

export type CycleRecord = {
  start: number;
  /** duración en minutos (null mientras corre) */
  min: number | null;
  /** minuto del ciclo en que llegó a cada nivel hito (20, 50, 100, 200, 300, 350, 400) */
  marks: Record<string, number>;
  tag?: string | null;
};

export type PanelState = {
  at: number;
  mode: BotMode;
  /** frase corta de lo que hace ahora, ej. "acampando en Arena 4 (91,13)" */
  doing: string;
  char: {
    name: string; cls?: string; level: number; resets: number | null;
    /** número de clase crudo del protocolo: bits 3-7 del primer byte de apariencia de CharacterList */
    classId?: number;
    hp: [number, number]; mp: [number, number];
    stats: { str: number; agi: number; vit: number; ene: number; cmd?: number };
    points: number; zen: number | null;
  };
  where: { map: number; mapName: MapName; x: number; y: number; spot?: string | null };
  exp: { perMin1: number; perMin5: number };
  cycle: CycleRecord | null;
  cycles: CycleRecord[];
  /** resets/día proyectados con el promedio de los últimos ciclos sin tag */
  resetsPerDay: number | null;
  events: EventTimer[];
  invasion: Invasion | null;
  /** tickets de eventos en el inventario, ej. { "Devil's Invitation +4": 1 } */
  tickets: Record<string, number>;
  nearby: { monsters: number; players: number };
  /** slots de equipo 0-11 ocupados (del inventario que trackea el bot) */
  equipment?: EquippedItem[];
  /** últimas ~60 posiciones (una cada 2 s), solo del mapa actual */
  trail?: [number, number][];
  /** campamento / punto al que va el bot ahora, si tiene uno */
  camp?: [number, number] | null;
  /** lo que el bot ve en su scope (coordenadas del mapa actual): para dibujar el mapa en el panel */
  entities?: {
    monsters: { id: number; x: number; y: number; type: number; name: string; gold: boolean; target: boolean }[];
    players: { id: number; x: number; y: number }[];
    drops: { x: number; y: number; name: string; money: boolean; valuable: boolean }[];
  };
  /** desde que arrancó el bot: kills, muertes, skills tirados, exp ganada, loot, skill de ataque actual */
  session?: { since: number; level0: number; kills: number; deaths: number; casts: number; exp: number; loot: number; skill: string };
};

export type EquippedItem = { slot: number; group: number; num: number; level: number; excellent: boolean };

/** Órdenes que acepta el bot. Cualquier otra se rechaza. */
export type PanelCommand =
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'farm' }
  /** cazar dorados; sin map = el mapa con más vivos al alcance según 0xFD */
  | { cmd: 'hunt'; map?: number }
  /**
   * chat del personaje: `to` = susurro a ese personaje; si no, `channel` normal (default), party o
   * guild. Texto de 1 a 60 caracteres imprimibles; los comandos ("/...") no se aceptan.
   */
  | { cmd: 'say'; text: string; to?: string; channel?: 'normal' | 'party' | 'guild' }
  /** manda /ranking (el top de resets y ELO de Arena del server); la respuesta llega por el chat */
  | { cmd: 'ranking' }
  /** ir a un spot de la ruta (índice de warp: 2 Lorencia, 6 Devias 3, 26 Arena 4, ...) */
  | { cmd: 'warp'; warp: number };

export const PANEL_COMMANDS = ['pause', 'resume', 'farm', 'hunt', 'warp', 'say', 'ranking'] as const;

/** Mensajes bot → panel por el WebSocket. */
export type PanelServerMessage =
  | { type: 'hello'; botVersion: string; commands: readonly string[] }
  | { type: 'panel-state'; state: PanelState }
  | { type: 'log'; at: number; text: string }
  | { type: 'command-result'; id: number; ok: boolean; msg: string }
  /** una línea de chat (recibida o mandada por el bot) o un aviso del server */
  | { type: 'chat'; at: number; kind: 'normal' | 'party' | 'guild' | 'whisper' | 'server'; from: string; text: string; mine?: boolean };

/** Mensaje panel → bot. */
export type PanelClientMessage = { type: 'command'; id: number; command: PanelCommand };

// Campos permitidos por orden: una orden con campos de más se rechaza entera.
const COMMAND_KEYS: Record<(typeof PANEL_COMMANDS)[number], readonly string[]> = {
  pause: ['cmd'], resume: ['cmd'], farm: ['cmd'], hunt: ['cmd', 'map'], warp: ['cmd', 'warp'], say: ['cmd', 'text', 'to', 'channel'], ranking: ['cmd'],
};

export function isPanelCommand(v: unknown): v is PanelCommand {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.cmd !== 'string' || !PANEL_COMMANDS.includes(c.cmd as never)) return false;
  const allowed = COMMAND_KEYS[c.cmd as (typeof PANEL_COMMANDS)[number]];
  if (Object.keys(c).some((k) => !allowed.includes(k))) return false;
  if (c.cmd === 'say') {
    // Imprimible latin1 (sin controles), 1-60, sin comandos del server.
    if (typeof c.text !== 'string' || !/^[\x20-\x7e\xa0-\xff]{1,60}$/.test(c.text) || c.text.trimStart().startsWith('/')) return false;
    if (c.to !== undefined && (typeof c.to !== 'string' || !/^[A-Za-z0-9_]{1,10}$/.test(c.to))) return false;
    if (c.channel !== undefined && !['normal', 'party', 'guild'].includes(c.channel as string)) return false;
    return !(c.to !== undefined && c.channel !== undefined && c.channel !== 'normal');
  }
  if (c.cmd === 'warp') return Number.isInteger(c.warp) && (c.warp as number) >= 0 && (c.warp as number) < 256;
  const isMap = (m: unknown) => m === undefined || (Number.isInteger(m) && (m as number) >= 0 && (m as number) < 256);
  if (c.cmd === 'hunt') return isMap(c.map);
  return true;
}
