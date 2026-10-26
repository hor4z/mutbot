/**
 * Mini event bus para el bot.
 *
 * No es el EventBus del repo (src/libs/eventBus): ese tipa sus eventos contra
 * Babylon y el ECS, así que arrastraría media app. Acá alcanza con un mapa de
 * handlers por nombre de packet.
 */

type Handler = (payload: any) => void;

class BotEventBus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler) {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload?: unknown) {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copia: un handler puede desuscribirse mientras iteramos.
    for (const h of [...set]) h(payload);
  }

  clear() {
    this.handlers.clear();
  }
}

export const EventBus = new BotEventBus();