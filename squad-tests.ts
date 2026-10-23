/**
 * Tests offline de las escuadras: roles, misiones (explorar, cazar dorados, crianza), abortos, contrato
 * estricto, libro de escuadras, alas y plan de cuentas. Reloj simulado y mocks: no hay red, no se
 * registra ninguna cuenta y no se toca ningún bot.
 *
 *   bun run squad-tests.ts
 */
import {
  ASSIGNMENT_TTL_MS, CLASS_KIT, MISSION, NURTURE_MODEL, SQUAD_MAPS, SquadBook, assignGroupRoles, cellsFromWalkable, isTerminal,
  levelSpreadOk, nurtureOptions, parseSquadRequest, type Cell, type Finding, type MemberSnap, type Order, type Snapshot, type SquadClass,
} from './squad';
import { FENRIR, WING_TIER_SCORE, gearNotes, wingScore, wingsFor } from './squad-gear';
import { ACCOUNT_PACING, AccountRunner, COMPLEMENTARY, planSquadAccounts } from './squad-accounts';
import { dist } from './corner';
import { parseStationRequest } from './estacion-logic';
import { WARP_SPOTS } from './route';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

// Mapa de mentira: 100x100 abierto, celdas de 25 (16 celdas).
const cells: Cell[] = cellsFromWalkable((x, y) => x < 100 && y < 100, 25, 40);
const KNOWN = new Set(['hume', 'zamu', 'mela', 'kaelor', 'vexa']);

type Sim = { now: number; mem: Map<string, MemberSnap>; findings: Finding[]; hostiles: Snapshot['hostiles']; book: SquadBook };
function member(char: string, cls: SquadClass, level: number, over: Partial<MemberSnap> = {}): MemberSnap {
  return { char, cls, level, map: 0, x: 130, y: 130, hpPct: 100, mode: 'farm', online: true, obeys: true, ...over };
}
function sim(members: MemberSnap[], seed = 1): Sim {
  const book = new SquadBook(() => cells, seeded(seed));
  return { now: 1_000_000, mem: new Map(members.map((m) => [m.char, m])), findings: [], hostiles: [], book };
}
const snapOf = (s: Sim): Snapshot => ({ now: s.now, members: s.mem, findings: s.findings, hostiles: s.hostiles });

/** Un paso de 2 s: el libro decide y cada miembro cumple su orden (warp tras el delay, caminar 4 tiles). */
function tick(s: Sim, ms = 2000) {
  s.now += ms;
  s.book.tick(snapOf(s));
  for (const [c, m] of s.mem) {
    const a = s.book.assignmentFor(c);
    const o = a?.order;
    if (!o) continue;
    if (o.kind === 'warp' && m.map !== o.map) { warpTimers.set(c, (warpTimers.get(c) ?? 0) + ms); if ((warpTimers.get(c) ?? 0) >= o.delayMs) { m.map = o.map; m.x = 100; m.y = 100; } }
    const go = (t: { x: number; y: number }) => {
      const d = dist(m, t);
      if (d <= 1) return;
      const k = Math.min(4, d) / d;
      m.x = Math.round(m.x + (t.x - m.x) * k);
      m.y = Math.round(m.y + (t.y - m.y) * k);
    };
    if (o.kind === 'goto' || o.kind === 'retreat' || o.kind === 'hunt') go(o);
  }
}
const warpTimers = new Map<string, number>();
const orderOf = (s: Sim, c: string): Order | undefined => s.book.assignmentFor(c)?.order;
const phaseOf = (s: Sim, id = 'sq1') => s.book.squads.get(id)?.mission?.phase;
const runUntil = (s: Sim, pred: () => boolean, max = 400) => { for (let i = 0; i < max && !pred(); i++) tick(s); return pred(); };

function team5(): Sim {
  return sim([member('hume', 'dk', 400), member('zamu', 'dw', 350), member('mela', 'elf', 300), member('kaelor', 'mg', 320), member('vexa', 'dk', 310)]);
}

