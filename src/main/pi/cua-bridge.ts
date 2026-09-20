import { app } from "electron";
import { uiText } from "../engine/ui-text";
import type { ComputerPermissionStatus, ComputerRequest, ComputerResult } from "@shared/types";

/**
 * FastVibe's bridge to Cua Driver, the Rust engine behind the `computer_*` tools.
 *
 * Unlike `browser-bridge`, nothing here crosses a process boundary: the driver is a
 * native library loaded *into the Electron main process* (`CuaDriver.create(undefined)`,
 * no daemon, no socket). That is not an optimisation — it is the only arrangement macOS
 * accepts. Accessibility and Screen Recording are granted to a *process*, keyed by its
 * code signature, and a child spawned through a gateway, a terminal or `open` starts a
 * new responsibility chain that owns none of this app's grants. Running in-process means
 * the grants the user gave FastVibe are the grants the driver acts under.
 *
 * The corollary is that a build signed with an unstable identity cannot hold those grants
 * across an update, which is why this feature is gated behind the Developer ID work in
 * `electron-builder.yml` rather than the other way round.
 */

/** Loaded lazily; see `driverModule()`. */
type DriverModule = typeof import("@trycua/cua-driver");
/** The driver object itself. `CuaDriver.create` returns the structural interface. */
type Driver = Awaited<ReturnType<DriverModule["CuaDriver"]["create"]>>;

/**
 * The session label Cua paints under the agent cursor while it is driving.
 *
 * Deliberately the product name and not the conversation id: this badge is the user's
 * one on-screen cue that something other than their own hand is moving the pointer, and
 * a UUID reads as a glitch rather than as an explanation.
 */
const SESSION = "FastVibe";

/** Any single desktop action that has not answered by now is not going to. */
const DEFAULT_TIMEOUT_MS = 30_000;

let modulePromise: Promise<DriverModule> | null = null;
let driverPromise: Promise<Driver> | null = null;
let driver: Driver | null = null;
let sessionStarted = false;

/**
 * Load the native bindings, once.
 *
 * The import is dynamic because the package resolves a ~50 MB platform-specific
 * `.dylib`/`.so`/`.dll` at import time. A user on a platform with no matching native
 * package — or a build whose other-architecture package was filtered out at packaging
 * time — must get a disabled feature and a legible message, not a main process that
 * throws before the first window opens.
 */
async function driverModule(): Promise<DriverModule> {
  modulePromise ??= import("@trycua/cua-driver").catch((error: unknown) => {
    modulePromise = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      uiText(
        `电脑操作组件未能加载（当前系统或架构可能没有对应的原生库）：${detail}`,
        `Could not load the computer-use engine (this OS/architecture may have no native library): ${detail}`,
      ),
    );
  });
  return modulePromise;
}

/** Non-prompting permission read, for Settings and for the pre-flight check. */
export async function computerPermissions(): Promise<ComputerPermissionStatus> {
  if (process.platform !== "darwin") {
    // Windows and Linux need no TCC-style grant; the driver either works or reports
    // its own platform error on first use.
    return { platform: process.platform, accessibility: true, screenRecording: true, ready: true };
  }
  const module = await driverModule();
  const status = module.currentMacOsPermissionStatus();
  return {
    platform: "darwin",
    accessibility: status.accessibility,
    screenRecording: status.screenRecording,
    ready: status.accessibility && status.screenRecording,
  };
}

/**
 * Ask macOS for the grants, which shows the system prompts.
 *
 * The prompt only *registers* the app in System Settings; the user still has to flip the
 * toggle. So a caller that gets `ready: false` back has not failed — it has started a
 * flow that completes outside this app.
 */
export async function requestComputerPermissions(): Promise<ComputerPermissionStatus> {
  if (process.platform !== "darwin") return computerPermissions();
  const module = await driverModule();
  const status = module.requestMacOsPermissions();
  if (!status.screenRecording) {
    // Screen Recording has no in-place prompt on recent macOS: the only way through is
    // the Settings pane, so open it rather than leaving the user to find it. Failing to
    // open a settings pane must not turn a partial grant into a thrown error.
    try {
      module.openMacOsScreenRecordingSettings();
    } catch {
      // The status below still tells the caller what is missing.
    }
  }
  return {
    platform: "darwin",
    accessibility: status.accessibility,
    screenRecording: status.screenRecording,
    ready: status.accessibility && status.screenRecording,
  };
}

