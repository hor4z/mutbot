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

import type { SalesPlan } from './commerce-plan';

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
  /** pinned: spot fijo elegido desde el panel (la ruta no lo cambia hasta "farm") */
  where: { map: number; mapName: MapName; x: number; y: number; spot?: string | null; pinned?: boolean };
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
  /** último plan de la orden `equipplan` (solo mostrar); se borra al ejecutar `equip` */
  equipPlan?: EquipPlanView | null;
  /** slots de equipo 0-11 ocupados (del inventario que trackea el bot) */
  equipment?: EquippedItem[];
  /** inventario (slots 12-75) */
  inventory?: EquippedItem[];
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
  /** Comercio (solo lectura de lo leído con la orden `shops`, y el estado de mi tienda / trade); ver commerce.ts */
  shops?: ShopsView | null;
  /** zonas donde se vieron dragones en este mapa (de la base, v_dragon_zones): n = avistamientos */
  zones?: { x: number; y: number; n: number }[];
  /** desde que arrancó el bot: kills, muertes, skills tirados, exp ganada, loot, skill de ataque actual */
  session?: { since: number; level0: number; kills: number; deaths: number; casts: number; exp: number; loot: number; skill: string };
};

/** Ítem del personaje. `slot`: 0-11 equipo, 12-75 inventario (grilla de 8×8 desde el 12). `w`×`h`: casillas que ocupa. */
export type EquippedItem = { slot: number; group: number; num: number; level: number; excellent: boolean; name?: string; w?: number; h?: number };

/**
 * Un ítem en un catálogo o tienda (o en mi equipo/bolsa para comparar). `price`: zen; null = el packet
 * no lo trae (los NPC NO mandan precio: lo cobra el server) o precio 0 (de muestra, en tiendas personales
 * `price === 0`). `slot` es la casilla del catálogo / de la tienda / del inventario según de dónde venga.
 */
export type ShopItemView = {
  slot: number; group: number; num: number; level: number; excellent: boolean; name: string; w?: number; h?: number;
  luck?: boolean; skill?: boolean; option?: number; excFlags?: number; excCount?: number; ancient?: number;
  harmony?: { option: number; level: number } | null; opt380?: boolean; durability?: number;
  price: number | null;
};

/** Un catálogo de NPC o una tienda personal leída (orden `shops`). */
export type ShopView = {
  kind: 'npc' | 'player';
  id: number;
  /** NPC: nombre del tipo (data/monsters.json); jugador: su nombre */
  name: string;
  /** cartel de la tienda personal, si se leyó */
  title?: string;
  map: number; x: number; y: number;
  /** cuándo se leyó (ms epoch) */
  at: number;
  items: ShopItemView[];
  /** false = el layout del packet NO está verificado en vivo (tiendas personales) */
  verified: boolean;
};

export type TradeView = {
  /** nombre de la contraparte */
  with: string; withId: number | null;
  /** 'incoming' = me pidió trade y espera mi respuesta (vence a los 20 s); 'open' = ventana abierta; 'done' / 'cancelled' = terminó */
  state: 'incoming' | 'requested' | 'open' | 'done' | 'cancelled';
  at: number;
  mine: ShopItemView[]; theirs: ShopItemView[];
  mineZen: number; theirsZen: number;
  note?: string;
};

export type VendorView = { id: number; type: number; name: string; x: number; y: number; dist: number };

/** Lo que el bot sabe de comercio: vendedores y jugadores a la vista, lo leído, mi tienda y el trade en curso. */
export type ShopsView = {
  at: number;
  /** NPC a la vista (los que suelen vender); se leen con `shops {npc}` */
  vendors: VendorView[];
  /** jugadores a la vista; shop = cartel de su tienda personal si el server lo avisó */
  players: { id: number; name: string; x: number; y: number; dist: number; shop?: string }[];
  shops: ShopView[];
  mine: { open: boolean; title: string; items: { slot: number; price: number; name: string }[]; at: number } | null;
  trade: TradeView | null;
  /** mi equipo (slots 0-11) y bolsa (12-75) con todas las opciones, para comparar con lo leído */
  equipped: ShopItemView[]; bag: ShopItemView[];
  /** últimas operaciones de comercio hechas por orden del panel (más nueva primero) */
  history: { at: number; text: string; ok: boolean }[];
  /** qué vender y dónde (commerce-plan.ts): solo PROPONE */
  plan: SalesPlan | null;
  notes: string[];
};

/** Plan de equipamiento (orden `equipplan`): lo que saldría de equiparse con el baúl. Solo se muestra. */
export type EquipPlanView = {
  at: number;
  /** de dónde salió el baúl: lectura viva de esta sesión o el archivo vault-<pj>.json */
  source: 'vivo' | 'archivo';
  /** una línea legible por paso, en orden ("1. Sacar del baúl [4] Great Dragon Helm +9 ... → bolsa casilla 25") */
  steps: string[];
  /** por lugar: qué lleva y qué llevaría (puntaje = defensa equivalente, heurística nuestra) */
  gains: { slot: number; slotName: string; before: string | null; after: string; scoreBefore: number; scoreAfter: number; delta: number }[];
  /** piezas que no se pueden usar o no entran, con el motivo */
  blocked: { name: string; slot: number; reason: string }[];
  notes: string[];
  summary: string;
};

