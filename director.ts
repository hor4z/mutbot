/**
 * Director: mira a la flota y propone la próxima misión de cada escuadra, con su motivo. Lógica pura (sin red ni reloj).
 * Una sola fuente de "qué hace el grupo ahora" en vez de rutinas, pedidos de ayuda y avisos sueltos.
 * Fases por escuadra (sin misión en curso):
 *   GEAR   — hay un dorado avisado y toda la escuadra llega a ese mapa: misión `golden` (cobra quien más daño hace; ver docs/escuadras.md).
 *   LEVEL  — hay un padrino al que los demás pueden seguir con rendimiento (`followDecision`): campaña de crianza.
 *   (nada) — cada bot sigue su ruta fija; el reset no se coordina acá (lo frena la invasión, `resetBlockedByInvasion`).
 * No lanza nada: `estacion.ts` aplica la propuesta solo con MUBOT_DIRECTOR=auto; si no, la anuncia.
 */
import { followDecision, isTerminal, squadMapByWarp, SQUAD_MAPS, type Finding, type MemberSnap, type Snapshot, type Squad, type StartMission } from './squad';

export type Proposal = { squad: string; phase: 'GEAR' | 'LEVEL'; req: StartMission; why: string };

/** Un dorado avisado vale este tiempo para mandar a una escuadra a buscarlo. */
/** Diferencia mínima de nivel para que valga la pena criar. */
const MIN_GAP = 20;
export const GOLD_FRESH_MS = 3 * 60_000;

const key = (c: string) => c.toLowerCase();

function goldWarp(f: Finding): number | null {
  return SQUAD_MAPS.find((m) => m.map === f.map)?.warp ?? null;
}

export function propose(squads: Iterable<Squad>, snap: Snapshot): Proposal[] {
  const out: Proposal[] = [];
  for (const s of squads) {
    if (s.mission && !isTerminal(s.mission.phase)) continue;
    const act = s.members.map((c) => snap.members.get(key(c))).filter((m): m is MemberSnap => !!m && m.online && m.obeys);
    if (act.length < 2) continue;

    const gold = snap.findings
      .filter((f) => f.kind === 'golden' && snap.now - f.at <= GOLD_FRESH_MS)
      .map((f) => ({ f, warp: goldWarp(f) }))
      .filter((g): g is { f: Finding; warp: number } => g.warp != null)
      .filter((g) => act.every((a) => a.level >= squadMapByWarp(g.warp)!.reqLevel))
      .sort((a, b) => b.f.at - a.f.at)[0];
    if (gold) {
      out.push({ squad: s.id, phase: 'GEAR', req: { kind: 'golden', warp: gold.warp }, why: `dorado avisado en ${squadMapByWarp(gold.warp)!.name}${gold.f.note ? ` (${gold.f.note})` : ''}` });
      continue;
    }

    const sorted = [...act].sort((a, b) => b.level - a.level);
    const padrino = sorted[0];
    const wards = sorted.slice(1);
    if (wards.length && wards.every((w) => w.level < padrino.level)) {
      const d = followDecision(padrino.level, wards.map((w) => w.level));
      if (d.ok && padrino.level - Math.min(...wards.map((w) => w.level)) >= MIN_GAP) {
        out.push({ squad: s.id, phase: 'LEVEL', req: { kind: 'nurture', follow: true, padrino: padrino.char }, why: `crianza: ${d.msg}` });
      }
    }
  }
  return out;
}
