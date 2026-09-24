import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LoginThrottle, passwordProblem } from "./auth.ts";
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
  /** Directory holding the web client, when one has been built. */
  webRoot?: string;
  /**
   * Directory holding the file-icon SVGs.
   *
   * The desktop renderer reads these through a private Electron scheme
   * (`fastvibe-icon://`), which is a `protocol.handle` in Main and therefore does not
   * exist in a browser — every file chip and file-tree row came out as a broken image.
   * Served here under `/file-icon/` instead, so the web client has the same icons over
   * the transport it does have.
   */
  iconRoot?: string;
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

/**
 * The one document this server hands a browser.
 *
 * Emphatically *not* `index.html`: that is the Electron window's page, and it reaches
 * Main through a preload that does not exist in a browser — it reads `window.fastvibe`
 * as it loads and dies on the first line. Serving it was the difference between "the
 * remote server has no client yet" and "the remote server appears to have a client that
 * white-screens", so the desktop page is never served here at all, by any spelling.
 */
const CLIENT_ENTRY = "remote.html";

/**
 * The phone page: its own entry, not the desktop tree squeezed into 375pt.
 *
 * `/` hands it to a phone and the full client to everything else. Both stay reachable
 * by name (`/mobile.html`, `/remote.html`).
 */
const MOBILE_ENTRY = "mobile.html";

/** Phones, not tablets: an iPad has the width the full client is laid out for. */
export function prefersMobileEntry(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /iphone|ipod/i.test(userAgent) || (/android/i.test(userAgent) && /mobile/i.test(userAgent));
}

/**
 * Where file icons are served.
 *
 * Unauthenticated, like the client bundle itself: these are ~1250 SVGs from a public
 * npm package, identical on every install, and the page needs them before there is a
 * socket to ask over. Nothing about which icons a client fetches says anything about
 * the machine — the names come from the manifest, not from the workspace.
 */
const ICON_PREFIX = "/file-icon";

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
/** Do not let one slow tunnel grow an unbounded ws send buffer. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 60_000;

/** Pick a usable private IPv4 address for the LAN link shown in settings. */
export function lanAddress(): string | null {
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  return (
    addresses.find((address) =>
      /^(10|192\.168)\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address),
    ) ?? addresses[0] ?? null
  );
}