/** Open the Screen Recording pane in System Settings, for a Settings-row button. */
export async function openComputerSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  const module = await driverModule();
  module.openMacOsScreenRecordingSettings();
}

async function ensureDriver(): Promise<Driver> {
  driverPromise ??= (async () => {
    let permissions = await computerPermissions();
    if (!permissions.ready) {
      // Ask before complaining. macOS does not list an application under Privacy &
      // Security until it has actually requested the permission, so an error telling the
      // user to go flip a toggle would point them at a pane FastVibe is not in yet.
      // Requesting registers the app and surfaces the prompts; flipping the toggle stays
      // the user's decision, which is why this can still fall through to the throw.
      permissions = await requestComputerPermissions();
    }
    if (!permissions.ready) {
      // Starting the driver without grants gets a stream of opaque per-call failures
      // instead of one explanation, so refuse here and say which toggle is missing.
      const missing = [
        permissions.accessibility ? "" : uiText("辅助功能", "Accessibility"),
        permissions.screenRecording ? "" : uiText("屏幕录制", "Screen Recording"),
      ].filter(Boolean).join(uiText("、", ", "));
      throw new Error(
        uiText(
          `FastVibe 还没有获得「${missing}」权限，无法操作电脑。已经打开系统设置 › 隐私与安全性，请在其中把 FastVibe 的开关打开后重试。`,
          `FastVibe has not been granted ${missing}, so it cannot control the computer. System Settings › Privacy & Security has been opened — switch FastVibe on there and try again.`,
        ),
      );
    }
    const module = await driverModule();
    const created = module.CuaDriver.create(undefined);
    driver = created;
    return created;
  })().catch((error: unknown) => {
    driverPromise = null;
    driver = null;
    throw error;
  });
  return driverPromise;
}

/**
 * Serialises every desktop action.
 *
 * Two conversations sharing one physical desktop is not a concurrency problem the driver
 * can solve for us: interleaved clicks land in whichever window happens to be frontmost
 * at that instant, and the resulting screenshot belongs to neither caller. A queue makes
 * the interleaving impossible rather than merely unlikely.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** `bigint` cannot survive a JSON tool schema, so window ids travel as decimal strings. */
function windowId(value: string | undefined): bigint {
  if (!value) throw new Error(uiText("缺少 windowId", "windowId is required"));
  try {
    return BigInt(value);
  } catch {
    throw new Error(uiText(`windowId 不是合法的整数：${value}`, `windowId is not an integer: ${value}`));
  }
}

export async function requestComputer(request: ComputerRequest): Promise<ComputerResult> {
  return serialize(async () => {
    const module = await driverModule();
    const active = await ensureDriver();
    if (!sessionStarted) {
      // A named session is what puts the labelled agent cursor on screen. Failing to
      // start one is not fatal — the driver falls back to an implicit session — so a
      // driver version that renames the call must not take the whole feature down.
      await active
        .startSession(module.StartSessionInput.new({ session: SESSION }))
        .then(() => {
          sessionStarted = true;
        })
        .catch(() => undefined);
    }
    const signal = AbortSignal.timeout(Math.max(1_000, Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000)));
    return dispatch(module, active, request, signal);
  });
}

/**
 * The scope an action is delivered into.
 *
 * A window-scoped action is the one that can be delivered in the background, so naming a
 * window is worth doing wherever the caller can. `"primary"` is the display id Cua's own
 * examples use for the whole-desktop fallback.
 */
function target(module: DriverModule, request: ComputerRequest) {
  if (request.pid !== undefined && request.windowId !== undefined) {
    return new module.ActionTarget.Window({ pid: request.pid, windowId: windowId(request.windowId) });
  }
  return new module.ActionTarget.Desktop({ displayId: "primary" });
}

