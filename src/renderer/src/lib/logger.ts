type LogLevel = "debug" | "info" | "warn" | "error";

const MAX_MESSAGE_CHARS = 16_384;
const INSTALLED = "__fastvibeLoggerInstalled";

/**
 * Capture the renderer's console and window errors, and ship them to Main over
 * `app:log`. The renderer cannot write files (contextIsolation, no Node), so the
 * only durable copy lives in `logs/renderer.log`.
 *
 * Original console methods still run, so DevTools keeps its own view. Failures
 * to send (preview, a missing preload) are swallowed — the line already printed.
 */
export function installRendererLogger(): void {
  // HMR re-evaluates this module, but wrapping console twice would duplicate every line.
  if (Reflect.get(window, INSTALLED)) return;
  Reflect.set(window, INSTALLED, true);

  const originals = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.debug = (...args: unknown[]) => {
    originals.debug(...args);
    forward("debug", args);
  };
  console.log = (...args: unknown[]) => {
    originals.log(...args);
    forward("info", args);
  };
  console.info = (...args: unknown[]) => {
    originals.info(...args);
    forward("info", args);
  };
  console.warn = (...args: unknown[]) => {
    originals.warn(...args);
    forward("warn", args);
  };
  console.error = (...args: unknown[]) => {
    originals.error(...args);
    forward("error", args);
  };

  window.addEventListener("error", (event) => {
    forward("error", [
      `uncaught ${event.message}`,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "",
      event.error,
    ]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    forward("error", ["unhandledrejection", event.reason]);
  });

  forward("info", ["renderer ready"]);
}

/**
 * Report a renderer error React caught in an error boundary.
 *
 * A throw handled by a boundary never reaches `window.onerror`, so without this the
 * crash that matters most — the one that unmounted the tree — would be the only one
 * missing from `logs/renderer.log`.
 */
export function logError(message: string): void {
  console.error(message);
}

function forward(level: LogLevel, args: unknown[]): void {
  const message = args.map(formatArg).join(" ").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return;
  try {
    window.fastvibe.app.log({ level, message });
  } catch {
    // Preview / missing preload: the original console line already printed.
  }
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack?.trim() || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
