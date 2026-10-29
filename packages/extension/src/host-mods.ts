/**
 * Los módulos del núcleo que usa el cerebro (bot/src/brain). La página los publica en `window.__mu.mods` para que un cerebro nuevo, compilado aparte
 * (`bun run brain`, ver brain-build.ts), comparta el MISMO estado (`world`, `assist`, el mundo, el socket…) en vez de traer el suyo. Es el mismo
 * reparto que hacía la recarga en caliente del bot: el núcleo se queda, el cerebro se cambia. Si el cerebro importa un módulo nuevo de afuera de
 * `brain/`, hay que sumarlo acá.
 */
import * as actions from '../../bot/src/core/actions';
import * as config from '../../bot/src/core/config';
import * as connection from '../../bot/src/core/connection';
import * as gamedata from '../../bot/src/core/gamedata';
import * as journal from '../../bot/src/core/journal';
import * as lootState from '../../bot/src/core/loot-state';
import * as panelLogic from '../../bot/src/core/panel-logic';
import * as protocol097 from '../../bot/src/core/protocol097';
import * as state from '../../bot/src/core/state';
import * as telemetry from '../../bot/src/core/telemetry';
import * as util from '../../bot/src/core/util';
import * as eventBus from '../../bot/src/net/eventBus';
import * as packets from '../../bot/src/packets';

export const HOST_MODS: Record<string, object> = {
  'core/actions': actions,
  'core/config': config,
  'core/connection': connection,
  'core/gamedata': gamedata,
  'core/journal': journal,
  'core/loot-state': lootState,
  'core/panel-logic': panelLogic,
  'core/protocol097': protocol097,
  'core/state': state,
  'core/telemetry': telemetry,
  'core/util': util,
  'net/eventBus': eventBus,
  'packets/index': packets,
};