/**
 * The same scope, but omitted rather than defaulted when no window was named.
 *
 * `target` is optional on the keyboard and scroll inputs, and leaving it unset lets the
 * driver use the session's own desktop scope instead of this code asserting a display it
 * never enumerated.
 */
function optionalTarget(module: DriverModule, request: ComputerRequest) {
  if (request.pid !== undefined && request.windowId !== undefined) {
    return new module.ActionTarget.Window({ pid: request.pid, windowId: windowId(request.windowId) });
  }
  return undefined;
}

function toolResult(result: {
  text: string;
  images: Array<{ mimeType: string; dataBase64: string }>;
  structuredJson?: string;
  isError: boolean;
  errorCode?: string;
}): ComputerResult {
  if (result.isError) {
    throw new Error(result.text || result.errorCode || uiText("电脑操作失败", "Computer action failed"));
  }
  return {
    text: result.text,
    images: result.images.map((image) => ({ mimeType: image.mimeType, data: image.dataBase64 })),
    structured: result.structuredJson,
  };
}

async function dispatch(
  module: DriverModule,
  active: Driver,
  request: ComputerRequest,
  signal: AbortSignal,
): Promise<ComputerResult> {
  const opts = { signal };
  switch (request.action) {
    case "screenshot":
      return toolResult(await active.getDesktopState(module.GetDesktopStateInput.new({ session: SESSION }), opts));

    case "list_apps": {
      const output = await active.listApps(module.ListAppsInput.new({}), opts);
      return {
        text: JSON.stringify(
          output.apps.map((item) => ({
            pid: item.pid,
            name: item.name,
            active: item.active,
            bundleId: item.bundleId,
          })),
          null,
          2,
        ),
        images: [],
      };
    }

    case "list_windows": {
      const output = await active.listWindows(
        module.ListWindowsInput.new({ pid: request.pid, onScreenOnly: request.onScreenOnly ?? true }),
        opts,
      );
      return {
        text: JSON.stringify(
          output.windows.map((item) => ({
            // Stringified on the way out for the same reason it is parsed on the way in.
            windowId: item.windowId.toString(),
            pid: item.pid,
            appName: item.appName,
            title: item.title,
            bounds: item.bounds,
            minimized: item.minimized,
          })),
          null,
          2,
        ),
        images: [],
      };
    }

    case "window_state": {
      const output = await active.getWindowState(
        module.GetWindowStateInput.new({
          pid: request.pid ?? 0,
          windowId: windowId(request.windowId),
          session: SESSION,
          query: request.query,
          includeAccessibilityTree: true,
          includeScreenshot: request.includeScreenshot ?? false,
          maxElements: request.maxElements ?? 200,
        }),
        opts,
      );
      const elements = (output.elements ?? [])
        .filter((element) => element.elementToken)
        .map((element) => ({
          token: element.elementToken,
          role: element.role,
          label: element.label,
          value: element.value,
          enabled: element.enabled,
          frame: element.frame,
        }));
      return {
        text: JSON.stringify(
          {
            appName: output.appName,
            windowTitle: output.windowTitle,
            truncated: output.truncated ?? false,
            truncationReason: output.truncationReason,
            elements,
          },
          null,
          2,
        ),
        images: output.images.map((image) => ({ mimeType: image.mimeType, data: image.dataBase64 })),
      };
    }

    case "click": {
      const position = request.elementToken
        ? new module.ClickPosition.Element({ elementToken: request.elementToken })
        : new module.ClickPosition.Coordinates({ x: request.x ?? 0, y: request.y ?? 0 });
      const button =
        request.button === "right"
          ? module.ClickButton.Right
          : request.button === "middle"
            ? module.ClickButton.Middle
            : module.ClickButton.Left;
      // Background delivery is the default because it does not steal focus from whatever
      // the user is doing. A route that cannot be delivered in the background must NOT be
      // silently retried in the foreground — that is how an agent grabs a keyboard the
      // user is typing into — so the refusal is surfaced and the caller opts in per call.
      const result = await active.click(
        module.ClickInput.new({
          target: target(module, request),
          position,
          deliveryMode: request.foreground ? module.InputDeliveryMode.Foreground : module.InputDeliveryMode.Background,
          session: SESSION,
          button,
          count: request.count ?? 1,
        }),
        opts,
      );
      return { text: JSON.stringify(result, replacer, 2), images: [] };
    }

    case "type":
      return toolResult(
        await active.typeText(
          module.TypeTextInput.new({
            text: request.text ?? "",
            target: optionalTarget(module, request),
            session: SESSION,
          }),
          opts,
        ),
      );

    case "key":
      return toolResult(
        await active.pressKey(
          module.PressKeyInput.new({
            key: request.key ?? "",
            target: optionalTarget(module, request),
            session: SESSION,
            modifiers: request.modifiers,
          }),
          opts,
        ),
      );

    case "hotkey":
      return toolResult(
        await active.hotkey(
          module.HotkeyInput.new({
            keys: request.keys ?? [],
            target: optionalTarget(module, request),
            session: SESSION,
          }),
          opts,
        ),
      );

    case "scroll": {
      const direction =
        request.direction === "up"
          ? module.ScrollDirection.Up
          : request.direction === "left"
            ? module.ScrollDirection.Left
            : request.direction === "right"
              ? module.ScrollDirection.Right
              : module.ScrollDirection.Down;
      return toolResult(
        await active.scroll(
          module.ScrollInput.new({
            x: request.x ?? 0,
            y: request.y ?? 0,
            direction,
            target: optionalTarget(module, request),
            session: SESSION,
            amount: request.amount === undefined ? undefined : BigInt(Math.trunc(request.amount)),
          }),
          opts,
        ),
      );
    }

    case "menu":
      return toolResult(
        await active.invokeMenu(
          module.InvokeMenuInput.new({
            pid: request.pid ?? 0,
            windowId: windowId(request.windowId),
            path: request.path ?? [],
            session: SESSION,
          }),
          opts,
        ),
      );

    case "clipboard_read":
      return toolResult(await active.clipboardRead(module.ClipboardReadInput.new({ includeText: true, session: SESSION }), opts));

    case "clipboard_write":
      return toolResult(
        await active.clipboardWrite(
          module.ClipboardWriteInput.new({ text: request.text ?? "", session: SESSION }),
          opts,
        ),
      );

    default:
      throw new Error(uiText(`未知的电脑操作：${request.action}`, `Unknown computer action: ${request.action}`));
  }
}