// --- Roles por clase -------------------------------------------------------------------------------
{
  const r = assignGroupRoles([
    { char: 'a', cls: 'dk', level: 400 }, { char: 'b', cls: 'dw', level: 350 }, { char: 'c', cls: 'elf', level: 300 }, { char: 'd', cls: 'mg', level: 320 }, { char: 'e', cls: 'dl', level: 310 },
  ], false);
  ok('BK tanque, DW daño, Elf apoyo, MG daño, DL apoyo', r.a === 'tanque' && r.b === 'dano' && r.c === 'apoyo' && r.d === 'dano' && r.e === 'apoyo', r);
  const r2 = assignGroupRoles([{ char: 'a', cls: 'dw', level: 300 }, { char: 'b', cls: 'mg', level: 250 }], false);
  ok('sin DK: el MG hace de tanque', r2.b === 'tanque', r2);
  const r3 = assignGroupRoles([{ char: 'a', cls: 'dk', level: 400 }, { char: 'b', cls: 'dk', level: 300 }, { char: 'c', cls: 'elf', level: 200 }], true);
  ok('con explorador: el tanque de más nivel va al frente, el otro sigue de tanque', r3.a === 'explorador' && r3.b === 'tanque' && r3.c === 'apoyo', r3);
  ok('el kit del Elf trae Greater Damage/Defense y Heal', [26, 27, 28].every((n) => CLASS_KIT.elf.buffs.some((b) => b.skill === n)));
  ok('el kit del BK trae Swell Life (48) con nivel mínimo 120', CLASS_KIT.dk.buffs[0].skill === 48 && CLASS_KIT.dk.buffs[0].minLevel === 120);
  ok('la tabla de mapas coincide con WARP_SPOTS del bot', SQUAD_MAPS.every((m) => { const w = WARP_SPOTS.find((x) => x.index === m.warp); return !!w && w.map === m.map && w.reqLevel <= m.reqLevel + 0 && w.name === m.name; }), SQUAD_MAPS.filter((m) => !WARP_SPOTS.find((x) => x.index === m.warp && x.map === m.map && x.name === m.name)));
}

// --- Crianza: reparto y mapa -------------------------------------------------------------------------
{
  const opts = nurtureOptions(400, [100, 100]);
  ok('padrino 400 con dos de 100: entran a Lorencia, Devias y Arena 2, no a la 3', opts.some((o) => o.warp === 24) && !opts.some((o) => o.warp === 25), opts.map((o) => o.name));
  ok('la mejor para el protegido es la de más nivel de monstruo', opts[0].warp === 24, opts.map((o) => o.name));
  ok('el padrino también gana (>1×) con alguien más bajo', opts[0].padrinoGain > 1, opts[0].padrinoGain);
  ok('el protegido de 15 solo entra a Lorencia', nurtureOptions(400, [15]).every((o) => o.map === 0) && nurtureOptions(400, [15]).length === 1);
  ok('protegido de nivel 5: ningún mapa', nurtureOptions(400, [5]).length === 0);
  ok('protegido de 100 en Arena 2: cobra más que 1× si solo mata lento (modelo)', opts[0].wardGain > 0.5, opts[0].wardGain);
  const slow = { ...NURTURE_MODEL, wardSoloKillsPerMin: 2 };
  ok('si solo mata muy lento, la crianza rinde', nurtureOptions(400, [100], slow)[0].worth);
  const fast = { ...NURTURE_MODEL, wardSoloKillsPerMin: 40 };
  ok('si solo mata rápido, la crianza NO conviene (avisa)', !nurtureOptions(400, [100], fast)[0].worth);
  ok('rango de niveles: sin tope por defecto, con tope se respeta', levelSpreadOk([400, 20]) && !levelSpreadOk([400, 20], 200) && levelSpreadOk([400, 250], 200));
}

