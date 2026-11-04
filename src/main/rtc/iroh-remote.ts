import { join } from "node:path";
import type { RemoteSocket } from "../server/server.ts";
import { getFastVibePaths } from "../engine/paths.ts";
import type { AccountIrohDevice } from "../engine/account.ts";
import { uiText } from "../engine/ui-text.ts";
import { deviceNameSetting } from "../../shared/device-name.ts";
import { IrohRelayLease, type IrohRelayLeaseAccount } from "./iroh-relay.ts";
import { IrohSidecar, IrohSocket, type IrohSidecarEvent } from "./iroh-sidecar.ts";
import { IrohDiscoveryAdvertiser, type IrohDiscoveryPublisher } from "./iroh-discovery.ts";
import type { IrohRemoteState, IrohPeerPath } from "../../shared/iroh-remote";

export type IrohRemoteDeps = {
  account: IrohRelayLeaseAccount;
  deviceId: string | (() => string);
  attach: (socket: RemoteSocket, peer: { id: string; label: string }) => void;
  log: { info(message: string): void; warn(message: string, error?: unknown): void };
  onChange?: () => void;
  /** Only metadata returned by the authenticated account service may authorize a peer. */
  authorizePeer: (endpointId: string) => Promise<AccountIrohDevice | null>;
  sidecar?: IrohSidecar;
  identityFile?: string;
  deviceName?: () => string;
  discovery?: IrohDiscoveryPublisher;
};

/**
 * Makes the Rust iroh sidecar another authenticated input to the existing RemoteServer.
 *
 * The sidecar owns QUIC and iroh path selection. Main owns the Control-issued lease, byte
 * checkpoint policy and App Protocol socket adapter. No Relay URL or token is embedded here.
 */
export class IrohRemoteConnection {
  #deps: IrohRemoteDeps;
  #sidecar: IrohSidecar;
  #discovery: IrohDiscoveryPublisher;
  #directAddresses: string[] = [];
  #lifecycle = 0;
  #lease: IrohRelayLease | null = null;
  // Pending sockets must remain tracked for stop/disconnect, but never appear in state().
  #sockets = new Map<string, IrohSocket>();
  #labels = new Map<string, string>();
  #paths = new Map<string, "connecting" | "direct" | "relay">();
  #started = false;
  #stopping = false;
  #endpointId: string | null = null;
  #error: string | undefined;
  #signedOut = false;
  #startFlight: Promise<void> | null = null;
  #onEvent: (event: IrohSidecarEvent) => void;

