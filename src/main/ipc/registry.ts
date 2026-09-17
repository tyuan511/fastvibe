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

/**
 * Run one call. Awaited here so both transports see the same thing: a value, or a
 * throw — never a handler's un-awaited promise leaking past the boundary.
 */
export async function dispatch(channel: string, payload: unknown, ctx: CallerContext): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`unknown method: ${channel}`);
  return await handler(payload, ctx);
}
