/**
 * Tests offline de party.ts (a quién se acepta, lista de la party, invitaciones espaciadas) y de la
 * firma de órdenes de escuadra (squad.ts). Sin red.
 *
 *   bun run party-tests.ts
 */
import { INVITE_GAP_MS, INVITE_MAX_TRIES, INVITE_RETRY_MS, InviteScheduler, PARTY_MAX, decideInvite, parsePartyList } from './party';
import { buildPartyAccept, buildPartyInvite, buildPartyKick, parsePartyRequest } from './protocol097';
import { signAssignment, verifyAssignment, type Assignment } from './squad';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// --- Aceptar ------------------------------------------------------------------------------------
ok('escuadra: acepta a un miembro (sin importar mayúsculas)', decideInvite('ZAMU', ['hume', 'zamu'], false).accept);
ok('escuadra: rechaza a un extraño', !decideInvite('Pepe', ['hume', 'zamu'], true).accept);
ok('escuadra: rechaza a un extraño aunque el personaje sea nuevo (fallback true)', !decideInvite('Pepe', ['hume', 'zamu'], true).accept);
ok('escuadra: sin saber quién invita, rechaza', !decideInvite(undefined, ['hume'], true).accept);
ok('sin escuadra manda el fallback', decideInvite('Pepe', null, true).accept && !decideInvite('Pepe', null, false).accept);

// --- Bytes que ya estaban probados --------------------------------------------------------------
ok('invitar C1 05 40 id BE', Array.from(buildPartyInvite(0x1234)).join() === '193,5,64,18,52');
ok('aceptar C1 06 41 01 id', Array.from(buildPartyAccept(0x0102)).join() === '193,6,65,1,1,2');
ok('kick/salir C1 04 43 índice', Array.from(buildPartyKick(2)).join() === '193,4,67,2');
ok('PartyRequest: id del que invita', parsePartyRequest(Uint8Array.from([0xc1, 5, 0x40, 0x81, 0x02])) === 0x102);

// --- Lista de la party ----------------------------------------------------------------------------
{
  const name = (s: string) => Array.from({ length: 10 }, (_, i) => s.charCodeAt(i) || 0);
  const entry = (s: string) => [...name(s), 0, 0, 0, 0]; // stride 14: nombre + extras
  const raw = Uint8Array.from([0xc1, 5 + 28, 0x42, 0x01, 2, ...entry('Hume'), ...entry('Zamu')]);
  const l = parsePartyList(raw);
  ok('lista: dos miembros por nombre', l?.join() === 'Hume,Zamu', l);
  ok('lista: stride que no cierra = se ignora', parsePartyList(Uint8Array.from([0xc1, 20, 0x42, 1, 2, ...new Array(13).fill(65)])) === null);
  ok('lista: más de 5 = se ignora', parsePartyList(Uint8Array.from([0xc1, 9, 0x42, 1, 6, 0, 0, 0, 0])) === null);
  ok('lista: nombre con basura = se ignora', parsePartyList(Uint8Array.from([0xc1, 19, 0x42, 1, 1, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0])) === null);
  ok('lista vacía', parsePartyList(Uint8Array.from([0xc1, 5, 0x42, 1, 0]))?.length === 0);
}

// --- Invitaciones: solo el líder, una por vez, con espera -------------------------------------------
{
  const vis = new Map([['zamu', 11], ['mela', 12], ['pepe', 13]]);
  const members = ['hume', 'zamu', 'mela'];
  const sch = new InviteScheduler();
  const r = () => 0.5;
  ok('un seguidor nunca invita', sch.next(0, 'zamu', 'hume', members, [], vis, r) === null);
  const a = sch.next(1000, 'Hume', 'hume', members, ['Hume'], vis, r);
  ok('el líder invita al primero que ve', a?.name === 'zamu' && a.id === 11, a);
  ok('no invita a otro enseguida (espera larga)', sch.next(1000 + INVITE_GAP_MS[0] - 1, 'hume', 'hume', members, ['hume'], vis, r) === null);
  const b = sch.next(1000 + INVITE_GAP_MS[1] + 1, 'hume', 'hume', members, ['hume'], vis, r);
  ok('después de la espera, al siguiente (no repite a zamu todavía)', b?.name === 'mela', b);
  ok('no invita a quien no es de la escuadra (pepe)', !['pepe'].includes(b?.name ?? ''));
  ok('no invita a los que ya están en la party', sch.next(60_000_000, 'hume', 'hume', members, ['hume', 'zamu', 'mela'], vis, r) === null);
  const c = sch.next(1000 + INVITE_RETRY_MS + INVITE_GAP_MS[1] + 10, 'hume', 'hume', members, ['hume', 'mela'], vis, r);
  ok('reintenta a zamu recién tras INVITE_RETRY_MS', c?.name === 'zamu', c);
  // Tope de intentos
  const s2 = new InviteScheduler();
  let t = 0, n = 0;
  for (let i = 0; i < 20; i++) { t += INVITE_RETRY_MS + 20_000; if (s2.next(t, 'hume', 'hume', ['hume', 'zamu'], ['hume'], vis, r)) n++; }
  ok(`tope de ${INVITE_MAX_TRIES} intentos por miembro`, n === INVITE_MAX_TRIES && s2.gaveUp().includes('zamu'), n);
  ok('party llena: no invita', new InviteScheduler().next(0, 'hume', 'hume', members, ['a', 'b', 'c', 'd', 'e'].slice(0, PARTY_MAX), vis, r) === null);
}

// --- Firma de órdenes ---------------------------------------------------------------------------------
{
  const now = 1_000_000;
  const a: Assignment = { v: 1, char: 'zamu', squadId: 'sq1', missionId: 'sq1-m1', role: 'protegido', order: { kind: 'hold', leader: 'hume' }, leader: 'hume', members: ['hume', 'zamu'], invite: [], buffs: [], seq: 5, issuedAt: now, expiresAt: now + 20_000 };
  const signed = signAssignment('clave-secreta', a);
  ok('firma válida', 'a' in verifyAssignment('clave-secreta', signed, 'Zamu', now + 1000));
  ok('otra clave = rechazada', 'err' in verifyAssignment('otra', signed, 'zamu', now + 1000));
  ok('payload alterado = rechazado', 'err' in verifyAssignment('clave-secreta', { ...signed, payload: signed.payload.replace('hold', 'farm') }, 'zamu', now + 1000));
  ok('para otro personaje = rechazada', 'err' in verifyAssignment('clave-secreta', signed, 'hume', now + 1000));
  ok('vencida = rechazada', 'err' in verifyAssignment('clave-secreta', signed, 'zamu', now + 21_000));
  ok('más vieja que la última vista = rechazada', 'err' in verifyAssignment('clave-secreta', signed, 'zamu', now + 1000, 9));
  ok('sin clave = rechazada', 'err' in verifyAssignment('', signed, 'zamu', now + 1000));
  ok('basura = rechazada', 'err' in verifyAssignment('clave-secreta', { payload: 1, sig: 2 }, 'zamu', now) && 'err' in verifyAssignment('clave-secreta', null, 'zamu', now));
}

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
