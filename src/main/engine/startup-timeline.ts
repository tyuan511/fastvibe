import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Where the launch went, in one log line.
 *
 * «Startup is slow» was undiagnosable from outside: `app ready` and `window opened` are logged,
 * but the time between process start and the first usable chat is spent in places nothing
 * timed (loading the main bundle, the network proxy, the engine's MCP connections, the first
 * session's extensions). Each phase marks itself here and the whole line is written once, when
 * both the window and the engine are up.
 *
 * Electron-free on purpose: the engine marks from inside `start()`, and the headless Agent runs
 * the same engine.
 */

const marks = new Map<string, number>();
let flushed = false;
let sink: (line: string) => void = (line) => console.info(line);

/** Milliseconds since this process started. */
function sinceStart(): number {
  return Math.round(process.uptime() * 1000);
}

/** Record a phase. The first call for a name wins: a window reopened later is not the launch. */
export function markStartup(name: string): void {
  if (marks.has(name)) return;
  marks.set(name, sinceStart());
  if (marks.has("window-shown") && marks.has("engine-ready")) flushStartup();
}

/** `main-loaded 234, app-ready 236, …` in the order the phases happened. */
export function formatTimeline(entries: ReadonlyMap<string, number>): string {
  return [...entries].sort((a, b) => a[1] - b[1]).map(([name, ms]) => `${name} ${ms}`).join(", ");
}

/** Write the line once. Phases that never happened are simply absent. */
export function flushStartup(): void {
  if (flushed) return;
  flushed = true;
  sink(`[startup] ms since process start: ${formatTimeline(marks)}`);
}

/** Test seam: where the line goes, and a clean slate. */
export function resetStartupTimeline(next?: (line: string) => void): void {
  marks.clear();
  flushed = false;
  sink = next ?? ((line) => console.info(line));
}

/**
 * Report event-loop stalls on the main process.
 *
 * Main hosts the agent engine, every stream's fan-out, git, the remote server and the window
 * IPC on one thread, so a long synchronous stretch anywhere delays all of them. Nothing said how
 * often that happens or how long it lasts. A minute with nothing above `thresholdMs` is silent;
 * a minute with a stall writes one line with the worst and the 99th-percentile delay. The
 * histogram has a 10 ms resolution, so a reported max is the real stall to within that.
 */
export function watchEventLoop(options: { thresholdMs?: number; intervalMs?: number; write?: (line: string) => void } = {}): () => void {
  const thresholdMs = options.thresholdMs ?? 200;
  const write = options.write ?? ((line: string) => console.info(line));
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const timer = setInterval(() => {
    const max = histogram.max / 1e6;
    if (max >= thresholdMs) {
      write(`[loop] event loop stalled up to ${Math.round(max)} ms in the last minute (p99 ${Math.round(histogram.percentile(99) / 1e6)} ms)`);
    }
    histogram.reset();
  }, options.intervalMs ?? 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