/** Órdenes que acepta el bot. Cualquier otra se rechaza. */
export type PanelCommand =
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'farm' }
  /** cazar dorados; sin map = el mapa con más vivos al alcance según 0xFD */
  | { cmd: 'hunt'; map?: number }
  /** explorador: recorre mapas seguros SIN pelear (salvo defensa propia) y publica a la estación qué ve (scout.ts); `farm` lo corta */
  | { cmd: 'scout' }
  /**
   * chat del personaje: `to` = susurro a ese personaje; si no, `channel` normal (default), party o
   * guild. Texto de 1 a 60 caracteres imprimibles; los comandos ("/...") no se aceptan.
   */
  | { cmd: 'say'; text: string; to?: string; channel?: 'normal' | 'party' | 'guild' }
  /** ir a un spot de la ruta (índice de warp: 2 Lorencia, 6 Devias 3, 26 Arena 4, ...) */
  | { cmd: 'warp'; warp: number }
  /** leer el baúl (Baz, Lorencia) con el equipo y la bolsa: solo lee, no mueve nada */
  | { cmd: 'vault' }
  /** calcular y MOSTRAR el plan de equipamiento con el baúl leído (no mueve nada, no camina); sale en `equipPlan` del estado */
  | { cmd: 'equipplan' }
  /**
   * LEER paneles de venta (solo lectura): sin campos = refresca vendedores/jugadores a la vista; `npc` = habla con ese
   * NPC en scope, lee su catálogo y cierra; `player` = pide la lista de la tienda personal de ese jugador en scope.
   * No compra ni vende nada. El resultado sale en `shops` del estado.
   */
  | { cmd: 'shops'; npc?: number; player?: number }
  /** Operación de comercio que MUEVE zen/ítems: solo por orden explícita, con `confirm` (ver CommerceOp). El bot nunca la dispara solo. */
  | { cmd: 'commerce'; op: CommerceOp }
  /** EJECUTAR el plan: va a Baz, saca las piezas del baúl y se las pone, con ritmo humano. Solo si alguien la manda. */
  | { cmd: 'equip' };

/** Ítem identificado por casilla del inventario; el bot rechaza la orden si la casilla ya no tiene ese ítem. */
export type ItemRef = { slot: number; group: number; num: number; level: number };

/**
 * Operaciones de `commerce`. Todas llevan `confirm` = `commerceToken(op)` (commerce-packets.ts): el panel lo
 * arma al confirmar el resumen (ítem, cantidad y TOTAL) y el bot lo exige igual, para que ninguna orden
 * suelta ni mal armada mueva nada. SIN VERIFICAR EN VIVO (ver docs/comercio.md).
 */
export type CommerceOp =
  /** comprar `qty` veces la casilla `slot` del catálogo del NPC; `maxZen` = tope de zen a gastar en total (el packet no trae el precio) */
  | { kind: 'buy'; npc: number; slot: number; qty: number; maxZen: number; confirm: string }
  /** vender al NPC estos ítems de la bolsa (nunca cajas ni Cristales: el bot las rechaza) */
  | { kind: 'sell'; npc: number; items: ItemRef[]; confirm: string }
  /** abrir mi tienda personal con estos ítems y precios (0 = de muestra) */
  | { kind: 'shop-open'; title: string; items: (ItemRef & { price: number })[]; confirm: string }
  | { kind: 'shop-close' }
  /** comprar la casilla `slot` de la tienda personal de `player`, al `price` que se leyó (si cambió, se rechaza) */
  | { kind: 'shop-buy'; player: number; slot: number; price: number; confirm: string }
  /** trade directo: pedirle trade a `player`, poner estos ítems y `zen`, y marcar OK */
  | { kind: 'trade'; player: number; items: ItemRef[]; zen: number; confirm: string }
  /** aceptar el pedido de trade que me llegó de `player` (no pongo nada) */
  | { kind: 'trade-accept'; player: number; confirm: string }
  /** marcar OK en mi lado de la ventana de trade abierta, tras revisar lo del otro */
  | { kind: 'trade-ok'; confirm: string }
  | { kind: 'trade-cancel' };

/** Una operación sin su `confirm` (lo que el panel arma antes de pedir la confirmación). */
export type CommerceDraft = CommerceOp extends infer T ? (T extends unknown ? Omit<T, 'confirm'> : never) : never;

/** Comandos del server que `say` deja pasar (texto exacto, sin canal ni destinatario). */
export const SAY_COMMANDS: readonly string[] = ['/pkclear'];

