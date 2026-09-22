import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;
import { Ipc, type AppUpdateState } from "@shared/ipc";
import { broadcast } from "./ipc/broadcast";
import { handle } from "./ipc/registry";
import { presentNotification, readNotificationSettings } from "./engine/notifications";
import { notificationEnabled } from "@shared/notifications";
import { uiText } from "./engine/ui-text";
import { shouldRecheckBeforeDownload } from "./update-refresh";

const CHECK_DELAY_MS = 8_000;
/**
 * Background re-checks after the launch one, for as long as the app runs.
 *
 * This is also the interval a *found* version is revisited on — see `update-refresh.ts`
 * for why an `available` notice is not simply left alone — so it wants to be far shorter
 * than the hour or so it takes a superseded release to matter. Ten minutes bounds how
 * long the screen can name a version that is no longer the newest.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Squirrel.Mac (electron-updater's native installer) only accepts a Developer ID
 * Apple trusts. A homemade/ad-hoc signature fails SecStaticCodeCheckValidity, so
 * unsigned Mac builds replace the .app after quit instead of calling quitAndInstall.
 */
const MAC_INSTALL_SCRIPT = [
  "set -eu",
  'pid="$1"',
  'zip="$2"',
  'app="$3"',
  'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
  "sleep 0.4",
  'tmp="$(mktemp -d -t fastvibe-update)"',
  'trap \'rm -rf "$tmp"\' EXIT',
  'ditto -x -k "$zip" "$tmp"',
  'new_app=""',
  'for candidate in "$tmp"/*.app "$tmp"/*/*.app; do',
  '  if [ -d "$candidate" ]; then new_app="$candidate"; break; fi',
  "done",
  'if [ -z "$new_app" ] || [ ! -d "$new_app" ]; then exit 1; fi',
  'xattr -cr "$new_app" || true',
  'old="${app}.old"',
  'staging="${app}.new"',
  'rm -rf "$old" "$staging"',
  'ditto "$new_app" "$staging"',
  'xattr -cr "$staging" || true',
  'mv "$app" "$old"',
  'if mv "$staging" "$app"; then rm -rf "$old"; else mv "$old" "$app" || true; exit 1; fi',
  'xattr -cr "$app" 2>/dev/null || osascript -e "do shell script \\"xattr -cr \\" & quoted form of \\"$app\\" with administrator privileges"',
  // `open` re-applies Gatekeeper on unsigned apps; launch the binary instead.
  'exe="$app/Contents/MacOS/$(basename "$app" .app)"',
  'if [ -x "$exe" ]; then nohup "$exe" >/dev/null 2>&1 & else open "$app"; fi',
].join("\n");

let windows: () => Iterable<BrowserWindow> = () => [];
/** Bringing the window back for an update notice; the same one Main uses. */
let createWindow: () => void = () => undefined;
let state: AppUpdateState = {
  status: "idle",
  currentVersion: "0.0.0",
};
let pendingInstall = false;
let firstCheckTimer: NodeJS.Timeout | undefined;
let repeatCheckTimer: NodeJS.Timeout | undefined;
let scheduleEnabled: boolean | null = null;
let manualCheck = false;
let downloadedFile: string | undefined;
/** When the last check answered, epoch ms; 0 when none has. See `update-refresh.ts`. */
let lastCheckedAt = 0;

function setState(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch };
  broadcast(Ipc.updateState, state);
}