// --- Contrato estricto --------------------------------------------------------------------------------
{
  const good = { action: 'squad-mission', squad: 'sq1', kind: 'explore', warp: 24, confirm: true };
  ok('misión válida', parseSquadRequest(good)?.action === 'squad-mission');
  ok('sin confirm = rechazada (nada automático)', parseSquadRequest({ ...good, confirm: undefined }) === null && parseSquadRequest({ ...good, confirm: false }) === null);
  ok('campo de más = rechazada', parseSquadRequest({ ...good, extra: 1 }) === null);
  ok('kind desconocido / warp inexistente = rechazada', parseSquadRequest({ ...good, kind: 'raid' }) === null && parseSquadRequest({ ...good, warp: 99 }) === null);
  ok('squad con formato raro = rechazada', parseSquadRequest({ ...good, squad: '../x' }) === null);
  ok('explorar sin mapa = rechazada', parseSquadRequest({ action: 'squad-mission', squad: 'sq1', kind: 'golden', confirm: true }) === null);
  ok('nurture con padrino y nivel meta', parseSquadRequest({ action: 'squad-mission', squad: 'sq1', kind: 'nurture', padrino: 'hume', targetLevel: 150, confirm: true })?.action === 'squad-mission');
  ok('padrino en explorar = rechazada', parseSquadRequest({ ...good, padrino: 'hume' }) === null);
  ok('crear: nombre y 2 a 5 personajes', parseSquadRequest({ action: 'squad-create', name: 'Alfa', chars: ['hume', 'zamu'] })?.action === 'squad-create');
  ok('crear con 1, con 6 o repetidos = rechazada', parseSquadRequest({ action: 'squad-create', name: 'A', chars: ['hume'] }) === null && parseSquadRequest({ action: 'squad-create', name: 'A', chars: ['a', 'b', 'c', 'd', 'e', 'f'] }) === null && parseSquadRequest({ action: 'squad-create', name: 'A', chars: ['hume', 'hume'] }) === null);
  ok('líder que no es miembro = rechazada', parseSquadRequest({ action: 'squad-create', name: 'A', chars: ['a1', 'b1'], leader: 'zz' }) === null);
  ok('abortar / disolver', parseSquadRequest({ action: 'squad-abort', squad: 'sq2' })?.action === 'squad-abort' && parseSquadRequest({ action: 'squad-disband', squad: 'sq2' })?.action === 'squad-disband');
  ok('cuentas: plan de 3 / start / stop', parseSquadRequest({ action: 'squad-accounts', mode: 'plan', n: 3 })?.action === 'squad-accounts' && parseSquadRequest({ action: 'squad-accounts', mode: 'stop' })?.action === 'squad-accounts');
  ok('cuentas: n=9 o clase rara = rechazada', parseSquadRequest({ action: 'squad-accounts', mode: 'plan', n: 9 }) === null && parseSquadRequest({ action: 'squad-accounts', mode: 'plan', classes: ['dk', 'xx'] }) === null);
  ok('la estación enruta squad-* por parseStationRequest', parseStationRequest(good)?.action === 'squad-mission' && parseStationRequest({ action: 'squad-abort', squad: 'sq1', x: 1 }) === null);
}

// --- Libro: crear / disolver ----------------------------------------------------------------------------
{
  const s = team5();
  const b = s.book;
  ok('crear con 1 miembro = no', !b.create('A', ['hume'], undefined, KNOWN, s.now).ok);
  ok('crear con un desconocido = no', !b.create('A', ['hume', 'pepe'], undefined, KNOWN, s.now).ok);
  const r = b.create('Alfa', ['hume', 'zamu', 'mela', 'kaelor', 'vexa'], 'zamu', KNOWN, s.now);
  ok('crear de 5, líder primero', r.ok && r.squad!.members[0] === 'zamu' && r.squad!.leader === 'zamu');
  ok('un personaje no puede estar en dos escuadras', !b.create('B', ['hume', 'pepe2'], undefined, new Set([...KNOWN, 'pepe2']), s.now).ok);
  const j = JSON.parse(JSON.stringify(b.toJSON()));
  const b2 = SquadBook.fromJSON(j);
  ok('guardar y leer (sin misiones)', b2.squads.get('sq1')?.members.length === 5 && b2.squads.get('sq1')?.mission === null);
  ok('basura al leer = libro vacío', SquadBook.fromJSON({ squads: [{ id: 'x', members: 3 }] }).squads.size === 0 && SquadBook.fromJSON(null).squads.size === 0);
  ok('disolver', b.disband('sq1').ok && !b.disband('sq1').ok);
}

