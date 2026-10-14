/**
 * The computer-control engine is not in the installer.
 *
 * Turning 电脑操控 on fetches the private worker and the native library into the
 * data directory. A dev tree that already has them (predev, or node_modules) does
 * not fetch again. Opening the settings page does not fetch: the switch is the
 * request, and a tool call on an already-enabled chat is the other one.
 */

import { app } from "electron";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { broadcast } from "../ipc/broadcast";
import { installCuaDriver } from "../engine/cua-driver-install";
import { cuaInstallLayout, cuaPlatformSpec, type CuaPlatformSpec } from "../engine/cua-driver-spec";
import { getFastVibePaths } from "../engine/paths";
import { log } from "../engine/logger";
import { uiText } from "../engine/ui-text";
import { Ipc } from "@shared/ipc";
import type { ComputerComponentStatus } from "@shared/types";

let phaseOverride: "downloading" | "failed" | null = null;
let received = 0;
let total = 0;
let errorMessage: string | undefined;
let inflight: Promise<void> | null = null;
let abortDownload: (() => void) | null = null;
let lastBroadcast = 0;
let fallbackInstalled = false;

function componentRoot(): string {
  return join(getFastVibePaths().userData, "runtime", "cua-driver");
}

function specForHere(): CuaPlatformSpec | null {
  return cuaPlatformSpec(process.platform, process.arch);
}

/** A worker left by predev, or by an installer from before on-demand download. */
export function bundledWorkerPath(): string | null {
  const name = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  const candidates = [
    join(__dirname, "../../resources/cua-driver", process.arch, name),
    join(__dirname, "../../resources/cua-driver", process.arch, "cua-driver"),
    app.isPackaged ? join(process.resourcesPath, name) : "",
    app.isPackaged ? join(process.resourcesPath, "cua-driver") : "",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

function versionStamp(): string {
  return join(componentRoot(), ".version");
}

/** A download from another bindings version must not be reused. */
function downloadedVersionMatches(spec: CuaPlatformSpec): boolean {
  try {
    return readFileSync(versionStamp(), "utf8").trim() === spec.version;
  } catch {
    return false;
  }
}

function downloadedWorker(spec: CuaPlatformSpec): string | null {
  if (!downloadedVersionMatches(spec)) return null;
  const path = join(componentRoot(), spec.workerName);
  return existsSync(path) ? path : null;
}

/** Where the private worker is, once something has put it on disk. */
export function computerWorkerPath(): string | null {
  const spec = specForHere();
  if (spec) {
    const downloaded = downloadedWorker(spec);
    if (downloaded) return downloaded;
  }
  return bundledWorkerPath();
}

function bundledNativeReady(spec: CuaPlatformSpec): boolean {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_.resolve(`${spec.packageName}/package.json`);
    const dir = dirname(pkg);
    return existsSync(join(dir, spec.nativeLib)) && existsSync(join(dir, spec.nativeAddon));
  } catch {
    return false;
  }
}

function downloadedNativeReady(spec: CuaPlatformSpec): boolean {
  if (!downloadedVersionMatches(spec)) return false;
  const dir = join(componentRoot(), "native");
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, spec.nativeLib)) && existsSync(join(dir, spec.nativeAddon));
}

/** True when both halves can be loaded without a download. */
export function computerComponentReady(): boolean {
  const spec = specForHere();
  if (!spec) return false;
  const worker = downloadedWorker(spec) ?? bundledWorkerPath();
  const native = downloadedNativeReady(spec) || bundledNativeReady(spec);
  return Boolean(worker) && native;
}

export function computerComponentStatus(): ComputerComponentStatus {
  const spec = specForHere();
  if (!spec) return { phase: "unsupported", received: 0, total: 0 };
  if (phaseOverride === "downloading") return { phase: "downloading", received, total, version: spec.version };
  if (computerComponentReady()) return { phase: "ready", received: 0, total: 0, version: spec.version };
  if (phaseOverride === "failed") return { phase: "failed", received, total, error: errorMessage, version: spec.version };
  return { phase: "missing", received: 0, total: 0 };
}

