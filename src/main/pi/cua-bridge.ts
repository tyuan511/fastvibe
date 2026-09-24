import { app, nativeImage, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { uiText } from "../engine/ui-text";
import { readComputerSettings } from "../engine/app-settings";
import { unpackedPath } from "../engine/asar-unpacked";
import { getFastVibePaths } from "../engine/paths";
import { resolveComputerAvailability } from "@shared/computer-availability";
import type {
  ComputerAppInfo,
  ComputerError,
  ComputerErrorCode,
  ComputerPermissionStatus,
  ComputerRequest,
  ComputerResult,
} from "@shared/types";

/**
 * FastVibe's bridge to Cua Driver, the Rust engine behind the `computer_*` tools.
 *
 * The driver runs as a *private worker*: a `cua-driver` process this app spawns and
 * owns, reached over a unix socket. It began as an in-process library
 * (`CuaDriver.create`), which is simpler and needs no bundled executable — but that
 * arrangement cannot show the user anything. Every agent-cursor call is refused with
 * `facility_unavailable`, because `DriverHostOptions.cursor` is, in cua's words,
 * "Rust-only host configuration used by the standalone daemon. Language bindings
 * intentionally receive the smaller DriverOptions record." An agent moving a pointer
 * around someone's desktop with no on-screen sign of what it is doing is not a
 * trade worth ~30 MB of savings.
 *
 * What does *not* change is where the permissions come from. macOS grants Accessibility
 * and Screen Recording to a process, keyed by its code signature, and a child spawned
 * through a gateway, a terminal or `open` starts a new responsibility chain owning none
 * of them. `EmbeddedCuaDriverHost` spawns the worker directly from this process, so it
 * inherits the grants the user gave FastVibe — which is also why cua requires the spawn
 * to come from the app that holds them.
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

/**
 * A failure that carries its own remedy.
 *
 * Thrown rather than returned so every existing call site keeps working unchanged; the
 * structure rides along on the error object for the ones that know to look. A model that
 * is told only "it failed" retries the same call, and a pane that is handed only a
 * sentence can do nothing but print it.
 */
export class ComputerFailure extends Error {
  readonly detail: ComputerError;
  constructor(detail: ComputerError) {
    super(detail.message);
    this.name = "ComputerFailure";
    this.detail = detail;
  }
}

function fail(code: ComputerErrorCode, message: string, suggestedAction?: string, permissions?: ComputerPermissionStatus): never {
  throw new ComputerFailure({ code, message, suggestedAction, permissions });
}

/** Identity the worker reports in macOS permission diagnostics. Advisory only. */
const HOST_BUNDLE_ID = "dev.fastvibe.desktop";

let modulePromise: Promise<DriverModule> | null = null;
let driverPromise: Promise<Driver> | null = null;
let driver: Driver | null = null;
/** The embedded host owning the worker process, so shutdown can stop it. */
let host: ReturnType<DriverModule["EmbeddedCuaDriverHost"]["withOptions"]> | null = null;
let sessionStarted = false;
let asarShimInstalled = false;

/**
 * Point native-library resolution at the unpacked copy, because the Cua SDK opens its
 * `.dylib`/`.so`/`.dll` with a raw `dlopen` rather than through `process.dlopen`.
 *
 * `electron-builder` marks the native packages `asarUnpack`, so the library sits on disk
 * at `app.asar.unpacked/…` — but `require.resolve` still hands back the `app.asar/…`
 * path, and Electron's asar-aware `fs` makes that path *look* present. That is enough for
 * the pure-JS import to proceed and then fail at the first native call: the Rust side
 * calls `libc`'s `dlopen` directly, and the kernel answers `errno=20` (`ENOTDIR`) for a
 * path through the archive. Electron patches `process.dlopen` for `.node` addons, but
 * nothing patches the raw `dlopen` a native dependency performs itself.
 *
 * So rewrite a resolved path to its unpacked twin whenever that twin actually exists.
 * Packed JavaScript has no twin, so its resolution is untouched; the only paths this
 * moves are the ones the packaging step deliberately placed outside the archive.
 */
function installAsarNativeResolution(): void {
  if (asarShimInstalled) return;
  asarShimInstalled = true;
  const require_ = createRequire(import.meta.url);
  const Module = require_("node:module") as typeof import("node:module") & {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
  };
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
    const resolved = original.call(this, request, ...rest);
    const candidate = typeof resolved === "string" ? unpackedPath(resolved) : resolved;
    if (candidate !== resolved && existsSync(candidate)) return candidate;
    return resolved;
  };
}

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
  installAsarNativeResolution();
  modulePromise ??= import("@trycua/cua-driver").catch((error: unknown) => {
    modulePromise = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ComputerFailure({
      code: "engine_unavailable",
      message: uiText(
        `电脑操作组件未能加载：${detail}`,
        `Could not load the computer-use engine: ${detail}`,
      ),
      suggestedAction: uiText(
        "当前系统或架构可能没有对应的原生库。",
        "This OS or architecture may have no matching native library.",
      ),
    });
  });
  return modulePromise;
}

