/**
 * ws.bufferedAmount includes uncompressed bytes being processed by zlib, not just
 * bytes a slow peer failed to read. A multi-MiB snapshot therefore exceeds the soft
 * watermark even on loopback. Check send progress and outstanding frame age; a
 * separate hard ceiling prevents the per-client queue from growing without bound.
 *
 * Call before each send AND when a send finishes. Sampling only before sends would
 * join two isolated large replies into one apparently continuous stall.
 */
export const BUFFER_SOFT_LIMIT = 2 * 1024 * 1024;
export const BUFFER_HARD_LIMIT = 32 * 1024 * 1024;
/** Give a mobile link time to drain; progress gets grace, but never unlimited memory/time. */
export const BUFFER_GRACE_MS = 15_000;
export const BUFFER_MAX_PENDING_MS = 120_000;
const PROGRESS_BYTES = 64 * 1024;

export type BackpressureReason = "hard-limit" | "sustained" | "pending-timeout";

export class BackpressureGuard {
  #since: number | null = null;
  #progressAt = 0;
  #progressBuffer = 0;
  #nextSend = 0;
  #pending = new Map<number, number>();

  /** Track before calling ws.send; complete only on a successful write callback.
   * This is local transport progress, not an acknowledgement from the client.
   * Queue size alone misses progress when fast producers replace every sent byte.
   */
  trackSend(now = performance.now()): (completedAt?: number) => void {
    const id = this.#nextSend++;
    this.#pending.set(id, now);
    return (completedAt = performance.now()) => {
      if (!this.#pending.delete(id)) return;
      this.#progressAt = completedAt;
    };
  }

  clear(): void {
    this.#pending.clear();
    this.#since = null;
  }

  observe(buffered: number, now = performance.now()): BackpressureReason | null {
    if (buffered <= BUFFER_SOFT_LIMIT) {
      this.#since = null;
      return null;
    }
    if (buffered > BUFFER_HARD_LIMIT) return "hard-limit";
    if (this.#since === null) {
      this.#since = this.#progressAt = now;
      this.#progressBuffer = buffered;
    } else if (buffered <= this.#progressBuffer - PROGRESS_BYTES) {
      // Queue shrinkage also detects progress within a large write before its
      // callback arrives. Several small drains count together; tiny drips do not.
      this.#progressAt = now;
      this.#progressBuffer = buffered;
    }
    // A busy queue may stay above the soft limit indefinitely while delivering
    // promptly. Bound the oldest outstanding frame, not how long the stream runs.
    const oldest = this.#pending.values().next().value;
    if (oldest !== undefined && now - oldest >= BUFFER_MAX_PENDING_MS) return "pending-timeout";
    return now - this.#progressAt >= BUFFER_GRACE_MS ? "sustained" : null;
  }
}
