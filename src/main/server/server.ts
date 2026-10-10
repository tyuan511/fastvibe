import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LoginThrottle, passwordProblem } from "./auth.ts";
import { BackpressureGuard, BUFFER_GRACE_MS, BUFFER_SOFT_LIMIT } from "./backpressure.ts";
import { authenticate, isConfigured, listDevices, login, touchDevice } from "./store.ts";
import { assertPolicyCoverage, remotePolicy } from "../../shared/remote-policy.ts";
import {
  APP_CAPABILITIES,
  newServerInstanceId,
  readClientMessage,
  type AppCapability,
  type AppServerIdentity,
} from "../../shared/app-protocol.ts";
import {
  decodeBinaryAttachment,
  materializeBinaryAttachments,
} from "../../shared/binary-attachment.ts";
import { AppServer } from "../app-server/app-server.ts";
import type { ClientSession } from "../app-server/client-session.ts";

/**
 * The remote server: a second way into the same call table the desktop windows use.
 *
 * Deliberately free of Electron. It is handed a `dispatch` and a `subscribe` and knows
 * nothing about windows, which is what keeps "one behaviour, two transports" true — and
 * what would let this run without a GUI later.
 *
 * It binds to loopback by default and expects a tunnel to publish it. The user can
 * explicitly opt into LAN access; in that mode it listens on all local interfaces and
 * reports the machine's private IPv4 address so another device has an address to open.
 */

export type RemoteLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
};

/**
 * The slice of a WebSocket the server uses, so a transport that is not one — a WebRTC
 * data channel (`rtc/channel-socket.ts`) — can be handed in through `attachTransport`
 * and get everything else for free: the policy, the backpressure guard, the heartbeat,
 * the App Protocol session. `ws`'s own `WebSocket` satisfies it as is.
 */
