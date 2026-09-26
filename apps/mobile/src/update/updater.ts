import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";
import { compareVersions, findNewerRelease, GitHubStatusError, type AppRelease } from "./release";
import { t } from "../i18n";

/**
 * Android self-update from GitHub Releases: the APK is downloaded into the cache
 * directory and handed to the system package installer, which does the part that
 * matters — it refuses an APK not signed with the key the installed app was. So no
 * checksum of our own guards the install; the size check only tells a finished
 * download from one the network cut short.
 *
 * iOS has no sideloading, so every entry point here is a no-op there.
 */

const SKIPPED_KEY = "fastvibe.update.skipped.v1";
const APK_DIRECTORY = "updates";
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export const updatesSupported = Platform.OS === "android";

export function currentVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}

/**
 * How long an answer is reused. Not the process lifetime: backing out of the app on
 * Android keeps the JS runtime alive, so a "no update" cached per launch outlived the
 * release it predated and reopening the app never looked again.
 */
const CHECK_FRESH_MS = 10 * 60 * 1000;

/**
 * Per request. A network that silently drops GitHub's packets (common on mainland
 * mobile data) otherwise leaves a check hanging for minutes, and a manual 检查更新
 * spinning that long reads as broken rather than as "GitHub is unreachable".
 */
const REQUEST_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

let inflight: Promise<AppRelease | null> | null = null;
let settled: { at: number; release: AppRelease | null } | null = null;

async function fetchWithTimeout(url: string, init?: { headers?: Record<string, string> }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function checkForUpdate({ force = false }: { force?: boolean } = {}): Promise<AppRelease | null> {
  if (!updatesSupported) return Promise.resolve(null);
  if (inflight) return inflight;
  if (!force && settled && Date.now() - settled.at < CHECK_FRESH_MS) return Promise.resolve(settled.release);
  const check = findNewerRelease(currentVersion(), fetchWithTimeout);
  inflight = check;
  check
    .then(
      (release) => {
        settled = { at: Date.now(), release };
      },
      // A failure is not remembered, so the next ask tries again.
      () => {},
    )
    .finally(() => {
      if (inflight === check) inflight = null;
    });
  return check;
}

/** A failed check as a sentence for the user; the raw error of a blocked request says nothing. */
export function describeCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || /abort/i.test(message)) return t("update.githubTimeout");
  if (/network request failed/i.test(message)) return t("update.githubUnreachable");
  if (error instanceof GitHubStatusError && error.status === 403) return t("update.githubRateLimited");
  return message;
}

/**
 * A release a manual check found, handed to the banner — the check is started from
 * the list's footer, but offering, downloading and installing live in the banner.
 */
type ReleaseListener = (release: AppRelease) => void;
const releaseListeners = new Set<ReleaseListener>();

export function onReleaseAnnounced(listener: ReleaseListener): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}

export function announceRelease(release: AppRelease): void {
  for (const listener of releaseListeners) listener(release);
}

export async function skippedVersion(): Promise<string | null> {
  return AsyncStorage.getItem(SKIPPED_KEY);
}

export async function skipVersion(version: string): Promise<void> {
  await AsyncStorage.setItem(SKIPPED_KEY, version);
}

/** Asking by hand overrides an earlier 忽略: the user wants to see it now. */
export async function clearSkippedVersion(): Promise<void> {
  await AsyncStorage.removeItem(SKIPPED_KEY);
}

function apkDirectory(): Directory {
  const directory = new Directory(Paths.cache, APK_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function apkFile(release: AppRelease): File {
  return new File(apkDirectory(), release.apkName);
}

/** The APK already on disk for this release, if a previous download finished. */
export function downloadedApk(release: AppRelease): File | null {
  const file = apkFile(release);
  if (!file.exists) return null;
  if (release.apkSize > 0 && file.size !== release.apkSize) return null;
  return file;
}

export async function downloadApk(
  release: AppRelease,
  onProgress: (fraction: number | null) => void,
  signal?: AbortSignal,
): Promise<File> {
  const existing = downloadedApk(release);
  if (existing) return existing;

  const destination = apkFile(release);
  if (destination.exists) destination.delete();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DOWNLOAD_TIMEOUT_MS);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const task = File.createDownloadTask(release.apkUrl, destination, {
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const total = totalBytes > 0 ? totalBytes : release.apkSize;
        onProgress(total > 0 ? Math.min(1, bytesWritten / total) : null);
      },
    });
    const file = await task.downloadAsync();
    if (!file) throw new Error(t("update.paused"));
    if (release.apkSize > 0 && file.size !== release.apkSize) {
      file.delete();
      throw new Error(t("update.incomplete"));
    }
    return file;
  } catch (error) {
    if (timedOut) throw new Error(t("update.downloadTimeout"));
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Opens the system installer. Resolves when the installer screen is dismissed —
 * which is also what happens when the user backs out, so the caller keeps offering
 * 安装 rather than assuming it happened. A successful install replaces this process.
 */
export async function installApk(file: File): Promise<void> {
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: file.contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
    type: "application/vnd.android.package-archive",
  });
}

/**
 * Deletes APKs for versions this install has already reached. An update leaves its
 * own APK behind in the cache — tens of megabytes nothing will read again.
 */
export function removeStaleApks(): void {
  if (!updatesSupported) return;
  try {
    const directory = new Directory(Paths.cache, APK_DIRECTORY);
    if (!directory.exists) return;
    const current = currentVersion();
    for (const entry of directory.list()) {
      if (!(entry instanceof File)) continue;
      const match = /app-v(\d+\.\d+\.\d+)/.exec(entry.name);
      if (!match || compareVersions(match[1], current) <= 0) entry.delete();
    }
  } catch {
    // Cache housekeeping; never worth surfacing.
  }
}
