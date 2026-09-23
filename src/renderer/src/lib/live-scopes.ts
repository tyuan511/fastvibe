/**
 * Named event scopes this page wants delivered, over whichever transport it has.
 *
 * A desktop window and the full web client subscribe to `*` and are done: the engine
 * only streams the conversation every window follows, and that is the one they show.
 * The phone page shows a chat *without* making it that conversation — so it asks for the
 * chat's scope by name (`conversation:<id>`), which is what makes Main publish that
 * chat's live stream to it (`PiProcessManager.setStreamWatch`).
 *
 * The page imports this module, never the bridge: the bridge owns the boot and has side
 * effects, while this is only a registry the bridge installs itself into. With no host
 * installed (the Electron window, the mock preview) watching is a no-op — those already
 * receive what they need.
 */

export type LiveScopeHost = {
  subscribe(scopes: string[]): void;
  unsubscribe(scopes: string[]): void;
};

let host: LiveScopeHost | null = null;
const counts = new Map<string, number>();
const reconnectListeners = new Set<() => void>();

export function installLiveScopeHost(next: LiveScopeHost): void {
  host = next;
}

/** Scopes currently asked for, so a new socket can ask for them again. */
export function watchedScopes(): string[] {
  return [...counts.keys()];
}

/**
 * Ask for one scope until the returned function is called. Reference-counted, so two
 * components watching the same chat do not unsubscribe each other.
 */
export function watchScope(scope: string): () => void {
  const count = counts.get(scope) ?? 0;
  counts.set(scope, count + 1);
  if (count === 0) {
    try {
      host?.subscribe([scope]);
    } catch {
      // The socket is down; the reconnect asks for every watched scope again.
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (counts.get(scope) ?? 1) - 1;
    if (left > 0) {
      counts.set(scope, left);
      return;
    }
    counts.delete(scope);
    try {
      host?.unsubscribe([scope]);
    } catch {
      // Already gone with the socket.
    }
  };
}

/**
 * Called after the connection came back (or the server reported a gap) without a page
 * reload. Events that arrived while it was down are not replayed, so a listener re-reads
 * what it shows.
 */
export function onLiveReconnected(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

export function notifyLiveReconnected(): void {
  for (const listener of [...reconnectListeners]) {
    try {
      listener();
    } catch {
      // One reader failing must not stop the others re-reading.
    }
  }
}
