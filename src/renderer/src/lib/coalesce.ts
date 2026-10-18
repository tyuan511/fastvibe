/**
 * Collapse a burst of calls to one background read.
 *
 * The event handler asks for the same reads from several events that arrive together: a run
 * ending sends `agent_end` and then `agent_settled` a moment later, and each asked for the
 * state, the transcript tail and the stats — two of every read for one finished turn. Tool
 * results refreshed the stats once each, so a script or a parallel batch finishing a dozen
 * calls asked Main to walk the whole session a dozen times.
 *
 * The first call waits `delayMs`; every call made meanwhile shares that run. A call made while
 * the run is in flight is not folded into it — it may be about state the read already passed —
 * and schedules exactly one more run once it ends. Every caller's promise resolves when the run
 * that covers it has finished. `run` is expected to swallow its own failures, as the refreshes do.
 */
export type CoalesceClock = {
  setTimeout(run: () => void, ms: number): unknown;
};

const browserClock: CoalesceClock = { setTimeout: (run, ms) => setTimeout(run, ms) };

export function coalesce(run: () => Promise<void>, delayMs: number, clock: CoalesceClock = browserClock): () => Promise<void> {
  let next: { promise: Promise<void>; resolve: () => void } | null = null;
  let scheduled = false;
  let busy = false;

  const fire = (): void => {
    scheduled = false;
    const batch = next;
    if (busy || !batch) return;
    next = null;
    busy = true;
    void run()
      .catch(() => undefined)
      .then(() => {
        busy = false;
        batch.resolve();
        if (next && !scheduled) {
          scheduled = true;
          clock.setTimeout(fire, 0);
        }
      });
  };

  return () => {
    if (!next) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      next = { promise, resolve };
    }
    const asked = next.promise;
    if (!scheduled && !busy) {
      scheduled = true;
      clock.setTimeout(fire, delayMs);
    }
    return asked;
  };
}