// --- Explorar en grupo de 5 -------------------------------------------------------------------------------
{
  const s = team5();
  s.book.create('Alfa', ['hume', 'zamu', 'mela', 'kaelor', 'vexa'], 'hume', KNOWN, s.now);
  const st = s.book.startMission('sq1', { kind: 'explore', warp: 24 }, snapOf(s));
  ok('explorar arranca', st.ok, st);
  tick(s);
  const warps = ['hume', 'zamu', 'mela', 'kaelor', 'vexa'].map((c) => orderOf(s, c)).filter((o) => o?.kind === 'warp') as Extract<Order, { kind: 'warp' }>[];
  ok('todos reciben viaje al mismo warp', warps.length === 5 && warps.every((w) => w.warp === 24), warps.length);
  ok('los viajes salen escalonados (delays distintos, ninguno en ráfaga)', new Set(warps.map((w) => w.delayMs)).size >= 4 && warps.every((w) => w.delayMs >= MISSION.WARP_STAGGER_MS[0] && w.delayMs <= MISSION.WARP_STAGGER_MS[1]), warps.map((w) => w.delayMs));
  ok('travel → gather', runUntil(s, () => phaseOf(s) === 'gather', 60), phaseOf(s));
  ok('gather → sweep (reunidos)', runUntil(s, () => phaseOf(s) === 'sweep', 80), phaseOf(s));
  tick(s);
  const m = s.book.squads.get('sq1')!.mission!;
  ok('hay un explorador al frente', Object.values(m.roles).filter((r) => r === 'explorador').length === 1, m.roles);
  const gotos = ['hume', 'zamu', 'mela', 'kaelor', 'vexa'].map((c) => orderOf(s, c)).filter((o) => o?.kind === 'goto') as Extract<Order, { kind: 'goto' }>[];
  const keys = new Set(gotos.map((g) => `${g.x},${g.y}`));
  ok('cada uno recibe una celda distinta', gotos.length === 5 && keys.size === 5, [...keys]);
  runUntil(s, () => m.visited.length >= 6, 120);
  ok('las celdas visitadas se acumulan sin repetirse', m.visited.length >= 6 && new Set(m.visited).size === m.visited.length, m.visited);
  // Hallazgo: un dorado compartido por un miembro.
  s.findings.push({ kind: 'golden', map: m.map, x: 60, y: 40, at: s.now, note: 'visto por zamu' });
  tick(s);
  ok('hallazgo → converge', phaseOf(s) === 'converge', phaseOf(s));
  const conv = ['hume', 'zamu', 'mela', 'kaelor', 'vexa'].map((c) => orderOf(s, c) as Extract<Order, { kind: 'goto' }>);
  ok('todos van al hallazgo, a puntos distintos (no amontonados)', conv.every((o) => o.kind === 'goto' && dist(o, { x: 60, y: 40 }) <= 4) && new Set(conv.map((o) => `${o.x},${o.y}`)).size === 5, conv);
  ok('llegan al hallazgo', runUntil(s, () => [...s.mem.values()].every((x) => dist(x, { x: 60, y: 40 }) <= 8), 60));
  s.findings.length = 0;
  runUntil(s, () => phaseOf(s) === 'done' || isTerminal(phaseOf(s) ?? 'travel'), 80);
  ok('termina con el resultado del hallazgo', s.book.squads.get('sq1')!.last?.result.includes('hallazgo en (60,40)') === true, s.book.squads.get('sq1')!.last);
  ok('al terminar todos reciben release', ['hume', 'zamu', 'mela'].every((c) => orderOf(s, c)?.kind === 'release'));
}