type Client = {
  id: string;
  socket: WebSocket;
  /** Arrived from 127.0.0.1 / ::1, so it may present the SSH loopback token. */
  loopback: boolean;
  deviceId: string | null;
  detach: (() => void) | null;
  timer: NodeJS.Timeout | null;
  /** Answered the last ping. Cleared when one is sent, set again when the pong lands. */
  alive: boolean;
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
      host: this.#listenHost === "0.0.0.0" ? (lanAddress() ?? "0.0.0.0") : this.#host,
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
    if (this.#deps.loopbackToken && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("SSH loopback鉴权服务只能监听本机");
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
    this.#host = host === "0.0.0.0" ? (lanAddress() ?? host) : host;
    this.#port = typeof address === "object" && address ? address.port : options.port;
    this.#heartbeat = this.#beat(this.#deps.heartbeatMs ?? HEARTBEAT_MS);
    // Never the reason the process stays up: the app owns its own lifetime, and a
    // timer nobody can see would keep a test run from exiting.
    this.#heartbeat.unref();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      this.#deps.log.warn(`remote server bound to ${host} — reachable beyond this machine`);
    }
    this.#deps.log.info(`remote server listening on ${host}:${this.#port}`);
    return this.status;
  }

  async stop(): Promise<RemoteServerStatus> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const client of [...this.#clients.values()]) this.#dropClient(client);
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
    if (url.pathname.startsWith(`${ICON_PREFIX}/`)) {
      this.#serveIcon(url.pathname.slice(ICON_PREFIX.length + 1), response);
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
    this.#serveStatic(url.pathname, response, request.headers["user-agent"]);
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

  /**
   * Serve one file icon.
   *
   * The same rules as the desktop scheme's handler: the name is checked against a
   * narrow character class rather than resolved and compared, because unlike the web
   * root this directory is addressed by name and a name is all a client may give — and
   * an unknown one falls back to the generic glyph, since the icon theme's manifest
   * names generated clones that never shipped as files.
   */
  #serveIcon(name: string, response: ServerResponse): void {
    const root = this.#deps.iconRoot;
    const icon = name.replace(/\.svg$/, "");
    if (!root || !/^[a-z0-9._-]+$/i.test(icon)) {
      this.#json(response, 404, { error: "not found" });
      return;
    }
    const file = join(root, `${icon}.svg`);
    const target = existsSync(file) ? file : join(root, "file.svg");
    if (!existsSync(target)) {
      this.#json(response, 404, { error: "not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": "image/svg+xml",
      // Immutable for the life of a build: the name is the icon.
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    createReadStream(target).pipe(response);
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

  /**
   * Serve the web client.
   *
   * The path is resolved and then checked to be inside the root, rather than filtered
   * for `..` beforehand: a filter has to anticipate every spelling of the same escape,
   * while comparing the resolved path answers the actual question.
   *
   * What that check guarantees is only that nothing *outside* the root is reachable —
   * everything inside it is served, by design. So the root must hold the built client
   * and nothing else; it is not a place to keep anything that should not be downloaded.
   *
   * A path that resolves inside the root but names no file falls through to the client
   * entry, which is what lets the client own its own routes.
   */
  #serveStatic(pathname: string, response: ServerResponse, userAgent?: string): void {
    const root = this.#deps.webRoot;
    if (!root) {
      this.#json(response, 404, { error: "not found" });
      return;
    }
    const rootPath = resolve(root);
    const entry = join(rootPath, CLIENT_ENTRY);
    // The built pages share a directory, so the desktop one is sitting right there next
    // to the client. Asking for it by name gets the client instead of a page that would
    // only white-screen.
    const desktopEntry = normalizePath(pathname) === "/index.html";
    const home = prefersMobileEntry(userAgent) && existsSync(join(rootPath, MOBILE_ENTRY)) ? MOBILE_ENTRY : CLIENT_ENTRY;
    const requested = pathname === "/" || desktopEntry ? `/${home}` : pathname;
    const candidate = resolve(join(rootPath, normalizePath(requested)));
    const inside = candidate === rootPath || candidate.startsWith(rootPath + sep);
    const file = inside && existsSync(candidate) && statSync(candidate).isFile() ? candidate : entry;
    if (!existsSync(file)) {
      this.#json(response, 404, { error: "not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    createReadStream(file).pipe(response);
  }

  // ---------------------------------------------------------------- WebSocket

  #handleUpgrade(wss: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = requestUrl(request);
    if (!url || url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // A browser attaches `Origin` on its own and cannot forge it, so this is what stops
    // a page the user happens to be visiting from opening a socket to a tunnel it
    // guessed. Non-browser clients send none, which is allowed: they are not subject to
    // the same-origin machinery this is guarding.
    const origin = request.headers.origin;
    if (typeof origin === "string" && !this.#originAllowed(origin, request)) {
      this.#deps.log.warn(`remote upgrade refused origin=${origin}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  }

  /**
   * Whether the page that opened this socket is served from the host it dialled.
   *
   * A browser attaches `Origin` itself and cannot forge it, so this is what stops a page
   * the user happens to be visiting from opening a socket to a server it guessed — the
   * case where the page is one thing and the socket's target another.
   *
   * But a tunnel is the honest version of exactly that shape. Every one of them rewrites
   * `Host` to the address it forwards to by default — ngrok's default is literally
   * `--host-header=rewrite`, and cloudflared sends the origin service's host — while the
   * page, correctly, is served from the public hostname. Judging on `Host` alone refused
   * every user who brought their own tunnel, and the only trace was one warn line here;
   * on screen it was 「连接被断开」 next to a login form that had just succeeded. That is
   * what the three rules below fix:
   *
   *   1. `Host` is the origin's host: a direct connection, or a proxy told to preserve it.
   *   2. `X-Forwarded-Host` is present (ngrok sets it) — it is then the authoritative
   *      answer to the question being asked, so it has to match rather than merely exist.
   *   3. Otherwise any `X-Forwarded-*` at all says something in front of us rewrote the
   *      request (cloudflared sets `X-Forwarded-Proto` and `-For`, but no `-Host`).
   *
   * A page cannot produce any of those headers — the WebSocket API gives it no way to set
   * one — so rule 3 is out of reach for the page this check exists to refuse. What it does
   * give up is a page going *through the user's own tunnel*, which is still not a way in:
   * the first frame has to carry a device token, and the only place to get one is
   * `POST /api/login`, which a cross-origin page cannot complete (no CORS headers are
   * sent, so its preflight fails). The token, not this check, is what keeps a stranger
   * out; this keeps the browser from being used as the transport.
   */
  #originAllowed(origin: string, request: IncomingMessage): boolean {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (request.headers.host === originHost) return true;
    // A chain of proxies sends a list; the first entry is the hostname the client asked
    // for, which is the one that compares to the origin.
    const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
    if (forwardedHost) return forwardedHost === originHost;
    return Boolean(
      firstHeader(request.headers["x-forwarded-proto"]) ?? firstHeader(request.headers["x-forwarded-for"]),
    );
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
      loopback,
      deviceId: null,
      detach: null,
      // Nothing is served before the first frame authenticates, and a socket that never
      // sends one would otherwise sit open indefinitely.
      timer: setTimeout(() => socket.close(CLOSE_TIMEOUT, "auth timeout"), AUTH_GRACE_MS),
      alive: true,
      protocolClient: false,
      appSession: null,
      attachments: new Map(),
      attachmentBytes: 0,
    };
    this.#clients.set(client.id, client);

    socket.on("message", (raw, isBinary) => {
      void this.#handleFrame(client, raw as Buffer, isBinary).catch((error: unknown) => {
        this.#deps.log.error("remote frame failed", error);
      });
    });
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("close", () => this.#dropClient(client));
    socket.on("error", (error) => {
      this.#deps.log.warn(`remote socket error: ${String(error)}`);
      this.#dropClient(client);
    });
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
      const buffered = client.socket.bufferedAmount;
      if (buffered + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
        this.#deps.log.warn(`remote socket backpressure device=${client.deviceId ?? "unauthenticated"} buffered=${buffered}`);
        client.socket.close(CLOSE_BACKPRESSURE, "backpressure");
        return false;
      }
      client.socket.send(encoded);
      return true;
    } catch (error) {
      this.#deps.log.warn(`remote send failed: ${String(error)}`);
      return false;
    }
  }

  #dropClient(client: Client): void {
    if (!this.#clients.has(client.id)) return;
    // Only an attached client changes anything the pane shows (the `clients` count);
    // one that was still in its auth grace period leaving is not news.
    const wasAttached = client.deviceId !== null;
    this.#clients.delete(client.id);
    if (client.timer) clearTimeout(client.timer);
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

/**
 * Decoded and collapsed, so `/index.html` is recognised however it was spelled.
 *
 * A malformed escape (`/%`) returns the raw path rather than throwing: it then names no
 * file and falls through to the client entry, which is what every other unknown path
 * does.
 */
function normalizePath(pathname: string): string {
  try {
    return normalize(decodeURIComponent(pathname));
  } catch {
    return pathname;
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

/**
 * The first entry of a comma-separated header, trimmed — or undefined when there is none.
 *
 * A proxy list (`X-Forwarded-For: client, edge, lb`) is read by its first entry, which is
 * the closest thing to the client; `X-Forwarded-Host` is read the same way for the same
 * reason, the first hop being the one that knows what the client asked for.
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export { listDevices, passwordProblem };