  constructor(deps: IrohRemoteDeps) {
    this.#deps = deps;
    this.#sidecar = deps.sidecar ?? new IrohSidecar();
    this.#discovery = deps.discovery ?? new IrohDiscoveryAdvertiser({ log: deps.log });
    this.#onEvent = (event) => this.#handle(event);
    this.#sidecar.on("event", this.#onEvent);
    this.#sidecar.on("log", (message: string) => this.#deps.log.warn(`iroh: ${message.trim()}`));
    this.#sidecar.on("error", (error: Error) => {
      this.#started = false;
      this.#directAddresses = [];
      this.#discovery.stop();
      this.#error = error.message;
      this.#deps.onChange?.();
    });
    this.#sidecar.on("exit", () => {
      this.#started = false;
      this.#directAddresses = [];
      this.#discovery.stop();
      if (!this.#error) this.#error = "iroh transport exited";

      this.#sockets.clear();
      this.#labels.clear();
      this.#paths.clear();
      this.#deps.onChange?.();
    });
  }

  state(enabled: boolean): IrohRemoteState {
    const status: IrohRemoteState["status"] = !enabled ? "off" : this.#signedOut ? "signed-out" : this.#error ? "error" : this.#started ? "online" : "connecting";
    return {
      enabled,
      status,
      endpointId: this.#endpointId,
      ...(this.#error ? { error: this.#error } : {}),
      peers: [...this.#labels].map(([id, label]) => ({ id, label, path: (this.#paths.get(id) ?? "connecting") as IrohPeerPath })),
      ...(this.#lease?.state().usage ? { usage: this.#lease.state().usage! } : {}),
    };
  }

  get running(): boolean {
    return this.#started;
  }

  setSignedOut(signedOut: boolean): void {
    this.#signedOut = signedOut;
    if (signedOut) {
      this.#error = undefined;
      this.#lifecycle++;
      this.#directAddresses = [];
      this.#discovery.stop();
    }
    this.#deps.onChange?.();
  }

  renamed(): void { this.#syncDiscovery(); }

  #syncDiscovery(): void {
    if (!this.#started || this.#stopping || this.#signedOut || !this.#endpointId || this.#error || !this.#directAddresses.length) {
      this.#discovery.stop();
      return;
    }
    const deviceId = typeof this.#deps.deviceId === "function" ? this.#deps.deviceId() : this.#deps.deviceId;
    this.#discovery.publish({
      deviceId, endpointId: this.#endpointId, name: this.#deps.deviceName?.(),
      directAddresses: this.#directAddresses,
    });
  }

  path(connectionId: string): "connecting" | "direct" | "relay" | null {
    return this.#paths.get(connectionId) ?? null;
  }

  async start(): Promise<void> {
    if (this.#stopping) throw new Error("iroh remote is stopping");
    if (this.#started) return;
    if (this.#startFlight) return this.#startFlight;
    this.#startFlight = this.#startOnce().finally(() => { this.#startFlight = null; });
    return this.#startFlight;
  }

  async #startOnce(): Promise<void> {
    if (this.#started) return;
    if (this.#stopping) throw new Error("iroh remote is stopping");
    const lifecycle = this.#lifecycle;
    const current = () => {
      if (lifecycle !== this.#lifecycle || this.#stopping || this.#signedOut) throw new Error("iroh remote start cancelled");
    };
    this.#directAddresses = [];
    const paths = getFastVibePaths();
    const identityFile = this.#deps.identityFile ?? join(paths.runtimeRoot, "iroh-endpoint.key");
    const deviceId = typeof this.#deps.deviceId === "function" ? this.#deps.deviceId() : this.#deps.deviceId;
    if (!deviceId) {
      this.#signedOut = true;
      this.#error = "official device is not registered";
      this.#deps.onChange?.();
      throw new Error(this.#error);
    }
    this.#signedOut = false;
    try {
      const endpointId = await this.#sidecar.identity(identityFile);
      current();
      this.#endpointId = endpointId;
      await this.#deps.account.setIrohEndpoint?.(deviceId, endpointId);
      current();
      const lease = new IrohRelayLease({
        account: this.#deps.account,
        deviceId,
        endpointId,
        onConfig: (config) => {
          if (this.#started) void this.#sidecar.refresh(config).catch((error: unknown) => this.#deps.log.warn("iroh relay credential refresh failed", error));
        },
        onError: (error) => this.#deps.log.warn("iroh relay lease failed", error),
      });
      const config = await this.#deps.account.issueIrohRelay(deviceId, endpointId);
      current();
      lease.adopt(config);
      this.#lease = lease;
      await this.#sidecar.startLease(config);
      current();
      this.#started = true;
      this.#error = undefined;
      this.#syncDiscovery();
      this.#deps.log.info(`iroh remote endpoint ready: ${endpointId}`);
      this.#deps.onChange?.();
    } catch (error) {
      const cancelled = lifecycle !== this.#lifecycle || this.#stopping || this.#signedOut;
      this.#started = false;
      this.#directAddresses = [];
      this.#discovery.stop();
      this.#error = cancelled ? undefined : error instanceof Error ? error.message : String(error);
      this.#lease?.close();
      this.#lease = null;
      await this.#sidecar.stop().catch((stopError: unknown) => this.#deps.log.warn("iroh sidecar cleanup failed", stopError));
      this.#deps.onChange?.();
      if (!cancelled) throw error;
    }
  }

  disconnectPeers(): void {
    for (const socket of this.#sockets.values()) socket.terminate();
    this.#sockets.clear();
    this.#labels.clear();
    this.#paths.clear();
    this.#deps.onChange?.();
  }

  async stop(): Promise<void> {
    this.#lifecycle++;
    this.#stopping = true;
    this.#directAddresses = [];
    this.#discovery.stop();
    try {
      await this.#startFlight?.catch(() => {});
      if (!this.#started && !this.#lease) return;
      this.disconnectPeers();
      await this.#lease?.flush().catch((error: unknown) => this.#deps.log.warn("iroh usage flush failed", error));
      this.#lease?.close();
      await this.#sidecar.stop();
    } finally {
      this.#started = false;
      this.#lease = null;
      this.#stopping = false;
      this.#deps.onChange?.();
    }
  }

  async dispose(): Promise<void> {
    this.#sidecar.off("event", this.#onEvent);
    await this.stop();
  }

  async #deviceFor(endpointId: string): Promise<AccountIrohDevice | null> {
    try {
      return await this.#deps.authorizePeer(endpointId);
    } catch (error) {
      this.#deps.log.warn("iroh peer authorization failed", error);
      return null;
    }
  }

  #peerLabel(device: AccountIrohDevice): string {
    const name = deviceNameSetting(device.name) || uiText("已连接设备", "Connected device");
    const used = new Set(this.#labels.values());
    let label = name;
    for (let suffix = 2; used.has(label); suffix++) label = `${name} (${suffix})`;
    return label;
  }

  #handle(event: IrohSidecarEvent): void {
    if (event.type === "started" || event.type === "addresses") {
      if (this.#stopping || this.#signedOut || (!this.#started && !this.#startFlight)
        || event.endpointId !== this.#endpointId || !Array.isArray(event.directAddresses)) return;
      this.#directAddresses = event.directAddresses.filter((address): address is string => typeof address === "string").slice(0, 64);
      this.#syncDiscovery();
      return;
    }
    if (event.type === "connected") {
      void this.#accept(event);
      return;
    }
    if (event.type === "path") {
      if (!this.#sockets.has(event.connectionId)) return;
      this.#paths.set(event.connectionId, event.path);
      if (this.#labels.has(event.connectionId)) this.#deps.onChange?.();
      return;
    }
    if (event.type === "traffic") {
      if (this.#paths.get(event.connectionId) !== "relay") return;
      this.#lease?.recordTraffic(event.direction === "in" ? { bytesIn: event.bytes, bytesOut: 0 } : { bytesIn: 0, bytesOut: event.bytes });
    }
  }

  async #accept(event: Extract<IrohSidecarEvent, { type: "connected" }>): Promise<void> {
    const socket = new IrohSocket(this.#sidecar, event.connectionId, true);
    if (!this.#started || this.#stopping) {
      socket.terminate();
      return;
    }
    this.#sockets.set(event.connectionId, socket);
    this.#paths.set(event.connectionId, "connecting");
    socket.once("close", () => {
      if (this.#sockets.get(event.connectionId) !== socket) return;
      this.#sockets.delete(event.connectionId);
      this.#labels.delete(event.connectionId);
      this.#paths.delete(event.connectionId);
      this.#deps.onChange?.();
    });
    const device = await this.#deviceFor(event.remoteId);
    if (!device || socket.readyState !== socket.OPEN || !this.#started || this.#stopping || this.#sockets.get(event.connectionId) !== socket) {
      socket.terminate();
      return;
    }
    try {
      const label = this.#peerLabel(device);
      this.#labels.set(event.connectionId, label);
      this.#deps.attach(socket, { id: `iroh:${event.connectionId}`, label });
      socket.resumeMessages();
      this.#deps.onChange?.();
    } catch (error) {
      socket.terminate();
      this.#deps.log.warn("iroh client attachment failed", error);
    }
  }
}
