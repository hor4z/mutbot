/**
 * Escuadras (lógica pura, la usa la estación): grupos de hasta 5 personajes propios con una misión
 * coordinada. La estación es la única que da órdenes: arma una `Assignment` por miembro (rol + orden),
 * la FIRMA (HMAC con una clave que solo comparten la estación y los bots que ella lanzó) y cada bot la
 * consulta por loopback (squad-client.ts). Un bot sin clave, o con una firma vieja o ajena, no obedece.
 *
 * Misiones (máquinas de estados, un paso por `stepMission`, sin red ni reloj propio):
 *   explore  travel → gather → sweep → converge → done      (repartir celdas, uno al frente, converger)
 *   golden   travel → gather → search → engage → loot → …   (todos sobre el mismo dorado)
 *   nurture  travel → gather → farm → done                  (padrino sube a los protegidos)
 *   en cualquier momento: retreat → aborted  (muertes, vida baja, jugador hostil, miembro perdido, timeout)
 * Una misión NUNCA se arma sola: solo `startMission` desde un pedido explícito del usuario
 * (`confirm: true` en la API). Al terminar, los bots reciben `release` y vuelven a su rutina.
 *
 * Tests en `squad-tests.ts`. Hechos y supuestos: docs/escuadras.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { baseExp, partyShares } from './duo';
import { dist, type Pos } from './corner';

// --- Clases y roles --------------------------------------------------------------------------
export type SquadClass = 'dk' | 'dw' | 'elf' | 'mg' | 'dl';
export const SQUAD_CLASSES: readonly SquadClass[] = ['dk', 'dw', 'elf', 'mg', 'dl'];
export const isSquadClass = (v: unknown): v is SquadClass => typeof v === 'string' && (SQUAD_CLASSES as readonly string[]).includes(v);
export const SQUAD_MAX = 5;
export const SQUAD_MIN = 2;

export type SquadRole = 'tanque' | 'dano' | 'apoyo' | 'explorador' | 'padrino' | 'protegido';

export type BuffStep = { skill: number; name: string; everyMs: number; to: 'party' | 'tanque' | 'self' | 'low-hp-ally'; minLevel: number };

/**
 * Qué sabe hacer cada clase en grupo. Los números son de data/skills.json (num). Usados ya por el
 * bot en vivo: 16 (Soul Barrier), 48 (Swell Life), 41/42/43 (BK), 9/38 (DW). El resto (Elf 26-28, 77;
 * DL 64) sale solo de skills.json: SIN VERIFICAR en vivo (el bot no los tira todavía a un aliado).
 */
export const CLASS_KIT: Record<SquadClass, { role: SquadRole; attack: number[]; buffs: BuffStep[]; note: string }> = {
  dk: { role: 'tanque', attack: [43, 42, 41], buffs: [{ skill: 48, name: 'Swell Life', everyMs: 55_000, to: 'party', minLevel: 120 }], note: 'tanque: aguanta, Swell Life a la party' },
  mg: { role: 'dano', attack: [41], buffs: [], note: 'daño/segundo tanque con Twisting Slash' },
  dw: { role: 'dano', attack: [9, 38, 39], buffs: [{ skill: 16, name: 'Soul Barrier', everyMs: 50_000, to: 'tanque', minLevel: 0 }], note: 'daño de área; Soul Barrier al tanque' },
  elf: {
    role: 'apoyo', attack: [51],
    buffs: [
      { skill: 28, name: 'Greater Damage', everyMs: 120_000, to: 'party', minLevel: 0 },
      { skill: 27, name: 'Greater Defense', everyMs: 120_000, to: 'tanque', minLevel: 0 },
      { skill: 26, name: 'Heal', everyMs: 9_000, to: 'low-hp-ally', minLevel: 0 },
    ],
    note: 'apoyo: buffs de daño/defensa y Heal al que baja de vida',
  },
  dl: { role: 'apoyo', attack: [], buffs: [{ skill: 64, name: 'Increase Critical Damage', everyMs: 100_000, to: 'party', minLevel: 0 }], note: 'apoyo: crítico a la party (sin skill de ataque conocido en el repo)' },
};

/** Roles de una misión de grupo (explore/golden) a partir de las clases. */
export function assignGroupRoles(members: readonly { char: string; cls: SquadClass | null; level: number }[], scoutFront: boolean): Record<string, SquadRole> {
  const out: Record<string, SquadRole> = {};
  for (const m of members) out[m.char] = m.cls ? CLASS_KIT[m.cls].role : 'dano';
  // Siempre hay un tanque: el de más nivel entre dk/mg, si no el de más nivel.
  if (!members.some((m) => out[m.char] === 'tanque')) {
    const pool = [...members].filter((m) => m.cls === 'mg').sort((a, b) => b.level - a.level);
    const t = pool[0] ?? [...members].sort((a, b) => b.level - a.level)[0];
    if (t) out[t.char] = 'tanque';
  }
  // Un apoyo por clase: el segundo Elf (o el segundo DL) pelea como daño, sus buffs son los mismos.
  const seen = new Set<string>();
  for (const m of members) if (out[m.char] === 'apoyo') { if (seen.has(m.cls ?? '')) out[m.char] = 'dano'; seen.add(m.cls ?? ''); }
  if (scoutFront) {
    // Al frente va el más resistente que no es apoyo (el tanque de más nivel).
    const front = [...members].filter((m) => out[m.char] === 'tanque').sort((a, b) => b.level - a.level)[0];
    if (front) out[front.char] = 'explorador';
  }
  return out;
}

// --- Mapas de la escuadra ---------------------------------------------------------------------
/** Los warps que conoce el bot (route.ts WARP_SPOTS) con el nivel de entrada. Aida no: es peligrosa para crianza. */
export const SQUAD_MAPS: readonly { warp: number; name: string; map: number; reqLevel: number }[] = [
  { warp: 2, name: 'Lorencia', map: 0, reqLevel: 10 },
  { warp: 6, name: 'Devias 3', map: 2, reqLevel: 20 },
  { warp: 7, name: 'Devias 4', map: 2, reqLevel: 20 },
  { warp: 5, name: 'Devias 2', map: 2, reqLevel: 20 },
  { warp: 24, name: 'Arena 2', map: 83, reqLevel: 100 },
  { warp: 25, name: 'Arena 3', map: 84, reqLevel: 200 },
  { warp: 26, name: 'Arena 4', map: 85, reqLevel: 300 },
];
export const squadMapByWarp = (warp: number) => SQUAD_MAPS.find((m) => m.warp === warp);

