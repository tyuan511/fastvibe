import type { BrowserWindow } from "electron";

/**
 * The transport-neutral call table.
 *
 * Every method the UI can call used to be registered straight onto `ipcMain`, which
 * made Electron IPC the only way to reach Main. The table exists so a second transport
 * — the remote server's WebSocket — dispatches the *same* functions rather than
 * re-implementing them: one behaviour, two ways in. A method that existed only on one
 * side would be a method the remote client silently lacks, which is the class of bug
 * that only shows up on the machine you are not sitting at.
 *
 * Handlers take `(payload, ctx)` rather than Electron's `(event, payload)`, because
 * `event` is an Electron concept a WebSocket caller cannot produce. What the four
 * handlers that actually needed the sender were reaching for is in `ctx`.
 */
export type CallerContext = {
  /** Which transport the call arrived on. Desktop windows and remote clients differ. */
  kind: "window" | "remote";
  /**
   * The window that asked, when the call came over IPC — null for a remote caller.
   * Window controls act on it, and a save dialog is parented to it.
   */
  window: BrowserWindow | null;
  /**
   * The caller's broadcast identity, so a write is not echoed back to whoever made it.
   * Matches `Subscriber.id` in `broadcast.ts`.
   */
  origin?: string;
};

type StoredHandler = (payload: unknown, ctx: CallerContext) => unknown;

const handlers = new Map<string, StoredHandler>();

/**
 * Add one method to the table.
 *
 * `P` is inferred from the function, so each handler keeps the concrete payload type it
 * was written with while the table itself stays erased to `unknown` — the single cast
 * below is the only place the two meet.
 */
export function handle<P = void>(
  channel: string,
  fn: (payload: P, ctx: CallerContext) => unknown,
): void {
  if (handlers.has(channel)) throw new Error(`duplicate IPC handler: ${channel}`);
  handlers.set(channel, fn as StoredHandler);
}

/** Every registered channel, for a transport to wire itself up to. */
export function handlerChannels(): string[] {
  return [...handlers.keys()];
}

/** Look one up. Transports use this to reject an unknown channel with their own error. */
export function handlerFor(channel: string): StoredHandler | undefined {
  return handlers.get(channel);
}

/** A call that took at least this long is reported to the observer. */
export const SLOW_CALL_MS = 300;

/**
 * Calls that answer when their work is over, not when it is accepted — a run, a
 * compaction, a login waiting on a browser. Their length says nothing about the app.
 */
const LONG_BY_NATURE = /^(engine:(prompt|prompt-conversation|submit-prompt|continue|compact)|providers:oauth-login|ssh:)/;

let slowCallObserver: ((channel: string, ms: number, kind: CallerContext["kind"], failed: boolean) => void) | null = null;

/**
 * Be told about slow calls. One observer, set once at startup: the table itself knows
 * nothing about logging, and a second caller would only log the same line twice.
 *
 * It exists because «the app is slow» was undiagnosable from outside: a phone waiting ten
 * seconds for a chat to open looked like a slow network, while the reply it was waiting
 * for was a few hundred bytes that Main took all ten seconds to produce.
 */
export function observeSlowCalls(observer: typeof slowCallObserver): void {
  slowCallObserver = observer;
}

/**
 * Run one call. Awaited here so both transports see the same thing: a value, or a
 * throw — never a handler's un-awaited promise leaking past the boundary.
 */
export async function dispatch(channel: string, payload: unknown, ctx: CallerContext): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`unknown method: ${channel}`);
  const observer = slowCallObserver;
  if (!observer || LONG_BY_NATURE.test(channel)) return await handler(payload, ctx);
  const started = performance.now();
  let failed = false;
  try {
    return await handler(payload, ctx);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const ms = performance.now() - started;
    if (ms >= SLOW_CALL_MS) observer(channel, Math.round(ms), ctx.kind, failed);
  }
}
