import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserImportResult, BrowserProfileInfo } from "@shared/types";
import { uiText } from "./ui-text";

const execFileAsync = promisify(execFile);

type BrowserRoot = { browser: string; root: string };
type CookieRow = {
  host_key: string;
  name: string;
  path: string;
  value?: string;
  encrypted_value?: Buffer | Uint8Array | string;
  /**
   * Chromium stores this as microseconds since 1601, which no longer fits in a
   * safe JS integer — a recent expiry is ~1.3e16, past 2^53. Read as text so
   * `node:sqlite` never tries to box it as a number (that throws for the whole
   * query, not just the one row).
   */
  expires_utc?: string | null;
  is_secure?: number;
  is_httponly?: number;
  samesite?: number;
};

/** Chromium epoch (1601-01-01) in microseconds, as text so the subtraction stays exact. */
const CHROME_EPOCH_US = 11_644_473_600_000_000n;

/**
 * A Chromium `expires_utc` as a Unix timestamp in seconds, or undefined for a
 * session cookie (0) and for anything already in the past. Electron wants seconds,
 * and a value past its own range is rejected outright, so an unreadable or
 * absurd expiry is dropped rather than failing the cookie.
 */
function expirationSeconds(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  let micros: bigint;
  try {
    micros = BigInt(raw);
  } catch {
    return undefined;
  }
  if (micros <= CHROME_EPOCH_US) return undefined;
  const seconds = Number((micros - CHROME_EPOCH_US) / 1_000_000n);
  if (!Number.isFinite(seconds) || seconds <= Math.floor(Date.now() / 1000)) return undefined;
  return seconds;
}

function roots(): BrowserRoot[] {
  const home = homedir();
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      { browser: "Google Chrome", root: join(base, "Google", "Chrome") },
      { browser: "Microsoft Edge", root: join(base, "Microsoft Edge") },
      { browser: "Brave", root: join(base, "BraveSoftware", "Brave-Browser") },
      { browser: "Chromium", root: join(base, "Chromium") },
      { browser: "Arc", root: join(base, "Arc", "User Data") },
      { browser: "Opera", root: join(base, "com.operasoftware.Opera") },
    ];
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      { browser: "Google Chrome", root: join(base, "Google", "Chrome", "User Data") },
      { browser: "Microsoft Edge", root: join(base, "Microsoft", "Edge", "User Data") },
      { browser: "Brave", root: join(base, "BraveSoftware", "Brave-Browser", "User Data") },
      { browser: "Chromium", root: join(base, "Chromium", "User Data") },
    ];
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    { browser: "Google Chrome", root: join(base, "google-chrome") },
    { browser: "Microsoft Edge", root: join(base, "microsoft-edge") },
    { browser: "Brave", root: join(base, "BraveSoftware", "Brave-Browser") },
    { browser: "Chromium", root: join(base, "chromium") },
  ];
}

async function isDir(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function profileNames(root: string): Promise<Record<string, string>> {
  try {
    const state = JSON.parse(await readFile(join(root, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    return Object.fromEntries(Object.entries(state.profile?.info_cache ?? {}).map(([id, info]) => [id, info.name || id]));
  } catch { return {}; }
}

function cookieFile(profilePath: string): string {
  return join(profilePath, "Network", "Cookies");
}

async function findCookieFile(profilePath: string): Promise<string | undefined> {
  for (const path of [cookieFile(profilePath), join(profilePath, "Cookies")]) {
    try { if ((await stat(path)).isFile()) return path; } catch { /* try the next layout */ }
  }
  return undefined;
}

export async function listBrowserProfiles(): Promise<BrowserProfileInfo[]> {
  const result: BrowserProfileInfo[] = [];
  for (const item of roots()) {
    if (!(await isDir(item.root))) continue;
    const names = await profileNames(item.root);
    let entries: string[] = [];
    try { entries = (await readdir(item.root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name)).map((entry) => entry.name); } catch { continue; }
    for (const id of entries) {
      const path = join(item.root, id);
      const cookies = await findCookieFile(path);
      if (!cookies) continue;
      result.push({ id: `${item.browser}:${id}`, browser: item.browser, name: names[id] || id, path, cookiePath: cookies });
    }
  }
  return result;
}

async function chromeSafeStorageKey(browser: string): Promise<Buffer | undefined> {
  if (process.platform !== "darwin") return undefined;
  const service = browser === "Google Chrome" ? "Chrome Safe Storage" : `${browser} Safe Storage`;
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", service], { maxBuffer: 32_000 });
    return pbkdf2Sync(stdout.trim(), "saltysalt", 1003, 16, "sha1");
  } catch { return undefined; }
}

function decryptCookie(value: unknown, key: Buffer | undefined): string {
  if (!value) return "";
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array | string);
  if (!raw.length) return "";
  const prefix = raw.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") return raw.toString("utf8");
  if (!key) return "";
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]);
    // Chromium's macOS cookie format prefixes the value with a 32-byte
    // host-key digest after the v10/v11 marker.
    return plaintext.subarray(plaintext.length > 32 ? 32 : 0).toString("utf8").replace(/^\u0000+/, "");
  } catch { return ""; }
}

