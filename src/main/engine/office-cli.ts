import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { officeCliPlatformKey, officeFormatOf, parseOfficeCliManifest, type OfficeCliManifest } from "../../shared/office.ts";
import { getFastVibePaths } from "./paths.ts";

/**
 * The OfficeCLI binary that ships *with this install*, and the environment every child process
 * has to be given in order to use it safely.
 *
 * Two things are load-bearing here.
 *
 * **The binary is a resource, not a download.** It is fetched at build time
 * (`scripts/fetch-officecli.mjs`) against the SHA256 pinned in `scripts/officecli.json`, and
 * shipped through `extraResources` exactly like `resources/skills` and the models.dev snapshot.
 * So the lookup is one path: there is no install state, no 「没装就运行官方安装脚本」, and no
 * version that can drift away from the skills `load_skill` prints.
 *
 * **A bundled binary that updates or installs itself is a different program.** OfficeCLI checks
 * for updates on every call and swaps its own file on the next one, and running it bare copies
 * itself into `~/.local/bin` *and* writes skills and MCP configuration into every agent it
 * detects — including `~/.agents/skills/officecli`, a directory this app reads as a global
 * skill, where a same-named user skill silently wins over the built-in one. Both are switched
 * off through the environment, in the processes this app starts and nowhere else: a copy the
 * user installed for themselves keeps behaving the way they set it up.
 */

export type OfficeCliInstall = {
  /** Directory the binary was found in — the entry that goes on `PATH`. */
  dir: string;
  /** The binary itself, or null when this install does not carry one. */
  binary: string | null;
  /** Version from the manifest that shipped beside it, or null when there is none. */
  version: string | null;
};

/**
 * Where this install keeps OfficeCLI.
 *
 * `resources/officecli`, resolved the way the built-in skills and extensions are: packaged
 * under `process.resourcesPath`, in a dev tree under `FASTVIBE_RESOURCES_PATH` (falling back to
 * `<cwd>/resources`).
 */
export function officeCliResourceDir(): string {
  const root = process.env.FASTVIBE_RESOURCES_PATH?.trim()
    || (typeof process.resourcesPath === "string" && process.resourcesPath ? process.resourcesPath : "")
    || join(process.cwd(), "resources");
  return join(root, "officecli");
}

/**
 * What this install ships.
 *
 * Packaged, the layout is flat (`resourcesPath/officecli/officecli`) because `extraResources`
 * copies only the directory of the architecture being built. A dev tree keeps every architecture
 * it has fetched side by side (`resources/officecli/<os>-<arch>/`), which is how `pnpm dist:mac`
 * packages arm64 and x64 out of one working copy — so both spellings are probed, dev layout
 * second.
 */
export function officeCliInstall(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  dir = officeCliResourceDir(),
): OfficeCliInstall {
  const manifest = readOfficeCliManifest(dir);
  const name = platform === "win32" ? "officecli.exe" : "officecli";
  const key = officeCliPlatformKey(platform, arch);
  const flat = join(dir, name);
  const perArch = key ? join(dir, key, name) : "";
  const binary = existsSync(flat) ? flat : perArch && existsSync(perArch) ? perArch : null;
  return { dir: binary ? dirname(binary) : dir, binary, version: manifest?.version ?? null };
}

/** The pinned release this install was built against, or null when the manifest is absent or unreadable. */
export function readOfficeCliManifest(dir = officeCliResourceDir()): OfficeCliManifest | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  try {
    return parseOfficeCliManifest(JSON.parse(raw) as unknown);
  } catch {
    // A half-written manifest is no reason to refuse to start: it means the version is unknown,
    // not that the binary beside it is unusable.
    return null;
  }
}

/** Where OfficeCLI keeps its own state, moved out of `~/.officecli`. Created because the tool expects to write there. */
export function officeCliStateDir(): string {
  const dir = join(getFastVibePaths().runtimeRoot, "officecli-state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `PATH` on every platform but Windows, where a GUI process is handed `Path`. */
function pathKey(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return "PATH";
  return env.Path !== undefined ? "Path" : "PATH";
}

/**
 * Point every child process at the bundled OfficeCLI and switch its self-management off.
 *
 * Called beside `applyShellPath` / `applyShellLocale` in both entry points, before any agent
 * session, MCP stdio server or terminal is forked, so all of them inherit it — which is what
 * makes the agent typing `officecli` get *this* version rather than whatever else is on the
 * machine. The directory is prepended, never a replacement: a user's own copy stays exactly
 * where their shell put it, just behind ours.
 *
 * Returns the directory added, or null when this install carries no binary — in which case
 * nothing is written at all. Imposing `OFFICECLI_SKIP_UPDATE` on a machine that runs the user's
 * own OfficeCLI would silently change how *their* install behaves.
 */
export function applyOfficeCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  install: OfficeCliInstall = officeCliInstall(),
): string | null {
  if (!install.binary) return null;
  const key = pathKey(env);
  const separator = process.platform === "win32" ? ";" : ":";
  // Applied again once the login shell's PATH has been merged in front (`index.ts`), so the
  // bundled copy is moved back to the front rather than listed twice.
  const rest = (env[key] ?? "").split(separator).filter((entry) => entry && entry !== install.dir);
  env[key] = [install.dir, ...rest].join(separator);
  env.OFFICECLI_SKIP_UPDATE = "1";
  env.OFFICECLI_NO_AUTO_INSTALL = "1";
  env.OFFICECLI_STATE_DIR = officeCliStateDir();
  // A resident `open` holds edits in memory for ~10s, and the preview, the file snapshot and
  // the 「已修改文件」 card all read the disk. Flushing every change is the difference between a
  // preview of the document and a preview of what it was before the last edit.
  env.OFFICECLI_RESIDENT_FLUSH = "each";
  return install.dir;
}

/**
 * Flush and release the resident process holding an Office file, so the disk is the only copy.
 *
 * Needed before FastVibe itself rewrites the file (the retry rewind): the resident keeps edits in
 * memory and writes them out later, which would put the attempt being undone back on top of the
 * restored document. `close` is a no-op for a file with no resident, and a non-Office path is
 * skipped without spawning anything. It never throws — a rewind must not fail because a helper
 * process would not close.
 */
export async function releaseOfficeResident(
  file: string,
  install: OfficeCliInstall = officeCliInstall(),
  run: (binary: string, args: string[]) => Promise<void> = runClose,
): Promise<void> {
  if (!install.binary || !officeFormatOf(file)) return;
  try {
    await run(install.binary, ["close", file]);
  } catch {
    // Nothing to release, or it would not release; the rewind goes on.
  }
}

function runClose(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 10_000, windowsHide: true, env: process.env }, () => resolve());
  });
}
