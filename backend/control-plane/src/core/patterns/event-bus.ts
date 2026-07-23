/**
 * Observer pattern — typed, synchronous-dispatch event bus.
 *
 * The turn orchestrator emits an event at every pipeline stage. Two consumers:
 *
 *   1. the trace recorder, which builds the waterfall the dashboard renders
 *   2. the async plane (Redpanda), for analytics, billing, webhooks
 *
 * Handlers must never block the turn loop, so emit() dispatches sync handlers
 * inline (cheap: push to a buffer) and defers async ones to a microtask. A slow
 * webhook can never add latency to a phone call.
 */

export type Listener<T> = (payload: T) => void;
export type AsyncListener<T> = (payload: T) => Promise<void>;

export class EventBus<TEvents extends Record<string, unknown>> {
  private readonly sync = new Map<keyof TEvents, Set<Listener<any>>>();
  private readonly async = new Map<keyof TEvents, Set<AsyncListener<any>>>();
  private readonly wildcard = new Set<Listener<{ type: keyof TEvents; payload: unknown }>>();

  /** Runs inline, in the turn loop. Keep it to buffer appends. */
  on<K extends keyof TEvents>(type: K, listener: Listener<TEvents[K]>): () => void {
    let set = this.sync.get(type);
    if (!set) this.sync.set(type, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Deferred to a microtask. Safe for IO. Errors are isolated. */
  onAsync<K extends keyof TEvents>(type: K, listener: AsyncListener<TEvents[K]>): () => void {
    let set = this.async.get(type);
    if (!set) this.async.set(type, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Every event — used by the trace recorder. */
  onAny(listener: Listener<{ type: keyof TEvents; payload: unknown }>): () => void {
    this.wildcard.add(listener);
    return () => this.wildcard.delete(listener);
  }

  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void {
    const syncSet = this.sync.get(type);
    if (syncSet) {
      for (const l of syncSet) {
        try {
          l(payload);
        } catch (e) {
          this.reportError(type, e);
        }
      }
    }

    for (const l of this.wildcard) {
      try {
        l({ type, payload });
      } catch (e) {
        this.reportError(type, e);
      }
    }

    const asyncSet = this.async.get(type);
    if (asyncSet?.size) {
      queueMicrotask(() => {
        for (const l of asyncSet) {
          void l(payload).catch((e) => this.reportError(type, e));
        }
      });
    }
  }

  removeAll(): void {
    this.sync.clear();
    this.async.clear();
    this.wildcard.clear();
  }

  private reportError(type: keyof TEvents, e: unknown): void {
    // Never throw out of emit — a broken listener must not kill a live call.
    console.error(`[EventBus] listener failed for "${String(type)}"`, e);
  }
}
