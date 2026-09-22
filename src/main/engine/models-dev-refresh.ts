/**
 * Hourly refresh of the models.dev snapshot on the user's machine.
 *
 * The bundled index only moves when the app does, and 设置 → 关于 is a button people
 * do not go looking for, so limits and prices would otherwise sit still for the life
 * of an install. This schedules the same update that button runs: once shortly after
 * launch when the snapshot is already an hour old (or missing), then an hour after
 * every attempt — a failure included, so a down upstream is not polled in a loop.
 */

export const MODELS_DEV_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** An overdue snapshot still waits out launch, so the fetch does not compete with the window. */
export const MODELS_DEV_REFRESH_START_DELAY_MS = 15_000;

export type ModelsDevRefreshDelayInput = {
  now: number;
  /** `generatedAt` of the snapshot in use; 0 when there is none. */
  generatedAt: number;
  /** When the last attempt finished; 0 when none has run yet. */
  lastAttemptAt: number;
  intervalMs?: number;
  startDelayMs?: number;
};

/**
 * How long to wait before the next attempt.
 *
 * A fresh snapshot waits out the rest of its hour. One that is already due — or
 * missing — waits only the launch delay, and only on the first attempt. A clock that
 * has jumped so `generatedAt` is far ahead is clamped to one interval, or the refresh
 * would be postponed until that future date.
 */
export function nextModelsDevRefreshDelay(input: ModelsDevRefreshDelayInput): number {
  const interval = input.intervalMs ?? MODELS_DEV_REFRESH_INTERVAL_MS;
  const startDelay = input.startDelayMs ?? MODELS_DEV_REFRESH_START_DELAY_MS;
  const fromCatalog = input.generatedAt > 0 ? input.generatedAt + interval : input.now;
  const fromAttempt = input.lastAttemptAt > 0 ? input.lastAttemptAt + interval : fromCatalog;
  let dueAt = Math.max(fromCatalog, fromAttempt);
  if (input.lastAttemptAt === 0 && dueAt < input.now + startDelay) dueAt = input.now + startDelay;
  if (dueAt > input.now + interval) dueAt = input.now + interval;
  return Math.max(0, dueAt - input.now);
}

export type TimerHandle = { cancel: () => void };

export type ModelsDevRefreshDeps = {
  now?: () => number;
  generatedAt: () => number;
  refresh: () => Promise<void>;
  onError?: (error: unknown) => void;
  setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  intervalMs?: number;
  startDelayMs?: number;
};

function defaultSetTimer(fn: () => void, delayMs: number): TimerHandle {
  const timer = setTimeout(fn, delayMs);
  // A background refresh must not be what keeps the process alive after quit.
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Start the hourly refresh. The returned function cancels the pending timer; an
 * attempt already in flight is left to finish, but it will not schedule another.
 */
export function startModelsDevRefresh(deps: ModelsDevRefreshDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const interval = deps.intervalMs ?? MODELS_DEV_REFRESH_INTERVAL_MS;
  const startDelay = deps.startDelayMs ?? MODELS_DEV_REFRESH_START_DELAY_MS;
  let stopped = false;
  let timer: TimerHandle | undefined;
  let lastAttemptAt = 0;

  const arm = (): void => {
    if (stopped) return;
    const delay = nextModelsDevRefreshDelay({
      now: now(),
      generatedAt: deps.generatedAt(),
      lastAttemptAt,
      intervalMs: interval,
      startDelayMs: startDelay,
    });
    timer = setTimer(() => {
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;
    const at = now();
    const generatedAt = deps.generatedAt();
    // A manual update (or a refresh that landed while this timer was waiting) already
    // moved the snapshot. Downloading again would throw away the hour it just bought.
    if (generatedAt > 0 && at - generatedAt >= 0 && at - generatedAt < interval) {
      arm();
      return;
    }
    try {
      await deps.refresh();
    } catch (error) {
      deps.onError?.(error);
    }
    lastAttemptAt = now();
    if (!stopped) arm();
  };

  arm();
  return () => {
    stopped = true;
    timer?.cancel();
    timer = undefined;
  };
}