// --- Abortos / retirada --------------------------------------------------------------------------------------
{
  const mk = () => {
    const s = team5();
    s.book.create('Alfa', ['hume', 'zamu', 'mela', 'kaelor', 'vexa'], 'hume', KNOWN, s.now);
    s.book.startMission('sq1', { kind: 'explore', warp: 24 }, snapOf(s));
    runUntil(s, () => phaseOf(s) === 'sweep', 200);
    return s;
  };
  {
    const s = mk();
    s.mem.get('mela')!.mode = 'dead';
    tick(s);
    ok('una muerte en explorar → retirada', phaseOf(s) === 'retreat', phaseOf(s));
    const o = orderOf(s, 'hume');
    ok('la retirada manda a todos al punto de reunión', o?.kind === 'retreat');
    runUntil(s, () => phaseOf(s) === 'aborted', 40);
    ok('retirada → aborted con release y salida de la party', phaseOf(s) === 'aborted' && (orderOf(s, 'hume') as { leaveParty?: boolean }).leaveParty === true, phaseOf(s));
    ok('el motivo queda en el resultado', s.book.squads.get('sq1')!.last?.result.includes('muerte') === true);
  }
  {
    const s = mk();
    for (const c of ['zamu', 'mela']) s.mem.get(c)!.hpPct = 20;
    tick(s);
    ok('dos con la vida baja (1/3 de 5) → retirada', phaseOf(s) === 'retreat');
  }
  {
    const s = mk();
    const hm = s.mem.get('hume')!;
    s.hostiles.push({ map: hm.map, x: hm.x + 5, y: hm.y, at: s.now });
    tick(s);
    ok('jugador hostil a <= 15 → retirada', phaseOf(s) === 'retreat');
  }
  {
    const s = mk();
    s.hostiles.push({ map: 0, x: 5, y: 5, at: s.now });
    tick(s);
    ok('hostil en otro mapa no cuenta', phaseOf(s) === 'sweep');
  }
  {
    const s = mk();
    for (const c of ['zamu', 'mela', 'kaelor', 'vexa']) s.mem.get(c)!.online = false;
    tick(s);
    ok('quedan menos de 2 activos → retirada', phaseOf(s) === 'retreat');
  }
  {
    const s = mk();
    s.now += MISSION.DEFAULT_MAX_MS.explore + 1000;
    tick(s);
    ok('tiempo cumplido → termina bien (done)', phaseOf(s) === 'done');
  }
  {
    const s = mk();
    const r = s.book.abort('sq1', s.now);
    tick(s);
    ok('abortar a mano → retirada', r.ok && phaseOf(s) === 'retreat');
    ok('abortar sin misión → error', !team5().book.abort('sq1', 0).ok);
  }
  {
    // Celdas peligrosas: se saltean.
    const s = mk();
    const m = s.book.squads.get('sq1')!.mission!;
    s.findings.push({ kind: 'danger', map: m.map, x: 12, y: 12, at: s.now });
    tick(s);
    ok('hallazgo de peligro marca la celda y no se visita', m.danger.includes('0:0') && !m.visited.includes('0:0') && phaseOf(s) === 'sweep', m.danger);
  }
}

// --- Cazar dorados en grupo -------------------------------------------------------------------------------------
{
  const s = team5();
  s.book.create('Alfa', ['hume', 'zamu', 'mela', 'kaelor', 'vexa'], 'hume', KNOWN, s.now);
  const st = s.book.startMission('sq1', { kind: 'golden', warp: 24 }, snapOf(s));
  ok('golden arranca', st.ok, st);
  const m = s.book.squads.get('sq1')!.mission!;
  ok('roles: tanque/daño/apoyo por clase', m.roles.hume === 'explorador' && m.roles.vexa === 'tanque' && m.roles.zamu === 'dano' && m.roles.mela === 'apoyo' && m.roles.kaelor === 'dano', m.roles);
  runUntil(s, () => phaseOf(s) === 'search', 200);
  ok('golden: busca tras reunirse', phaseOf(s) === 'search', phaseOf(s));
  s.findings.push({ kind: 'golden', map: m.map, x: 70, y: 60, at: s.now });
  tick(s);
  ok('dorado visto → engage', phaseOf(s) === 'engage', phaseOf(s));
  const hunts = ['hume', 'zamu', 'mela', 'kaelor', 'vexa'].map((c) => orderOf(s, c) as Extract<Order, { kind: 'hunt' }>);
  ok('todos sobre el MISMO objetivo (focus)', hunts.every((h) => h.kind === 'hunt' && h.focus?.x === 70 && h.focus?.y === 60), hunts.map((h) => h.focus));
  const rad = (c: string) => (orderOf(s, c) as Extract<Order, { kind: 'hunt' }>).radius;
  ok('el apoyo se queda más atrás que el tanque', rad('mela') > rad('vexa'), [rad('mela'), rad('vexa')]);
  const a = s.book.assignmentFor('mela')!;
  ok('el Elf recibe sus buffs (28, 27, 26)', [28, 27, 26].every((n) => a.buffs.some((b) => b.skill === n)), a.buffs.map((b) => b.skill));
  ok('el BK recibe Swell Life (nivel 400 >= 120)', s.book.assignmentFor('hume')!.buffs.some((b) => b.skill === 48));
  // El dorado se mueve y sigue vigente.
  s.now += 4000;
  s.findings[0] = { kind: 'golden', map: m.map, x: 72, y: 62, at: s.now };
  tick(s);
  ok('si se mueve, el foco lo sigue', (orderOf(s, 'hume') as Extract<Order, { kind: 'hunt' }>).focus?.x === 72);
  // Muere: sale de la vista.
  s.findings.length = 0;
  runUntil(s, () => phaseOf(s) === 'loot', 30);
  ok('dorado fuera de vista → loot (junta cajas)', phaseOf(s) === 'loot', phaseOf(s));
  runUntil(s, () => phaseOf(s) === 'search', 30);
  ok('pasados los 15 s de cajas vuelve a buscar', phaseOf(s) === 'search', phaseOf(s));
  // Dos muertes → retirada.
  s.mem.get('zamu')!.mode = 'dead'; tick(s);
  s.mem.get('zamu')!.mode = 'farm'; tick(s);
  s.mem.get('mela')!.mode = 'dead'; tick(s);
  ok('dos muertes en cazar → retirada', phaseOf(s) === 'retreat', phaseOf(s));
  // nivel insuficiente
  const low = sim([member('hume', 'dk', 400), member('zamu', 'dw', 90)]);
  low.book.create('B', ['hume', 'zamu'], 'hume', KNOWN, low.now);
  ok('cazar en Arena 2 con uno de nivel 90 = no', !low.book.startMission('sq1', { kind: 'golden', warp: 24 }, snapOf(low)).ok);
}

