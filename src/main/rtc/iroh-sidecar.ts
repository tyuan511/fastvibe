import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSE,
  FrameAssembler,
  FrameError,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  closeMessage,
  controlMessage,
  splitFrame,
} from "./frames.ts";
import type { RemoteSocket } from "../server/server.ts";
import { irohRelayNodes, type IrohRelayConfig } from "../../shared/iroh-relay.ts";

export type IrohSidecarEvent =
  | { type: "identity"; endpointId: string }
  | { type: "started"; endpointId: string; relayId?: string; expiresAt?: string }
  | { type: "refreshed" }
  | { type: "connected"; connectionId: string; remoteId: string }
  | { type: "data"; connectionId: string; data: string; bytes?: number }
  | { type: "path"; connectionId: string; path: "connecting" | "direct" | "relay" }
  | { type: "traffic"; connectionId: string; direction: "in" | "out"; bytes: number }
  | { type: "closed"; connectionId: string }
  | { type: "sent"; seq: number; connectionId: string; bytes: number }
  | { type: "error"; connectionId?: string; seq?: number; message: string };


type SidecarCommand = Record<string, unknown>;
type SidecarWaiter = {
  onEvent: (event: IrohSidecarEvent) => void;
  reject: (error: Error) => void;
};

/** Resolve the platform sidecar without relying on Electron's own resources directory in dev. */
export function irohSidecarBinary(env: NodeJS.ProcessEnv = process.env): string {
  const executable = process.platform === "win32" ? "fastvibe-iroh.exe" : "fastvibe-iroh";
  const override = env.FASTVIBE_IROH_BIN?.trim();
  if (override) return override;

  const resourcesRoot = env.FASTVIBE_RESOURCES_PATH?.trim();
  if (resourcesRoot) return join(resourcesRoot, "iroh", executable);

  if (process.resourcesPath && process.resourcesPath !== process.cwd()) {
    return join(process.resourcesPath, "iroh", executable);
  }

  const candidates = [
    join(process.cwd(), "resources", "iroh", executable),
    join(process.cwd(), "rust", "target", "release", executable),
    join(process.cwd(), "rust", "target", "debug", executable),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function relayCommandFields(lease: IrohRelayConfig): SidecarCommand {
  return {
    // Older binaries ignore relays and can still read the compatibility fields.
    relayId: lease.relayId,
    relayUrl: lease.url,
    relayToken: lease.token,
    quicPort: lease.quicPort,
    expiresAt: lease.expiresAt,
    relays: irohRelayNodes(lease).map((node) => ({
      relayId: node.relayId, relayUrl: node.url, relayToken: node.token, quicPort: node.quicPort,
    })),
  };
}

function sidecarMissingError(binary: string): Error {
  return new Error(`找不到 iroh transport: ${binary}。请先运行 pnpm build:iroh，或设置 FASTVIBE_IROH_BIN`);
}

export class IrohSidecar extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | null = null;
  #seq = 1;
  #waiters = new Map<number, SidecarWaiter>();

  async start(identityPath: string, lease: IrohRelayConfig): Promise<string> {
    const endpointId = await this.identity(identityPath);
    await this.startLease(lease);
    return endpointId;
  }

  async identity(identityPath: string): Promise<string> {
    this.#ensureChild();
    const identity = await this.#command({ type: "identity", statePath: identityPath }, "identity");
    return stringField(identity, "endpointId");
  }

  async startLease(lease: IrohRelayConfig): Promise<void> {
    await this.#command({
      type: "start",
      ...relayCommandFields(lease),
    }, "started");
  }

  async refresh(lease: IrohRelayConfig): Promise<void> {
    await this.#command({ type: "refresh", ...relayCommandFields(lease) }, "refreshed");
  }

  async connect(remoteId: string, lease: IrohRelayConfig): Promise<{ connectionId: string; remoteId: string }> {
    const event = await this.#command({
      type: "connect",
      remoteId,
      ...relayCommandFields(lease),
    }, "connected", (candidate) => candidate.type === "connected" && candidate.remoteId === remoteId);
    if (event.type !== "connected") throw new Error("iroh sidecar did not acknowledge the connection");
    return { connectionId: event.connectionId, remoteId: event.remoteId };
  }

  async send(connectionId: string, bytes: Uint8Array): Promise<void> {
    const seq = this.#seq++;
    const event = await this.#command({ type: "send", seq, connectionId, data: Buffer.from(bytes).toString("base64") }, "sent", (candidate) => candidate.type === "sent" && candidate.seq === seq && candidate.connectionId === connectionId);
    if (event.type !== "sent") throw new Error("iroh sidecar did not acknowledge the write");
  }

  closeConnection(connectionId: string): void {
    this.#write({ type: "close", connectionId });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    try {
      this.#write({ type: "stop" });
    } catch {
      // The process may already be closing; killing it below is still sufficient.
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finish);
      child.kill();
      const timer = setTimeout(finish, 2_000);
      timer.unref();
    });
    if (this.#child === child) this.#child = null;
  }

  #ensureChild(): void {
    if (this.#child) return;
    const binary = irohSidecarBinary();
    if (!existsSync(binary)) throw sidecarMissingError(binary);
    const child = spawn(binary, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => this.emit("log", chunk.toString("utf8")));
    child.on("error", (error) => {
      const message = `iroh transport 启动失败: ${error.message}`;
      this.#rejectWaiters(new Error(message));
      this.emit("error", error);
    });
    child.on("exit", () => {
      this.#child = null;
      this.#rejectWaiters(new Error("iroh sidecar exited"));
      this.emit("exit");
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as IrohSidecarEvent;
        this.emit("event", event);
        if (event.type !== "error" || (event.connectionId === undefined && event.seq === undefined)) {
          this.emit(event.type, event);
        }
      } catch {
        this.emit("log", `iroh sidecar emitted invalid JSON: ${line}`);
      }
    });
    this.#child = child;
  }

  #write(command: SidecarCommand): void {
    if (!this.#child?.stdin.writable) throw new Error("iroh sidecar is not running");
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  #command(command: SidecarCommand, type: IrohSidecarEvent["type"], matches?: (event: IrohSidecarEvent & { seq?: number }) => boolean): Promise<IrohSidecarEvent> {
    return new Promise((resolve, reject) => {
      const id = this.#seq++;
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        this.off("event", onEvent);
        reject(new Error(`iroh sidecar timed out waiting for ${type}`));
      }, 20_000);
      const onEvent = (event: IrohSidecarEvent): void => {
        if (event.type === "error") {
          const scopedToCommand = event.connectionId !== undefined || event.seq !== undefined;
          if (scopedToCommand &&
            ((event.connectionId !== undefined && event.connectionId !== command.connectionId) ||
              (event.seq !== undefined && event.seq !== command.seq))) return;
          clearTimeout(timer);
          this.#waiters.delete(id);
          this.off("event", onEvent);
          reject(new Error(event.message));
          return;
        }
        if (event.type !== type || (matches && !matches(event as IrohSidecarEvent & { seq?: number }))) return;
        clearTimeout(timer);
        this.#waiters.delete(id);
        this.off("event", onEvent);
        resolve(event);
      };
      this.#waiters.set(id, { onEvent, reject: (error) => {
        clearTimeout(timer);
        this.off("event", onEvent);
        reject(error);
      } });
      this.on("event", onEvent);
      try {
        this.#write(command);
      } catch (error) {
        this.#waiters.delete(id);
        this.off("event", onEvent);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #rejectWaiters(error: Error): void {
    for (const { onEvent, reject } of this.#waiters.values()) {
      this.off("event", onEvent);
      reject(error);
    }
    this.#waiters.clear();
  }
}