export interface RemoteSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  /** Drop it now, without waiting for the other side to agree. */
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (raw: Buffer, isBinary: boolean) => void): this;
  on(event: "pong", listener: () => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type RemoteServerDeps = {
  /** Where the password hash and device tokens live. Never served by any method. */
  accessFile: string;
  /** Every method registered on the neutral table, for the policy coverage check. */
  channels: () => readonly string[];
  /** Headless Agent registers a supported subset; desktop server keeps the full table. */
  policyScope?: "full" | "subset";
  /**
   * Secret an SSH port forward presents from loopback instead of a device token.
   *
   * Loopback alone is not a credential: on a shared host every local user can reach
   * 127.0.0.1, and on the desktop so can any process (or a DNS-rebound page) that finds
   * the forwarded port. The bootstrap hands this token to the desktop over SSH, so only
   * the side that authenticated to SSH can present it. Setting it also pins the listen
   * address to loopback.
   */
  loopbackToken?: string;
  /** Run one method. The same function the Electron transport calls. Used for legacy frames. */
  dispatch: (method: string, payload: unknown, clientId: string) => Promise<unknown>;
  /**
   * Process-wide AppServer. When omitted, one is constructed for tests / headless with a
   * stable identity fallback. Production injects the runtime instance so Electron and
   * WebSocket share a journal, not a second envelope.
   */
  appServer?: AppServer;
  /** Stable identity advertised after outer authentication. Ignored when `appServer` is set. */
  identity?: AppServerIdentity;
  /** Capabilities this headless/desktop server exposes. Ignored when `appServer` is set. */
  capabilities?: readonly AppCapability[];
  /** Attach a push receiver; the returned function detaches it. Legacy clients only. */
  subscribe: (client: { id: string; send: (channel: string, payload: unknown) => void }) => () => void;
  /**
   * Told about a change the caller could not otherwise learn of: a device logging in
   * over plain HTTP, or a WebSocket attaching or dropping. None of those go through a
   * `remote:*` method, so without this the settings pane's device list and client count
   * only refresh the next time its own effect happens to run — a login while the pane is
   * already open would otherwise sit invisible until it is closed and reopened.
   */
  onStatusChange?: () => void;
  /**
   * How often to talk to each socket, so nothing in front of us times it out.
   *
   * Only tests pass this: a check that a silent socket is dropped cannot afford to wait
   * out the real interval, and a shorter one proves the same thing.
   */
  heartbeatMs?: number;
  log: RemoteLogger;
};

export type RemoteServerStatus = {
  running: boolean;
  host: string;
  port: number | null;
  /** Whether a password has been set. Without one the server refuses to start. */
  configured: boolean;
  clients: number;
  failedLogins: number;
};

/** A socket that has not authenticated within this long is closed. */
const AUTH_GRACE_MS = 10_000;

/**
 * How often each socket is pinged.
 *
 * Comfortably under every idle timeout this server meets in practice — Cloudflare's edge
 * drops a quiet WebSocket after 100 seconds, nginx's `proxy_read_timeout` defaults to 60
 * — because what it is protecting is the normal case: a transcript being read, or a run
 * being watched, is exactly a socket with nothing to say.
 */
const HEARTBEAT_MS = 30_000;

/** Largest frame accepted from a client. A prompt with images is the big one. */
const MAX_FRAME_BYTES = 24 * 1024 * 1024;

/** WebSocket close codes used here. 4001-4009 are private-use. */
const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_TIMEOUT = 4002;
const CLOSE_TOO_LARGE = 4003;
const CLOSE_BACKPRESSURE = 4004;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 60_000;

export type RemoteLanAddresses = { ipv4: string | null; ipv6: string | null };

/** Pick usable IPv4/IPv6 addresses of this machine, to report where a listener is reachable. */
export function lanAddresses(): RemoteLanAddresses {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const [name, items] of Object.entries(networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.internal) continue;
      if (item.family === "IPv4") {
        ipv4.push(item.address);
      } else if (item.family === "IPv6") {
        // Link-local IPv6 needs the interface zone to be usable from a browser.
        ipv6.push(item.address.toLowerCase().startsWith("fe80:") && !item.address.includes("%")
          ? `${item.address}%${name}`
          : item.address);
      }
    }
  }
  return {
    ipv4: ipv4.find((address) =>
      /^(10|192\.168)\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address),
    ) ?? ipv4[0] ?? null,
    // Prefer a routable/ULA address over a link-local address when both exist.
    ipv6: ipv6.find((address) => !address.toLowerCase().startsWith("fe80:")) ?? ipv6[0] ?? null,
  };
}

export function lanAddress(): string | null {
  return lanAddresses().ipv4;
}

type Client = {
  id: string;
  socket: RemoteSocket;
  /**
   * Attached through `attachTransport`: authenticated by whoever attached it, and not
   * tied to the HTTP listener, so stopping the listener leaves it connected.
   */
  external: boolean;
  /** Arrived from 127.0.0.1 / ::1, so it may present the SSH loopback token. */
  loopback: boolean;
  deviceId: string | null;
  detach: (() => void) | null;
  timer: NodeJS.Timeout | null;
  /** Answered the last ping. Cleared when one is sent, set again when the pong lands. */
  alive: boolean;
  backpressure: BackpressureGuard;
  backpressureTimer: NodeJS.Timeout | null;
  /** New App Protocol frames are used after the legacy auth frame. */
  protocolClient: boolean;
  appSession: ClientSession | null;
  attachments: Map<string, { bytes: Buffer; expiresAt: number }>;
  attachmentBytes: number;
};

export class RemoteServer {
  #deps: RemoteServerDeps;
  #http: Server | null = null;
  #wss: WebSocketServer | null = null;
  #clients = new Map<string, Client>();
  #throttle = new LoginThrottle();
  #heartbeat: NodeJS.Timeout | null = null;
  #host = "127.0.0.1";
  #listenHost = "127.0.0.1";
  #port: number | null = null;
  #appServer: AppServer;
  #ownsAppServer: boolean;

