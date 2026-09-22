import { AppClient, type MessageTransport } from "../../shared/app-client.ts";
import { ALL_SCOPES } from "../../shared/app-protocol.ts";
import type { AppServer } from "../app-server/app-server.ts";
import type { ClientSession } from "../app-server/client-session.ts";

/** Broadcast identity of one window, derived from its WebContents id. */
export function windowOrigin(webContentsId: number): string {
  return `window:${webContentsId}`;
}

export type WindowSessionHost = {
  origin: string;
  /** Trusted; native dialogs parent to this. Omitted for tests. */
  window?: unknown | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  isClosed?: () => boolean;
  clientKind?: string;
  clientVersion?: string;
  handshakeTimeoutMs?: number;
};

export type WindowSession = {
  origin: string;
  session: ClientSession;
  ready: Promise<void>;
  call: (method: string, payload?: unknown) => Promise<unknown>;
  dispose: () => void;
};

class LoopbackTransport implements MessageTransport {
  peer: LoopbackTransport | null = null;
  #messages = new Set<(message: unknown) => void>();
  #closes = new Set<(reason: string) => void>();
  #closed = false;

  send(message: unknown): void {
    if (this.#closed) throw new Error("closed");
    const peer = this.peer;
    if (!peer || peer.#closed) return;
    queueMicrotask(() => peer.#deliver(message));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close(): void {
    this.#disconnect("closed");
  }

  #deliver(message: unknown): void {
    if (this.#closed) return;
    for (const listener of [...this.#messages]) listener(message);
  }

  #disconnect(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of [...this.#closes]) listener(reason);
  }
}

/**
 * One AppServer session + AppClient for a desktop window.
 *
 * Index no longer `subscribe()`s each BrowserWindow onto `broadcast`. Live fan-out
 * reaches the renderer through this client: wildcard subscribe, then `onPush` →
 * `webContents.send`. `except` is the session origin, same string `broadcast` used.
 */
export function attachWindowSession(appServer: AppServer, host: WindowSessionHost): WindowSession {
  const clientWire = new LoopbackTransport();
  const serverWire = new LoopbackTransport();
  clientWire.peer = serverWire;
  serverWire.peer = clientWire;

  let disposed = false;
  const closed = (): boolean => disposed || Boolean(host.isClosed?.());

  const session = appServer.attach({
    identity: {
      subject: host.origin,
      kind: "window",
      clientKind: host.clientKind ?? "electron",
      clientVersion: host.clientVersion ?? "desktop",
    },
    send: (message) => {
      if (closed()) return false;
      try {
        serverWire.send(message);
        return true;
      } catch {
        return false;
      }
    },
    window: host.window,
    origin: host.origin,
  });

  const offServer = serverWire.onMessage((message) => {
    void appServer.receive(session, message);
  });

  const client = new AppClient(clientWire, {
    client: {
      kind: host.clientKind ?? "electron",
      version: host.clientVersion ?? "desktop",
    },
    handshakeTimeoutMs: host.handshakeTimeoutMs ?? 5_000,
  });
  client.onPush((channel, payload) => {
    if (closed()) return;
    try {
      host.sendToRenderer(channel, payload);
    } catch {
      // Renderer gone between the closed check and the send.
    }
  });

  const ready = client.connect().then(async () => {
    client.subscribe([ALL_SCOPES]);
    await waitUntil(() => session.isSubscribed(ALL_SCOPES), "window session subscription was not ready");
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    offServer();
    client.close();
    appServer.detach(session);
  };

  const call = async (method: string, payload?: unknown): Promise<unknown> => {
    await ready;
    return client.call(method, payload);
  };

  return { origin: host.origin, session, ready, call, dispose };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise<void>((settle) => {
      if (i < 8) queueMicrotask(settle);
      else setTimeout(settle, 5);
    });
  }
  throw new Error(message);
}