function notesOf(info: UpdateInfo): string | undefined {
  const raw = info.releaseNotes;
  if (typeof raw === "string") {
    const text = raw.trim();
    return text || undefined;
  }
  if (Array.isArray(raw)) {
    const text = raw
      .map((item) => (typeof item.note === "string" ? item.note : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

function notifyDownloaded(version: string): void {
  const focused = [...windows()].some((window) => !window.isDestroyed() && window.isFocused());
  if (focused) return;
  // 系统通知 → 应用更新 (设置 → 通用), read here rather than cached so turning the
  // switch off lands at the next check instead of at the next launch.
  if (!notificationEnabled(readNotificationSettings(), "notifyUpdate")) return;
  presentNotification(
    {
      setting: "notifyUpdate",
      title: "FastVibe",
      body: uiText(`版本 ${version} 已下载，重启即可更新。`, `Version ${version} is downloaded. Restart to update.`),
    },
    { windows, createWindow },
  );
}

function macAppBundle(): string | null {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  const bundle = join(process.execPath, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

function canReplaceMacApp(): { ok: true; bundle: string } | { ok: false; error: string } {
  const bundle = macAppBundle();
  if (!bundle) return { ok: false, error: "当前不是可更新的打包应用" };
  if (bundle.startsWith("/Volumes/")) {
    return { ok: false, error: "请先将 FastVibe 拖到「应用程序」文件夹，再安装更新" };
  }
  try {
    accessSync(bundle, constants.W_OK);
  } catch {
    return { ok: false, error: "没有权限替换当前应用，请把它放到「应用程序」文件夹后再更新" };
  }
  return { ok: true, bundle };
}

function spawnMacInstaller(zipPath: string, appBundle: string): void {
  if (!existsSync(zipPath)) return;
  spawn("/bin/bash", ["-c", MAC_INSTALL_SCRIPT, "fastvibe-update", String(process.pid), zipPath, appBundle], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function checkForUpdates(manual: boolean): Promise<AppUpdateState> {
  if (!app.isPackaged) return state;
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (manual) {
      setState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        progress: undefined,
      });
    }
  } finally {
    manualCheck = false;
  }
  return state;
}

async function downloadUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged) return state;
  // Already moving, or already on disk: the click is a repeat (a second window, a fast
  // double press), not a second download.
  if (state.status === "downloading" || state.status === "downloaded") return state;
  // `downloadUpdate()` downloads the version the *last check* resolved — the SDK caches
  // the metadata and never re-reads the feed — so a notice the user has been looking at
  // can already be superseded. Installing it would finish on an old release, and the app
  // would relaunch straight into 更新 again for the one that landed meanwhile. So a stale
  // notice is re-read first; a fresh one is trusted, since every press paying a round trip
  // before the progress bar moves is its own cost. See `update-refresh.ts`.
  const known = state.availableVersion;
  if (shouldRecheckBeforeDownload({ version: known, checkedAt: lastCheckedAt, now: Date.now() })) {
    setState({ status: "checking", progress: undefined, error: undefined });
    const next = await checkForUpdates(true);
    // The release was withdrawn, or the check failed (`checkForUpdates` has already put
    // the reason on the state) — either way there is nothing to download.
    if (next.status !== "available" || !next.availableVersion) return state;
    // A *different* version is on offer now. Downloading is the user's confirmation of
    // one version, notes included, so the new one goes back to them to look at rather
    // than being downloaded in place of the one they clicked.
    if (known && next.availableVersion !== known) return state;
  }
  // The provider resolves the blockmap and may diff against a cached archive before
  // a single byte moves, so the first `download-progress` can be seconds away. Without
  // this the click has no visible effect at all until then; `progress: undefined` is how
  // the renderer tells 「已开始但还没有进度」 from a real percentage.
  setState({ status: "downloading", progress: undefined, error: undefined });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setState({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      progress: undefined,
    });
  }
  return state;
}

/**
 * After engine teardown: install a downloaded update.
 * Windows/Linux use electron-updater. macOS swaps the .app (no Developer ID).
 */
export function applyPendingInstall(): boolean {
  if (process.platform === "darwin") {
    if (state.status === "downloaded" && downloadedFile) {
      const check = canReplaceMacApp();
      if (check.ok) spawnMacInstaller(downloadedFile, check.bundle);
    }
    return false;
  }
  if (!pendingInstall) return false;
  autoUpdater.quitAndInstall();
  return true;
}

export function registerUpdater(getWindows: () => Iterable<BrowserWindow>, openWindow: () => void): void {
  windows = getWindows;
  createWindow = openWindow;
  state = {
    status: app.isPackaged ? "idle" : "disabled",
    currentVersion: app.getVersion(),
  };

  handle(Ipc.updateGetState, () => state);
  handle(Ipc.updateCheck, () => checkForUpdates(true));
  handle(Ipc.updateDownload, () => downloadUpdate());
  handle(Ipc.updateInstall, () => {
    if (state.status !== "downloaded") return state;
    if (process.platform === "darwin") {
      const check = canReplaceMacApp();
      if (!check.ok) {
        setState({ status: "error", error: check.error });
        return state;
      }
    }
    pendingInstall = true;
    app.quit();
    return state;
  });

  if (!app.isPackaged) return;

  // Downloads are user-initiated: a background auto-check only announces a version,
  // and the settings update control (or the manual-check dialog) is what downloads it.
  autoUpdater.autoDownload = false;
  // Squirrel.Mac would try to apply the zip and fail without a Developer ID.
  autoUpdater.autoInstallOnAppQuit = process.platform !== "darwin";
  autoUpdater.allowPrerelease = false;
  // Blockmap delta over HTTP Range. GitHub's release CDN (`release-assets.githubusercontent.com`)
  // now returns 206 / Accept-Ranges, and the GitHub provider already disables multipart ranges.
  // A failed delta falls back to a full download; first update after a fresh install is always full
  // (no cached previous zip/installer — AppImage is the exception, it diffs against the running file).

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking", error: undefined });
  });
  autoUpdater.on("update-available", (info) => {
    lastCheckedAt = Date.now();
    setState({
      status: "available",
      availableVersion: info.version,
      releaseNotes: notesOf(info),
      error: undefined,
    });
  });
  autoUpdater.on("update-not-available", () => {
    lastCheckedAt = Date.now();
    setState({
      status: "not-available",
      availableVersion: undefined,
      progress: undefined,
      error: undefined,
    });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    setState({
      status: "downloading",
      progress: {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
  });
  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    downloadedFile = info.downloadedFile;
    setState({
      status: "downloaded",
      availableVersion: info.version,
      releaseNotes: notesOf(info),
      progress: undefined,
      error: undefined,
    });
    notifyDownloaded(info.version);
  });
  autoUpdater.on("error", (error) => {
    // A background check that failed on its way out. A version already on offer stays on
    // offer: it is still actionable, and the download path re-checks before it fetches
    // anything (`update-refresh.ts`), so a transient blip must not take the update off the
    // screen. That case is ordinary now that an `available` notice is periodically
    // re-read — a check that used to run only while nothing was known.
    if (!manualCheck && state.status === "available") return;
    const noisy = manualCheck || state.status === "downloading";
    if (!noisy) {
      setState({ status: "idle", error: undefined, progress: undefined });
      return;
    }
    setState({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      progress: undefined,
    });
  });
}

/**
 * A background check, skipped while one is already running or a version is known.
 *
 * An `available` notice is the exception: it is not being downloaded, and nothing else
 * re-reads the feed for as long as the app runs — so a release published while the user
 * reads the notes would sit behind a notice for the version before it, and the download
 * that eventually follows installs the older one. It is re-checked once the notice is
 * old enough that a newer release could plausibly have landed since. The download path
 * guards itself too (`update-refresh.ts`), so this is not what makes the install safe;
 * it is what makes the screen tell the truth in the meantime. A download in flight, or a
 * version already on disk, is still left alone: re-asking would throw it away.
 */
function backgroundCheck(): void {
  if (state.status === "checking" || state.status === "downloading" || state.status === "downloaded") {
    return;
  }
  if (state.status === "available" && !shouldRecheckBeforeDownload({ version: state.availableVersion, checkedAt: lastCheckedAt, now: Date.now() })) {
    return;
  }
  void checkForUpdates(false);
}

/**
 * Background checks: once shortly after launch, then every 10 minutes for as long as
 * the app runs. Called on every settings write, so the current preference wins when it
 * changes but an unchanged value leaves the running schedule (and its clock) alone.
 */
export function scheduleUpdateCheck(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (scheduleEnabled === enabled) return;
  scheduleEnabled = enabled;
  if (firstCheckTimer) clearTimeout(firstCheckTimer);
  if (repeatCheckTimer) clearInterval(repeatCheckTimer);
  firstCheckTimer = undefined;
  repeatCheckTimer = undefined;
  if (!enabled) return;
  firstCheckTimer = setTimeout(() => {
    firstCheckTimer = undefined;
    backgroundCheck();
  }, CHECK_DELAY_MS);
  repeatCheckTimer = setInterval(backgroundCheck, CHECK_INTERVAL_MS);
}
