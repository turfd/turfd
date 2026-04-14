import type { GameEvent } from "./types";

type Listener = (event: GameEvent) => void;

const DEV_MAX_LISTENERS = 20;

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

    if (import.meta.env.DEV && list.length > DEV_MAX_LISTENERS) {
      console.warn(
        `[EventBus] Possible listener leak: "${type}" has ${list.length} listeners (threshold: ${DEV_MAX_LISTENERS})`,
      );
    }

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
    for (let i = 0; i < list.length; i++) {
      const prev = list.length;
      list[i]!(event);
      if (list.length < prev) {
        i -= prev - list.length;
      }
    }
  }

  listenerCount(eventType: string): number {
    return this.handlers.get(eventType as GameEvent["type"])?.length ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