function publish(force = false): void {
  const now = Date.now();
  if (!force && now - lastBroadcast < 200) return;
  lastBroadcast = now;
  broadcast(Ipc.computerComponentState, computerComponentStatus());
}

/**
 * Point native-library lookup at the downloaded platform package.
 *
 * The bindings resolve `@trycua/cua-driver-<triple>` from their own directory.
 * That package is not in the installer, so a resolve that misses falls through
 * to the copy under the data directory. A dev install that still has the package
 * in node_modules keeps winning: the original resolve is tried first.
 */
function installNativeFallback(spec: CuaPlatformSpec): void {
  if (fallbackInstalled) return;
  fallbackInstalled = true;
  const nativeDir = cuaInstallLayout(componentRoot(), spec).nativeDir;
  const require_ = createRequire(import.meta.url);
  const Module = require_("node:module") as typeof import("node:module") & {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
  };
  const original = Module._resolveFilename;
  const packageName = spec.packageName;
  Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request !== packageName && !request.startsWith(`${packageName}/`)) {
      return original.call(this, request, ...rest);
    }
    try {
      return original.call(this, request, ...rest);
    } catch (error) {
      const pkgJson = join(nativeDir, "package.json");
      if (!existsSync(pkgJson)) throw error;
      if (request === packageName || request === `${packageName}/package.json`) return pkgJson;
      const relative = request.slice(packageName.length + 1);
      const candidate = join(nativeDir, relative);
      if (existsSync(candidate)) return candidate;
      throw error;
    }
  };
}

export function ensureComputerComponent(options?: { force?: boolean }): Promise<void> {
  const spec = specForHere();
  if (!spec) {
    return Promise.reject(new Error(uiText(
      "当前系统没有电脑操控组件可下载。",
      "This OS has no computer-control component to download.",
    )));
  }
  installNativeFallback(spec);
  const force = options?.force === true;
  if (!force && computerComponentReady()) {
    phaseOverride = null;
    return Promise.resolve();
  }
  if (inflight) return inflight;
  // A half-written update must not keep looking like the previous version.
  if (force) {
    try {
      unlinkSync(versionStamp());
    } catch {
      // No stamp yet.
    }
  }

  const controller = new AbortController();
  abortDownload = () => controller.abort();
  phaseOverride = "downloading";
  received = 0;
  total = 0;
  errorMessage = undefined;
  publish(true);
  log.info(`downloading computer-control component ${spec.version}`);

  inflight = installCuaDriver({
    root: componentRoot(),
    spec,
    signal: controller.signal,
    skipWorker: force ? false : Boolean(downloadedWorker(spec) ?? bundledWorkerPath()),
    skipNative: force ? false : downloadedNativeReady(spec) || bundledNativeReady(spec),
    onProgress: (progress) => {
      received = progress.received;
      total = progress.total;
      publish();
    },
  }).then(() => {
    writeFileSync(versionStamp(), `${spec.version}\n`);
    phaseOverride = null;
    errorMessage = undefined;
    publish(true);
    log.info("computer-control component ready");
  }).catch((error: unknown) => {
    if (controller.signal.aborted) {
      phaseOverride = null;
      publish(true);
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    phaseOverride = "failed";
    errorMessage = uiText(
      `电脑操控组件下载失败：${detail}`,
      `Could not download the computer-control component: ${detail}`,
    );
    publish(true);
    log.warn(`computer-control component download failed: ${detail}`);
    throw new Error(errorMessage);
  }).finally(() => {
    inflight = null;
    abortDownload = null;
  });
  return inflight;
}

/** Start a download when the switch turns on; drop an in-flight one when it turns off. */
export function syncComputerComponent(enabled: boolean): void {
  if (!enabled) {
    abortDownload?.();
    if (phaseOverride) {
      phaseOverride = null;
      errorMessage = undefined;
      publish(true);
    }
    return;
  }
  void ensureComputerComponent().catch(() => undefined);
}

export function cancelComputerComponent(): void {
  syncComputerComponent(false);
}
