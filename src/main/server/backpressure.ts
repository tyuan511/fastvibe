/**
 * ws.bufferedAmount includes uncompressed bytes being processed by zlib, not just
 * bytes a slow peer failed to read. A multi-MiB snapshot therefore exceeds the soft
 * watermark even on loopback. Only sustained congestion is a fault; a separate hard
 * ceiling prevents a burst from growing the per-client queue without bound.
 *
 * Call before each send AND when a send finishes. Sampling only before sends would
 * join two isolated large replies into one apparently continuous stall.
 */
export const BUFFER_SOFT_LIMIT = 2 * 1024 * 1024;
export const BUFFER_HARD_LIMIT = 32 * 1024 * 1024;
export const BUFFER_GRACE_MS = 5_000;

export type BackpressureReason = "hard-limit" | "sustained";

export class BackpressureGuard {
  #since: number | null = null;

  observe(buffered: number, now = performance.now()): BackpressureReason | null {
    if (buffered <= BUFFER_SOFT_LIMIT) {
      this.#since = null;
      return null;
    }
    if (buffered > BUFFER_HARD_LIMIT) return "hard-limit";
    this.#since ??= now;
    return now - this.#since >= BUFFER_GRACE_MS ? "sustained" : null;
  }
}
