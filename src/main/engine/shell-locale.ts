import { execFileSync } from "node:child_process";

/**
 * A GUI-launched Electron process is handed no locale.
 *
 * launchd gives it HOME, SHELL, PATH and little else; `LANG` is what a *login shell*
 * sets, or what Terminal.app sets from the region preference (「Set locale environment
 * variables on startup」). Neither runs here, so every child this app spawns — the
 * in-app terminal's shell first among them — runs in the POSIX/C locale, where a byte
 * above 0x7f is not part of a character.
 *
 * That is the terminal's 乱码. Measured with a real pty on macOS, `LC_CTYPE=C` makes
 * zsh's line editor non-multibyte, and it draws what the user typed rather than what
 * the bytes mean:
 *
 *     typing  echo 中文测试   →   echo <00ad><0096><0087><008b><0095>
 *     a failed glob           →   zsh: no matches found: /tmp/\M--\M-^V\M-^G*
 *     locale charmap          →   US-ASCII
 *
 * The bytes that reach the command are still correct (the reply to that `echo` prints
 * 中文测试), which is why this reads as "sometimes": nothing is wrong until something
 * non-ASCII is typed, pasted, completed, or rendered by a program that decodes by the
 * locale (vim, less, man, Ruby's `default_external`). With `LC_CTYPE` set to any UTF-8
 * locale the same session draws `echo 中文测试`.
 *
 * Only `LC_CTYPE` is written. It is the category that decides what a character is, and
 * the one every tool consults first after `LC_ALL`; leaving `LANG` alone keeps messages,
 * dates and collation in C, so `sort` keeps its byte order and nothing starts answering
 * in a language the user did not ask for. A locale that *is* set — by the user, by the
 * desktop session on Linux, or a deliberate `LANG=C` — is never touched.
 */

/** What a child's character handling is decided by, in the precedence the C library uses. */
const LOCALE_KEYS = ["LC_ALL", "LC_CTYPE", "LANG"];

/**
 * Preference order. `C.UTF-8` first: UTF-8 with no region attached, so it cannot
 * contradict anything else the user configured, and it ships with glibc 2.35+ and
 * macOS 13+. `en_US.UTF-8` is the one that exists on *every* macOS — which is the
 * platform where a locale is missing in the first place.
 */
export const UTF8_LOCALES = ["C.UTF-8", "en_US.UTF-8"];

const LOCALE_PROBE_TIMEOUT_MS = 500;

/**
 * `locale -a` spells the same locale differently per platform (`C.UTF-8` on macOS,
 * `C.utf8` on glibc), so names are compared folded and without the separator.
 */
export function normalizeLocaleName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "");
}

/** Whether this process was already given a character locale worth respecting. */
export function localeIsSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return LOCALE_KEYS.some((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Pick the locale to write, from what this machine actually has.
 *
 * `available === null` means the probe could not run at all. macOS is still answered —
 * `en_US.UTF-8` is part of the OS, so there is nothing to check — while elsewhere
 * nothing is set: an invented locale name is worse than the C locale, because every
 * command then prints `setlocale: LC_CTYPE: cannot change locale (…)`.
 */
export function pickUtf8Locale(
  available: string[] | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") return null;
  if (available === null) return platform === "darwin" ? "en_US.UTF-8" : null;
  const present = new Set(available.map(normalizeLocaleName));
  return UTF8_LOCALES.find((candidate) => present.has(normalizeLocaleName(candidate))) ?? null;
}

/** What `locale -a` lists, or null when it could not be run. */
export function availableLocales(env: NodeJS.ProcessEnv = process.env): string[] | null {
  try {
    const output = execFileSync("locale", ["-a"], {
      env: { ...env },
      encoding: "utf8",
      timeout: LOCALE_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Give this process — and so every child it spawns — a UTF-8 character locale, unless
 * it already has one. Returns the value written, or null when nothing was.
 *
 * Called beside `applyShellPath` in both entry points (`src/main/index.ts` and
 * `src/agent/main.ts`), which is why `TerminalSessions` needs no locale code of its own:
 * it spreads `process.env` into the pty. Windows is skipped — its console has a code
 * page rather than a locale, and ConPTY hands us UTF-8 either way.
 */
export function applyShellLocale(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: () => string[] | null = availableLocales,
): string | null {
  if (platform === "win32") return null;
  if (localeIsSet(env)) return null;
  const picked = pickUtf8Locale(probe(), platform);
  if (!picked) return null;
  env.LC_CTYPE = picked;
  return picked;
}
