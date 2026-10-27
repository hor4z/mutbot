/**
 * Entrada del cerebro: lo que se recarga en caliente (hot.ts). Reúne el loop y todo lo que decide (zonas, aprendizaje, combate, botín,
 * reparto de puntos…) y expone `install`, que le muestra al núcleo (panel, telemetría) lo que necesita vía `hooks` (state.ts).
 * El núcleo (conexión, protocolo, estado del mundo, panel, base) nunca importa nada de acá: así sigue conectado mientras el cerebro se cambia.
 */
import { D } from '../core/directivas';
import { SKILL_TABLE, pickAttackSkill } from './combat';
import { STAT_SHARES, lastPlace, targetValue } from './area';
import { resetStatTracking } from './progress';
import { hooks, world } from '../core/state';
import { mapName } from '../core/panel-logic';

export { autonomousLoop, type LoopResult } from './farm-loop';

/** Conecta el cerebro con el núcleo. Se llama cada vez que el cerebro (re)arranca. */
export function install() {
  resetStatTracking(); // el seguimiento del reparto de puntos arranca de cero en cada sesión y en cada recarga
  // La zona elegida solo vale en su mapa: descansando en el pueblo el evento dice el pueblo, no la zona de farmeo.
  hooks.placeName = () => (lastPlace.v && lastPlace.v.warp.map === world.map ? lastPlace.v.name : mapName(world.map));
  hooks.value = targetValue;
  hooks.skill = () => {
    const s = pickAttackSkill();
    return s ? { number: s.number, name: SKILL_TABLE.get(s.number)?.name ?? `skill ${s.number}` } : null;
  };
  hooks.plan = () => ({ agiTarget: D.agiTarget, shares: { ...STAT_SHARES }, batch: D.statBatch });
}
