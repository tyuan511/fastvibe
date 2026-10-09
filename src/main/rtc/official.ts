import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OfficialPeer, OfficialState, OfficialStatus } from "../../shared/official.ts";
import type { RemoteSocket } from "../server/server.ts";
import { uiText } from "../engine/ui-text.ts";
import { toIceServers } from "./ice.ts";
import type { PeerFactory } from "./peer.ts";
import { Responder } from "./responder.ts";
import { SignalingClient, type SignalingStop } from "./signaling.ts";

/**
 * The official remote connection: this desktop, reachable from a phone signed in to the
 * same FastVibe account.
 *
 * It registers the machine as a device, keeps the cloud's signaling open, and answers each
 * phone that calls (`Responder`). The connections it produces are attached to the remote
 * server like any other, which is where the policy and the App Protocol apply.
 *
 * Electron-free: the account, the server and the native WebRTC library are handed in, so
 * the whole lifecycle runs under `node --test`.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_PATH_POLL_MS = 3_000;
const DEFAULT_REGISTER_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

export type OfficialDeps = {
  account: {
    /** The signed-in account's device token, or null. Never leaves Main. */
    token: () => string | null;
    /** The site the token was issued by. */
    origin: () => string;
  };
  /** Hand a connected phone to the remote server. */
  attach: (socket: RemoteSocket, peer: { id: string; label: string }) => void;
  /** Where this install's id is kept (0600). */
  installFile: string;
  deviceName: () => string;
  platform: string;
  onChange: (state: OfficialState) => void;
  createPeer: PeerFactory;
  fetch?: typeof fetch;
  log: { info(message: string): void; warn(message: string): void };
  connectTimeoutMs?: number;
  pathPollMs?: number;
  registerRetryMs?: number[];
  signalingBackoffMs?: number[];
  signalingSilenceMs?: number;
};

type Registration = { ok: true; deviceId: string } | { ok: false; retry: boolean; unauthorized?: boolean; message: string };

export class OfficialConnection {
  #deps: OfficialDeps;
  #fetch: typeof fetch;
  #enabled = false;
  #status: OfficialStatus = "off";
  #error: string | undefined;
  #deviceId: string | null = null;
  #signaling: SignalingClient | null = null;
  #boundToken: string | null = null;
  #responders = new Map<string, Responder>();
  /** Bumped by every teardown so a registration that was overtaken cannot start signaling. */
  #generation = 0;
  #bringingUp = false;
  #retryTimer: NodeJS.Timeout | null = null;
  #retries = 0;
  #lastUnknownDeviceAt = 0;

  constructor(deps: OfficialDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetch ?? fetch;
  }