// --- Crianza: ¿conviene el grupo? -------------------------------------------------------------
/**
 * SUPUESTOS (no medidos; docs/escuadras.md): nivel típico del monstruo por mapa y kills por minuto.
 * El nivel 100 de Arena 2 sí es dato (duo.ts CORNER_MONSTER_LEVEL, Gaint Drakan en data/monsters.json).
 */
export const NURTURE_MODEL = {
  monsterLevel: { 2: 40, 83: 100, 84: 150, 85: 200, 0: 15 } as Record<number, number>,
  padrinoKillsPerMin: 20,
  wardSoloKillsPerMin: 5,
  /** Sin tope: el server no publica un rango de nivel para compartir exp (docs/escuadras.md). */
  maxLevelSpread: null as number | null,
  /** Desde cuánto se considera que la crianza rinde (ganancia del protegido contra farmear solo). */
  worthRatio: 1.3,
};

/** ¿Pueden compartir exp estos niveles? (tope configurable; hoy sin tope por falta de dato). */
export function levelSpreadOk(levels: readonly number[], maxSpread: number | null = NURTURE_MODEL.maxLevelSpread): boolean {
  if (maxSpread == null || levels.length < 2) return true;
  return Math.max(...levels) - Math.min(...levels) <= maxSpread;
}

export type NurtureOption = { warp: number; name: string; map: number; wardGain: number; padrinoGain: number; wardExpPerMin: number; worth: boolean };

/**
 * Mapas donde entran todos y cuánto rinde cada uno: el protegido más flojo comparado con farmear solo
 * (`wardGain` = exp/min en grupo ÷ exp/min solo, con kills/min SUPUESTOS) y el padrino contra su solo.
 * Ordenado de mejor a peor para el protegido; vacío si nadie puede entrar a ningún mapa.
 */
export function nurtureOptions(padrinoLevel: number, wardLevels: readonly number[], model = NURTURE_MODEL): NurtureOption[] {
  if (!wardLevels.length) return [];
  const minLevel = Math.min(padrinoLevel, ...wardLevels);
  const levels = [padrinoLevel, ...wardLevels];
  const weakest = Math.min(...wardLevels);
  const out: NurtureOption[] = [];
  for (const m of SQUAD_MAPS) {
    if (m.reqLevel > minLevel) continue;
    const M = model.monsterLevel[m.map] ?? 40;
    const shares = partyShares(levels, M);
    const wardIdx = 1 + wardLevels.indexOf(weakest);
    const wardParty = shares[wardIdx] * model.padrinoKillsPerMin;
    const wardSolo = baseExp(Math.max(1, Math.min(weakest, M)), weakest) * model.wardSoloKillsPerMin;
    const padSolo = baseExp(M, padrinoLevel);
    out.push({
      warp: m.warp, name: m.name, map: m.map,
      wardGain: wardSolo > 0 ? wardParty / wardSolo : 1,
      padrinoGain: padSolo > 0 ? shares[0] / padSolo : 1,
      wardExpPerMin: wardParty,
      worth: levelSpreadOk(levels, model.maxLevelSpread) && wardSolo > 0 && wardParty / wardSolo >= model.worthRatio,
    });
  }
  // Ordenado por lo que cobra el protegido (un mapa de entrada más alta paga más por kill).
  return out.sort((a, b) => b.wardExpPerMin - a.wardExpPerMin);
}

// --- Contrato ----------------------------------------------------------------------------------
export type MissionKind = 'explore' | 'golden' | 'nurture';
export const MISSION_KINDS: readonly MissionKind[] = ['explore', 'golden', 'nurture'];
export type Phase = 'travel' | 'gather' | 'sweep' | 'converge' | 'search' | 'engage' | 'loot' | 'farm' | 'retreat' | 'done' | 'aborted';
export const isTerminal = (p: Phase) => p === 'done' || p === 'aborted';

/** Lo que se le manda a cada bot. Todas las posiciones son del mapa `map` del mismo orden. */
export type Order =
  | { kind: 'idle'; why: string }
  /** viajar al spot `warp` (el bot espera `delayMs` antes: no viajan los 5 a la vez) */
  | { kind: 'warp'; warp: number; map: number; delayMs: number }
  | { kind: 'goto'; map: number; x: number; y: number; radius: number }
  /** seguir al líder con correa (formation.ts) */
  | { kind: 'follow'; leader: string }
  /** protegido: quedarse cerca del padrino, a salvo (formation.ts wardTile) */
  | { kind: 'hold'; leader: string }
  /** pelear en una zona; `focus` = el objetivo común (dorado) */
  | { kind: 'hunt'; map: number; x: number; y: number; radius: number; focus: Pos | null }
  /** su rutina de siempre (farm-loop) */
  | { kind: 'farm' }
  | { kind: 'retreat'; map: number; x: number; y: number }
  /** fin: vuelve a su rutina; `leaveParty` = salir de la party de la escuadra */
  | { kind: 'release'; leaveParty: boolean };

export type Assignment = {
  v: 1;
  char: string;
  squadId: string;
  missionId: string | null;
  role: SquadRole | null;
  order: Order;
  leader: string;
  members: string[];
  /** a quién invita este bot a la party ahora (solo el líder, y solo hasta completar) */
  invite: string[];
  buffs: BuffStep[];
  /** orden creciente: un bot ignora lo más viejo que lo último que vio */
  seq: number;
  issuedAt: number;
  expiresAt: number;
};
export const ASSIGNMENT_TTL_MS = 20_000;

export type Signed = { payload: string; sig: string };