export const PANEL_COMMANDS = ['pause', 'resume', 'farm', 'hunt', 'scout', 'warp', 'say', 'vault', 'equipplan', 'equip', 'shops', 'commerce'] as const;

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
  pause: ['cmd'], resume: ['cmd'], farm: ['cmd'], hunt: ['cmd', 'map'], scout: ['cmd'], warp: ['cmd', 'warp'], say: ['cmd', 'text', 'to', 'channel'], vault: ['cmd'], equipplan: ['cmd'], equip: ['cmd'], shops: ['cmd', 'npc', 'player'], commerce: ['cmd', 'op'],
};

const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isRef = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  return keys.length >= 4 && keys.every((k) => ['slot', 'group', 'num', 'level', 'price'].includes(k)) && int(r.slot, 0, 255) && int(r.group, 0, 15) && int(r.num, 0, 511) && int(r.level, 0, 15) && (r.price === undefined || int(r.price, 0, 2_000_000_000));
};
const exactKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

/** Forma exacta de una operación de `commerce` (campos de más = rechazo). El contenido lo vuelve a validar el bot. */
export function isCommerceOp(v: unknown): v is CommerceOp {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const list = (x: unknown, max: number) => Array.isArray(x) && x.length >= 1 && x.length <= max && x.every(isRef);
  const conf = typeof o.confirm === 'string' && o.confirm.length > 0 && o.confirm.length <= 600;
  switch (o.kind) {
    case 'buy': return exactKeys(o, ['kind', 'npc', 'slot', 'qty', 'maxZen', 'confirm']) && int(o.npc, 0, 0x7fff) && int(o.slot, 0, 255) && int(o.qty, 1, 20) && int(o.maxZen, 0, 2_000_000_000) && conf;
    case 'sell': return exactKeys(o, ['kind', 'npc', 'items', 'confirm']) && int(o.npc, 0, 0x7fff) && list(o.items, 8) && conf;
    case 'shop-open': return exactKeys(o, ['kind', 'title', 'items', 'confirm']) && typeof o.title === 'string' && /^[\x20-\x7e\xa0-\xff]{1,36}$/.test(o.title) && list(o.items, 32) && (o.items as Record<string, unknown>[]).every((i) => int(i.price, 0, 2_000_000_000)) && conf;
    case 'shop-close': return exactKeys(o, ['kind']);
    case 'shop-buy': return exactKeys(o, ['kind', 'player', 'slot', 'price', 'confirm']) && int(o.player, 0, 0x7fff) && int(o.slot, 0, 255) && int(o.price, 0, 2_000_000_000) && conf;
    case 'trade': return exactKeys(o, ['kind', 'player', 'items', 'zen', 'confirm']) && int(o.player, 0, 0x7fff) && (Array.isArray(o.items) && o.items.length <= 16 && o.items.every(isRef)) && int(o.zen, 0, 2_000_000_000) && ((o.items as unknown[]).length > 0 || (o.zen as number) > 0) && conf;
    case 'trade-accept': return exactKeys(o, ['kind', 'player', 'confirm']) && int(o.player, 0, 0x7fff) && conf;
    case 'trade-ok': return exactKeys(o, ['kind', 'confirm']) && conf;
    case 'trade-cancel': return exactKeys(o, ['kind']);
    default: return false;
  }
}

export function isPanelCommand(v: unknown): v is PanelCommand {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.cmd !== 'string' || !PANEL_COMMANDS.includes(c.cmd as never)) return false;
  const allowed = COMMAND_KEYS[c.cmd as (typeof PANEL_COMMANDS)[number]];
  if (Object.keys(c).some((k) => !allowed.includes(k))) return false;
  if (c.cmd === 'say') {
    // Imprimible latin1 (sin controles), 1-60, sin comandos del server salvo los de SAY_COMMANDS.
    if (typeof c.text !== 'string' || !/^[\x20-\x7e\xa0-\xff]{1,60}$/.test(c.text)) return false;
    if (c.text.trimStart().startsWith('/') && !(SAY_COMMANDS.includes(c.text) && c.to === undefined && c.channel === undefined)) return false;
    if (c.to !== undefined && (typeof c.to !== 'string' || !/^[A-Za-z0-9_]{1,10}$/.test(c.to))) return false;
    if (c.channel !== undefined && !['normal', 'party', 'guild'].includes(c.channel as string)) return false;
    return !(c.to !== undefined && c.channel !== undefined && c.channel !== 'normal');
  }
  if (c.cmd === 'warp') return Number.isInteger(c.warp) && (c.warp as number) >= 0 && (c.warp as number) < 256;
  const isMap = (m: unknown) => m === undefined || (Number.isInteger(m) && (m as number) >= 0 && (m as number) < 256);
  if (c.cmd === 'hunt') return isMap(c.map);
  if (c.cmd === 'shops') {
    const id = (x: unknown) => x === undefined || (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 0x7fff);
    return id(c.npc) && id(c.player) && !(c.npc !== undefined && c.player !== undefined);
  }
  if (c.cmd === 'commerce') return isCommerceOp(c.op);
  return true;
}