function sameSite(value: number | undefined): "unspecified" | "no_restriction" | "lax" | "strict" {
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  if (value === 0) return "no_restriction";
  return "unspecified";
}

/** Import cookies into the isolated Electron session used by the built-in webview. */
export async function importBrowserProfile(profile: BrowserProfileInfo, setCookie: (cookie: { url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number; sameSite?: "unspecified" | "no_restriction" | "lax" | "strict" }) => Promise<void>): Promise<BrowserImportResult> {
  const key = await chromeSafeStorageKey(profile.browser);
  const temp = await mkdtemp(join(tmpdir(), "fastvibe-browser-"));
  const copy = join(temp, basename(profile.cookiePath));
  try {
    await copyFile(profile.cookiePath, copy);
    // Chromium keeps recent cookie writes in a WAL while the source browser is
    // open. Copy the sidecars with the same basename so SQLite sees them too.
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(`${profile.cookiePath}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(copy, { readOnly: true });
    // `expires_utc` is cast to text: node:sqlite throws
    // "Value is too large to be represented as a JavaScript number" the moment one
    // row's expiry exceeds 2^53, and that aborts the whole import.
    const rows = db.prepare("SELECT host_key,name,path,value,encrypted_value,CAST(expires_utc AS TEXT) AS expires_utc,is_secure,is_httponly,samesite FROM cookies").all() as unknown as CookieRow[];
    let imported = 0;
    for (const row of rows) {
      const value = row.value || decryptCookie(row.encrypted_value, key);
      if (!value || !row.host_key || !row.name) continue;
      const host = row.host_key.replace(/^\.+/, "");
      const expirationDate = expirationSeconds(row.expires_utc);
      try {
        const details = { url: `https://${host}${row.path?.startsWith("/") ? row.path : "/"}`, name: row.name, value, domain: row.host_key, path: row.path || "/", secure: row.is_secure === 1, httpOnly: row.is_httponly === 1, ...(expirationDate ? { expirationDate } : {}), sameSite: sameSite(row.samesite) };
        try {
          await setCookie(details);
        } catch (error) {
          if (!row.name.startsWith("__Host-")) throw error;
          const { domain: _domain, ...hostOnly } = details;
          await setCookie(hostOnly);
        }
        imported += 1;
      } catch {
        // A malformed/obsolete cookie must not prevent the rest of the profile
        // from being imported (notably __Host-* cookies reject a Domain field).
      }
    }
    db.close();
    const skipped = rows.length - imported;
    return { browser: profile.browser, profile: profile.name, cookies: imported, encryptedCookiesSkipped: skipped, message: imported ? uiText(`已导入 ${imported} 个 Cookie${skipped ? `，另有 ${skipped} 个无法解密或已失效` : ""}`, `Imported ${imported} cookies${skipped ? `; ${skipped} could not be decrypted or had expired` : ""}`) : uiText("没有可导入的 Cookie（可能需要先关闭源浏览器或系统密钥未授权）", "No cookies found (close the source browser, or grant keychain access)") };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}