  constructor(deps: RemoteServerDeps) {
    this.#deps = deps;
    if (deps.appServer) {
      this.#appServer = deps.appServer;
      this.#ownsAppServer = false;
      return;
    }
    const identity: AppServerIdentity = deps.identity ?? {
      serverInstanceId: newServerInstanceId(),
      version: "unknown",
      platform: process.platform,
    };
    this.#ownsAppServer = true;
    this.#appServer = new AppServer({
      identity,
      channels: deps.channels,
      capabilities: deps.capabilities ?? APP_CAPABILITIES,
      dispatch: (method, payload, context) =>
        deps.dispatch(method, payload, context.origin ?? context.subject),
      log: deps.log,
    });
  }

  /** The AppServer this socket adapter talks to. Process-wide when injected. */
  get appServer(): AppServer {
    return this.#appServer;
  }

  get status(): RemoteServerStatus {
    return {
      running: this.#http !== null,
      host: this.#listenHost === "0.0.0.0"
        ? (lanAddresses().ipv4 ?? "0.0.0.0")
        : this.#listenHost === "::"
          ? (lanAddresses().ipv6 ?? "::")
          : this.#host,
      port: this.#port,
      configured: isConfigured(this.#deps.accessFile),
      clients: this.#clients.size,
      failedLogins: this.#throttle.failures,
    };
  }

  /**
   * Start listening.
   *
   * Refuses without a password: a server that is reachable and asks for nothing is the
   * one mistake that cannot be walked back, so it is made impossible rather than warned
   * about. The policy check runs here too — the table is fully known by now, and a method
   * nobody classified must stop the server rather than be quietly exposed.
   */
  async start(options: { port: number; host?: string }): Promise<RemoteServerStatus> {
    if (this.#http) return this.status;
    if (!isConfigured(this.#deps.accessFile) && !this.#deps.loopbackToken) {
      throw new Error("请先设置远程访问密码");
    }
    assertPolicyCoverage(this.#deps.channels(), { requireAll: this.#deps.policyScope !== "subset" });

    const host = options.host?.trim() || "127.0.0.1";
    // The loopback token is what lets the desktop's SSH forward in without a password, and
    // it is only ever honoured for a client that arrived from loopback (`#attach`). Listening
    // beyond loopback is therefore safe exactly when everyone else has a password to present:
    // without one the only door left would be a server that asks nothing of its visitors.
    const loopbackOnly = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (this.#deps.loopbackToken && !loopbackOnly && !isConfigured(this.#deps.accessFile)) {
      throw new Error("监听外部地址前必须先设置密码");
    }
    // Both handlers are the outermost frame of their own call: anything thrown here
    // reaches no `catch` but the logger's global one, which records it and leaves the
    // socket open forever. A client that gets no answer and no close is worse than an
    // error, so every request ends in a response and every bad upgrade in a destroyed
    // socket.
    const server = createServer((request, response) => {
      try {
        this.#handleHttp(request, response);
      } catch (error) {
        this.#deps.log.error("remote request failed", error);
        this.#fail(response);
      }
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      // Browser and `ws` clients negotiate this extension automatically. A low
      // zlib level keeps compression from competing with the agent on Main's loop.
      perMessageDeflate: {
        threshold: 512,
        concurrencyLimit: 8,
        zlibDeflateOptions: { level: 3, memLevel: 7 },
      },
    });
    server.on("upgrade", (request, socket, head) => {
      try {
        this.#handleUpgrade(wss, request, socket, head);
      } catch (error) {
        this.#deps.log.error("remote upgrade failed", error);
        socket.destroy();
      }
    });
    wss.on("connection", (socket, request) => this.#handleConnection(socket, request));

    await new Promise<void>((settle, fail) => {
      const onError = (error: unknown): void => fail(error instanceof Error ? error : new Error(String(error)));
      server.once("error", onError);
      server.listen(options.port, host, () => {
        server.removeListener("error", onError);
        settle();
      });
    });

    const address = server.address();
    this.#http = server;
    this.#wss = wss;
    this.#listenHost = host;
    this.#host = host === "0.0.0.0"
      ? (lanAddresses().ipv4 ?? host)
      : host === "::"
        ? (lanAddresses().ipv6 ?? host)
        : host;
    this.#port = typeof address === "object" && address ? address.port : options.port;
    // Never the reason the process stays up: the app owns its own lifetime, and a
    // timer nobody can see would keep a test run from exiting.
    this.#ensureHeartbeat();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      this.#deps.log.warn(`remote server bound to ${host} — reachable beyond this machine`);
    }
    this.#deps.log.info(`remote server listening on ${host}:${this.#port}`);
    return this.status;
  }

  async stop(): Promise<RemoteServerStatus> {
    // Only what came in through the listener. A connection attached by another transport
    // does not depend on it, and switching off the password-protected door must not cut
    // the account's own.
    for (const client of [...this.#clients.values()]) if (!client.external) this.#dropClient(client);
    if (this.#heartbeat && ![...this.#clients.values()].some((client) => client.external)) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    // Shared process AppServer (Electron windows, other adapters) stays up. Only a
    // fallback instance this server constructed for itself is torn down here.
    if (this.#ownsAppServer) this.#appServer.closeAll();
    this.#wss?.close();
    const server = this.#http;
    this.#http = null;
    this.#wss = null;
    this.#listenHost = "127.0.0.1";
    this.#host = "127.0.0.1";
    this.#port = null;
    if (server) {
      await new Promise<void>((settle) => server.close(() => settle()));
      this.#deps.log.info("remote server stopped");
    }
    return this.status;
  }

  /** Close every connection belonging to a device, used when that device is revoked. */
  disconnectDevice(deviceId: string): void {
    for (const client of [...this.#clients.values()]) {
      if (client.deviceId === deviceId) client.socket.close(CLOSE_UNAUTHORIZED, "device revoked");
    }
  }

  // ---------------------------------------------------------------- HTTP

  #handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const url = requestUrl(request);
    if (!url) {
      this.#json(response, 400, { error: "请求格式无效" });
      return;
    }
    if (url.pathname === "/api/hello") {
      this.#json(response, 200, { configured: isConfigured(this.#deps.accessFile) });
      return;
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      void this.#handleLogin(request, response).catch((error: unknown) => {
        // Not the request being malformed — that is answered inside. This is the write
        // of the issued token failing, and it must still end the request.
        this.#deps.log.error("remote login failed", error);
        this.#fail(response);
      });
      return;
    }
    // Nothing else is served: the phone app speaks `/api/login` and `/ws`, and a browser
    // has no page here. The answer says what this port is for rather than leaving a
    // blank error for someone who typed the address into one.
    this.#json(response, 404, { error: "not found", hint: "This is a FastVibe remote access endpoint; open it from the FastVibe app." });
  }

  async #handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The wait applies before the password is even read: the point is to make guessing
    // slow, and a check that runs first would leak whether a password was close.
    const wait = this.#throttle.retryAfterMs();
    if (wait > 0) {
      response.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      this.#json(response, 429, { error: "尝试过于频繁，请稍后再试", retryAfterMs: wait });
      return;
    }
    let body: { password?: unknown; label?: unknown };
    try {
      body = JSON.parse(await readBody(request, 64 * 1024)) as typeof body;
    } catch {
      this.#json(response, 400, { error: "请求格式无效" });
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    const label = typeof body.label === "string" ? body.label : "远程客户端";
    const issued = login(this.#deps.accessFile, password, label);
    if (!issued) {
      this.#throttle.recordFailure();
      this.#deps.log.warn(`remote login failed (${this.#throttle.failures} so far)`);
      // The same answer whether the password was wrong or none is set, so the endpoint
      // does not become a way to ask what state the server is in.
      this.#json(response, 401, { error: "密码错误" });
      return;
    }
    this.#throttle.recordSuccess();
    this.#deps.log.info(`remote login ok device=${issued.device.id}`);
    this.#deps.onStatusChange?.();
    this.#json(response, 200, {
      token: issued.token,
      device: { id: issued.device.id, label: issued.device.label, createdAt: issued.device.createdAt },
    });
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // The client is served from this same origin and never framed.
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    response.end(payload);
  }

  /** End a request that threw, without assuming nothing was written yet. */
  #fail(response: ServerResponse): void {
    try {
      if (response.headersSent) response.end();
      else this.#json(response, 500, { error: "\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef" });
    } catch {
      response.destroy();
    }
  }

  // ---------------------------------------------------------------- WebSocket

  #handleUpgrade(wss: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = requestUrl(request);
    if (!url || url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // A browser attaches `Origin` on its own and cannot forge it, and the only clients of
    // this socket are the phone app and the desktop's own SSH forward — neither is a
    // browser, so neither sends one. Any page that does is a page the user happens to be
    // visiting trying a server it guessed, and gets nothing.
    if (typeof request.headers.origin === "string") {
      this.#deps.log.warn(`remote upgrade refused origin=${request.headers.origin}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  }

  /**
   * Ping every socket, and drop the ones that stopped answering.
   *
   * A tunnel or reverse proxy in front of this server will cut a WebSocket that goes
   * quiet — Cloudflare's edge after 100 seconds, nginx's `proxy_read_timeout` after 60 —
   * and quiet is the normal case here: reading a transcript, or watching a run, is a
   * socket with nothing to say. Pinging keeps traffic in *both* directions, because the
   * browser's pong is what resets the timer on the other side of the tunnel.
   *
   * It doubles as liveness, which matters more through a tunnel than on a wire: a
   * half-open connection there looks attached forever and never receives anything again.
   * A socket that missed a whole round is gone, so it is terminated — which becomes the
   * `close` the client reconnects from, instead of a client that believes it is
   * connected to a chat it will never hear from again.
   */
  #beat(milliseconds: number): NodeJS.Timeout {
    return setInterval(() => {
      for (const client of [...this.#clients.values()]) {
        if (!client.alive) {
          // `terminate`, not `close`: the point is that this socket is not answering, so
          // waiting for a close handshake it will never send is waiting forever.
          this.#deps.log.warn(`remote heartbeat timeout device=${client.deviceId ?? "unauthenticated"} buffered=${client.socket.bufferedAmount}`);
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          // Already closing; its close handler settles the rest.
        }
      }
    }, milliseconds);
  }

  #handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const loopback = isLoopbackAddress(request.socket.remoteAddress);
    const client: Client = {
      id: `remote:${randomUUID()}`,
      socket,
      external: false,
      loopback,
      deviceId: null,
      detach: null,
      // Nothing is served before the first frame authenticates, and a socket that never
      // sends one would otherwise sit open indefinitely.
      timer: setTimeout(() => socket.close(CLOSE_TIMEOUT, "auth timeout"), AUTH_GRACE_MS),
      alive: true,
      backpressure: new BackpressureGuard(),
      backpressureTimer: null,
      protocolClient: false,
      appSession: null,
      attachments: new Map(),
      attachmentBytes: 0,
    };
    this.#clients.set(client.id, client);
    this.#wire(client);
  }

  /**
   * Take a connection that something else has already authenticated.
   *
   * The official remote connection is the case: the phone and this desktop were
   * introduced by the cloud's signaling, which only connects two sessions of the same
   * account, so there is no password to ask for and no token to present. Everything past
   * authentication is the ordinary path, which is the point — one policy, one backpressure
   * guard, one App Protocol session, whatever carried the bytes.
   *
   * It does not need the listener, or a password: the listener is how a *browser* gets
   * in, and this is not that.
   */
  attachTransport(socket: RemoteSocket, peer: { id: string; label: string }): void {
    // The check `start()` makes before it will listen. A method nobody classified must
    // stop this door too, not only the one that opens onto a port.
    assertPolicyCoverage(this.#deps.channels(), { requireAll: this.#deps.policyScope !== "subset" });
    const client: Client = {
      id: `remote:${randomUUID()}`,
      socket,
      external: true,
      loopback: false,
      deviceId: peer.id,
      detach: null,
      timer: null,
      alive: true,
      backpressure: new BackpressureGuard(),
      backpressureTimer: null,
      protocolClient: false,
      appSession: null,
      attachments: new Map(),
      attachmentBytes: 0,
    };
    this.#clients.set(client.id, client);
    this.#wire(client);
    this.#ensureHeartbeat();
    this.#ensureLegacySubscription(client);
    this.#send(client, { type: "auth", ok: true, device: { id: peer.id, label: peer.label } });
    this.#deps.log.info(`remote client attached over a trusted transport device=${peer.id}`);
    this.#deps.onStatusChange?.();
  }

  #wire(client: Client): void {
    const socket = client.socket;
    socket.on("message", (raw, isBinary) => {
      void this.#handleFrame(client, raw, isBinary).catch((error: unknown) => {
        this.#deps.log.error("remote frame failed", error);
      });
    });
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("close", (code, reason) => {
      this.#deps.log.info(`remote socket closed device=${client.deviceId ?? "unauthenticated"} code=${code} reason=${JSON.stringify(reason.toString().slice(0, 123))}`);
      this.#dropClient(client);
    });
    socket.on("error", (error) => {
      this.#deps.log.warn(`remote socket error: ${String(error)}`);
      this.#dropClient(client);
    });
  }

  /** Start the heartbeat if nothing has. It runs while any client needs it. */
  #ensureHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = this.#beat(this.#deps.heartbeatMs ?? HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  async #handleFrame(client: Client, raw: Buffer, isBinary = false): Promise<void> {
    if (raw.byteLength > MAX_FRAME_BYTES) {
      client.socket.close(CLOSE_TOO_LARGE, "frame too large");
      return;
    }
    if (isBinary) {
      if (!client.deviceId || !client.appSession?.supportsBinaryAttachments) {
        client.socket.close(CLOSE_UNAUTHORIZED, "binary attachments not negotiated");
        return;
      }
      const attachment = decodeBinaryAttachment(raw);
      if (!attachment || attachment.bytes.byteLength === 0) {
        client.socket.close(CLOSE_TOO_LARGE, "invalid attachment frame");
        return;
      }
      this.#rememberAttachment(client, attachment.id, Buffer.from(attachment.bytes));
      return;
    }
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(raw.toString("utf8"));
    } catch {
      this.#send(client, { type: "error", error: "请求格式无效" });
      return;
    }

    const legacy = typeof rawMessage === "object" && rawMessage !== null
      ? rawMessage as Record<string, unknown>
      : null;
    if (legacy?.type === "auth") {
      if (!client.deviceId) this.#authenticate(client, typeof legacy.token === "string" ? legacy.token : "");
      return;
    }
    if (!client.deviceId) {
      client.socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }

    const appMessage = readClientMessage(rawMessage);
    if (appMessage) {
      if (!client.appSession) {
        client.protocolClient = true;
        client.detach?.();
        client.detach = null;
        client.appSession = this.#appServer.attach({
          identity: {
            subject: client.deviceId,
            kind: "remote",
            clientKind: appMessage.kind === "hello" ? appMessage.hello.client.kind : "unknown",
            clientVersion: appMessage.kind === "hello" ? appMessage.hello.client.version : "unknown",
          },
          origin: client.id,
          send: (message) => {
            return this.#send(client, message);
          },
        });
      }
      if (appMessage.kind === "call" || appMessage.kind === "query") {
        const materialized = materializeBinaryAttachments(rawMessage, (id) => this.#attachment(client, id));
        if (materialized.missing.length > 0) {
          this.#send(client, {
            kind: "result",
            requestId: appMessage.requestId,
            ok: false,
            error: { code: "attachment.missing", message: "附件传输不完整，请重试" },
          });
          return;
        }
        rawMessage = materialized.value;
      }
      const keep = await this.#appServer.receive(client.appSession, rawMessage, client.socket);
      if (!keep) {
        this.#appServer.detach(client.appSession);
        client.appSession = null;
        client.socket.close(CLOSE_UNAUTHORIZED, "protocol rejected");
      }
      return;
    }

    // Legacy transport adapter. It is intentionally below the canonical protocol: old
    // `{id, method}` clients still work, but a client that already completed hello must
    // not fall back to this path — that would bypass negotiated capabilities.
    if (client.protocolClient || client.appSession) {
      this.#send(client, { type: "error", error: "请使用 App 协议调用" });
      return;
    }
    this.#ensureLegacySubscription(client);
    const id = typeof legacy?.id === "number" ? legacy.id : null;
    const method = typeof legacy?.method === "string" ? legacy.method : "";
    const payload = legacy?.payload;
    if (id === null || !method) {
      this.#send(client, { type: "error", error: "缺少 id 或 method" });
      return;
    }
    const verdict = remotePolicy(method);
    if (!verdict.allowed) {
      this.#send(client, { id, ok: false, error: verdict.reason });
      return;
    }
    try {
      const result = await this.#deps.dispatch(method, payload, client.id);
      this.#send(client, { id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#send(client, { id, ok: false, error: message });
    }
  }

  #sendPush(client: Client, channel: string, payload: unknown): void {
    this.#send(client, { push: channel, payload });
  }

  #rememberAttachment(client: Client, id: string, bytes: Buffer): void {
    this.#pruneAttachments(client);
    const previous = client.attachments.get(id);
    const nextBytes = client.attachmentBytes - (previous?.bytes.byteLength ?? 0) + bytes.byteLength;
    if (nextBytes > MAX_ATTACHMENT_BYTES) {
      client.socket.close(CLOSE_TOO_LARGE, "attachments too large");
      return;
    }
    client.attachments.set(id, { bytes, expiresAt: Date.now() + ATTACHMENT_TTL_MS });
    client.attachmentBytes = nextBytes;
  }

  #attachment(client: Client, id: string): Buffer | undefined {
    this.#pruneAttachments(client);
    const attachment = client.attachments.get(id);
    if (!attachment) return undefined;
    attachment.expiresAt = Date.now() + ATTACHMENT_TTL_MS;
    return attachment.bytes;
  }

  #pruneAttachments(client: Client): void {
    const now = Date.now();
    for (const [id, attachment] of client.attachments) {
      if (attachment.expiresAt > now) continue;
      client.attachments.delete(id);
      client.attachmentBytes -= attachment.bytes.byteLength;
    }
  }

  #ensureLegacySubscription(client: Client): void {
    if (client.detach || client.protocolClient) return;
    client.detach = this.#deps.subscribe({
      id: client.id,
      send: (channel, payload) => this.#sendPush(client, channel, payload),
    });
  }

  #authenticateLoopback(client: Client): void {
    if (client.timer) clearTimeout(client.timer);
    client.timer = null;
    client.deviceId = "ssh-loopback";
    this.#ensureLegacySubscription(client);
    this.#send(client, { type: "auth", ok: true, device: { id: client.deviceId, label: "SSH" } });
    this.#deps.log.info("SSH loopback client attached");
  }

  #authenticate(client: Client, token: string): void {
    if (client.loopback && tokenMatches(this.#deps.loopbackToken, token)) {
      this.#authenticateLoopback(client);
      return;
    }
    const device = token ? authenticate(this.#deps.accessFile, token) : null;
    if (!device) {
      this.#send(client, { type: "auth", ok: false, error: "令牌无效" });
      client.socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    if (client.timer) clearTimeout(client.timer);
    client.timer = null;
    client.deviceId = device.id;
    touchDevice(this.#deps.accessFile, device.id);
    // Legacy clients expect pushes immediately after auth. The App Protocol transport
    // filters any such race until its hello has been sent, then switches this client to
    // the canonical AppServer session.
    this.#ensureLegacySubscription(client);
    this.#send(client, { type: "auth", ok: true, device: { id: device.id, label: device.label } });
    this.#deps.log.info(`remote client attached device=${device.id}`);
    this.#deps.onStatusChange?.();
  }

  #send(client: Client, message: unknown): boolean {
    if (client.socket.readyState !== client.socket.OPEN) return false;
    try {
      const encoded = JSON.stringify(message);
      // Judge the existing backlog, not the next message: allow one large reply
      // but stop further writes at the hard ceiling (bounded by limit + one frame).
      if (!this.#checkBackpressure(client)) return false;
      const completeSend = client.backpressure.trackSend();
      client.socket.send(encoded, (error) => {
        if (!this.#clients.has(client.id)) return;
        if (error) {
          this.#deps.log.warn(`remote send failed device=${client.deviceId ?? "unauthenticated"}: ${String(error)}`);
          this.#dropClient(client);
          return;
        }
        // A completed write is progress even if new model output refilled the queue.
        completeSend();
        this.#checkBackpressure(client);
      });
      // Start the grace clock even if nothing else is sent. Do not retroactively
      // reject the large frame just accepted on an otherwise empty queue.
      this.#checkBackpressure(client, false);
      return true;
    } catch (error) {
      this.#deps.log.warn(`remote send failed: ${String(error)}`);
      this.#dropClient(client);
      return false;
    }
  }

  #checkBackpressure(client: Client, enforce = true): boolean {
    if (client.socket.readyState !== client.socket.OPEN) return false;
    const buffered = client.socket.bufferedAmount;
    const pressure = client.backpressure.observe(buffered);
    if (buffered <= BUFFER_SOFT_LIMIT || (pressure && enforce)) {
      if (client.backpressureTimer) clearTimeout(client.backpressureTimer);
      client.backpressureTimer = null;
    }
    if (pressure && enforce) {
      this.#deps.log.warn(`remote socket backpressure device=${client.deviceId ?? "unauthenticated"} buffered=${buffered} cause=${pressure}`);
      client.socket.close(CLOSE_BACKPRESSURE, "backpressure");
      return false;
    }
    if (buffered > BUFFER_SOFT_LIMIT && !client.backpressureTimer) {
      // A stalled send need not finish, and may have no subsequent sends. Sample
      // independently so the grace window cannot turn into an indefinite wait.
      client.backpressureTimer = setTimeout(() => {
        client.backpressureTimer = null;
        if (this.#clients.has(client.id)) this.#checkBackpressure(client);
      }, Math.min(1_000, BUFFER_GRACE_MS));
      client.backpressureTimer.unref();
    }
    return true;
  }

  #dropClient(client: Client): void {
    if (!this.#clients.has(client.id)) return;
    // Only an attached client changes anything the pane shows (the `clients` count);
    // one that was still in its auth grace period leaving is not news.
    const wasAttached = client.deviceId !== null;
    this.#clients.delete(client.id);
    if (client.timer) clearTimeout(client.timer);
    if (client.backpressureTimer) clearTimeout(client.backpressureTimer);
    client.backpressureTimer = null;
    client.backpressure.clear();
    client.detach?.();
    client.detach = null;
    if (client.appSession) {
      this.#appServer.detach(client.appSession);
      client.appSession = null;
    }
    client.attachments.clear();
    client.attachmentBytes = 0;
    try {
      client.socket.close();
    } catch {
      // already gone
    }
    // Started by a transport attached while the listener was off: nothing is left to
    // watch once the last such client has gone.
    if (this.#heartbeat && !this.#http && this.#clients.size === 0) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    if (wasAttached) this.#deps.onStatusChange?.();
  }
}

/**
 * The request's URL, or null when it does not have one that parses.
 *
 * Both halves can be junk from the wire. A `Host` of `bad host` makes the base URL
 * invalid, and Node hands the header through without judging it; the target can be any
 * bytes a client cares to send. Neither is worth an exception — this server's only
 * answer to an unparseable request is 400.
 */
function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    return null;
  }
}

/** Read a request body with a hard ceiling, so a login cannot be used to exhaust memory. */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tokenMatches(expected: string | undefined, actual: string): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

export { listDevices, passwordProblem };
