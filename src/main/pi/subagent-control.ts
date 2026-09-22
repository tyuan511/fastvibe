/** Cancellation covers setup as well as prompt(). Aborting an idle SDK session
 * before prompt is not enough: prompt resets the SDK's abort flag. */
export class SubagentControl {
  readonly #controller = new AbortController();
  readonly #parent?: AbortSignal;
  readonly #releasePrompts: () => void;
  #session?: { abort(): Promise<void> };
  #aborting?: Promise<void>;
  readonly #onParentAbort = (): void => { void this.abort().catch(() => undefined); };

  constructor(parent: AbortSignal | undefined, releasePrompts: () => void) {
    this.#parent = parent;
    this.#releasePrompts = releasePrompts;
    if (parent?.aborted) this.#onParentAbort();
    else parent?.addEventListener("abort", this.#onParentAbort, { once: true });
  }

  get aborted(): boolean { return this.#controller.signal.aborted; }

  check(): void {
    if (this.aborted) throw new DOMException("Subagent cancelled", "AbortError");
  }

  bind(session: { abort(): Promise<void> }): void {
    this.#session = session;
    this.check();
  }

  abort(): Promise<void> {
    if (!this.aborted) {
      this.#controller.abort();
      // The tool_call approval hook cannot observe the SDK's abort until its
      // parked UI promise resolves. Release it before waiting for session.abort.
      this.#releasePrompts();
      this.#aborting = this.#session?.abort() ?? Promise.resolve();
    }
    return this.#aborting ?? Promise.resolve();
  }

  dispose(): void {
    this.#parent?.removeEventListener("abort", this.#onParentAbort);
  }
}
