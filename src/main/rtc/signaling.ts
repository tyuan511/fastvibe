import WebSocket from "ws";

/**
 * The desktop's end of the cloud's signaling: one WebSocket, kept up while the official
 * remote connection is on, over which a phone signed in to the same account asks to
 * connect and the two exchange their WebRTC offer, answer and ICE candidates.
 *
 * Electron-free, so it runs under `node --test` against a stand-in server. The messages
 * are the ones the service documents (`docs/cloud-service.md`, 官方远程连接 → 信令协议).
 */

/** Close codes the service uses that end the attempt rather than retry it. */
const CLOSE_REPLACED = 4001;
const CLOSE_KICKED = 4005;

const PING_TIMEOUT_MS = 70_000;
/**
 * How often this side asks the service whether it is still there, and how long it waits.
 *
 * The service's own ping comes every 25 seconds and its silence is only called dead after
 * 70, which is how long this computer stayed unreachable after its network changed under
 * it (another Wi-Fi, a VPN going up or down): the socket was gone, nothing said so, and
 * every phone that called meanwhile was told the device was offline. A ping of our own
 * finds out within one interval and one wait.
 */
const PROBE_EVERY_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export type SignalingStatus = "connecting" | "online" | "offline";

/** Why signaling stopped for good, as opposed to being down for now. */
export type SignalingStop =
  /** The token was refused. Signing in again is the only fix. */
  | "unauthorized"
  /** The same device connected from somewhere else. */
  | "replaced"
  /** The device was removed from the account, or the session ended. */
  | "removed"
  /** The device id is not one the account has; register again. */
  | "unknown-device";

export type PeerInfo = { name: string; platform?: string };

export type SignalingEvents = {
  status(status: SignalingStatus): void;
  incoming(cid: string, peer: PeerInfo): void;
  signal(cid: string, data: unknown): void;
  hangup(cid: string): void;
  /** Reconnecting will not help; the owner decides what to do. */
  stopped(reason: SignalingStop): void;
};

export type SignalingDeps = {
  /** The site, e.g. `https://app.fastvibe.dev`. */
  origin: string;
  /** Read at each connect: the token can change under a long-lived process. */
  token: () => string | null;
  deviceId: string;
  platform: string;
  events: SignalingEvents;
  log: { info(message: string): void; warn(message: string): void };
  /** Delays between attempts. Only tests change them. */
  backoffMs?: number[];
  random?: () => number;
  /** How long without a word from the service counts as a dead link. */
  silenceMs?: number;
  /** How often to ping the service, and how long its pong may take. */
  probeMs?: number;
  probeTimeoutMs?: number;
};

export class SignalingClient {
  #deps: SignalingDeps;
  #socket: WebSocket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #probeTimer: NodeJS.Timeout | null = null;
  #pongDeadline: NodeJS.Timeout | null = null;
  #attempt = 0;
  #running = false;
  #status: SignalingStatus = "offline";

  constructor(deps: SignalingDeps) {
    this.#deps = deps;
  }