/** `JSON.stringify` throws on the `bigint`s the driver returns inside action results. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Release the driver.
 *
 * `shutdown()` closes admission and drains what is already running; `uniffiDestroy()`
 * then releases the binding handle. Doing the second without awaiting the first is how a
 * half-finished click outlives the object that owns it.
 */
export async function shutdownComputer(): Promise<void> {
  const active = driver;
  driverPromise = null;
  driver = null;
  sessionStarted = false;
  if (!active) return;
  await active.shutdown().catch(() => undefined);
  const destroyable = active as { uniffiDestroy?: () => void };
  if (typeof destroyable.uniffiDestroy === "function") destroyable.uniffiDestroy();
}

const BIND_KEY = "__fastvibeComputerConversationId";
let bindTail: Promise<unknown> = Promise.resolve();

/**
 * Stamp the conversation that is about to load `computer-use`, so the extension factory
 * can close over it — the same hand-off `bindBrowserConversation` performs, serialised
 * for the same reason: factories run during `resourceLoader.reload()`, and two sessions
 * created at once would otherwise share one mutating global.
 */
export function bindComputerConversation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const run = bindTail.then(async () => {
    const g = globalThis as Record<string, unknown>;
    const previous = g[BIND_KEY];
    g[BIND_KEY] = conversationId;
    try {
      return await fn();
    } finally {
      g[BIND_KEY] = previous;
    }
  });
  bindTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Exposed for the resource-loaded extension, which cannot import FastVibe internals —
 * it is loaded by path from outside the asar, the same arrangement `browser-bridge` uses.
 */
export function installComputerGlobal(): void {
  (globalThis as Record<string, unknown>).__fastvibeComputerRequest = requestComputer;
  app.once("will-quit", () => {
    void shutdownComputer();
  });
}
