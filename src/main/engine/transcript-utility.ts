import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";

export type TranscriptUtilityResult = {
  lineCount: number;
  parsedCount: number;
  malformed: number;
  bytes: number;
  firstId?: string;
  lastId?: string;
  entries?: unknown[];
};

type Request = {
  id: number;
  method: "scan-jsonl" | "parse-jsonl";
  file: string;
  start?: number;
  mode?: "stats" | "entries";
};

type Pending = {
  resolve: (value: TranscriptUtilityResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Optional transcript parsing isolation experiment. It is deliberately not part of AppServer or
 * the remote call table: enabling it changes only a local benchmark/host experiment.
 */
export class TranscriptUtilityClient {
  static readonly enabled = process.env.FASTVIBE_TRANSCRIPT_UTILITY === "1";
  #child: UtilityProcess | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  readonly timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  start(): boolean {
    if (this.#child) return true;
    if (!TranscriptUtilityClient.enabled) return false;
    const entry = join(__dirname, "transcript-utility.js");
    const child = utilityProcess.fork(entry, [], { serviceName: "fastvibe-transcript-utility" });
    child.on("message", (event) => this.#onMessage(((event as { data?: unknown })?.data ?? event) as unknown));
    child.on("exit", (code) => this.#onExit(code));
    this.#child = child;
    return true;
  }

  scan(file: string, start = 0): Promise<TranscriptUtilityResult> {
    return this.#request({ method: "scan-jsonl", file, start });
  }

  parse(file: string, start = 0): Promise<TranscriptUtilityResult> {
    return this.#request({ method: "parse-jsonl", file, start, mode: "entries" });
  }

  close(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child) child.kill();
    this.#rejectAll(new Error("transcript utility closed"));
  }

  #request(input: Omit<Request, "id">): Promise<TranscriptUtilityResult> {
    if (!this.start() || !this.#child) return Promise.reject(new Error("transcript utility is disabled"));
    const id = this.#nextId++;
    return new Promise<TranscriptUtilityResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`transcript utility request timed out: ${input.method}`));
        this.#child?.kill();
        this.#child = undefined;
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child?.postMessage({ id, ...input });
    });
  }

  #onMessage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true && message.result && typeof message.result === "object") {
      pending.resolve(message.result as TranscriptUtilityResult);
    } else {
      pending.reject(new Error(typeof message.error === "string" ? message.error : "transcript utility request failed"));
    }
  }

  #onExit(code: number): void {
    this.#child = undefined;
    this.#rejectAll(new Error(`transcript utility exited with code ${code}`));
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
