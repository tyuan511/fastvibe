import { accessSync, constants } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";

/**
 * Full Disk Access, checked without ever touching Desktop, Documents or Downloads.
 *
 * Those three are exactly the prompts this exists to stop, and *reading* one of them
 * is what makes macOS show the dialog. There is no status API for the grant. The
 * TCC database is protected by the same grant and by nothing else, so a failed open
 * is a refusal rather than a consent dialog. Do not "improve" the probe by stating
 * a folder the user can see — that brings the per-folder prompt back.
 */

const USER_TCC = join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db");
const SYSTEM_TCC = "/Library/Application Support/com.apple.TCC/TCC.db";

export type DiskProbeResult = "ok" | "denied" | "missing";
export type DiskProbe = (path: string) => DiskProbeResult;

export function probePath(path: string): DiskProbeResult {
  try {
    accessSync(path, constants.R_OK);
    return "ok";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Absent is not a refusal: a Mac without that database cannot answer, and
    // treating it as denied would nag forever on a machine that has the grant.
    if (code === "ENOENT") return "missing";
    return "denied";
  }
}

export function hasFullDiskAccess(options?: {
  platform?: NodeJS.Platform;
  probe?: DiskProbe;
  paths?: readonly string[];
}): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") return true;
  const probe = options?.probe ?? probePath;
  const paths = options?.paths ?? [USER_TCC, SYSTEM_TCC];
  for (const path of paths) {
    if (probe(path) === "ok") return true;
  }
  // A refusal and a pair of missing databases both mean we cannot claim the grant.
  // The prompt that follows is dismissible, so a false negative is a nag, not a lock.
  return false;
}

/** Ventura (Darwin 22) replaced System Preferences, and the old anchor stopped landing. */
export function fullDiskAccessSettingsUrl(darwinMajor = Number(release().split(".")[0])): string {
  return darwinMajor >= 22
    ? "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
}

/** The bundle a Privacy list accepts, rather than the binary nested inside it. */
export function appBundlePath(exe: string): string {
  const match = /^(.*\.app)(?:[/\\]|$)/.exec(exe);
  return match?.[1] ?? exe;
}