export function signAssignment(key: string, a: Assignment): Signed {
  const payload = JSON.stringify(a);
  return { payload, sig: createHmac('sha256', key).update(payload).digest('hex') };
}

/**
 * Verifica lo que llegó de la estación: firma, que sea para este personaje, vigente y no más vieja
 * que la última vista. Devuelve la asignación o null (y por qué, para el log).
 */
export function verifyAssignment(key: string, body: unknown, me: string, now: number, lastSeq = -1): { a: Assignment } | { err: string } {
  if (!key) return { err: 'sin clave de escuadra' };
  if (!body || typeof body !== 'object') return { err: 'cuerpo inválido' };
  const { payload, sig } = body as Partial<Signed>;
  if (typeof payload !== 'string' || typeof sig !== 'string' || payload.length > 4096 || !/^[0-9a-f]{64}$/.test(sig)) return { err: 'formato inválido' };
  const want = createHmac('sha256', key).update(payload).digest();
  const got = Buffer.from(sig, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { err: 'firma inválida' };
  let a: Assignment;
  try { a = JSON.parse(payload) as Assignment; } catch { return { err: 'payload inválido' }; }
  if (a.v !== 1 || typeof a.char !== 'string' || a.char.toLowerCase() !== me.toLowerCase()) return { err: 'no es para mí' };
  if (!Array.isArray(a.members) || !a.members.every((m) => typeof m === 'string') || typeof a.order?.kind !== 'string') return { err: 'asignación inválida' };
  if (now > a.expiresAt || now < a.issuedAt - 5_000) return { err: 'vencida' };
  if (a.seq < lastSeq) return { err: 'más vieja que la última' };
  return { a };
}

// --- Estado de la escuadra ---------------------------------------------------------------------
export type MemberSnap = {
  char: string;
  cls: SquadClass | null;
  level: number;
  map: number;
  x: number;
  y: number;
  /** 0-100 */
  hpPct: number;
  mode: string;
  online: boolean;
  /** ¿lanzado con la clave de escuadra? (si no, no recibe órdenes) */
  obeys: boolean;
};
export type Finding = { kind: 'golden' | 'camp' | 'danger'; map: number; x: number; y: number; at: number; note?: string };
export type Snapshot = { now: number; members: Map<string, MemberSnap>; findings: Finding[]; hostiles: { map: number; x: number; y: number; at: number }[] };

export type Cell = { key: string; x: number; y: number };
export type CellProvider = (map: number) => Cell[];

/** Celdas de `size` tiles con lugar para caminar; el centro es un caminable (el más cercano al medio). */
export function cellsFromWalkable(open: (x: number, y: number) => boolean, size = 25, minOpen = 40): Cell[] {
  const out: Cell[] = [];
  for (let cy = 0; cy * size < 256; cy++)
    for (let cx = 0; cx * size < 256; cx++) {
      let n = 0, best: Pos | null = null, bd = Infinity;
      const mx = cx * size + size / 2, my = cy * size + size / 2;
      for (let y = cy * size; y < Math.min(256, (cy + 1) * size); y++)
        for (let x = cx * size; x < Math.min(256, (cx + 1) * size); x++)
          if (open(x, y)) {
            n++;
            const d = Math.hypot(x - mx, y - my);
            if (d < bd) { bd = d; best = { x, y }; }
          }
      if (n >= minOpen && best) out.push({ key: `${cx}:${cy}`, ...best });
    }
  return out;
}

export type Mission = {
  id: string;
  kind: MissionKind;
  warp: number;
  map: number;
  startedAt: number;
  phase: Phase;
  phaseAt: number;
  maxMs: number;
  roles: Record<string, SquadRole>;
  /** punto de reunión (null hasta que llegan al mapa) */
  meet: Pos | null;
  /** nurture: nivel que tienen que alcanzar los protegidos (0 = solo el tiempo) */
  targetLevel: number;
  padrino: string | null;
  visited: string[];
  danger: string[];
  cellOf: Record<string, string | null>;
  found: Finding | null;
  foundAt: number;
  deaths: Record<string, number[]>;
  warpDelays: Record<string, number>;
  result: string | null;
};

export type Squad = { id: string; name: string; members: string[]; leader: string; createdAt: number; mission: Mission | null; last: { kind: MissionKind; result: string; at: number } | null; log: string[]; seq: number };

export const MISSION = {
  GATHER_RADIUS: 8,
  GATHER_TIMEOUT_MS: 3 * 60_000,
  TRAVEL_TIMEOUT_MS: 4 * 60_000,
  CELL_REACHED: 6,
  CONVERGE_HOLD_MS: 60_000,
  FINDING_TTL_MS: 90_000,
  LOOT_MS: 15_000,
  /** el dorado desapareció de la vista hace esto: terminó la pelea */
  FOCUS_LOST_MS: 15_000,
  RETREAT_MS: 30_000,
  OFFLINE_MS: 90_000,
  DANGER_HP_PCT: 35,
  DEATH_WINDOW_MS: 10 * 60_000,
  DEATHS_ABORT: { explore: 1, golden: 2, nurture: 2 } as Record<MissionKind, number>,
  DEFAULT_MAX_MS: { explore: 25 * 60_000, golden: 20 * 60_000, nurture: 90 * 60_000 } as Record<MissionKind, number>,
  /** espera humana antes de viajar, por miembro (ms) */
  WARP_STAGGER_MS: [2_000, 22_000] as readonly [number, number],
};

type StepOut = { orders: Map<string, Order>; events: string[] };

const key = (c: string) => c.toLowerCase();
const cellKeyAt = (cells: Cell[], p: Pos) => {
  let best: Cell | null = null, bd = Infinity;
  for (const c of cells) { const d = dist(c, p); if (d < bd) { bd = d; best = c; } }
  return bd <= 25 ? best?.key ?? null : null;
};

/** Miembros activos: conectados, obedecen y no fuera hace mucho. */
function activeMembers(squad: Squad, snap: Snapshot): MemberSnap[] {
  return squad.members.map((c) => snap.members.get(key(c))).filter((m): m is MemberSnap => !!m && m.online && m.obeys && m.mode !== 'connecting');
}

/** Reparte celdas sin visitar a quien no tiene: cerca de sí y, los que no van al frente, cerca del explorador. */
function assignCells(m: Mission, act: MemberSnap[], cells: Cell[], rand: () => number) {
  const free = cells.filter((c) => !m.visited.includes(c.key) && !m.danger.includes(c.key));
  const taken = new Set(Object.values(m.cellOf).filter((v): v is string => !!v));
  const order = [...act].sort((a, b) => (m.roles[key(b.char)] === 'explorador' ? 1 : 0) - (m.roles[key(a.char)] === 'explorador' ? 1 : 0));
  let anchor: Pos | null = null;
  for (const mem of order) {
    const cur = m.cellOf[key(mem.char)];
    if (cur && !m.visited.includes(cur) && !m.danger.includes(cur)) {
      anchor ??= cells.find((c) => c.key === cur) ?? null;
      continue;
    }
    let best: Cell | null = null, bs = Infinity;
    for (const c of free) {
      if (taken.has(c.key)) continue;
      const s = dist(mem, c) + (anchor ? 0.6 * dist(anchor, c) : dist(c, m.meet ?? mem) * 0.3) + rand() * 3;
      if (s < bs) { bs = s; best = c; }
    }
    m.cellOf[key(mem.char)] = best?.key ?? null;
    if (best) { taken.add(best.key); anchor ??= best; }
  }
}

function freshFinding(snap: Snapshot, m: Mission, kinds: readonly Finding['kind'][]): Finding | null {
  const f = snap.findings.filter((x) => x.map === m.map && kinds.includes(x.kind) && snap.now - x.at <= MISSION.FINDING_TTL_MS).sort((a, b) => b.at - a.at)[0];
  return f ?? null;
}

const setPhase = (m: Mission, p: Phase, now: number, out: StepOut, why: string) => {
  m.phase = p;
  m.phaseAt = now;
  out.events.push(`${p}: ${why}`);
};

/** Puntos distintos alrededor de `c` para que no se amontonen en el mismo tile. */
function around(c: Pos, i: number, n: number, r: number): Pos {
  const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.6;
  return { x: Math.max(0, Math.min(255, Math.round(c.x + Math.cos(a) * r))), y: Math.max(0, Math.min(255, Math.round(c.y + Math.sin(a) * r))) };
}

/**
 * Un paso de la misión: actualiza `m` (se muta) y devuelve la orden de cada miembro. `rand` entra por
 * parámetro (tests); los tiempos humanos (escalonar el viaje, variar la espera) salen de ahí.
 */
export function stepMission(squad: Squad, snap: Snapshot, cells: Cell[], rand: () => number = Math.random): StepOut {
  const m = squad.mission!;
  const now = snap.now;
  const out: StepOut = { orders: new Map(), events: [] };
  const act = activeMembers(squad, snap);
  const actKeys = new Set(act.map((a) => key(a.char)));
  const idle = (c: string, why: string) => out.orders.set(key(c), { kind: 'idle', why });
  for (const c of squad.members) if (!actKeys.has(key(c))) idle(c, snap.members.get(key(c))?.obeys === false ? 'no recibe órdenes (arrancó sin clave)' : 'fuera de línea');
  const leaderSnap = snap.members.get(key(squad.leader));
  const retreatTo = m.meet ?? (leaderSnap ? { x: leaderSnap.x, y: leaderSnap.y } : { x: 0, y: 0 });

  const finish = (phase: 'done' | 'aborted', why: string) => {
    m.result = why;
    setPhase(m, phase, now, out, why);
    for (const c of squad.members) out.orders.set(key(c), { kind: 'release', leaveParty: m.kind === 'nurture' || phase === 'aborted' });
  };

  if (isTerminal(m.phase)) { for (const c of squad.members) out.orders.set(key(c), { kind: 'release', leaveParty: false }); return out; }

  // --- Cortes de seguridad (en cualquier fase menos retreat) --------------------------------
  if (m.phase !== 'retreat') {
    const recent = Object.values(m.deaths).flat().filter((t) => now - t <= MISSION.DEATH_WINDOW_MS).length;
    const low = act.filter((a) => a.hpPct > 0 && a.hpPct < MISSION.DANGER_HP_PCT).length;
    const hostile = snap.hostiles.some((h) => h.map === m.map && now - h.at < 60_000 && act.some((a) => a.map === m.map && dist(a, h) <= 15));
    const lost = squad.members.filter((c) => {
      const s = snap.members.get(key(c));
      return !s || !s.online;
    }).length;
    let why: string | null = null;
    if (now - m.startedAt > m.maxMs) { finish('done', 'tiempo cumplido'); return out; }
    if (recent >= MISSION.DEATHS_ABORT[m.kind]) why = `${recent} muerte(s) en 10 min`;
    else if (hostile) why = 'jugador hostil cerca';
    else if (act.length && low >= Math.max(1, Math.ceil(act.length / 3))) why = `${low} con la vida baja`;
    else if (act.length < SQUAD_MIN) why = `quedan ${act.length} activos`;
    else if (m.kind === 'nurture' && m.padrino && !actKeys.has(key(m.padrino))) why = 'el padrino no está disponible';
    else if (lost > squad.members.length - SQUAD_MIN) why = 'se perdió gente';
    if (why) {
      setPhase(m, 'retreat', now, out, `retirada (${why})`);
      m.result = `retirada: ${why}`;
    }
  }

  switch (m.phase) {
    case 'retreat': {
      for (const a of act) out.orders.set(key(a.char), { kind: 'retreat', map: m.map, ...retreatTo });
      if (now - m.phaseAt > MISSION.RETREAT_MS) finish('aborted', m.result ?? 'retirada');
      return out;
    }
    case 'travel': {
      let allThere = act.length > 0;
      for (const a of act) {
        if (a.map === m.map) { out.orders.set(key(a.char), { kind: 'idle', why: 'llegó, espera a los demás' }); continue; }
        allThere = false;
        m.warpDelays[key(a.char)] ??= Math.round(MISSION.WARP_STAGGER_MS[0] + rand() * (MISSION.WARP_STAGGER_MS[1] - MISSION.WARP_STAGGER_MS[0]));
        out.orders.set(key(a.char), { kind: 'warp', warp: m.warp, map: m.map, delayMs: m.warpDelays[key(a.char)] });
      }
      if (allThere) setPhase(m, 'gather', now, out, 'todos en el mapa');
      else if (now - m.phaseAt > MISSION.TRAVEL_TIMEOUT_MS) finish('aborted', 'no llegaron todos al mapa');
      return out;
    }
    case 'gather': {
      m.meet ??= leaderSnap && leaderSnap.map === m.map ? { x: leaderSnap.x, y: leaderSnap.y } : act.find((a) => a.map === m.map) ? { x: act[0].x, y: act[0].y } : null;
      if (!m.meet) return out;
      let close = 0;
      act.forEach((a, i) => {
        const spot = around(m.meet!, i, act.length, 2 + (i % 3));
        const near = a.map === m.map && dist(a, m.meet!) <= MISSION.GATHER_RADIUS;
        if (near) close++;
        out.orders.set(key(a.char), near ? { kind: 'idle', why: 'reunidos, esperando' } : { kind: 'goto', map: m.map, ...spot, radius: 3 });
      });
      const timeout = now - m.phaseAt > MISSION.GATHER_TIMEOUT_MS;
      if (close === act.length || (timeout && close >= SQUAD_MIN)) {
        setPhase(m, m.kind === 'nurture' ? 'farm' : m.kind === 'explore' ? 'sweep' : 'search', now, out, close === act.length ? 'reunidos' : `reunidos ${close}/${act.length} (tiempo)`);
      } else if (timeout) finish('aborted', 'no se juntaron');
      return out;
    }
    case 'farm': {
      const wards = act.filter((a) => key(a.char) !== key(m.padrino ?? ''));
      for (const a of act) {
        if (key(a.char) === key(m.padrino ?? '')) out.orders.set(key(a.char), { kind: 'farm' });
        else out.orders.set(key(a.char), { kind: 'hold', leader: m.padrino! });
      }
      if (m.targetLevel > 0 && wards.length && wards.every((w) => w.level >= m.targetLevel)) finish('done', `los protegidos llegaron al ${m.targetLevel}`);
      return out;
    }
    case 'sweep':
    case 'search': {
      // Danger y hallazgos compartidos.
      for (const f of snap.findings.filter((x) => x.map === m.map && x.kind === 'danger' && now - x.at < 5 * 60_000)) {
        const k = cellKeyAt(cells, f);
        if (k && !m.danger.includes(k)) { m.danger.push(k); out.events.push(`celda ${k} marcada peligrosa`); }
      }
      const f = freshFinding(snap, m, m.kind === 'golden' ? ['golden'] : ['golden', 'camp']);
      if (f) {
        m.found = f;
        m.foundAt = now;
        setPhase(m, m.kind === 'golden' ? 'engage' : 'converge', now, out, `hallazgo ${f.kind} en (${f.x},${f.y})`);
        return stepFound(squad, m, snap, act, out, rand);
      }
      for (const a of act) {
        const k = cellKeyAt(cells, a);
        if (k && a.map === m.map && !m.visited.includes(k)) m.visited.push(k);
        const mine = m.cellOf[key(a.char)];
        const c = mine ? cells.find((x) => x.key === mine) : null;
        if (c && dist(a, c) <= MISSION.CELL_REACHED && !m.visited.includes(c.key)) m.visited.push(c.key);
      }
      assignCells(m, act, cells, rand);
      let any = false;
      for (const a of act) {
        const c = m.cellOf[key(a.char)] ? cells.find((x) => x.key === m.cellOf[key(a.char)]) : null;
        if (c) {
          any = true;
          out.orders.set(key(a.char), m.roles[key(a.char)] === 'apoyo'
            ? { kind: 'goto', map: m.map, x: c.x, y: c.y, radius: 7 }
            : { kind: 'goto', map: m.map, x: c.x, y: c.y, radius: 4 });
        } else out.orders.set(key(a.char), { kind: 'idle', why: 'sin celda' });
      }
      if (!any) finish('done', m.kind === 'golden' ? 'recorrió el mapa sin ver dorados' : 'mapa recorrido sin hallazgos');
      return out;
    }
    case 'converge':
    case 'engage':
    case 'loot':
      return stepFound(squad, m, snap, act, out, rand);
  }
  return out;
}

/** converge (explore) / engage / loot (golden): todos al mismo punto o al mismo dorado. */
function stepFound(squad: Squad, m: Mission, snap: Snapshot, act: MemberSnap[], out: StepOut, rand: () => number): StepOut {
  const now = snap.now;
  const live = m.found && snap.findings.some((x) => x.kind === m.found!.kind && x.map === m.map && now - x.at <= MISSION.FOCUS_LOST_MS && dist(x, m.found!) <= 12);
  // Seguir al dorado si se movió.
  if (m.found && live) {
    const upd = snap.findings.filter((x) => x.kind === m.found!.kind && x.map === m.map && now - x.at <= MISSION.FOCUS_LOST_MS && dist(x, m.found!) <= 12).sort((a, b) => b.at - a.at)[0];
    m.found = upd;
    m.foundAt = now;
  }
  const f = m.found!;
  const fp = { x: f.x, y: f.y };
  if (m.phase === 'converge') {
    act.forEach((a, i) => out.orders.set(key(a.char), { kind: 'goto', map: m.map, ...around(fp, i, act.length, 3), radius: 3 }));
    if (now - m.foundAt > MISSION.CONVERGE_HOLD_MS) {
      m.result = `hallazgo en (${f.x},${f.y})`;
      setPhase(m, 'done', now, out, m.result);
      for (const c of squad.members) out.orders.set(key(c), { kind: 'release', leaveParty: false });
    }
    return out;
  }
  if (m.phase === 'engage') {
    if (!live && now - m.foundAt > MISSION.FOCUS_LOST_MS) {
      setPhase(m, 'loot', now, out, 'dorado fuera de vista: junto las cajas');
    } else {
      act.forEach((a, i) => {
        const role = m.roles[key(a.char)];
        const r = role === 'apoyo' ? 6 : role === 'dano' ? 4 : 2;
        const p = around(fp, i, act.length, r);
        out.orders.set(key(a.char), { kind: 'hunt', map: m.map, ...p, radius: r + 2, focus: fp });
      });
      return out;
    }
  }
  // loot: quedarse cerca (la caja es del que más daño hizo y su party, 10 s) y volver a buscar.
  act.forEach((a, i) => out.orders.set(key(a.char), { kind: 'hunt', map: m.map, ...around(fp, i, act.length, 3), radius: 6, focus: null }));
  if (now - m.phaseAt > MISSION.LOOT_MS) {
    m.found = null;
    setPhase(m, 'search', now, out, 'cajas levantadas: sigo buscando');
  }
  void rand;
  return out;
}

// --- Libro de escuadras (lo que guarda la estación) ---------------------------------------------
export type StartMission = { kind: MissionKind; warp?: number; targetLevel?: number; maxMin?: number; padrino?: string };

export class SquadBook {
  squads = new Map<string, Squad>();
  private assignments = new Map<string, Assignment>();
  private prevMode = new Map<string, string>();
  private nextId = 1;

  constructor(private cells: CellProvider = () => [], private rand: () => number = Math.random) {}

  create(name: string, chars: readonly string[], leader: string | undefined, known: ReadonlySet<string>, now: number): { ok: boolean; msg: string; squad?: Squad } {
    const members = [...new Set(chars.map(key))];
    if (members.length < SQUAD_MIN || members.length > SQUAD_MAX) return { ok: false, msg: `una escuadra tiene de ${SQUAD_MIN} a ${SQUAD_MAX} personajes` };
    const unknown = members.filter((c) => !known.has(c));
    if (unknown.length) return { ok: false, msg: `no conozco a ${unknown.join(', ')}` };
    for (const s of this.squads.values()) {
      const dup = members.find((c) => s.members.includes(c));
      if (dup) return { ok: false, msg: `${dup} ya está en la escuadra "${s.name}"` };
    }
    const lead = leader ? key(leader) : members[0];
    if (!members.includes(lead)) return { ok: false, msg: 'el líder tiene que ser de la escuadra' };
    const id = `sq${this.nextId++}`;
    const squad: Squad = { id, name, members: [lead, ...members.filter((c) => c !== lead)], leader: lead, createdAt: now, mission: null, last: null, log: [], seq: 0 };
    this.squads.set(id, squad);
    return { ok: true, msg: `escuadra "${name}" armada con ${members.length}`, squad };
  }

  disband(id: string): { ok: boolean; msg: string } {
    const s = this.squads.get(id);
    if (!s) return { ok: false, msg: 'no existe esa escuadra' };
    // Los bots reciben un release firmado (con su seq) hasta que venza: la estación lo emite una vez.
    for (const c of s.members) this.assignments.set(c, this.build(s, c, { kind: 'release', leaveParty: true }, Date.now(), null));
    this.squads.delete(id);
    return { ok: true, msg: `escuadra "${s.name}" disuelta` };
  }

  /** Pedido explícito del usuario. Nunca se llama solo. */
  startMission(id: string, req: StartMission, snap: Snapshot): { ok: boolean; msg: string } {
    const s = this.squads.get(id);
    if (!s) return { ok: false, msg: 'no existe esa escuadra' };
    if (s.mission && !isTerminal(s.mission.phase)) return { ok: false, msg: 'ya tiene una misión en curso: abortala primero' };
    const mem = s.members.map((c) => snap.members.get(key(c)));
    const act = mem.filter((m): m is MemberSnap => !!m && m.online && m.obeys);
    if (act.length < SQUAD_MIN) return { ok: false, msg: `hacen falta ${SQUAD_MIN} conectados que reciban órdenes (hoy ${act.length}); un bot lanzado antes de las escuadras hay que reiniciarlo` };
    let roles: Record<string, SquadRole>;
    let padrino: string | null = null;
    let warp = req.warp ?? 0;
    let note = '';
    if (req.kind === 'nurture') {
      padrino = key(req.padrino ?? [...act].sort((a, b) => b.level - a.level)[0].char);
      const pm = act.find((a) => key(a.char) === padrino);
      if (!pm) return { ok: false, msg: 'el padrino tiene que estar conectado y recibir órdenes' };
      const wards = act.filter((a) => a !== pm);
      if (!wards.length) return { ok: false, msg: 'hace falta al menos un protegido' };
      if (wards.some((w) => w.level >= pm.level)) return { ok: false, msg: 'los protegidos tienen que ser de menor nivel que el padrino' };
      const opts = nurtureOptions(pm.level, wards.map((w) => w.level));
      if (!opts.length) return { ok: false, msg: 'ningún mapa admite a todos (nivel de entrada)' };
      const pick = req.warp != null ? opts.find((o) => o.warp === req.warp) : opts[0];
      if (!pick) return { ok: false, msg: 'ese mapa no admite a todos' };
      warp = pick.warp;
      note = ` en ${pick.name} (el protegido cobra ~${pick.wardGain.toFixed(1)}× de lo que haría solo, supuesto${pick.worth ? '' : '; NO llega al umbral de ' + NURTURE_MODEL.worthRatio + '×'})`;
      roles = Object.fromEntries(s.members.map((c) => [c, key(c) === padrino ? 'padrino' : 'protegido'])) as Record<string, SquadRole>;
    } else {
      const sp = squadMapByWarp(warp);
      if (!sp) return { ok: false, msg: 'falta un mapa válido (warp)' };
      const low = act.filter((a) => a.level < sp.reqLevel).map((a) => a.char);
      if (low.length) return { ok: false, msg: `${low.join(', ')} no llega(n) al nivel ${sp.reqLevel} de ${sp.name}` };
      roles = assignGroupRoles(act.map((a) => ({ char: key(a.char), cls: a.cls, level: a.level })), true);
    }
    const sp = squadMapByWarp(warp);
    if (!sp) return { ok: false, msg: 'mapa inválido' };
    const maxMs = Math.round((req.maxMin ?? 0) * 60_000) || MISSION.DEFAULT_MAX_MS[req.kind];
    const m: Mission = {
      id: `${id}-m${++s.seq}`, kind: req.kind, warp, map: sp.map, startedAt: snap.now, phase: 'travel', phaseAt: snap.now, maxMs,
      roles, meet: null, targetLevel: req.targetLevel ?? 0, padrino, visited: [], danger: [], cellOf: {}, found: null, foundAt: 0, deaths: {}, warpDelays: {}, result: null,
    };
    s.mission = m;
    this.push(s, `misión ${req.kind} en ${sp.name}${note}`, snap.now);
    return { ok: true, msg: `misión ${req.kind} en ${sp.name}${note}` };
  }

  abort(id: string, now: number, why = 'abortada por el usuario'): { ok: boolean; msg: string } {
    const s = this.squads.get(id);
    if (!s?.mission || isTerminal(s.mission.phase)) return { ok: false, msg: 'no hay misión en curso' };
    const m = s.mission;
    m.result = why;
    m.phase = 'retreat';
    m.phaseAt = now;
    this.push(s, `retirada (${why})`, now);
    return { ok: true, msg: 'abortando: la escuadra se retira' };
  }

  /** Un paso de todas las misiones; deja una asignación firmable por miembro. */
  tick(snap: Snapshot) {
    for (const [c, mem] of snap.members) {
      const was = this.prevMode.get(c);
      if (mem.mode === 'dead' && was !== 'dead') {
        for (const s of this.squads.values()) if (s.mission && s.members.includes(c) && !isTerminal(s.mission.phase)) (s.mission.deaths[c] ??= []).push(snap.now);
      }
      this.prevMode.set(c, mem.mode);
    }
    for (const s of this.squads.values()) {
      const m = s.mission;
      if (!m) continue;
      const wasTerminal = isTerminal(m.phase);
      const out = stepMission(s, snap, this.cells(m.map), this.rand);
      for (const e of out.events) this.push(s, e, snap.now);
      if (!wasTerminal && isTerminal(m.phase)) s.last = { kind: m.kind, result: m.result ?? m.phase, at: snap.now };
      const invite = this.invites(s, m, snap);
      for (const c of s.members) {
        const order = out.orders.get(c) ?? { kind: 'idle', why: '' } as Order;
        const cls = snap.members.get(c)?.cls;
        const lvl = snap.members.get(c)?.level ?? 0;
        const buffs = cls && !isTerminal(m.phase) ? CLASS_KIT[cls].buffs.filter((b) => lvl >= b.minLevel) : [];
        this.assignments.set(c, this.build(s, c, order, snap.now, m, invite, buffs));
      }
      if (isTerminal(m.phase) && snap.now - m.phaseAt > 2 * ASSIGNMENT_TTL_MS) s.mission = null;
    }
    for (const [c, a] of this.assignments) if (snap.now > a.expiresAt + ASSIGNMENT_TTL_MS) this.assignments.delete(c);
  }

  /** Quién invita a quién: solo el líder, mientras la misión está viva y falta gente en la party. */
  private invites(s: Squad, m: Mission, snap: Snapshot): string[] {
    if (isTerminal(m.phase) || m.phase === 'retreat') return [];
    return s.members.filter((c) => c !== s.leader && snap.members.get(c)?.online && snap.members.get(c)?.obeys);
  }

  private build(s: Squad, c: string, order: Order, now: number, m: Mission | null, invite: string[] = [], buffs: BuffStep[] = []): Assignment {
    const mem = m?.roles[c] ?? null;
    return {
      v: 1, char: c, squadId: s.id, missionId: m?.id ?? null, role: mem, order, leader: s.leader, members: s.members,
      invite: c === s.leader ? invite : [], buffs, seq: ++s.seq, issuedAt: now, expiresAt: now + ASSIGNMENT_TTL_MS,
    };
  }

  private push(s: Squad, text: string, now: number) {
    s.log.push(`${new Date(now).toISOString().slice(11, 19)} ${text}`);
    if (s.log.length > 40) s.log.shift();
  }

  /** Lo que la estación le sirve al bot `char`, o null si no tiene escuadra. */
  assignmentFor(char: string): Assignment | null {
    return this.assignments.get(key(char)) ?? null;
  }

  /** Para la interfaz (sin nada firmado). */
  view(snap: Snapshot): SquadView[] {
    return [...this.squads.values()].map((s) => ({
      id: s.id, name: s.name, leader: s.leader, last: s.last, log: s.log.slice(-12),
      mission: s.mission ? { id: s.mission.id, kind: s.mission.kind, phase: s.mission.phase, map: s.mission.map, warp: s.mission.warp, result: s.mission.result, since: s.mission.startedAt, maxMs: s.mission.maxMs, visited: s.mission.visited.length, found: s.mission.found ? { x: s.mission.found.x, y: s.mission.found.y, kind: s.mission.found.kind } : null } : null,
      members: s.members.map((c) => {
        const m = snap.members.get(c);
        const a = this.assignments.get(c);
        return { char: c, cls: m?.cls ?? null, level: m?.level ?? 0, online: !!m?.online, obeys: !!m?.obeys, hpPct: m?.hpPct ?? 0, map: m?.map ?? 0, x: m?.x ?? 0, y: m?.y ?? 0, role: s.mission?.roles[c] ?? null, order: a?.order ?? null };
      }),
    }));
  }

  toJSON() { return { v: 1, nextId: this.nextId, squads: [...this.squads.values()] }; }

  /** Lee lo guardado; descarta lo que no cierra. Las misiones no se retoman (se pierden al reiniciar la estación). */
  static fromJSON(raw: unknown, cells?: CellProvider, rand?: () => number): SquadBook {
    const book = new SquadBook(cells, rand);
    const r = raw as { nextId?: unknown; squads?: unknown };
    if (!r || typeof r !== 'object' || !Array.isArray(r.squads)) return book;
    for (const x of r.squads as Partial<Squad>[]) {
      if (typeof x?.id !== 'string' || !/^sq\d+$/.test(x.id) || typeof x.name !== 'string' || !Array.isArray(x.members)) continue;
      if (!x.members.every((c) => typeof c === 'string' && /^[a-z0-9_]{1,10}$/.test(c)) || x.members.length < SQUAD_MIN || x.members.length > SQUAD_MAX) continue;
      if (typeof x.leader !== 'string' || !x.members.includes(x.leader)) continue;
      book.squads.set(x.id, { id: x.id, name: x.name.slice(0, 20), members: x.members, leader: x.leader, createdAt: Number(x.createdAt) || 0, mission: null, last: x.last ?? null, log: [], seq: Number(x.seq) || 0 });
    }
    book.nextId = Math.max(1, Number(r.nextId) || 1);
    return book;
  }
}

export type SquadView = {
  id: string; name: string; leader: string; last: Squad['last']; log: string[];
  mission: null | { id: string; kind: MissionKind; phase: Phase; map: number; warp: number; result: string | null; since: number; maxMs: number; visited: number; found: { x: number; y: number; kind: string } | null };
  members: { char: string; cls: SquadClass | null; level: number; online: boolean; obeys: boolean; hpPct: number; map: number; x: number; y: number; role: SquadRole | null; order: Order | null }[];
};

// --- Pedidos del navegador (parse estricto) ------------------------------------------------------
export type SquadRequest =
  | { action: 'squad-create'; name: string; chars: string[]; leader?: string }
  | { action: 'squad-mission'; squad: string; kind: MissionKind; warp?: number; targetLevel?: number; maxMin?: number; padrino?: string; confirm: true }
  | { action: 'squad-abort'; squad: string }
  | { action: 'squad-disband'; squad: string }
  | { action: 'squad-accounts'; mode: 'plan' | 'start' | 'stop'; n?: number; classes?: SquadClass[] };

const CHAR_KEY = /^[a-z0-9_]{1,10}$/;
const allKeys = (r: Record<string, unknown>, ...keys: string[]) => {
  const have = Object.keys(r).sort();
  return keys.length === have.length && [...keys].sort().every((k, i) => k === have[i]);
};
const onlyKeys = (r: Record<string, unknown>, required: string[], optional: string[]) =>
  required.every((k) => k in r) && Object.keys(r).every((k) => required.includes(k) || optional.includes(k));
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function parseSquadRequest(v: unknown): SquadRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  switch (r.action) {
    case 'squad-create': {
      if (!onlyKeys(r, ['action', 'name', 'chars'], ['leader'])) return null;
      if (typeof r.name !== 'string' || !/^[A-Za-z0-9 _-]{1,20}$/.test(r.name.trim()) || !r.name.trim()) return null;
      if (!Array.isArray(r.chars) || r.chars.length < SQUAD_MIN || r.chars.length > SQUAD_MAX || !r.chars.every((c) => typeof c === 'string' && CHAR_KEY.test(c))) return null;
      if (new Set(r.chars).size !== r.chars.length) return null;
      if (r.leader !== undefined && (typeof r.leader !== 'string' || !r.chars.includes(r.leader))) return null;
      return { action: 'squad-create', name: r.name.trim(), chars: r.chars as string[], ...(r.leader ? { leader: r.leader as string } : {}) };
    }
    case 'squad-mission': {
      if (!onlyKeys(r, ['action', 'squad', 'kind', 'confirm'], ['warp', 'targetLevel', 'maxMin', 'padrino'])) return null;
      if (r.confirm !== true) return null; // nunca sin confirmación explícita
      if (typeof r.squad !== 'string' || !/^sq\d+$/.test(r.squad) || !MISSION_KINDS.includes(r.kind as MissionKind)) return null;
      if (r.warp !== undefined && !(int(r.warp, 0, 255) && squadMapByWarp(r.warp))) return null;
      if (r.targetLevel !== undefined && !int(r.targetLevel, 1, 400)) return null;
      if (r.maxMin !== undefined && !int(r.maxMin, 1, 240)) return null;
      if (r.padrino !== undefined && (typeof r.padrino !== 'string' || !CHAR_KEY.test(r.padrino))) return null;
      if (r.kind !== 'nurture' && (r.padrino !== undefined || r.targetLevel !== undefined)) return null;
      if (r.kind !== 'nurture' && r.warp === undefined) return null;
      return { action: 'squad-mission', squad: r.squad, kind: r.kind as MissionKind, confirm: true, ...(r.warp !== undefined ? { warp: r.warp as number } : {}), ...(r.targetLevel !== undefined ? { targetLevel: r.targetLevel as number } : {}), ...(r.maxMin !== undefined ? { maxMin: r.maxMin as number } : {}), ...(r.padrino ? { padrino: r.padrino as string } : {}) };
    }
    case 'squad-abort':
    case 'squad-disband':
      if (!allKeys(r, 'action', 'squad') || typeof r.squad !== 'string' || !/^sq\d+$/.test(r.squad)) return null;
      return { action: r.action, squad: r.squad };
    case 'squad-accounts': {
      if (!onlyKeys(r, ['action', 'mode'], ['n', 'classes'])) return null;
      if (r.mode !== 'plan' && r.mode !== 'start' && r.mode !== 'stop') return null;
      if (r.n !== undefined && !int(r.n, 1, SQUAD_MAX)) return null;
      if (r.classes !== undefined && (!Array.isArray(r.classes) || r.classes.length > SQUAD_MAX || !r.classes.every(isSquadClass))) return null;
      if (r.mode !== 'stop' && r.n === undefined && r.classes === undefined) return null;
      return { action: 'squad-accounts', mode: r.mode, ...(r.n !== undefined ? { n: r.n as number } : {}), ...(r.classes ? { classes: r.classes as SquadClass[] } : {}) };
    }
  }
  return null;
}
