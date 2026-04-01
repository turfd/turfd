import type { GameEvent } from "./types";

type Listener = (event: GameEvent) => void;

/**
 * Typed pub/sub for UI ↔ game ↔ network. Handlers registered per `type` receive narrowed events.
 */
export class EventBus {
  private readonly handlers = new Map<GameEvent["type"], Listener[]>();

  on<E extends GameEvent["type"]>(
    type: E,
    handler: (event: Extract<GameEvent, { type: E }>) => void,
  ): () => void {
    const list = this.handlers.get(type) ?? [];
    const wrapped: Listener = (event: GameEvent) => {
      if (event.type === type) {
        handler(event as Extract<GameEvent, { type: E }>);
      }
    };
    list.push(wrapped);
    this.handlers.set(type, list);
    return () => {
      const i = list.indexOf(wrapped);
      if (i >= 0) {
        list.splice(i, 1);
      }
      if (list.length === 0) {
        this.handlers.delete(type);
      }
    };
  }

  emit<E extends GameEvent>(event: E): void {
    const list = this.handlers.get(event.type);
    if (!list) {
      return;
    }
    const snapshot = [...list];
    for (const h of snapshot) {
      h(event);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
