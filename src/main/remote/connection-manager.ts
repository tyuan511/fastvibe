import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import WebSocket from "ws";
import { ALL_SCOPES, type AppCapability, type AppHandshake } from "../../shared/app-protocol.ts";
import { remoteProjectKey } from "../../shared/project-binding.ts";
import type { ProjectBinding } from "../../shared/project-binding.ts";
import {
  DuplicateServerIdentityError,
  type RemoteAppClient,
  type RemoteClientStatus,
  type RemoteConnectionStatus,
  type RemoteMessageTransport,
} from "../../shared/remote-connection.ts";
import { namespaceRemotePush, shouldRelayRemotePush } from "../../shared/remote-events.ts";
import type { RemoteHostProfile } from "../../shared/remote-host.ts";
import type { RemoteWorkspace } from "../../shared/types.ts";

/**
 * Every remote App Server this machine is currently talking to.
 *
 * The branch this replaces held exactly one: `SshManager` owned a single tunnel and a
 * single client, and connecting a second host tore the first one down. Bindings let a
 * user keep projects on several machines visible at once, so the connections are a map
 * and every call names its own destination. There is no global active host.
 *
 * The manager owns connection *lifecycle*. It does not decide what a call means and it
 * does not keep a catalog: it hands out a connected, handshaken client keyed by the
 * server's own identity, and the caller routes through it.
 *
 * Each profile has a generation counter. Disconnect (and closeAll) bump it; an
 * in-flight deploy / tunnel / handshake that finishes afterwards refuses to register.
 * That is what stops a cancelled connect from resurrecting a row the user already closed.
 */

export type { RemoteConnectionStatus, RemoteMessageTransport };
export { DuplicateServerIdentityError };

export type MessageTransport = RemoteMessageTransport;
export type AppClientStatus = RemoteClientStatus;

export type ConnectionManagerDeps = {
  log: { info(message: string): void; warn(message: string): void };
  /** Fired on every status change, so a pane can show why a project is unavailable. */
  onStatus: (status: RemoteConnectionStatus) => void;
  /** Rewritten pushes, ready to broadcast locally. Dropped channels never arrive here. */
  onPush: (channel: string, payload: unknown, serverInstanceId: string) => void;
  /**
   * Deploy the headless Agent and open a forwarding tunnel. Returns the local port.
   *
   * Typical impl: `runSshCommand` for the runtime archive, then `SshTunnel.start`, then
   * `{ port: localPort, close: () => tunnel.stop(), configSyncToken }`. The manager never talks to SSH
   * itself — a test, and a non-SSH transport, inject a different opener.
   */
  openTransport: (
    profile: RemoteHostProfile,
    signal?: AbortSignal,
  ) => Promise<{ port: number; close: () => Promise<void>; configSyncToken?: string; home?: string }>;
  /**
   * Bring a connection back after it drops on its own (a tunnel that died, a laptop that
   * slept). Absent, a dropped connection stays down until something connects it again.
   *
   * Only an *unrequested* loss is retried: `disconnect` bumps the generation, which
   * cancels any pending attempt. A refused credential or host key is not retried either —
   * it would fail identically, and a password retried in a loop trips fail2ban.
   */
  reconnect?: {
    /** Wait before each attempt; one attempt per entry, then the connection stays down. */
    delaysMs: number[];
    /** The profile as it is now — the user may have edited it since the first connect. */
    profile?: (connectionId: string) => RemoteHostProfile | undefined;
    onReconnected?: (server: ConnectedServer) => void;
  };
  /**
   * Build the framed transport on top of a local port.
   *
   * Injected so a test can drive the manager without SSH or a socket. Production uses
   * `webSocketTransport`. Skipped when `createClient` is provided and this is absent.
   */
  createTransport?: (port: number, token?: string) => MessageTransport;
  /**
   * Build the protocol client on a framed transport.
   *
   * Injected so a test never has to speak the envelope AppClient is being rewritten
   * against. Production loads AppClient on demand: `connect()` handshake, `call(method,
   * payload)`, `onStatus` / `onPush` are the stable surface.
   */
  createClient?: (transport: MessageTransport) => RemoteAppClient;
};

