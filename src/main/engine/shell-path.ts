import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * GUI-launched Electron inherits launchd's stub PATH (`/usr/bin:/bin:/usr/sbin:/sbin`
 * on macOS). Homebrew, cargo, pnpm and friends never make it in, so the agent's
 * bash tool and the in-app terminal cannot see `rg` / `node` / `git` the user
 * installed. We prepend the well-known bins for this OS — only directories that
 * actually exist, and only if they are not already on PATH.
 *
 * We also ask the user's login shell for its PATH. This is intentionally
 * shell-oriented rather than manager-oriented: fnm, nvm, mise, Homebrew and
 * user-defined tools can all configure themselves from the same shell startup
 * files. A broken or slow startup file is not allowed to prevent the app from
 * launching; the fixed directories below remain the fallback.
 */
export function applyShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  const shellEntries = shellPathEntries(env, platform);
  const existing = [...shellEntries, ...current.split(delimiter).filter(Boolean)].filter(
    (entry, index, entries) => entries.indexOf(entry) === index,
  );
  const extras = commonPathDirs(platform, home, env).filter(
    (dir) => existsSync(dir) && !hasPathEntry(existing, dir, platform),
  );
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

const SHELL_PATH_START = "__FASTVIBE_PATH_START__";
const SHELL_PATH_END = "__FASTVIBE_PATH_END__";
const SHELL_PATH_TIMEOUT_MS = 1_500;

function shellPathEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") return [];
  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  if (!shell.startsWith("/")) return [];

  try {
    const output = execFileSync(
      shell,
      ["-ilc", `printf '${SHELL_PATH_START}%s${SHELL_PATH_END}' "$PATH"`],
      {
        env: { ...env },
        encoding: "utf8",
        timeout: SHELL_PATH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const match = output.match(
      new RegExp(`${SHELL_PATH_START}([\\s\\S]*?)${SHELL_PATH_END}`),
    );
    return match?.[1]?.split(delimiter).filter(Boolean) ?? [];
  } catch {
    return [];
  }
}

function hasPathEntry(entries: string[], dir: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const lower = dir.toLowerCase();
    return entries.some((entry) => entry.toLowerCase() === lower);
  }
  return entries.includes(dir);
}