  state(): OfficialState {
    const peers: OfficialPeer[] = [...this.#responders.values()]
      .filter((responder) => responder.connected)
      .map((responder) => ({
        id: responder.cid,
        name: responder.peer.name,
        ...(responder.peer.platform ? { platform: responder.peer.platform } : {}),
        path: responder.path,
      }));
    return {
      enabled: this.#enabled,
      status: this.#status,
      deviceId: this.#deviceId,
      deviceName: this.#deps.deviceName(),
      ...(this.#error ? { error: this.#error } : {}),
      peers,
    };
  }

  /** Switch the connection on or off. The caller persists the preference. */
  setEnabled(enabled: boolean): OfficialState {
    this.#enabled = enabled;
    this.#reconcile();
    return this.state();
  }

  /** The account signed in, out, or changed. */
  accountChanged(): void {
    this.#reconcile();
  }

  /** Drop every connected phone, leaving the connection itself up. */
  disconnectPeers(): void {
    for (const responder of [...this.#responders.values()]) responder.close();
  }

  shutdown(): void {
    this.#teardown();
  }

  /* ------------------------------------------------------------ lifecycle */

  #reconcile(): void {
    const token = this.#deps.account.token();
    if (!this.#enabled) {
      this.#teardown();
      this.#set("off");
      return;
    }
    if (!token) {
      this.#teardown();
      this.#set("signed-out");
      return;
    }
    if (this.#boundToken !== null && this.#boundToken !== token) this.#teardown();
    if (this.#signaling || this.#retryTimer || this.#bringingUp) return;
    void this.#bringUp(token);
  }

  async #bringUp(token: string): Promise<void> {
    const generation = this.#generation;
    this.#boundToken = token;
    this.#bringingUp = true;
    this.#set("connecting");
    const registration = await this.#register(token);
    if (generation !== this.#generation) {
      // Switched off, or signed in as someone else, meanwhile. A newer bring-up may own the
      // flag by now; only clear it when this one is still the current.
      return;
    }
    this.#bringingUp = false;

    if (!registration.ok) {
      if (registration.unauthorized) {
        // The account service will notice the same thing on its next refresh; do not
        // keep knocking with a token the server has already refused.
        this.#teardown();
        this.#set("signed-out");
        return;
      }
      this.#set("error", registration.message);
      if (registration.retry) this.#scheduleRetry(generation);
      return;
    }
    this.#retries = 0;
    this.#deviceId = registration.deviceId;
    this.#startSignaling(registration.deviceId);
  }

  #scheduleRetry(generation: number): void {
    const delays = this.#deps.registerRetryMs ?? DEFAULT_REGISTER_RETRY_MS;
    const delay = delays[Math.min(this.#retries, delays.length - 1)];
    this.#retries += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (generation !== this.#generation) return;
      const token = this.#deps.account.token();
      if (this.#enabled && token) void this.#bringUp(token);
    }, delay);
    this.#retryTimer.unref();
  }

  #startSignaling(deviceId: string): void {
    const signaling = new SignalingClient({
      origin: this.#deps.account.origin(),
      token: () => this.#deps.account.token(),
      deviceId,
      platform: this.#deps.platform,
      log: this.#deps.log,
      backoffMs: this.#deps.signalingBackoffMs,
      silenceMs: this.#deps.signalingSilenceMs,
      events: {
        status: (status) => {
          if (this.#signaling !== signaling) return;
          if (status === "online") this.#set("online");
          else this.#set("connecting");
        },
        incoming: (cid, peer) => this.#accept(signaling, cid, peer),
        signal: (cid, data) => this.#responders.get(cid)?.signal(data),
        hangup: (cid) => this.#responders.get(cid)?.remoteHangup(),
        stopped: (reason) => {
          if (this.#signaling !== signaling) return;
          this.#onSignalingStopped(reason);
        },
      },
    });
    this.#signaling = signaling;
    signaling.start();
  }

  #onSignalingStopped(reason: SignalingStop): void {
    this.#signaling = null;
    switch (reason) {
      case "unauthorized":
        this.#teardown();
        this.#set("signed-out");
        return;
      case "unknown-device": {
        // The account no longer has this device (removed in the console). Register again,
        // but not in a tight loop if the service keeps disagreeing.
        const now = Date.now();
        const recent = now - this.#lastUnknownDeviceAt < 60_000;
        this.#lastUnknownDeviceAt = now;
        this.#teardown();
        if (recent) {
          this.#set("error", uiText("无法在账号中登记这台设备，请稍后重试", "Couldn't register this device with your account. Try again later."));
          return;
        }
        this.#reconcile();
        return;
      }
      case "replaced":
        this.#teardown();
        this.#set("error", uiText(
          "这台设备已在另一个 FastVibe 窗口或进程中连接，请先关闭它",
          "This device is already connected from another FastVibe process. Close it first.",
        ));
        return;
      case "removed":
        this.#teardown();
        this.#set("error", uiText(
          "这台设备已从你的账号中移除。重新打开开关即可再次登记",
          "This device was removed from your account. Turn the switch back on to register it again.",
        ));
        return;
    }
  }