// --- Crianza con padrino ---------------------------------------------------------------------------------------------
{
  const s = sim([member('hume', 'dk', 400, { map: 83 }), member('zamu', 'dw', 100, { map: 83 }), member('mela', 'elf', 120, { map: 83 })]);
  s.book.create('Cria', ['hume', 'zamu', 'mela'], 'hume', KNOWN, s.now);
  ok('padrino que no es el más fuerte / protegido más alto = no', !s.book.startMission('sq1', { kind: 'nurture', padrino: 'zamu' }, snapOf(s)).ok);
  const st = s.book.startMission('sq1', { kind: 'nurture', targetLevel: 130 }, snapOf(s));
  ok('crianza arranca con el de más nivel de padrino', st.ok && st.msg.includes('Arena 2'), st);
  ok('el mensaje avisa si es supuesto', st.msg.includes('supuesto'));
  runUntil(s, () => phaseOf(s) === 'farm', 100);
  tick(s);
  ok('padrino sigue su rutina (farm), protegidos cobran cerca (hold)', orderOf(s, 'hume')?.kind === 'farm' && orderOf(s, 'zamu')?.kind === 'hold' && (orderOf(s, 'zamu') as { leader: string }).leader === 'hume' && orderOf(s, 'mela')?.kind === 'hold');
  ok('los roles quedan padrino / protegido', s.book.squads.get('sq1')!.mission!.roles.hume === 'padrino' && s.book.squads.get('sq1')!.mission!.roles.zamu === 'protegido');
  ok('el líder (hume) es el único que invita a la party', s.book.assignmentFor('hume')!.invite.join() === 'zamu,mela' && s.book.assignmentFor('zamu')!.invite.length === 0, s.book.assignmentFor('hume')!.invite);
  s.mem.get('zamu')!.level = 131;
  tick(s);
  ok('con uno solo por debajo de la meta sigue', phaseOf(s) === 'farm');
  s.mem.get('mela')!.level = 131;
  tick(s);
  ok('todos los protegidos en la meta → done y salen de la party', phaseOf(s) === 'done' && (orderOf(s, 'zamu') as { leaveParty?: boolean }).leaveParty === true, phaseOf(s));
  // Padrino caído
  const t = sim([member('hume', 'dk', 400, { map: 83 }), member('zamu', 'dw', 100, { map: 83 })]);
  t.book.create('C', ['hume', 'zamu'], 'hume', KNOWN, t.now);
  t.book.startMission('sq1', { kind: 'nurture' }, snapOf(t));
  runUntil(t, () => phaseOf(t) === 'farm', 100);
  t.mem.get('hume')!.online = false;
  tick(t);
  ok('padrino desconectado → retirada', phaseOf(t) === 'retreat');
  const u = sim([member('hume', 'dk', 400, { obeys: false }), member('zamu', 'dw', 100)]);
  u.book.create('D', ['hume', 'zamu'], 'hume', KNOWN, u.now);
  const r = u.book.startMission('sq1', { kind: 'nurture' }, snapOf(u));
  ok('un bot lanzado sin clave (Hume viejo) no entra a misiones: avisa que hay que reiniciarlo', !r.ok && r.msg.includes('reiniciar'), r);
  ok('...y no recibe ninguna asignación firmable', u.book.assignmentFor('hume') === null);
  // Una misión nunca arranca sola, ni encadena otra al terminar.
  const v = sim([member('hume', 'dk', 400, { map: 83 }), member('zamu', 'dw', 100, { map: 83 })]);
  v.book.create('E', ['hume', 'zamu'], 'hume', KNOWN, v.now);
  for (let i = 0; i < 20; i++) tick(v);
  ok('sin pedido explícito no hay misión ni órdenes', v.book.squads.get('sq1')!.mission === null && v.book.assignmentFor('hume') === null);
  v.book.startMission('sq1', { kind: 'nurture', maxMin: 1 }, snapOf(v));
  runUntil(v, () => phaseOf(v) === 'done', 200);
  for (let i = 0; i < 40; i++) tick(v);
  ok('al terminar no se encadena otra (misión liberada, solo release)', v.book.squads.get('sq1')!.mission === null || isTerminal(v.book.squads.get('sq1')!.mission!.phase));
  ok('las asignaciones vencen a los 20 s (si la estación se cae, el bot vuelve a su rutina)', ASSIGNMENT_TTL_MS === 20_000 && s.book.assignmentFor('hume')!.expiresAt - s.book.assignmentFor('hume')!.issuedAt === ASSIGNMENT_TTL_MS);
}