/** A RemoteSocket adapter: iroh carries the same framed App Protocol used by WebRTC. */
export class IrohSocket extends EventEmitter implements RemoteSocket {
  readonly OPEN = 1;
  #state = 1;
  #buffered = 0;
  #queue: Array<{ frame: Buffer; done?: (error?: Error) => void }> = [];
  #pumping = false;
  #sidecar: IrohSidecar;
  #connectionId: string;
  #assembler = new FrameAssembler(32 * 1024 * 1024);
  #onEvent: (event: IrohSidecarEvent) => void;
  #deferMessages: boolean;
  #pendingMessages: Array<{ data: Buffer; binary: boolean }> = [];
  #pendingBytes = 0;

  constructor(sidecar: IrohSidecar, connectionId: string, deferMessages = false) {
    super();
    this.#sidecar = sidecar;
    this.#connectionId = connectionId;
    this.#deferMessages = deferMessages;
    this.#onEvent = (event) => this.#receive(event);
    sidecar.on("event", this.#onEvent);
  }

  get readyState(): number { return this.#state; }
  get bufferedAmount(): number { return this.#buffered; }

  resumeMessages(): void {
    if (!this.#deferMessages || this.#state !== 1) return;
    while (this.#pendingMessages.length && this.#state === 1) {
      const message = this.#pendingMessages.shift()!;
      this.#pendingBytes -= message.data.byteLength;
      this.emit("message", message.data, message.binary);
    }
    this.#deferMessages = false;
  }

  send(data: string | Uint8Array, callback?: (error?: Error) => void): void {
    if (this.#state !== 1) {
      callback?.(new Error("iroh connection is not open"));
      return;
    }
    const binary = typeof data !== "string";
    const frames = splitFrame(typeof data === "string" ? Buffer.from(data, "utf8") : data, binary, false, MAX_MESSAGE_BYTES);
    frames.forEach((frame, index) => this.#queue.push({ frame, done: index === frames.length - 1 ? callback : undefined }));
    this.#buffered += frames.reduce((sum, frame) => sum + frame.byteLength, 0);
    void this.#pump();
  }

  ping(): void {
    if (this.#state === 1) this.#queue.unshift({ frame: controlMessage(PING) });
    void this.#pump();
  }

  close(code = 1000, reason = ""): void {
    if (this.#state >= 2) return;
    this.#state = 2;
    this.#queue.unshift({ frame: closeMessage(code, reason) });
    void this.#pump().finally(() => this.#finish(code, reason));
  }

  terminate(): void { this.#finish(1006, ""); }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#state >= 3) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && this.#state < 3) {
        const item = this.#queue.shift()!;
        try {
          await this.#sidecar.send(this.#connectionId, item.frame);
          this.#buffered -= item.frame.byteLength;
          item.done?.();
        } catch (error) {
          this.#buffered -= item.frame.byteLength;
          item.done?.(error instanceof Error ? error : new Error(String(error)));
          this.#finish(1006, "send failed");
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  #receive(event: IrohSidecarEvent): void {
    if (!("connectionId" in event) || event.connectionId !== this.#connectionId || this.#state >= 3) return;
    if (event.type === "closed") return this.#finish(1006, "");
    if (event.type !== "data") return;
    try {
      const bytes = Buffer.from(event.data, "base64");
      const frame = this.#assembler.push(bytes);
      if (frame.kind === "partial") return;
      if (frame.kind === "frame") {
        if (this.#deferMessages) {
          this.#pendingBytes += frame.data.byteLength;
          if (this.#pendingBytes > 2 * 1024 * 1024 || this.#pendingMessages.length >= 64) {
            this.close(1009, "too much data before attachment");
            return;
          }
          this.#pendingMessages.push({ data: frame.data, binary: frame.binary });
        } else this.emit("message", frame.data, frame.binary);
        return;
      }
      if (frame.kind === "ping") return void this.sendControl(PONG);
      if (frame.kind === "pong") return void this.emit("pong");
      if (frame.kind === "close") return void this.#finish(frame.code, frame.reason);
    } catch (error) {
      if (error instanceof FrameError) this.close(1002, error.message);
      else this.#finish(1006, "frame error");
    }
  }

  sendControl(kind: typeof PING | typeof PONG): void {
    this.#queue.unshift({ frame: controlMessage(kind) });
    void this.#pump();
  }

  #finish(code: number, reason: string): void {
    if (this.#state >= 3) return;
    this.#state = 3;
    this.#sidecar.closeConnection(this.#connectionId);
    this.#sidecar.off("event", this.#onEvent);
    this.#queue.splice(0).forEach((item) => item.done?.(new Error("iroh connection closed")));
    this.#pendingMessages = [];
    this.#pendingBytes = 0;
    this.#buffered = 0;
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}

function stringField(event: IrohSidecarEvent, field: string): string {
  const value = (event as unknown as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value) throw new Error(`iroh sidecar event missing ${field}`);
  return value;
}
