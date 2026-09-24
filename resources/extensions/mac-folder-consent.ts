import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * macOS asks once per protected folder — Desktop, Documents, Downloads, plus
 * iCloud, a cloud-storage provider, and each external volume. The answer is
 * supposed to stick. It does not, when the syscall that raises the dialog runs
 * on a libuv worker: the tools read through `fs/promises`, the user clicks
 * Allow, and the next file in the same folder asks again.
 *
 * A synchronous stat of the folder root, from this function, runs on the main
 * thread. That is the access macOS records. Call it before the tool, and only
 * for a folder the call is actually about to touch — never up front for every
 * protected folder, and never as a Full Disk Access prompt.
 */

const HOME_FOLDERS = ["Desktop", "Documents", "Downloads"] as const;

/** Folders already stated this process. The grant itself lives in TCC. */
const remembered = new Set<string>();

function sameOrInside(root: string, target: string): boolean {
  const base = root.toLowerCase();
  const path = target.toLowerCase();
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** The protected folder that contains `targetPath`, or null when macOS will not ask. */
export function protectedFolderRoot(targetPath: string, home: string): string | null {
  const target = resolve(targetPath);
  const base = resolve(home);
  for (const name of HOME_FOLDERS) {
    const root = join(base, name);
    if (sameOrInside(root, target)) return root;
  }
  const icloud = join(base, "Library", "Mobile Documents");
  if (sameOrInside(icloud, target)) return icloud;
  const cloud = join(base, "Library", "CloudStorage");
  if (sameOrInside(cloud, target) && target !== cloud) {
    const provider = target.slice(cloud.length + 1).split(sep)[0];
    if (provider) return join(cloud, provider);
  }
  const volume = /^\/volumes\/([^/]+)/i.exec(target);
  if (volume?.[1]) return `/Volumes/${volume[1]}`;
  return null;
}

function expandHome(token: string, home: string): string {
  if (token.startsWith("~/")) return join(home, token.slice(2));
  if (token.startsWith("${HOME}/")) return join(home, token.slice("${HOME}/".length));
  if (token.startsWith("$HOME/")) return join(home, token.slice("$HOME/".length));
  return token;
}

const COMMAND_PATH = /(?:~|\$\{HOME\}|\$HOME)\/[^\s"'\\;|&<>]+|\/Volumes\/[^\s"'\\;|&<>]+|\/Users\/[^\s"'\\;|&<>]+/gi;
const RELATIVE_FOLDER = /(?:^|[\s'"=])((?:Desktop|Documents|Downloads)(?:\/[^\s"'\\;|&<>]*)?)/g;

/** Protected folders a shell command names, plus a bare `Desktop` when cwd makes it one. */
export function protectedRootsInCommand(command: string, cwd: string, home: string): string[] {
  const roots = new Set<string>();
  const add = (token: string): void => {
    const root = protectedFolderRoot(expandHome(token, home), home);
    if (root) roots.add(root);
  };
  for (const match of command.matchAll(COMMAND_PATH)) add(match[0]);
  for (const match of command.matchAll(RELATIVE_FOLDER)) {
    const root = protectedFolderRoot(resolve(cwd, match[1] ?? ""), home);
    if (root) roots.add(root);
  }
  return [...roots];
}

const FS_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

function inputString(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function resolveToolPath(cwd: string, raw: string, home: string): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(home, trimmed.slice(1)) : trimmed;
  return resolve(cwd, expanded);
}

/** Folder roots this call will touch. Empty when the call stays out of a protected folder. */
export function consentRootsForCall(tool: string, input: unknown, cwd: string, home: string): string[] {
  const roots = new Set<string>();
  if (FS_TOOLS.has(tool)) {
    const cwdRoot = protectedFolderRoot(resolve(cwd), home);
    if (cwdRoot) roots.add(cwdRoot);
  }
  const path = inputString(input, "path");
  if (path) {
    const root = protectedFolderRoot(resolveToolPath(cwd, path, home), home);
    if (root) roots.add(root);
  }
  if (tool === "bash" || tool === "powershell") {
    for (const root of protectedRootsInCommand(inputString(input, "command"), cwd, home)) roots.add(root);
  }
  return [...roots];
}

export function rememberProtectedFolders(
  roots: readonly string[],
  options?: {
    platform?: NodeJS.Platform;
    stat?: (path: string) => void;
    memory?: Set<string>;
  },
): void {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin" || roots.length === 0) return;
  const stat = options?.stat ?? statSync;
  const memory = options?.memory ?? remembered;
  for (const root of roots) {
    if (memory.has(root)) continue;
    try {
      stat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Allow can land in TCC and still fail the syscall that showed the dialog.
      // One more stat picks the grant up. A denial returns immediately the second
      // time, so this does not raise the dialog twice.
      if (code === "EPERM" || code === "EACCES") {
        try {
          stat(root);
        } catch {
          // The user said no, or the folder is not readable. The tool reports it.
        }
      }
    }
    memory.add(root);
  }
}

/** Stat each protected folder this tool call is about to touch. No-op off macOS. */
export function primeToolFolderConsent(tool: string, input: unknown, cwd: string): void {
  rememberProtectedFolders(consentRootsForCall(tool, input, cwd, homedir()));
}
