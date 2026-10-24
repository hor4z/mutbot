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

/** Paquete propio 0xFD (InvasionMonsters). */
export type Invasion = {
  status: 'active' | 'defeated' | 'none';
  total: number;
  maps: { map: number; name: MapName; alive: number }[];
  at: number;
  /** próxima invasión según el calendario fijo (todas las horas a los :50, 15 min) */
  nextAt: number;
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
  invasion: Invasion | null;
  nearby: { monsters: number; players: number };
  /** últimas ~60 posiciones (una cada 2 s), solo del mapa actual */
  trail?: [number, number][];
  /** campamento / punto al que va el bot ahora, si tiene uno */
  camp?: [number, number] | null;
  /** lo que el bot ve en su scope (coordenadas del mapa actual): para dibujar el mapa en el panel */
  entities?: {
    monsters: { id: number; x: number; y: number; type: number; name: string; gold: boolean; target: boolean }[];
    /** name: el del paquete del server (sin verificar en todos los casos); mate: compañero (MUBOT_MATES) */
    players: { id: number; x: number; y: number; name?: string; mate?: boolean }[];
    drops: { x: number; y: number; name: string; money: boolean; valuable: boolean }[];
  };
  /** zonas donde se vieron dragones en este mapa (de la base, v_dragon_zones): n = avistamientos */
  zones?: { x: number; y: number; n: number }[];
  /** desde que arrancó el bot: kills, muertes, skills tirados, exp ganada, loot, skill de ataque actual */
  /** últimas decisiones del bot (dorado visto, cacería, aviso al equipo, trabas...), las más nuevas al final */
  notes?: { at: number; text: string }[];
  session?: { since: number; level0: number; kills: number; deaths: number; casts: number; exp: number; loot: number; skill: string };
  /**
   * Opcionales (los llena quien los tenga; un bot viejo no los manda y la vista usa defaults):
   * celdas letales / zonas de muertes del mapa actual (n = muertes vistas) …
   */
  hazards?: { x: number; y: number; n: number }[];
  /** … miembros de escuadra / scouts en cualquier mapa … */
  squad?: { name: string; map: number; x: number; y: number; role?: string }[];
  /** … y skills con su espera (readyAt = ms epoch en que vuelve a estar listo; ausente = listo). */
  skills?: { name: string; readyAt?: number; current?: boolean }[];
};

/** Órdenes que acepta el bot. Cualquier otra se rechaza. */
export type PanelCommand =
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'farm' }
  /** cazar dorados; sin map = el mapa con más vivos al alcance según 0xFD */
  | { cmd: 'hunt'; map?: number };

export const PANEL_COMMANDS = ['pause', 'resume', 'farm', 'hunt'] as const;

/** Mensajes bot → panel por el WebSocket. */
export type PanelServerMessage =
  | { type: 'hello'; botVersion: string; commands: readonly string[] }
  | { type: 'panel-state'; state: PanelState }
  | { type: 'command-result'; id: number; ok: boolean; msg: string };

// Campos permitidos por orden: una orden con campos de más se rechaza entera.
const COMMAND_KEYS: Record<(typeof PANEL_COMMANDS)[number], readonly string[]> = {
  pause: ['cmd'], resume: ['cmd'], farm: ['cmd'], hunt: ['cmd', 'map'],
};

export function isPanelCommand(v: unknown): v is PanelCommand {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.cmd !== 'string' || !PANEL_COMMANDS.includes(c.cmd as never)) return false;
  const allowed = COMMAND_KEYS[c.cmd as (typeof PANEL_COMMANDS)[number]];
  if (Object.keys(c).some((k) => !allowed.includes(k))) return false;
  const inRange = (m: unknown) => Number.isInteger(m) && (m as number) >= 0 && (m as number) < 256;
  if (c.cmd === 'hunt') return c.map === undefined || inRange(c.map);
  return true;
}
