import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";
import { compareVersions, findNewerRelease, type AppRelease } from "./release";

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

/** One check per app launch, shared by every caller that asks during it. */
let launchCheck: Promise<AppRelease | null> | null = null;

export function checkForUpdate({ force = false }: { force?: boolean } = {}): Promise<AppRelease | null> {
  if (!updatesSupported) return Promise.resolve(null);
  if (!launchCheck || force) {
    launchCheck = findNewerRelease(currentVersion(), fetch);
    // A failed check must not stick for the rest of the session.
    launchCheck.catch(() => {
      launchCheck = null;
    });
  }
  return launchCheck;
}

export async function skippedVersion(): Promise<string | null> {
  return AsyncStorage.getItem(SKIPPED_KEY);
}

export async function skipVersion(version: string): Promise<void> {
  await AsyncStorage.setItem(SKIPPED_KEY, version);
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
  const task = File.createDownloadTask(release.apkUrl, destination, {
    signal,
    onProgress: ({ bytesWritten, totalBytes }) => {
      const total = totalBytes > 0 ? totalBytes : release.apkSize;
      onProgress(total > 0 ? Math.min(1, bytesWritten / total) : null);
    },
  });
  const file = await task.downloadAsync();
  if (!file) throw new Error("下载已暂停");
  if (release.apkSize > 0 && file.size !== release.apkSize) {
    file.delete();
    throw new Error("下载不完整，请重试");
  }
  return file;
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