/**
 * Non-prompting permission read, for Settings and for the pre-flight check.
 *
 * Never throws: Settings has to render a row for a machine whose native engine will not
 * load at all, and an exception there would leave the page blank rather than explaining
 * that this architecture has no build.
 */
export async function computerPermissions(): Promise<ComputerPermissionStatus> {
  const availability = resolveComputerAvailability(process.platform, false);
  if (!availability.supported) {
    // Decide this before loading the optional native SDK. Unsupported platforms do not
    // ship its package, and Settings should still explain the platform cleanly.
    return {
      platform: process.platform,
      accessibility: false,
      screenRecording: false,
      ready: false,
      available: false,
      error:
        availability.kind === "local-linux"
          ? uiText(
              "Linux 下的电脑操控依赖随桌面合成器而异的组件，本应用未附带，因此未开放。",
              "Computer control on Linux depends on compositor-specific components this app does not ship, so it is not offered.",
            )
          : uiText("当前环境不支持电脑操控。", "Computer control is not supported in this environment."),
    };
  }

  let module: DriverModule;
  try {
    module = await driverModule();
  } catch (error) {
    return {
      platform: process.platform,
      accessibility: false,
      screenRecording: false,
      ready: false,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (process.platform !== "darwin") {
    // Windows needs no TCC-style grant; the driver either works or reports its own
    // platform error on first use.
    return {
      platform: process.platform,
      accessibility: true,
      screenRecording: true,
      ready: true,
      available: true,
    };
  }
  const status = module.currentMacOsPermissionStatus();
  return {
    platform: "darwin",
    accessibility: status.accessibility,
    screenRecording: status.screenRecording,
    ready: status.accessibility && status.screenRecording,
    available: true,
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
    available: true,
  };
}

/** Open the Screen Recording pane in System Settings, for a Settings-row button. */
export async function openComputerSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  const module = await driverModule();
  module.openMacOsScreenRecordingSettings();
}

/**
 * The driver object, created once.
 *
 * No permission check here on purpose. Enumerating applications needs no TCC grant, and
 * Settings lists them *before* anything has been granted — choosing what to allow is how
 * the user decides to grant at all. The grants gate actions, not the object, so that
 * check lives in `assertDrivable` on the action path.
 */
/**
 * The bundled `cua-driver` executable, which this app runs as its private worker.
 *
 * Fetched at build time by `scripts/fetch-cua-driver.mjs` and shipped outside the asar,
 * because a private worker is the only arrangement that gives the user a visible agent
 * cursor. In-process mode (`CuaDriver.create`) refuses every cursor call with
 * `facility_unavailable`: `DriverHostOptions.cursor` is "Rust-only host configuration
 * used by the standalone daemon. Language bindings intentionally receive the smaller
 * DriverOptions record." An agent driving a desktop with no on-screen sign of what it
 * is doing is the thing worth paying ~30 MB to avoid.
 */
function driverBinary(): string {
  // Packaged builds carry one slice, already named `cua-driver`; a dev tree holds both,
  // so pick the one this process can run.
  return app.isPackaged
    ? join(process.resourcesPath, "cua-driver")
    : join(__dirname, "../../resources/cua-driver", process.arch, "cua-driver");
}

/**
 * Start the private worker and connect to it.
 *
 * The worker inherits this process's Accessibility and Screen Recording grants, which
 * is why cua requires the spawn to come from the app that owns them rather than from a
 * terminal or a launcher. `EmbeddedCuaDriverHost` holds a parent-liveness pipe, so the
 * daemon cannot outlive a crash of this process.
 */
async function ensureDriver(): Promise<Driver> {
  driverPromise ??= (async () => {
    const module = await driverModule();
    const binary = driverBinary();
    if (!existsSync(binary)) {
      throw new Error(
        uiText(
          `未找到电脑操控组件（${binary}）。开发环境请先运行 pnpm fetch:cua-driver。`,
          `The computer-use engine is missing (${binary}). In development, run pnpm fetch:cua-driver first.`,
        ),
      );
    }
    const embedded = module.EmbeddedCuaDriverHost.withOptions(
      module.EmbeddedDriverHostOptions.new({
        binaryPath: binary,
        hostBundleId: HOST_BUNDLE_ID,
        // The agent cursor is the whole reason this runs as a worker instead of
        // in-process, so the host must not suppress it.
        noOverlay: false,
        // Cua Driver reports product telemetry to PostHog unless told otherwise, and
        // nothing about running it on the user's behalf implies consent to that. The
        // environment takes precedence over its persisted setting, so this holds even
        // if something else on the machine enabled it.
        environment: [module.EmbeddedEnvironmentVariable.new({ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" })],
        // No manifest or policy file is supplied, so there is nothing to pre-approve;
        // saying so explicitly keeps a future default from widening what this grants.
        approveCapabilityManifest: false,
        approveSessionPolicy: false,
        // The flag that turns off the driver's own runtime approvals. FastVibe's
        // permission sandbox is not a substitute for them, and its own default mode
        // asks nothing at all — together those would be no check anywhere.
        dangerouslyBypassApprovals: false,
        // The worker's stderr carries its telemetry notice and its own diagnostics;
        // routing it into this process's output would interleave it with the agent's.
        inheritStderr: false,
      }),
    );
    const connection = await embedded.start();
    host = embedded;
    const created = module.CuaDriver.connect(connection.socketPath);
    driver = created;
    return created;
  })().catch((error: unknown) => {
    driverPromise = null;
    driver = null;
    host = null;
    throw error;
  });
  return driverPromise;
}

/** Refuse, legibly, unless this machine has actually granted what a desktop action needs. */
async function assertDrivable(): Promise<void> {
  let permissions = await computerPermissions();
  if (!permissions.ready && permissions.available) {
    // Ask before complaining. macOS does not list an application under Privacy &
    // Security until it has actually requested the permission, so an error telling the
    // user to go flip a toggle would point them at a pane FastVibe is not in yet.
    // Requesting registers the app and surfaces the prompts; flipping the toggle stays
    // the user's decision, which is why this can still fall through to the throw.
    permissions = await requestComputerPermissions();
  }
  if (permissions.ready) return;
  if (!permissions.available) {
    fail(
      "unsupported",
      permissions.error ?? uiText("电脑操作组件不可用。", "The computer-use engine is unavailable."),
      undefined,
      permissions,
    );
  }
  // Starting to act without grants gets a stream of opaque per-call failures instead of
  // one explanation, so refuse here and say which toggle is missing.
  const missing = [
    permissions.accessibility ? "" : uiText("辅助功能", "Accessibility"),
    permissions.screenRecording ? "" : uiText("屏幕录制", "Screen Recording"),
  ].filter(Boolean).join(uiText("、", ", "));
  // The live status rides along so the UI need not ask again to know which toggle is
  // still off — the answer it would get could already differ from the one that failed.
  fail(
    "permission_required",
    uiText(`FastVibe 还没有获得「${missing}」权限。`, `FastVibe has not been granted ${missing}.`),
    uiText(
      "在 设置 › 电脑操控 点「开始授权」，按引导把浮层拖进系统设置的列表。",
      "Press Start granting in Settings › Computer control and drag the panel into the System Settings list.",
    ),
    permissions,
  );
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

/** Actions that read or replace the clipboard, which 电脑操控 gates separately. */
const CLIPBOARD_ACTIONS = new Set(["clipboard_read", "clipboard_write"]);

/**
 * Run one action, or a whole sequence, against the desktop.
 *
 * A sequence is not a convenience wrapper. Driving a GUI one tool call at a time means
 * a model round trip, a confirmation and a screenshot between every click — a dozen
 * steps of ordinary work becomes a dozen of each, and the cost shows up as latency the
 * user watches and tokens they pay for. `steps` collapses the predictable runs (click,
 * type, press Return, look) into a single call while keeping every step's result.
 *
 * It stops at the first failure and reports how far it got. Continuing past a failed
 * step would carry on typing into a window that never opened.
 */
export async function requestComputer(request: ComputerRequest): Promise<ComputerResult> {
  return serialize(async () => {
    // Read per call, not per session: a user who turns the switch off mid-run means it
    // to stop now, and a cached value would let the current run finish driving anyway.
    const settings = readComputerSettings(getFastVibePaths());
    if (!settings.enabled) {
      fail(
        "disabled",
        uiText("电脑操控尚未开启。", "Computer control is switched off."),
        uiText("在 设置 › 电脑操控 中打开「允许操作电脑」。", "Turn on \"Allow controlling the computer\" in Settings › Computer control."),
      );
    }
    const steps = request.action === "batch" ? (request.steps ?? []) : [request];
    if (steps.length === 0) {
      throw new Error(uiText("批量操作为空", "The batch contains no steps"));
    }
    // Checked across the whole sequence before any of it runs: a batch that would be
    // refused halfway leaves the desktop in a state nobody asked for.
    if (!settings.clipboard && steps.some((step) => CLIPBOARD_ACTIONS.has(step.action))) {
      fail(
        "clipboard_disabled",
        uiText("剪贴板访问尚未开启。", "Clipboard access is switched off."),
        uiText("在 设置 › 电脑操控 中打开「读写剪贴板」。", "Turn on \"Read and write the clipboard\" in Settings › Computer control."),
      );
    }
    if (steps.some((step) => step.action === "batch")) {
      throw new Error(uiText("批量操作不能嵌套", "A batch cannot contain another batch"));
    }
    await assertDrivable();
    const module = await driverModule();
    const active = await ensureDriver();
    if (!sessionStarted) {
      // A named session is what puts the labelled agent cursor on screen. Failing to
      // start one is not fatal — the driver falls back to an implicit session — so a
      // driver version that renames the call must not take the whole feature down.
      await active
        .startSession(module.StartSessionInput.new({ session: SESSION }))
        .then(async () => {
          sessionStarted = true;
          // Make Cua's click-through Agent Cursor explicit. Relying on the driver's
          // default is not enough across platforms/embedded hosts, and without this
          // the agent can act in the background with no visible pointer or badge.
          await active
            .setAgentCursorEnabled(
              module.SetAgentCursorEnabledInput.new({ session: SESSION, enabled: true }),
            )
            .catch(() => undefined);
        })
        .catch(() => undefined);
    }
    const results: ComputerResult[] = [];
    for (const [index, step] of steps.entries()) {
      // Per step rather than per call: a long sequence must not have its last action
      // cut short by a budget the first one already spent.
      const signal = AbortSignal.timeout(
        Math.max(1_000, Math.min(step.timeoutMs ?? request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000)),
      );
      // The preference is a default, not a ceiling: a call that explicitly asked for the
      // foreground has already been through the confirmation that explains what that costs.
      const resolved: ComputerRequest = {
        ...step,
        foreground: step.foreground ?? !settings.preferBackground,
      };
      try {
        const result = await dispatch(module, active, resolved, signal);
        // Named from the pid the driver actually routes to, so the app reported back
        // cannot drift from the one that was driven.
        if (resolved.pid !== undefined) {
          const app = await computerAppForPid(resolved.pid).catch(() => undefined);
          if (app) result.targetApp = { name: app.name, bundleId: app.bundleId };
        }
        results.push(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (steps.length === 1) throw error;
        // Naming the step is the whole value of the report: the model has to know which
        // of the actions it batched left the desktop where it is.
        const inner = error instanceof ComputerFailure ? error.detail : undefined;
        throw new ComputerFailure({
          code: "batch_step_failed",
          message: uiText(
            `第 ${index + 1}/${steps.length} 步（${step.action}）失败：${reason}${summarise(results, steps)}`,
            `Step ${index + 1}/${steps.length} (${step.action}) failed: ${reason}${summarise(results, steps)}`,
          ),
          // The step's own remedy is what the caller can act on; the batch wrapper only
          // says where it stopped.
          suggestedAction: inner?.suggestedAction,
          permissions: inner?.permissions,
        });
      }
    }
    return steps.length === 1 ? results[0] : merge(results, steps);
  });
}

/** What a failed batch got through, so the model can reason about where it stopped. */
function summarise(done: ComputerResult[], steps: ComputerRequest[]): string {
  if (done.length === 0) return "";
  const names = steps.slice(0, done.length).map((step) => step.action).join(" → ");
  return uiText(`（已完成：${names}）`, ` (completed: ${names})`);
}

/**
 * One result for a whole sequence.
 *
 * Every step's text is kept and labelled, because a batch ending in a screenshot is the
 * normal shape and the steps before it explain what the screenshot shows. Images are
 * concatenated in order for the same reason.
 */
function merge(results: ComputerResult[], steps: ComputerRequest[]): ComputerResult {
  const text = results
    .map((result, index) => {
      const body = result.text?.trim();
      return body ? `[${index + 1}/${results.length}] ${steps[index].action}: ${body}` : `[${index + 1}/${results.length}] ${steps[index].action}: ok`;
    })
    .join("\n");
  return {
    text,
    images: results.flatMap((result) => result.images),
    structured: results.find((result) => result.structured)?.structured,
    targetApp: results.find((result) => result.targetApp)?.targetApp,
  };
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

/**
 * What a screenshot is allowed to cost before it reaches a model.
 *
 * The dimension governs what the model pays for: vision models resize what they are
 * given to their own working resolution — around 1568px on the long edge for the current
 * generation — so a 3360px Retina capture spends four and a half times the pixels that
 * survive. The byte ceiling governs everything else the image touches: the request body,
 * the transcript it is stored in, and every later turn that carries it there.
 *
 * The byte ceiling is the one that bites. A transcript resends its whole history, so
 * screenshots accumulate across turns, and a provider answers the sum with a 413 rather
 * than a message about any single image.
 *
 * ZCode budgets images the same way and adds a token ceiling derived from base64 length.
 * That is deliberately not copied: for an image the proxy is wrong by an order of
 * magnitude — vision tokens scale with pixel area, not encoded size — so it would
 * over-compress to satisfy a number that never described screenshots.
 */
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 200 * 1024;
/** What Cua's own Claude-Code compatibility mode encodes screenshots at. */
const JPEG_QUALITY = 85;
/** Tried in turn when the first encode is still over budget. */
const FALLBACK_EDGES = [1024, 768];

/**
 * Bring a driver screenshot inside that budget.
 *
 * JPEG first. An earlier version preferred PNG on the reasoning that the model is
 * reading UI text and compression artefacts land hardest on small glyphs — measured, the
 * same frame is 604 KB as PNG and 70 KB as JPEG at 85, and the PNG-first version sent
 * enough bytes to earn a 413. Cua encodes screenshots the same way in its own
 * compatibility path. A screenshot too large to send is worth nothing at all, which
 * settles the trade the other way.
 *
 * Failure is never fatal: an image that cannot be decoded or re-encoded passes through
 * untouched, because an expensive screenshot still beats a failed action.
 */
function budgetImage(image: { mimeType: string; data: string }): { mimeType: string; data: string } {
  try {
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
    const { width, height } = decoded.getSize();
    if (width === 0 || height === 0) return image;

    for (const edge of [MAX_IMAGE_EDGE, ...FALLBACK_EDGES]) {
      const longest = Math.max(width, height);
      // `resize` keeps the aspect ratio when only one dimension is given.
      const scaled =
        longest <= edge
          ? decoded
          : width >= height
            ? decoded.resize({ width: edge, quality: "good" })
            : decoded.resize({ height: edge, quality: "good" });
      // Both, and keep whichever is smaller. JPEG wins by a wide margin on a real
      // desktop — measured, one frame is 604 KB as PNG and 70 KB as JPEG — but an image
      // that is mostly high-frequency detail inverts that, and sending the larger of two
      // encodings we already hold would be a straightforward waste.
      const best = smaller(scaled.toJPEG(JPEG_QUALITY), "image/jpeg", scaled.toPNG(), "image/png");
      if (!best) break;
      // The last rung: send it rather than nothing, because a large screenshot is still
      // a screenshot the caller can act on.
      if (best.bytes.length <= MAX_IMAGE_BYTES || edge === FALLBACK_EDGES[FALLBACK_EDGES.length - 1]) {
        return { mimeType: best.mimeType, data: best.bytes.toString("base64") };
      }
    }
    return image;
  } catch {
    return image;
  }
}

/** The smaller of two encodings, ignoring any that failed to produce bytes. */
function smaller(
  a: Buffer,
  aType: string,
  b: Buffer,
  bType: string,
): { bytes: Buffer; mimeType: string } | undefined {
  if (a.length === 0 && b.length === 0) return undefined;
  if (a.length === 0) return { bytes: b, mimeType: bType };
  if (b.length === 0) return { bytes: a, mimeType: aType };
  return a.length <= b.length ? { bytes: a, mimeType: aType } : { bytes: b, mimeType: bType };
}

function budgetImages(images: Array<{ mimeType: string; data: string }>): Array<{ mimeType: string; data: string }> {
  return images.map(budgetImage);
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
    images: budgetImages(result.images.map((image) => ({ mimeType: image.mimeType, data: image.dataBase64 }))),
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
          // What the element can do and whether it is on: the decision loop reads a
          // checkbox's state and an element's AXPress off these (computer_task).
          ...(element.selected !== undefined ? { selected: element.selected } : {}),
          ...(element.actions?.length ? { actions: element.actions } : {}),
          frame: element.frame,
        }));
      // Static text usually carries no token — it cannot be acted on — but it is what the
      // window *says*, which a model deciding the next step needs as much as the controls.
      const texts = (output.elements ?? [])
        .filter((element) => !element.elementToken && /statictext|^text$/i.test(element.role.replace(/^AX/, "")))
        .map((element) => (element.value || element.label || "").trim())
        .filter(Boolean);
      return {
        text: JSON.stringify(
          {
            appName: output.appName,
            windowTitle: output.windowTitle,
            truncated: output.truncated ?? false,
            truncationReason: output.truncationReason,
            elements,
            ...(texts.length ? { texts } : {}),
          },
          null,
          2,
        ),
        images: budgetImages(output.images.map((image) => ({ mimeType: image.mimeType, data: image.dataBase64 }))),
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
  const worker = host;
  driverPromise = null;
  driver = null;
  host = null;
  sessionStarted = false;
  if (active) {
    await active.shutdown().catch(() => undefined);
    const destroyable = active as { uniffiDestroy?: () => void };
    if (typeof destroyable.uniffiDestroy === "function") destroyable.uniffiDestroy();
  }
  // After the client, never before: `stop()` cancels an in-progress start and is
  // idempotent, but tearing the process down under a live client loses whatever it
  // was in the middle of.
  if (worker) {
    await worker.stop().catch(() => undefined);
    const destroyable = worker as { uniffiDestroy?: () => void };
    if (typeof destroyable.uniffiDestroy === "function") destroyable.uniffiDestroy();
  }
}

/**
 * Running applications, for the Settings allow-list picker.
 *
 * Deliberately not routed through `requestComputer`: that path enforces the master
 * switch and the grants, and Settings has to list apps before either is in place —
 * choosing what to allow is how the user decides to turn it on at all.
 */
export async function listComputerApps(): Promise<ComputerAppInfo[]> {
  const module = await driverModule();
  const active = await ensureDriver();
  const output = await active.listApps(module.ListAppsInput.new({}));
  return output.apps
    .filter((item) => item.running && item.name)
    .map((item) => ({ pid: item.pid, name: item.name, bundleId: item.bundleId, active: item.active }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which application a pid belongs to, for the confirmation dialog and the allow-list.
 *
 * Cached for a few seconds: the permission sandbox asks this on every action, and a
 * process's identity does not change under a pid within one interaction. A miss simply
 * re-enumerates.
 */
let appCache: { at: number; byPid: Map<number, ComputerAppInfo> } | null = null;
const APP_CACHE_MS = 5_000;

export async function computerAppForPid(pid: number): Promise<ComputerAppInfo | undefined> {
  if (!appCache || Date.now() - appCache.at > APP_CACHE_MS) {
    const apps = await listComputerApps().catch(() => [] as ComputerAppInfo[]);
    appCache = { at: Date.now(), byPid: new Map(apps.map((item) => [item.pid, item])) };
  }
  return appCache.byPid.get(pid);
}

/**
 * Start a native drag carrying FastVibe's own application bundle.
 *
 * This is the macOS grant flow that actually works. The Privacy & Security list accepts
 * an application dropped onto it, and dropping is the one gesture that does not require
 * the user to find this app inside a file picker rooted somewhere else. `startDrag`
 * must be called on the sender's `webContents`, from Main, in response to a real
 * dragstart — the renderer cannot produce a file drag on its own.
 */
export function startComputerDrag(contents: WebContents): void {
  if (process.platform !== "darwin") return;
  const bundle = appBundlePath();
  if (!bundle) throw new Error(uiText("未能定位 FastVibe 应用包", "Could not locate the FastVibe application bundle"));
  const iconFile = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(__dirname, "../../resources/icon.png");
  const icon = nativeImage.createFromPath(iconFile);
  contents.startDrag({
    file: bundle,
    // An empty image makes the drag invisible and the gesture unexplainable, so fall
    // back to a blank 1×1 only when the icon file is genuinely missing.
    icon: icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 64, height: 64 }),
  });
}

/** `/Applications/FastVibe.app`, derived from the running executable. */
function appBundlePath(): string | null {
  const exe = app.getPath("exe");
  const marker = exe.indexOf(".app/Contents/MacOS/");
  if (marker === -1) return null;
  return exe.slice(0, marker + ".app".length);
}

/**
 * Drop the worker so the next action starts a fresh one.
 *
 * macOS hands a process its TCC answers when it starts; a worker spawned before the
 * user granted Screen Recording keeps being told "no" for as long as it lives, however
 * many times the tools ask. Cua's own guidance is to call `embedded.restart()` and
 * reconnect on the new generation — this does the same thing by letting the existing
 * lazy start do it, which costs one cold start on the next action and avoids a second
 * reconnection path that would only ever run in this one situation.
 *
 * It is why granting no longer asks the user to restart FastVibe: the process that has
 * to be restarted is the worker, and it is ours.
 */
export async function resetComputerWorker(): Promise<void> {
  if (!driverPromise && !host) return;
  await shutdownComputer();
}

/**
 * Exposed for the resource-loaded extension, which cannot import FastVibe internals —
 * it is loaded by path from outside the asar, the same arrangement `browser-bridge` uses.
 */
export function installComputerGlobal(): void {
  (globalThis as Record<string, unknown>).__fastvibeComputerRequest = requestComputer;
  // The permission sandbox turns a pid into an application name for its dialog, and
  // matches 始终允许的应用 against the same identity.
  (globalThis as Record<string, unknown>).__fastvibeComputerAppForPid = computerAppForPid;
  app.once("will-quit", () => {
    void shutdownComputer();
  });
}