// --- Alas y montura -------------------------------------------------------------------------------------------------
{
  ok('alas por clase (MU original, supuesto)', wingsFor('dk')[0].name === 'Wings of Dragon' && wingsFor('dw')[0].name === 'Wings of Soul' && wingsFor('elf')[0].name === 'Wings of Spirit' && wingsFor('mg')[0].name === 'Wings of Darkness' && wingsFor('dl')[0].name === 'Cape of Lord');
  ok('2da vale más que una 1ra aunque la 1ra esté +9', wingScore('dk', { group: 12, num: 5 }) > wingScore('dk', { group: 12, num: 2, level: 9 }), [wingScore('dk', { group: 12, num: 5 }), wingScore('dk', { group: 12, num: 2, level: 9 })]);
  ok('el nivel, las opciones y lo excelente suman', wingScore('dk', { group: 12, num: 5, level: 9, option: 2, excellent: true }) === WING_TIER_SCORE[2] + 36 + 12 + 10);
  ok('alas de otra clase o que no son alas valen 0', wingScore('dk', { group: 12, num: 4 }) === 0 && wingScore('dk', { group: 0, num: 5 }) === 0);
  const n = gearNotes([
    { char: 'hume', cls: 'dk', level: 400, worn: { group: 12, num: 5, level: 9 } },
    { char: 'zamu', cls: 'dw', level: 100, worn: null },
    { char: 'mela', cls: 'elf', level: 200, worn: { group: 12, num: 0 } },
    { char: 'kaelor', cls: 'mg', level: 320, worn: null },
  ]);
  ok('Hume con Dragon +9: solo falta el Fenrir (nivel >= 300)', n.filter((x) => x.char === 'hume').map((x) => x.need).join() === 'Horn of Fenrir', n);
  ok('Zamu 100 sin alas: las de 1ra', n.some((x) => x.char === 'zamu' && x.need === 'Wings of Angel'));
  ok('Mela 200 con alas de 1ra: le faltan las de 2da', n.some((x) => x.char === 'mela' && x.need === 'Wings of Spirit'));
  ok('Kaelor 320 sin alas: Darkness y Fenrir', n.filter((x) => x.char === 'kaelor').length === 2 && FENRIR.minLevel === 300);
}

