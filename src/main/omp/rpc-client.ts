import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeFrame, JsonlDecoder } from "./jsonl";

export type RpcCommand = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  code?: string;
  data?: unknown;
};

type Pending = {
  command: string;
  resolve: (value: RpcResponse) => void;
  reject: (error: Error) => void;
};

export class OmpRpcClient {
  #proc: ChildProcessWithoutNullStreams;
  #decoder = new JsonlDecoder();
  #pending = new Map<string, Pending>();
  #seq = 0;
  #listeners = new Set<(event: Record<string, unknown>) => void>();
  #ready: Record<string, unknown> | null = null;
  #readyWaiters: Array<{
    resolve: (ready: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = [];
  #closed = false;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      for (const frame of this.#decoder.push(chunk)) {
        this.#dispatch(frame);
      }
    });
    proc.on("exit", () => this.dispose(new Error("omp process exited")));
  }

  get readyFrame(): Record<string, unknown> | null {
    return this.#ready;
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitForReady(timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.#ready) return Promise.resolve(this.#ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for omp RPC ready frame"));
      }, timeoutMs);
      this.#readyWaiters.push({
        resolve: (ready) => {
          clearTimeout(timer);
          resolve(ready);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async negotiate(): Promise<void> {
    const ready = await this.waitForReady();
    const versions = ready.supportedProtocolVersions;
    if (Array.isArray(versions) && versions.includes(2)) {
      await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    }
  }

  request(command: RpcCommand, timeoutMs = 60_000): Promise<RpcResponse> {
    if (this.#closed) return Promise.reject(new Error("omp RPC client is closed"));
    const id = command.id ?? `req_${++this.#seq}`;
    const payload = { ...command, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC timed out: ${command.type}`));
      }, timeoutMs);

      this.#pending.set(id, {
        command: command.type,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.#write(payload);
    });
  }

  send(command: RpcCommand): void {
    this.#write({ ...command, id: command.id ?? `evt_${++this.#seq}` });
  }

  dispose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#decoder.reset();
    for (const pending of this.#pending.values()) {
      pending.reject(error ?? new Error("omp RPC client disposed"));
    }
    this.#pending.clear();
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error ?? new Error("engine process exited"));
    }
  }

  #write(value: unknown): void {
    if (!this.#proc.stdin.writable) {
      throw new Error("omp stdin is not writable");
    }
    this.#proc.stdin.write(encodeFrame(value));
  }

  #dispatch(frame: unknown): void {
    if (!isRecord(frame) || typeof frame.type !== "string") return;

    if (frame.type === "ready") {
      this.#ready = frame;
      for (const waiter of this.#readyWaiters) waiter.resolve(frame);
      this.#readyWaiters = [];
      this.#emit(frame);
      return;
    }

    if (frame.type === "response") {
      const response = frame as RpcResponse;
      if (response.id) {
        const pending = this.#pending.get(response.id);
        if (pending) {
          this.#pending.delete(response.id);
          pending.resolve(response);
        }
      }
      this.#emit(frame);
      return;
    }

    this.#emit(frame);
  }

  #emit(event: Record<string, unknown>): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