  /** Stop everything and forget the connection state, but keep the preference. */
  #teardown(): void {
    this.#generation += 1;
    this.#bringingUp = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#retries = 0;
    const signaling = this.#signaling;
    this.#signaling = null;
    signaling?.stop();
    for (const responder of [...this.#responders.values()]) responder.close();
    this.#responders.clear();
    this.#deviceId = null;
    this.#boundToken = null;
  }

  /* ------------------------------------------------------------ calls */

  #accept(signaling: SignalingClient, cid: string, peer: { name: string; platform?: string }): void {
    if (this.#signaling !== signaling || this.#responders.has(cid)) return;
    const responder = new Responder({
      cid,
      peer,
      createPeer: this.#deps.createPeer,
      loadIce: () => this.#loadIce(),
      sendSignal: (data) => signaling.signal(cid, data),
      attach: (socket) => this.#deps.attach(socket, { id: `rtc:${cid}`, label: peer.name }),
      onChange: () => this.#emit(),
      onEnd: () => {
        this.#responders.delete(cid);
        // Free the call on the service too; harmless if the phone already did.
        signaling.hangup(cid);
        this.#emit();
      },
      connectTimeoutMs: this.#deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      pathPollMs: this.#deps.pathPollMs ?? DEFAULT_PATH_POLL_MS,
      log: this.#deps.log,
    });
    this.#responders.set(cid, responder);
    void responder.start();
  }

  async #loadIce() {
    const token = this.#deps.account.token();
    if (!token) return [];
    const response = await this.#call("/api/rtc/ice", { token });
    if (!response.ok) throw new Error(`ice servers: ${response.status}`);
    return toIceServers(await response.json());
  }

  /* ------------------------------------------------------------ registration */

  async #register(token: string): Promise<Registration> {
    let response: Response;
    try {
      response = await this.#call("/api/devices/me", {
        method: "PUT",
        token,
        body: { install_id: this.#installId(), name: this.#deps.deviceName(), platform: this.#deps.platform },
      });
    } catch (error) {
      this.#deps.log.warn(`official: could not reach the service: ${String(error)}`);
      return { ok: false, retry: true, message: uiText("无法连接 FastVibe 服务，请检查网络", "Couldn't reach FastVibe. Check your connection.") };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 401) return { ok: false, retry: false, unauthorized: true, message: "" };
    if (response.ok) {
      const id = (body as { device?: { id?: unknown } } | undefined)?.device?.id;
      if (typeof id === "string" && id) return { ok: true, deviceId: id };
      return { ok: false, retry: true, message: uiText("服务返回了无法识别的内容", "The server sent an unexpected reply.") };
    }
    const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (code === "too_many_devices") {
      return { ok: false, retry: false, message: uiText(
        "账号下的设备已达上限，请先在控制台移除不用的设备",
        "Your account has reached its device limit. Remove one you no longer use in the console.",
      ) };
    }
    this.#deps.log.warn(`official: registration refused (${response.status} ${String(code)})`);
    return { ok: false, retry: response.status >= 500, message: uiText("登记这台设备没有成功，请稍后重试", "Couldn't register this device. Try again shortly.") };
  }

  async #call(path: string, options: { method?: string; token: string; body?: unknown }): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${options.token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return this.#fetch(new URL(path, this.#deps.account.origin()), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  }

  /**
   * The id this install registers under, minted once and kept, so signing in again finds
   * the same device in the account's list instead of adding another.
   */
  #installId(): string {
    const file = this.#deps.installFile;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { installId?: unknown };
      if (typeof parsed.installId === "string" && /^[\x21-\x7e]{8,64}$/.test(parsed.installId)) return parsed.installId;
    } catch {
      // first run, or unreadable: mint a new one below
    }
    const installId = `inst_${randomUUID().replace(/-/g, "")}`;
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ installId }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    return installId;
  }

  /* ------------------------------------------------------------ state */

  #set(status: OfficialStatus, error?: string): void {
    this.#status = status;
    this.#error = error;
    this.#emit();
  }

  #emit(): void {
    this.#deps.onChange(this.state());
  }
}