  get status(): SignalingStatus {
    return this.#status;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#attempt = 0;
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.close(1000, "stopping");
      } catch {
        socket.terminate();
      }
    }
    this.#setStatus("offline");
  }

  /** Send to the peer on a call. False when not connected, which the caller treats as a lost message. */
  signal(cid: string, data: unknown): boolean {
    return this.#send({ type: "signal", cid, data });
  }

  hangup(cid: string): boolean {
    return this.#send({ type: "hangup", cid });
  }

  /**
   * Ask the service whether this link is still alive, now rather than at the next round.
   *
   * For whoever has just seen something that a dead network would also explain — a
   * phone's connection ending is the case. One question at a time: a probe already
   * waiting for its pong is the answer to this one too.
   */
  probe(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#pongDeadline) return;
    try {
      socket.ping();
    } catch {
      // Closing; its close event decides what happens next.
      return;
    }
    this.#pongDeadline = setTimeout(() => {
      this.#pongDeadline = null;
      if (this.#socket !== socket) return;
      this.#deps.log.warn("signaling did not answer a ping; reconnecting");
      socket.terminate();
    }, this.#deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    this.#pongDeadline.unref();
  }

  #send(message: unknown): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#status !== "online") return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  #connect(): void {
    if (!this.#running) return;
    const token = this.#deps.token();
    if (!token) {
      this.#finish("unauthorized");
      return;
    }
    this.#setStatus("connecting");
    const url = new URL("/api/rtc/signal", this.#deps.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
      maxPayload: 256 * 1024,
    });
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#socket !== socket) return;
      socket.send(JSON.stringify({ type: "hello", role: "device", device_id: this.#deps.deviceId, platform: this.#deps.platform }));
      this.#armWatchdog(socket);
      this.#probeTimer = setInterval(() => this.probe(), this.#deps.probeMs ?? PROBE_EVERY_MS);
      this.#probeTimer.unref();
    });
    socket.on("ping", () => this.#armWatchdog(socket));
    socket.on("pong", () => {
      if (this.#socket !== socket) return;
      if (this.#pongDeadline) clearTimeout(this.#pongDeadline);
      this.#pongDeadline = null;
      this.#armWatchdog(socket);
    });
    socket.on("message", (raw) => {
      if (this.#socket !== socket) return;
      this.#armWatchdog(socket);
      this.#handle(raw.toString("utf8"));
    });
    // A refused upgrade is not an open-then-close: the status line is all there is.
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (response.statusCode === 401 || response.statusCode === 403) this.#finish("unauthorized");
      else this.#retry(`upgrade refused with ${response.statusCode}`);
    });
    socket.on("error", (error) => {
      // Followed by `close` (or `unexpected-response`), which decides what happens next.
      this.#deps.log.warn(`signaling error: ${error.message}`);
    });
    socket.on("close", (code) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearTimers();
      if (code === CLOSE_REPLACED) return this.#finish("replaced");
      if (code === CLOSE_KICKED) return this.#finish("removed");
      this.#retry(`closed with ${code}`);
    });
  }

  #handle(text: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const cid = typeof message.cid === "string" ? message.cid : "";
    switch (message.type) {
      case "hello":
        this.#attempt = 0;
        this.#setStatus("online");
        return;
      case "incoming": {
        const peer = message.peer as { name?: unknown; platform?: unknown } | undefined;
        if (!cid) return;
        this.#deps.events.incoming(cid, {
          name: typeof peer?.name === "string" && peer.name ? peer.name : "Phone",
          ...(typeof peer?.platform === "string" ? { platform: peer.platform } : {}),
        });
        return;
      }
      case "signal":
        if (cid) this.#deps.events.signal(cid, message.data);
        return;
      case "hangup":
        if (cid) this.#deps.events.hangup(cid);
        return;
      case "error":
        if (message.code === "device_not_found") this.#finish("unknown-device");
        else this.#deps.log.warn(`signaling refused a message: ${String(message.code)}`);
        return;
      default:
        return;
    }
  }

  /** The service pings every 25 seconds; silence for much longer than that is a dead link. */
  #armWatchdog(socket: WebSocket): void {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      this.#deps.log.warn("signaling went silent; reconnecting");
      socket.terminate();
    }, this.#deps.silenceMs ?? PING_TIMEOUT_MS);
    this.#watchdog.unref();
  }

  #retry(why: string): void {
    this.#clearTimers();
    if (!this.#running) return;
    const delays = this.#deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    const base = delays[Math.min(this.#attempt, delays.length - 1)];
    this.#attempt += 1;
    const jitter = 1 + ((this.#deps.random ?? Math.random)() - 0.5) * 0.4;
    this.#setStatus("offline");
    this.#deps.log.info(`signaling ${why}; retrying in ${Math.round(base * jitter)} ms`);
    this.#timer = setTimeout(() => this.#connect(), base * jitter);
    this.#timer.unref();
  }

  #finish(reason: SignalingStop): void {
    this.#running = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.terminate();
    }
    this.#setStatus("offline");
    this.#deps.events.stopped(reason);
  }

  #clearTimers(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#watchdog) clearTimeout(this.#watchdog);
    if (this.#probeTimer) clearInterval(this.#probeTimer);
    if (this.#pongDeadline) clearTimeout(this.#pongDeadline);
    this.#timer = null;
    this.#watchdog = null;
    this.#probeTimer = null;
    this.#pongDeadline = null;
  }

  #setStatus(status: SignalingStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#deps.events.status(status);
  }
}
