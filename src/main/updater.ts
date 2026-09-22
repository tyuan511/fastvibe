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

const CHECK_DELAY_MS = 8_000;
/** Background re-checks after the launch one, for as long as the app runs. */
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
    setState({
      status: "available",
      availableVersion: info.version,
      releaseNotes: notesOf(info),
      error: undefined,
    });
  });
  autoUpdater.on("update-not-available", () => {
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
    const noisy = manualCheck || state.status === "available" || state.status === "downloading";
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
 * A background check, skipped while one is already running or a version is already
 * known — re-asking would only throw away a pending download.
 */
function backgroundCheck(): void {
  if (
    state.status === "checking" ||
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded"
  ) {
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
