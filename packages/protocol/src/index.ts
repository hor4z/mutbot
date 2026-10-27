/**
 * Contrato entre el bot (headless-bot.ts, vía ws-server.ts) y el panel (ui/). Todo sale del protocolo del juego.
 *
 *   bot ── ws://127.0.0.1:<--ws-port> ──> panel
 *        <── órdenes (lista cerrada) ───
 *
 * El panel nunca manda código: solo `PanelCommand` con un `cmd` de la lista. El bot valida, la aplica en el próximo tick y contesta
 * con `command-result`.
 */

/** Qué está haciendo el bot, en una palabra (para el panel y el log). */
export type BotMode = 'farm' | 'paused' | 'connecting' | 'dead';

/** Tipo de decisión (journal.ts): el panel filtra el feed por esto. */
export type NoteKind = 'spot' | 'travel' | 'flee' | 'stat' | 'loot' | 'order' | 'stuck' | 'death' | 'fight' | 'system';

export type PanelState = {
  at: number;
  mode: BotMode;
  /** frase corta de lo que hace ahora, ej. "peleando con Giant en Lorencia (30,35)" */
  doing: string;
  char: {
    name: string; level: number;
    /** número de clase crudo del protocolo: bits 3-7 del primer byte de apariencia de CharacterList */
    classId?: number;
    hp: [number, number]; mp: [number, number];
    stats: { str: number; agi: number; vit: number; ene: number; cmd?: number };
    points: number; zen: number | null;
  };
  where: { map: number; mapName: string; x: number; y: number; spot?: string | null };
  /** `now`: exp total; `from` y `to`: la exp donde empieza y termina el nivel actual (la barra); `etaMin`: minutos para subir al ritmo de los últimos 5 min. */
  exp: { perMin1: number; perMin5: number; now?: number; from?: number; to?: number; etaMin?: number | null };
  nearby: { monsters: number; players: number };
  /** si el personaje está en una party */
  inParty?: boolean;
  /** últimas ~60 posiciones (una cada 2 s), solo del mapa actual */
  trail?: [number, number][];
  /** punto al que va el bot ahora, si tiene uno */
  camp?: [number, number] | null;
  /** lo que el bot ve en su scope (coordenadas del mapa actual): para dibujar el radar */
  entities?: {
    monsters: { id: number; x: number; y: number; type: number; name: string; target: boolean; value: number }[];
    players: { id: number; x: number; y: number; name?: string }[];
    drops: { x: number; y: number; name: string; money: boolean; valuable: boolean }[];
  };
  /** Plan de puntos: agilidad objetivo y porcentajes del resto. */
  plan?: { agiTarget: number; shares: { str: number; agi: number; vit: number; ene: number }; batch: number };
  /** Lo que lleva: equipo puesto (casillas 0 a 11) y bolsa (12 a 75, grilla de 8 por 8). */
  inventory?: { slot: number; group: number; num: number; name: string; level: number; excellent: boolean; w: number; h: number; kind: 'joya' | 'skill' | 'pocion' | 'equipo' | 'otro' }[];
  /** Chat del personaje (público, party, guild, susurros y avisos del server): las últimas líneas, las más nuevas al final. */
  chat?: ChatEntry[];
  /** Decisiones del bot con su motivo, las más nuevas al final. */
  notes?: { at: number; kind: NoteKind; text: string }[];
  /** desde que arrancó el bot: kills, muertes, skills tirados, exp ganada, loot, skill de ataque actual */
  session?: { since: number; level0: number; kills: number; deaths: number; casts: number; exp: number; loot: number; skill: string };
};

export type ChatChannel = 'normal' | 'party' | 'guild';
export type ChatEntry = { at: number; kind: ChatChannel | 'whisper' | 'server'; from: string; text: string; mine?: boolean };
/** Lo más que cabe en un mensaje de chat (el cliente corta en 60 bytes). */
export const CHAT_MAX_BYTES = 60;

/** Órdenes que acepta el bot. Cualquier otra se rechaza. */
export type PanelCommand =
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  /** ir a Lorencia y quedarse en pausa */
  | { cmd: 'town' }
  /** tirar al suelo el ítem de esa casilla de la bolsa (12 a 75) */
  | { cmd: 'drop'; slot: number }
  /** hablar por el chat: `to` = susurro a ese personaje; si no, `channel` (público por defecto, party o guild) */
  | { cmd: 'say'; text: string; to?: string; channel?: ChatChannel };

export const PANEL_COMMANDS = ['pause', 'resume', 'town', 'drop', 'say'] as const;

/** Mensajes bot → panel por el WebSocket. */
export type PanelServerMessage =
  | { type: 'hello'; botVersion: string; commands: readonly string[] }
  | { type: 'panel-state'; state: PanelState }
  | { type: 'command-result'; id: number; ok: boolean; msg: string };

// Campos permitidos por orden: una orden con campos de más se rechaza entera.
const COMMAND_KEYS: Record<(typeof PANEL_COMMANDS)[number], readonly string[]> = {
  pause: ['cmd'], resume: ['cmd'], town: ['cmd'], drop: ['cmd', 'slot'], say: ['cmd', 'text', 'to', 'channel'],
};

export function isPanelCommand(v: unknown): v is PanelCommand {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.cmd !== 'string' || !PANEL_COMMANDS.includes(c.cmd as never)) return false;
  const allowed = COMMAND_KEYS[c.cmd as (typeof PANEL_COMMANDS)[number]];
  if (Object.keys(c).some((k) => !allowed.includes(k))) return false;
  if (c.cmd === 'drop' && !(Number.isInteger(c.slot) && (c.slot as number) >= 12 && (c.slot as number) < 76)) return false;
  if (c.cmd === 'say') {
    if (typeof c.text !== 'string' || !c.text.trim()) return false;
    if (c.to !== undefined && (typeof c.to !== 'string' || !/^[A-Za-z0-9_ ]{1,10}$/.test(c.to))) return false;
    if (c.channel !== undefined && !['normal', 'party', 'guild'].includes(c.channel as string)) return false;
  }
  return true;
}
