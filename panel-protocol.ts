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
};

/** Órdenes que acepta el bot. Cualquier otra se rechaza. */
export type PanelCommand =
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'farm' }
  /** cazar dorados; sin map = el mapa con más vivos al alcance según 0xFD */
  | { cmd: 'hunt'; map?: number }
  /** ir a un spot de la ruta (índice de warp: 2 Lorencia, 6 Devias 3, 26 Arena 4, ...) */
  | { cmd: 'warp'; warp: number };

export const PANEL_COMMANDS = ['pause', 'resume', 'farm', 'hunt', 'warp'] as const;

/** Mensajes bot → panel por el WebSocket. */
export type PanelServerMessage =
  | { type: 'hello'; botVersion: string; commands: readonly string[] }
  | { type: 'panel-state'; state: PanelState }
  | { type: 'log'; at: number; text: string }
  | { type: 'command-result'; id: number; ok: boolean; msg: string };

/** Mensaje panel → bot. */
export type PanelClientMessage = { type: 'command'; id: number; command: PanelCommand };

export function isPanelCommand(v: unknown): v is PanelCommand {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (!PANEL_COMMANDS.includes(c.cmd as never)) return false;
  if (c.cmd === 'warp') return Number.isInteger(c.warp) && (c.warp as number) >= 0 && (c.warp as number) < 256;
  if (c.cmd === 'hunt') return c.map === undefined || (Number.isInteger(c.map) && (c.map as number) >= 0 && (c.map as number) < 256);
  return true;
}
