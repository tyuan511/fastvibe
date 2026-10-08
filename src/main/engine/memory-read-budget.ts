/** Automatic context preparation has a shorter budget than an explicit search. */
export const MEMORY_PREPARATION_TIMEOUT_MS = 2_000;

/** One deadline for model loading, embedding and every retrieval request. */
export class MemoryReadBudget {
  readonly deadlineAt: number;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #external: AbortSignal | undefined;
  readonly #onAbort: () => void;

  constructor(timeoutMs: number, signal?: AbortSignal) {
    this.deadlineAt = Date.now() + Math.max(0, timeoutMs);
    this.#external = signal;
    this.#onAbort = () => this.#controller.abort(signal?.reason);
    this.#timer = setTimeout(() => this.#controller.abort(new DOMException("Memory preparation timed out", "TimeoutError")), Math.max(0, timeoutMs));
    if (signal?.aborted) this.#onAbort();
    else signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  get signal(): AbortSignal { return this.#controller.signal; }
  get remainingMs(): number { return this.signal.aborted ? 0 : Math.max(0, this.deadlineAt - Date.now()); }

  /** Release this reader even when a shared model loader cannot itself be aborted. */
  async wait<T>(start: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (this.remainingMs <= 0) {
      this.#controller.abort(new DOMException("Memory preparation timed out", "TimeoutError"));
      this.signal.throwIfAborted();
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => {
        this.signal.throwIfAborted();
        return start();
      }).then(resolve, reject).finally(() => this.signal.removeEventListener("abort", onAbort));
    });
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#external?.removeEventListener("abort", this.#onAbort);
    this.#controller.abort();
  }
}
