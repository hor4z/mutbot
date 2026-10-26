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
  exp: { perMin1: number; perMin5: number };
  nearby: { monsters: number; players: number };
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
  /** Decisiones del bot con su motivo, las más nuevas al final. */
  notes?: { at: number; kind: NoteKind; text: string }[];
  /** desde que arrancó el bot: kills, muertes, skills tirados, exp ganada, loot, skill de ataque actual */
  session?: { since: number; level0: number; kills: number; deaths: number; casts: number; exp: number; loot: number; skill: string };
};

/** Órdenes que acepta el bot. Cualquier otra se rechaza. */
export type PanelCommand =
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  /** ir a Lorencia y quedarse en pausa */
  | { cmd: 'town' };

export const PANEL_COMMANDS = ['pause', 'resume', 'town'] as const;

/** Mensajes bot → panel por el WebSocket. */
export type PanelServerMessage =
  | { type: 'hello'; botVersion: string; commands: readonly string[] }
  | { type: 'panel-state'; state: PanelState }
  | { type: 'command-result'; id: number; ok: boolean; msg: string };

// Campos permitidos por orden: una orden con campos de más se rechaza entera.
const COMMAND_KEYS: Record<(typeof PANEL_COMMANDS)[number], readonly string[]> = {
  pause: ['cmd'], resume: ['cmd'], town: ['cmd'],
};

export function isPanelCommand(v: unknown): v is PanelCommand {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.cmd !== 'string' || !PANEL_COMMANDS.includes(c.cmd as never)) return false;
  const allowed = COMMAND_KEYS[c.cmd as (typeof PANEL_COMMANDS)[number]];
  if (Object.keys(c).some((k) => !allowed.includes(k))) return false;
  return true;
}
