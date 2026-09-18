import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LoginThrottle, passwordProblem } from "./auth.ts";
import { authenticate, isConfigured, listDevices, login, touchDevice } from "./store.ts";
import { assertPolicyCoverage, remotePolicy } from "./policy.ts";

/**
 * The remote server: a second way into the same call table the desktop windows use.
 *
 * Deliberately free of Electron. It is handed a `dispatch` and a `subscribe` and knows
 * nothing about windows, which is what keeps "one behaviour, two transports" true — and
 * what would let this run without a GUI later.
 *
 * It binds to loopback by default and expects a tunnel to publish it. Binding to a real
 * interface is possible but is not the intended shape: the tunnel is where the second
 * layer of authentication belongs, and loopback means a mistake in the settings pane
 * cannot put an agent that runs shell commands onto the local network.
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
  /** Run one method. The same function the Electron transport calls. */
  dispatch: (method: string, payload: unknown, clientId: string) => Promise<unknown>;
  /** Attach a push receiver; the returned function detaches it. */
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

/** A socket that has not authenticated within this long is closed. */
const AUTH_GRACE_MS = 10_000;

/** Largest frame accepted from a client. A prompt with images is the big one. */
const MAX_FRAME_BYTES = 24 * 1024 * 1024;

/** WebSocket close codes used here. 4001-4009 are private-use. */
const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_TIMEOUT = 4002;
const CLOSE_TOO_LARGE = 4003;

type Client = {
  id: string;
  socket: WebSocket;
  deviceId: string | null;
  detach: (() => void) | null;
  timer: NodeJS.Timeout | null;
};

export class RemoteServer {
  #deps: RemoteServerDeps;
  #http: Server | null = null;
  #wss: WebSocketServer | null = null;
  #clients = new Map<string, Client>();
  #throttle = new LoginThrottle();
  #host = "127.0.0.1";
  #port: number | null = null;

  constructor(deps: RemoteServerDeps) {
    this.#deps = deps;
  }

  get status(): RemoteServerStatus {
    return {
      running: this.#http !== null,
      host: this.#host,
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
    if (!isConfigured(this.#deps.accessFile)) {
      throw new Error("请先设置远程访问密码");
    }
    assertPolicyCoverage(this.#deps.channels());

    const host = options.host?.trim() || "127.0.0.1";
    const server = createServer((request, response) => this.#handleHttp(request, response));
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    server.on("upgrade", (request, socket, head) => this.#handleUpgrade(wss, request, socket, head));
    wss.on("connection", (socket) => this.#handleConnection(socket));

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
    this.#host = host;
    this.#port = typeof address === "object" && address ? address.port : options.port;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      this.#deps.log.warn(`remote server bound to ${host} — reachable beyond this machine`);
    }
    this.#deps.log.info(`remote server listening on ${host}:${this.#port}`);
    return this.status;
  }

  async stop(): Promise<RemoteServerStatus> {
    for (const client of [...this.#clients.values()]) this.#dropClient(client);
    this.#wss?.close();
    const server = this.#http;
    this.#http = null;
    this.#wss = null;
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
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/hello") {
      this.#json(response, 200, { configured: isConfigured(this.#deps.accessFile) });
      return;
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      void this.#handleLogin(request, response);
      return;
    }
    this.#serveStatic(url.pathname, response);
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
  #serveStatic(pathname: string, response: ServerResponse): void {
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
    const requested = pathname === "/" || desktopEntry ? `/${CLIENT_ENTRY}` : pathname;
    const candidate = resolve(join(rootPath, normalize(decodeURIComponent(requested))));
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
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
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

  #originAllowed(origin: string, request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  #handleConnection(socket: WebSocket): void {
    const client: Client = {
      id: `remote:${randomUUID()}`,
      socket,
      deviceId: null,
      detach: null,
      // Nothing is served before the first frame authenticates, and a socket that never
      // sends one would otherwise sit open indefinitely.
      timer: setTimeout(() => socket.close(CLOSE_TIMEOUT, "auth timeout"), AUTH_GRACE_MS),
    };
    this.#clients.set(client.id, client);

    socket.on("message", (raw) => {
      void this.#handleFrame(client, raw as Buffer);
    });
    socket.on("close", () => this.#dropClient(client));
    socket.on("error", (error) => {
      this.#deps.log.warn(`remote socket error: ${String(error)}`);
      this.#dropClient(client);
    });
  }

  async #handleFrame(client: Client, raw: Buffer): Promise<void> {
    if (raw.byteLength > MAX_FRAME_BYTES) {
      client.socket.close(CLOSE_TOO_LARGE, "frame too large");
      return;
    }
    let message: { id?: unknown; type?: unknown; method?: unknown; payload?: unknown; token?: unknown };
    try {
      message = JSON.parse(raw.toString("utf8")) as typeof message;
    } catch {
      this.#send(client, { type: "error", error: "请求格式无效" });
      return;
    }

    if (message.type === "auth") {
      this.#authenticate(client, typeof message.token === "string" ? message.token : "");
      return;
    }
    if (!client.deviceId) {
      client.socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }

    const id = typeof message.id === "number" ? message.id : null;
    const method = typeof message.method === "string" ? message.method : "";
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
      const result = await this.#deps.dispatch(method, message.payload, client.id);
      this.#send(client, { id, ok: true, result });
    } catch (error) {
      // The message only — a stack trace names paths and packages on this machine, and
      // the client can do nothing with it.
      this.#send(client, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #authenticate(client: Client, token: string): void {
    const device = authenticate(this.#deps.accessFile, token);
    if (!device) {
      this.#send(client, { type: "auth", ok: false, error: "令牌无效" });
      client.socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    if (client.timer) clearTimeout(client.timer);
    client.timer = null;
    client.deviceId = device.id;
    touchDevice(this.#deps.accessFile, device.id);
    // Pushes start only now: a socket that has not proved who it is must not be sent
    // conversation events while it waits.
    client.detach = this.#deps.subscribe({
      id: client.id,
      send: (channel, payload) => this.#send(client, { push: channel, payload }),
    });
    this.#send(client, { type: "auth", ok: true, device: { id: device.id, label: device.label } });
    this.#deps.log.info(`remote client attached device=${device.id}`);
    this.#deps.onStatusChange?.();
  }

  #send(client: Client, message: unknown): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch (error) {
      this.#deps.log.warn(`remote send failed: ${String(error)}`);
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
    try {
      client.socket.close();
    } catch {
      // already gone
    }
    if (wasAttached) this.#deps.onStatusChange?.();
  }
}

/** Decoded and collapsed, so `/index.html` is recognised however it was spelled. */
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
