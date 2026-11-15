export type Unsubscribe = () => void;

export type EventMap = Record<string, unknown>;

type Handler<T> = (payload: T) => void | Promise<void>;

export interface EventBus<TEvents extends EventMap = EventMap> {
  publish<K extends keyof TEvents & string>(type: K, payload: TEvents[K]): Promise<void>;
  subscribe<K extends keyof TEvents & string>(type: K, handler: Handler<TEvents[K]>): Unsubscribe;
}

export type ErrorHandler = (error: unknown, eventType: string) => void;

/** In-process implementation. A failing handler never blocks other handlers or the publisher. */
export class InMemoryEventBus<TEvents extends EventMap = EventMap> implements EventBus<TEvents> {
  private readonly handlers = new Map<string, Set<Handler<never>>>();

  constructor(private readonly onError: ErrorHandler = () => undefined) {}

  async publish<K extends keyof TEvents & string>(type: K, payload: TEvents[K]): Promise<void> {
    const set = this.handlers.get(type);
    if (!set) return;
    await Promise.all(
      [...set].map(async (handler) => {
        try {
          await (handler as Handler<TEvents[K]>)(payload);
        } catch (error) {
          this.onError(error, type);
        }
      }),
    );
  }

  subscribe<K extends keyof TEvents & string>(type: K, handler: Handler<TEvents[K]>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const stored = handler as Handler<never>;
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }
}