export type ConnectedServer = {
  connectionId: string;
  serverInstanceId: string;
  capabilities: AppCapability[];
  client: RemoteAppClient;
  /** The transport's own teardown (the SSH tunnel and its forwarding process). */
  closeTransport: () => Promise<void>;
  /** Secret established by the SSH bootstrap for desktop → Agent config replication. */
  configSyncToken?: string;
  /** The remote user's home directory, when the transport learned it. */
  home?: string;
};

/** Failures a retry would only repeat. */
const FATAL_ERROR_CODES = new Set(["auth-failed", "host-key-unknown", "host-key-changed"]);

/** How long a call may wait for a remote server before it is given up on. */
const CALL_TIMEOUT_MS = 120_000;

const CANCELLED = "远程连接已取消";

type InFlightOpen = {
  client: RemoteAppClient | null;
  closeTransport: (() => Promise<void>) | null;
  controller: AbortController;
};

export class RemoteConnectionManager {
  #deps: ConnectionManagerDeps;
  #servers = new Map<string, ConnectedServer>();
  #connecting = new Map<string, Promise<ConnectedServer>>();
  #inflight = new Map<string, InFlightOpen>();
  #statuses = new Map<string, RemoteConnectionStatus>();
  #generation = new Map<string, number>();
  #profiles = new Map<string, RemoteHostProfile>();
  #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: ConnectionManagerDeps) {
    this.#deps = deps;
  }

  statuses(): RemoteConnectionStatus[] {
    return [...this.#statuses.values()];
  }

  status(connectionId: string): RemoteConnectionStatus | null {
    return this.#statuses.get(connectionId) ?? null;
  }

  /** The live server for a connection profile, if it is up and handshaken. */
  server(connectionId: string): ConnectedServer | undefined {
    return this.#servers.get(connectionId);
  }

  /**
   * The server that owns an instance id.
   *
   * This is the lookup a routed call makes: a namespaced identifier names a server, and
   * the address of that server on this machine is whichever profile happens to be
   * connected to it. Deliberately not keyed by profile — a binding records the server,
   * and the user is free to change which profile (and which host, port or key) reaches
   * it.
   */
  serverForInstance(serverInstanceId: string): ConnectedServer | undefined {
    for (const server of this.#servers.values()) {
      if (server.serverInstanceId === serverInstanceId) return server;
    }
    return undefined;
  }

  /**
   * Bring a connection up, or return the one already up.
   *
   * Concurrent callers share one attempt: two windows opening the same project at once
   * must not each deploy an Agent and open a tunnel to the same machine.
   */
  async connect(profile: RemoteHostProfile): Promise<ConnectedServer> {
    const existing = this.#servers.get(profile.id);
    if (existing) return existing;
    this.#profiles.set(profile.id, profile);
    this.#clearReconnect(profile.id);
    const inFlight = this.#connecting.get(profile.id);
    if (inFlight) return inFlight;

    const attempt = this.#open(profile).finally(() => {
      if (this.#connecting.get(profile.id) === attempt) this.#connecting.delete(profile.id);
    });
    this.#connecting.set(profile.id, attempt);
    return attempt;
  }

  async #open(profile: RemoteHostProfile): Promise<ConnectedServer> {
    const generation = this.#gen(profile.id);
    this.#setStatus({ connectionId: profile.id, serverInstanceId: null, state: "connecting", capabilities: [] });
    const controller = new AbortController();
    const slot: InFlightOpen = { client: null, closeTransport: null, controller };
    this.#inflight.set(profile.id, slot);
    let closeTransport: (() => Promise<void>) | null = null;
    let client: RemoteAppClient | null = null;
    try {
      const transport = await this.#deps.openTransport(profile, controller.signal);
      closeTransport = transport.close;
      slot.closeTransport = transport.close;
      if (this.#stale(profile.id, generation) || controller.signal.aborted) {
        await transport.close().catch(() => undefined);
        throw new Error(CANCELLED);
      }

      const framed = this.#framedTransport(transport.port, transport.configSyncToken);
      client = await this.#makeClient(framed);
      slot.client = client;
      if (this.#stale(profile.id, generation) || controller.signal.aborted) {
        client.close();
        await closeTransport().catch(() => undefined);
        throw new Error(CANCELLED);
      }

      this.#bindClient(profile.id, generation, client);

      const handshake = await client.connect();
      // A gateway needs live events from every remote scope. Wildcard is deliberately
      // live-only; if it reconnects, snapshots are fetched again rather than replaying
      // an unknown set of conversation cursors.
      client.subscribe([ALL_SCOPES]);
      if (this.#stale(profile.id, generation) || controller.signal.aborted) {
        client.close();
        await closeTransport().catch(() => undefined);
        throw new Error(CANCELLED);
      }

      const duplicate = this.serverForInstance(handshake.server.serverInstanceId);
      if (duplicate && duplicate.connectionId !== profile.id) {
        client.close();
        client = null;
        slot.client = null;
        await closeTransport().catch(() => undefined);
        closeTransport = null;
        slot.closeTransport = null;
        const error = new DuplicateServerIdentityError(
          handshake.server.serverInstanceId,
          duplicate.connectionId,
          profile.id,
        );
        this.#setStatus({
          connectionId: profile.id,
          serverInstanceId: handshake.server.serverInstanceId,
          state: "error",
          capabilities: [],
          error: error.message,
        });
        throw error;
      }

      const server: ConnectedServer = {
        connectionId: profile.id,
        serverInstanceId: handshake.server.serverInstanceId,
        capabilities: handshake.capabilities,
        client,
        closeTransport,
        configSyncToken: transport.configSyncToken,
        ...(transport.home ? { home: transport.home } : {}),
      };
      this.#inflight.delete(profile.id);
      this.#servers.set(profile.id, server);
      this.#setStatus({
        connectionId: profile.id,
        serverInstanceId: handshake.server.serverInstanceId,
        state: "ready",
        capabilities: handshake.capabilities,
      });
      return server;
    } catch (error) {
      if (this.#inflight.get(profile.id) === slot) this.#inflight.delete(profile.id);
      client?.close();
      if (closeTransport) await closeTransport().catch(() => undefined);
      if (this.#stale(profile.id, generation)) {
        throw error instanceof Error ? error : new Error(CANCELLED);
      }
      if (error instanceof DuplicateServerIdentityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(error);
      this.#setStatus({
        connectionId: profile.id,
        serverInstanceId: null,
        state: /不兼容/.test(message) ? "incompatible" : "error",
        capabilities: [],
        error: message,
        ...(code ? { errorCode: code } : {}),
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * The workspaces a connected server offers.
   *
   * Read through the App Protocol rather than by reaching into the remote machine: the
   * remote server's own project list *is* its workspace catalog. Returned as
   * `RemoteWorkspace` so a binding is built from a value the server stated, never from
   * a path this machine guessed.
   */
  async listWorkspaces(server: ConnectedServer): Promise<RemoteWorkspace[]> {
    const snapshot = (await this.call(server, "conversations:list", undefined)) as
      | { projects?: Array<Record<string, unknown>> }
      | undefined;
    const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
    return projects
      .map((project) => {
        const remotePath = typeof project.cwd === "string" ? project.cwd : "";
        if (!remotePath) return null;
        return {
          serverInstanceId: server.serverInstanceId,
          workspaceId: remotePath,
          path: remotePath,
          name: typeof project.name === "string" && project.name ? project.name : remotePath,
        } satisfies RemoteWorkspace;
      })
      .filter((item): item is RemoteWorkspace => item !== null);
  }

  /** One call, with a deadline, against a named server. */
  async call(server: ConnectedServer, method: string, payload: unknown): Promise<unknown> {
    return server.client.call(method, payload, { timeoutMs: CALL_TIMEOUT_MS });
  }

  async disconnect(connectionId: string): Promise<void> {
    this.#bump(connectionId);
    this.#clearReconnect(connectionId);
    const inFlight = this.#connecting.get(connectionId);
    // Drop the shared attempt so a caller that connects while we wait does not join
    // the dying one — it starts a new generation instead.
    if (inFlight) this.#connecting.delete(connectionId);
    await this.#abortInflight(connectionId);
    const server = this.#servers.get(connectionId);
    this.#servers.delete(connectionId);
    if (server) {
      server.client.close();
      await server.closeTransport().catch(() => undefined);
    }
    this.#setStatus({
      connectionId,
      serverInstanceId: server?.serverInstanceId ?? null,
      state: "closed",
      capabilities: [],
    });
  }

  /**
   * Tear everything down, for app exit — live servers *and* in-flight opens.
   *
   * A connection left open holds an SSH process, and an Electron quit that leaves one
   * behind means the next launch finds a tunnel already forwarded. Cancelling a deploy
   * that has not yet handshaken is the same obligation: that process is already running.
   */
  async closeAll(): Promise<void> {
    const connecting = [...this.#connecting.values()];
    const ids = new Set([...this.#servers.keys(), ...this.#connecting.keys(), ...this.#inflight.keys(), ...this.#reconnectTimers.keys()]);
    await Promise.all([...ids].map((id) => this.disconnect(id).catch(() => undefined)));
    await Promise.all(connecting.map((attempt) => attempt.catch(() => undefined)));
  }

  #bindClient(connectionId: string, generation: number, client: RemoteAppClient): void {
    client.onPush((channel, payload) => {
      if (this.#stale(connectionId, generation)) return;
      const serverInstanceId = client.handshake?.server.serverInstanceId;
      if (!serverInstanceId) return;
      if (!shouldRelayRemotePush(channel)) return;
      const next = namespaceRemotePush(channel, payload, serverInstanceId);
      if (next === undefined) return;
      this.#deps.onPush(channel, next, serverInstanceId);
    });
    client.onStatus((status) => {
      if (this.#stale(connectionId, generation)) return;
      const live = this.#servers.get(connectionId);
      if (!live || live.client !== client) return;
      if (status.state !== "error" && status.state !== "closed" && status.state !== "incompatible") return;
      this.#servers.delete(connectionId);
      void live.closeTransport().catch(() => undefined);
      this.#setStatus({
        connectionId,
        serverInstanceId: live.serverInstanceId,
        state: status.state === "incompatible" ? "incompatible" : status.state === "closed" ? "closed" : "error",
        capabilities: live.capabilities,
        ...(status.state === "error" || status.state === "incompatible" ? { error: status.message } : {}),
      });
      if (status.state !== "incompatible") this.#scheduleReconnect(connectionId, generation, 0);
    });
  }

  #scheduleReconnect(connectionId: string, generation: number, attempt: number): void {
    const policy = this.#deps.reconnect;
    const delay = policy?.delaysMs[attempt];
    if (!policy || delay === undefined || this.#stale(connectionId, generation)) return;
    this.#clearReconnect(connectionId);
    const timer = setTimeout(() => {
      if (this.#reconnectTimers.get(connectionId) === timer) this.#reconnectTimers.delete(connectionId);
      if (this.#stale(connectionId, generation)) return;
      if (this.#servers.has(connectionId) || this.#connecting.has(connectionId)) return;
      const profile = policy.profile?.(connectionId) ?? this.#profiles.get(connectionId);
      if (!profile) return;
      this.#deps.log.info(`[remote:${connectionId}] reconnecting (attempt ${attempt + 1}/${policy.delaysMs.length})`);
      this.connect(profile).then(
        (server) => policy.onReconnected?.(server),
        (error: unknown) => {
          const code = errorCode(error);
          if (code && FATAL_ERROR_CODES.has(code)) return;
          // `connect` does not bump the generation, so a user disconnect in the meantime
          // is what makes this stale — and then nothing more is scheduled.
          this.#scheduleReconnect(connectionId, generation, attempt + 1);
        },
      );
    }, delay);
    timer.unref?.();
    this.#reconnectTimers.set(connectionId, timer);
  }

  #clearReconnect(connectionId: string): void {
    const timer = this.#reconnectTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.#reconnectTimers.delete(connectionId);
  }

  async #abortInflight(connectionId: string): Promise<void> {
    const pending = this.#inflight.get(connectionId);
    this.#inflight.delete(connectionId);
    pending?.controller.abort();
    pending?.client?.close();
    if (pending?.closeTransport) await pending.closeTransport().catch(() => undefined);
  }

  #framedTransport(port: number, token?: string): MessageTransport {
    if (this.#deps.createTransport) return this.#deps.createTransport(port, token);
    if (this.#deps.createClient) return noopTransport();
    return webSocketTransport(port, { token });
  }

  async #makeClient(transport: MessageTransport): Promise<RemoteAppClient> {
    if (this.#deps.createClient) return this.#deps.createClient(transport);
    const mod = await loadAppClient();
    return new mod.AppClient(transport, {
      client: { kind: "fastvibe-desktop", version: this.#desktopVersion() },
      log: this.#deps.log,
      callTimeoutMs: CALL_TIMEOUT_MS,
    });
  }

  #gen(connectionId: string): number {
    return this.#generation.get(connectionId) ?? 0;
  }

  #bump(connectionId: string): number {
    const next = this.#gen(connectionId) + 1;
    this.#generation.set(connectionId, next);
    return next;
  }

  #stale(connectionId: string, generation: number): boolean {
    return this.#gen(connectionId) !== generation;
  }

  #setStatus(status: RemoteConnectionStatus): void {
    this.#statuses.set(status.connectionId, status);
    this.#deps.onStatus(status);
  }

  #desktopVersion(): string {
    return process.env.FASTVIBE_VERSION ?? "0.0.0";
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

async function loadAppClient(): Promise<typeof import("./app-client.ts")> {
  return import("./app-client.ts");
}

function noopTransport(): MessageTransport {
  return {
    send: () => undefined,
    onMessage: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
  };
}

/** How long to wait for the auth acknowledgement after the socket opens. */
const AUTH_TIMEOUT_MS = 10_000;

export type WebSocketTransportOptions = {
  authTimeoutMs?: number;
  /** Secret the SSH bootstrap printed; the remote Agent refuses loopback clients without it. */
  token?: string;
};

/**
 * A framed transport over the loopback port an SSH forward provides.
 *
 * Outbound frames (hello included) queue until the auth acknowledgement. Loopback is
 * not the credential — any local user on either machine can reach it — so the first
 * frame carries the token the bootstrap handed over through SSH. Close and
 * error settle once; a listener attached afterwards still sees the reason.
 * Legacy `{ push }` frames never reach a canonical AppClient.
 */
export function webSocketTransport(port: number, options?: WebSocketTransportOptions): MessageTransport {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const listeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  const queued: unknown[] = [];
  let authed = false;
  let settled = false;
  let closeReason: string | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (reason: string): void => {
    if (settled) return;
    settled = true;
    closeReason = reason;
    if (authTimer !== null) {
      clearTimeout(authTimer);
      authTimer = null;
    }
    queued.length = 0;
    for (const listener of [...closeListeners]) listener(reason);
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      // already gone
    }
  };

  const flush = (): void => {
    if (!authed || settled) return;
    for (const message of queued) {
      if (settled) return;
      socket.send(JSON.stringify(message));
    }
    queued.length = 0;
  };

  socket.on("open", () => {
    if (settled) return;
    const timeoutMs = options?.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    if (timeoutMs > 0) {
      authTimer = setTimeout(() => settle("远程 App Server 鉴权超时"), timeoutMs);
      authTimer.unref?.();
    }
    socket.send(JSON.stringify({ type: "auth", token: options?.token ?? "" }));
  });
  socket.on("message", (data) => {
    if (settled) return;
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    const record = typeof message === "object" && message !== null
      ? message as Record<string, unknown>
      : null;
    if (record && record.type === "auth") {
      if (record.ok !== true) {
        settle(typeof record.error === "string" && record.error ? record.error : "远程 App Server 鉴权失败");
        return;
      }
      if (authTimer !== null) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      authed = true;
      flush();
      return;
    }
    // Legacy `{ push }` must never reach AppClient: before welcome it looks like a
    // bad handshake, and afterwards it is not an event.
    if (record && typeof record.push === "string") return;
    if (!authed) return;
    for (const listener of [...listeners]) listener(message);
  });
  socket.on("close", () => {
    settle(authed ? "远程 App Server 连接已断开" : "无法连接远程 App Server");
  });
  socket.on("error", (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    settle(reason || "无法连接远程 App Server");
  });

  return {
    send: (message) => {
      if (settled) throw new Error(closeReason ?? "远程连接已关闭");
      if (!authed) {
        queued.push(message);
        return;
      }
      socket.send(JSON.stringify(message));
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      if (settled && closeReason !== null) listener(closeReason);
      return () => closeListeners.delete(listener);
    },
    close: () => settle("远程连接已关闭"),
  };
}

/** A free loopback port for the SSH forward to bind. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("无法分配本地 SSH 转发端口");
  return port;
}

/** Mint the stable identity recorded for a binding's local row. */
export function newBindingId(): string {
  return `bind_${randomUUID()}`;
}

/** The project key a workspace on a server is grouped under. */
export function workspaceProjectKey(serverInstanceId: string, workspaceId: string): string {
  return remoteProjectKey(serverInstanceId, workspaceId);
}

export type { ProjectBinding, AppHandshake };
