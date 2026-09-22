/**
 * The one place a pushed message leaves Main through.
 *
 * Main used to fan out by walking the window set at each of its push sites — status,
 * engine events, conversation-ready, OAuth, terminal data, settings, updater — which
 * baked "a receiver is a BrowserWindow" into every one of them. A remote client is not
 * a window, so each site would have had to grow a second loop over a second kind of
 * receiver, and the two would have drifted the first time one was updated alone.
 *
 * Subscribers register a `send` instead. The push sites no longer know what is
 * listening: windows today, WebSocket clients next, and nothing at those sites has to
 * change when that happens.
 */

export type Subscriber = {
  /**
   * Stable identity of this receiver. `broadcast` can skip one, which is how a write
   * that a client made itself is not echoed back to it (settings).
   */
  readonly id: string;
  send(channel: string, payload: unknown): void;
};

const subscribers = new Map<string, Subscriber>();

export type BroadcastObservation = {
  channel: string;
  payload: unknown;
  except?: string;
};

type BroadcastObserver = (observation: BroadcastObservation) => void;

const observers = new Set<BroadcastObserver>();

/** Register a receiver. The returned function removes it; call it once, on close. */
export function subscribe(subscriber: Subscriber): () => void {
  subscribers.set(subscriber.id, subscriber);
  return () => {
    subscribers.delete(subscriber.id);
  };
}

/**
 * Watch every push, including the `except` origin `broadcast` itself applies.
 *
 * Distinct from `subscribe`: a subscriber is skipped when its id matches `except`, which
 * is what stops a window echoing its own write. The process AppServer still has to see
 * that write so every *other* session can receive it — so the observer is not a
 * subscriber, is not counted in `subscriberCount`, and is never the origin being skipped.
 */
export function observe(observer: BroadcastObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/**
 * Push one message to every subscriber, optionally skipping the one that caused it.
 *
 * A receiver that throws is dropped rather than allowed to break the fan-out: a window
 * destroyed between the last tick and this one would otherwise throw
 * "Object has been destroyed" partway through the loop and silently deny the message
 * to every subscriber after it. That ordering-dependent loss is exactly the kind of
 * thing that never reproduces, so it is handled here once instead of at seven sites.
 */
export function broadcast(channel: string, payload: unknown, options?: { except?: string }): void {
  for (const observer of [...observers]) {
    try {
      observer({ channel, payload, except: options?.except });
    } catch {
      observers.delete(observer);
    }
  }
  for (const subscriber of [...subscribers.values()]) {
    if (options?.except && subscriber.id === options.except) continue;
    try {
      subscriber.send(channel, payload);
    } catch {
      subscribers.delete(subscriber.id);
    }
  }
}

/** How many receivers are attached. Used by the server UI to show connected clients. */
export function subscriberCount(): number {
  return subscribers.size;
}