// --- Plan de cuentas (todo con mocks: no se registra nada) ------------------------------------------------------------
{
  const now = 5_000_000;
  const p = planSquadAccounts({ n: 5, now, rand: seeded(7), takenUsers: ['hume'], takenChars: ['Hume'] });
  ok('plan de 5 cuentas con clases complementarias', p.ok && p.steps.length === 5 && p.steps.map((s) => s.cls).join() === COMPLEMENTARY[5].join(), p.ok && p.steps.map((s) => s.cls));
  if (p.ok) {
    ok('nombres válidos (4-10) y cuentas válidas, todos distintos', p.steps.every((s) => /^[A-Za-z0-9]{4,10}$/.test(s.char) && /^[a-z0-9]{4,10}$/.test(s.user)) && new Set(p.steps.map((s) => s.char.toLowerCase())).size === 5 && new Set(p.steps.map((s) => s.user)).size === 5);
    ok('la primera no sale antes de 30 s', p.steps[0].at - now >= ACCOUNT_PACING.firstDelayMs[0]);
    ok('espaciado largo entre registros (>= 12 min), nunca ráfaga', p.steps.every((s, i) => i === 0 || s.at - p.steps[i - 1].at >= ACCOUNT_PACING.gapMs[0]));
    ok('el plan no lleva claves', !JSON.stringify(p).toLowerCase().includes('pass'));
    // Ejecutor con registro de mentira y reloj simulado.
    const calls: string[] = [];
    const run = new AccountRunner(p.steps, seeded(3));
    let t = now;
    for (let i = 0; i < 3000 && run.remaining; i++) {
      t += 60_000;
      const st = run.due(t);
      if (st) { calls.push(`${t}:${st.char}`); run.report(st, { ok: true, msg: 'mock' }, t); }
    }
    ok('el ejecutor crea las 5, una por vez', run.created === 5 && calls.length === 5);
    const times = calls.map((c) => Number(c.split(':')[0]));
    ok('a lo sumo 2 por hora en cualquier ventana', times.every((x, i) => times.filter((y) => y >= x && y < x + 3_600_000).length <= ACCOUNT_PACING.perHour), times);
    ok('nunca dos registros a menos de 12 min', times.every((x, i) => i === 0 || x - times[i - 1] >= ACCOUNT_PACING.gapMs[0]));
    // Throttled: pausa de 1 h
    const r2 = new AccountRunner(p.steps.slice(0, 2), seeded(4));
    let t2 = p.steps[0].at;
    const s1 = r2.due(t2)!;
    r2.report(s1, { ok: false, msg: 'throttled', code: 'throttled' }, t2);
    ok('throttled → pausa de 1 h', r2.due(t2 + 3_000_000) === null && r2.due(t2 + 3_700_000)?.char === s1.char);
    // Fallos seguidos → se detiene
    const r3 = new AccountRunner(p.steps.slice(0, 3), seeded(5));
    let t3 = p.steps[0].at;
    for (let i = 0; i < 2; i++) { const s = r3.due(t3)!; r3.report(s, { ok: false, msg: 'caído' }, t3); t3 += 3 * 3_600_000; }
    ok('dos fallos seguidos → se detiene solo', r3.stopped && r3.due(t3 + 1e9) === null);
    // Cuenta tomada: otra cuenta, mismo personaje
    const r4 = new AccountRunner(p.steps.slice(0, 1), seeded(6));
    const s4 = r4.due(p.steps[0].at)!;
    r4.report(s4, { ok: false, msg: 'taken', code: 'taken' }, p.steps[0].at);
    const again = r4.due(p.steps[0].at + 41 * 60_000);
    ok('cuenta tomada → reintenta con otra cuenta y el mismo personaje', !!again && again.char === s4.char && again.user !== s4.user, again);
    // stop manual
    r4.stop();
    ok('detener manual', r4.due(1e12) === null);
  }
  ok('Dark Lord no se crea desde el bot', !planSquadAccounts({ classes: ['dk', 'dl'], now }).ok);
  ok('sin n ni clases = error', !planSquadAccounts({ now }).ok);
  ok('más de 5 = error', !planSquadAccounts({ classes: ['dk', 'dk', 'dk', 'dk', 'dk', 'dk'], now }).ok);
}

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
