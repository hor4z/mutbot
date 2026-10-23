/**
 * Tests offline de recovery.ts (auto-recuperación del PK). Sin red, reloj simulado.
 *
 *   bun run recovery-tests.ts
 */
import { PK_RECOVERY, PkRecovery, classifyServerMessage } from './recovery';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const C = PK_RECOVERY;

// --- Avisos reales del server (tabla events, server_msg, 2026-10-23) ---------------------------------------
ok('"Un PK no puede usar /move."', classifyServerMessage('Un PK no puede usar /move.')?.kind === 'pk-move');
ok('"PK: 2 kills, 10% probabilidad de drop."', JSON.stringify(classifyServerMessage('PK: 2 kills, 10% probabilidad de drop.')) === '{"kind":"pk-info","kills":2}');
ok('"[/pkclear] Hume kills have been cleaned."', classifyServerMessage('[/pkclear] Hume kills have been cleaned.')?.kind === 'pk-cleared');
ok('otros avisos no son PK', classifyServerMessage('You need 1000 in order to warp') === null && classifyServerMessage('[Noria] Golden invasion!') === null);

// --- El caso de Hume: aviso de PK → /pkclear solo, una vez, y el aviso de limpio cierra el episodio ------------
{
  const r = new PkRecovery();
  const t0 = 1_000_000;
  ok('sin aviso no manda nada', r.next(t0) === null);
  r.onServerMessage('PK: 2 kills, 10% probabilidad de drop.', t0);
  r.onServerMessage('Un PK no puede usar /move.', t0 + 3000);
  ok('espera el retardo inicial (no pisa el chat)', r.next(t0 + 1000) === null);
  const a = r.next(t0 + C.firstDelayMs);
  ok('primer intento tras el retardo', a != null && 'send' in a && a.send === '/pkclear' && a.tryNo === 1, a);
  r.sent(t0 + C.firstDelayMs);
  ok('no repite mientras espera la respuesta', r.next(t0 + C.firstDelayMs + 5000) === null);
  r.onServerMessage('Un PK no puede usar /move.', t0 + 8000); // otro warp que falla: no reabre ni adelanta
  ok('un aviso más no adelanta el reintento', r.next(t0 + C.firstDelayMs + C.retryMs - 1) === null);
  r.onServerMessage('[/pkclear] Hume kills have been cleaned.', t0 + 6000);
  ok('el aviso de limpio cierra el episodio', !r.active && r.next(t0 + 60_000) === null && r.tries === 0);
}

// --- Si el server no lo limpia: tope de intentos y enfriamiento largo -------------------------------------
{
  const r = new PkRecovery();
  let t = 0;
  r.onServerMessage('Un PK no puede usar /move.', t);
  const sent: number[] = [];
  let gaveUp: string | null = null;
  for (t = 0; t < 3 * 3600_000 && !gaveUp; t += 1000) {
    const a = r.next(t);
    if (a && 'send' in a) { r.sent(t); sent.push(t); }
    else if (a && 'giveUp' in a) gaveUp = a.giveUp;
  }
  ok('hace como mucho maxTries intentos', sent.length === C.maxTries, sent);
  ok('respeta retryMs entre intentos', sent.every((s, i) => i === 0 || s - sent[i - 1] >= C.retryMs), sent);
  ok('después se rinde con aviso (para el diario)', gaveUp != null, gaveUp);
  const giveAt = t - 1000;
  ok('en el enfriamiento no vuelve a mandar aunque lleguen avisos', (() => {
    r.onServerMessage('Un PK no puede usar /move.', giveAt + 1000);
    return r.next(giveAt + 2000) === null && r.next(giveAt + C.cooldownMs - 5000) === null;
  })());
  ok('pasado el enfriamiento, si sigue el PK, vuelve a intentar', (() => {
    const a = r.next(giveAt + C.cooldownMs + C.firstDelayMs + 10);
    return a != null && 'send' in a && a.tryNo === 1;
  })());
}

// --- Warps sin respuesta repetidos (sin que haya llegado el aviso de PK) ------------------------------------
{
  const r = new PkRecovery();
  r.onWarp(false, 0); r.onWarp(false, 15_000);
  ok('2 warps fallidos: todavía no', !r.active);
  r.onWarp(false, 30_000);
  ok('3 warps fallidos: prueba /pkclear', r.active && (r.next(30_000 + C.firstDelayMs) as { send?: string } | null)?.send === '/pkclear');
  const r2 = new PkRecovery();
  r2.onWarp(false, 0); r2.onWarp(false, 1); r2.onWarp(true, 2); r2.onWarp(false, 3);
  ok('un warp que sí respondió corta la racha', !r2.active);
}

// --- El vigía puede pedirlo (diagnosticó PK) ---------------------------------------------------------------
{
  const r = new PkRecovery();
  r.force(0, 'vigía: sin progreso y PK');
  ok('force abre el episodio', r.active && (r.next(C.firstDelayMs) as { why?: string } | null)?.why === 'vigía: sin progreso y PK');
}

// --- PK: 0 kills = limpio -----------------------------------------------------------------------------------
{
  const r = new PkRecovery();
  r.onServerMessage('Un PK no puede usar /move.', 0);
  r.onServerMessage('PK: 0 kills, 0% probabilidad de drop.', 1);
  ok('PK: 0 kills cierra el episodio', !r.active);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE RECUPERACIÓN PASARON' : `\n${fails} TEST(S) DE RECUPERACIÓN FALLARON`);
process.exit(fails ? 1 : 0);
