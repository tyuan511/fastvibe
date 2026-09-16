import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * GUI-launched Electron inherits launchd's stub PATH (`/usr/bin:/bin:/usr/sbin:/sbin`
 * on macOS). Homebrew, cargo, pnpm and friends never make it in, so the agent's
 * bash tool and the in-app terminal cannot see `rg` / `node` / `git` the user
 * installed. We prepend the well-known bins for this OS — only directories that
 * actually exist, and only if they are not already on PATH.
 *
 * A login-shell dump would be more complete, but it is slow, can hang on a
 * heavy `.zshrc`, and is not what we want at every launch. Existing entries are
 * left in place so a terminal-launched `pnpm dev` keeps the user's order.
 */
export function applyShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  const existing = current.split(delimiter).filter(Boolean);
  const extras = commonPathDirs(platform, home, env).filter(
    (dir) => existsSync(dir) && !hasPathEntry(existing, dir, platform),
  );
  if (extras.length === 0) {
    env[key] = current;
    return current;
  }
  const next = [...extras, ...existing].join(delimiter);
  env[key] = next;
  return next;
}

export function commonPathDirs(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const local = join(home, ".local", "bin");
  const cargo = join(home, ".cargo", "bin");
  const go = join(home, "go", "bin");
  const bun = join(home, ".bun", "bin");
  const asdf = join(home, ".asdf", "shims");
  const mise = join(home, ".local", "share", "mise", "shims");

  if (platform === "darwin") {
    return [
      local,
      cargo,
      go,
      bun,
      asdf,
      mise,
      join(home, "Library", "pnpm"),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/opt/local/bin",
    ];
  }

  if (platform === "linux") {
    return [
      local,
      cargo,
      go,
      bun,
      asdf,
      mise,
      join(home, ".local", "share", "pnpm"),
      join(home, ".linuxbrew", "bin"),
      "/home/linuxbrew/.linuxbrew/bin",
      "/home/linuxbrew/.linuxbrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/snap/bin",
    ];
  }

  if (platform === "win32") {
    const localApp = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      cargo,
      go,
      bun,
      join(localApp, "pnpm"),
      join(home, "scoop", "shims"),
      join(localApp, "Programs", "Git", "cmd"),
      join(programFiles, "Git", "cmd"),
      join(programFiles, "Git", "usr", "bin"),
      join(programFilesX86, "Git", "cmd"),
      join(programFilesX86, "Git", "usr", "bin"),
      "C:\\ProgramData\\chocolatey\\bin",
    ];
  }

  return [local];
}

function hasPathEntry(entries: string[], dir: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const lower = dir.toLowerCase();
    return entries.some((entry) => entry.toLowerCase() === lower);
  }
  return entries.includes(dir);
}
