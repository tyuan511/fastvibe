import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Parent directory for FastVibe-created worktrees: `~/.fastvibe/worktree`. */
export const WORKTREE_HOME_SEGMENTS = [".fastvibe", "worktree"] as const;

export type GitWorktreeInfo = {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: boolean;
  prunable?: boolean;
  current?: boolean;
};

export function worktreeHome(home = homedir()): string {
  return join(home, ...WORKTREE_HOME_SEGMENTS);
}

/** `~/.fastvibe/worktree/<project-name>` — default parent for a project's worktrees. */
export function defaultWorktreeDir(projectName: string, home = homedir()): string {
  return join(worktreeHome(home), sanitizeSegment(projectName) || "project");
}

/** Default checkout path under the per-project directory. */
export function defaultWorktreePath(projectName: string, folder: string, home = homedir()): string {
  return join(defaultWorktreeDir(projectName, home), sanitizeSegment(folder) || "run");
}

export function sanitizeSegment(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return trimmed.slice(0, 64);
}

export function expandUserPath(value: string, home = homedir()): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  return trimmed;
}

export function isManagedWorktreePath(path: string, extraRoots: readonly string[] = [], home = homedir()): boolean {
  const roots = [worktreeHome(home), ...extraRoots.filter(Boolean)];
  const candidate = resolve(path);
  return roots.some((root) => {
    const base = resolve(root);
    const within = relative(base, candidate);
    return within === "" || (!within.startsWith("..") && !isAbsolute(within));
  });
}

export function parseWorktreePorcelain(stdout: string): GitWorktreeInfo[] {
  const items: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | undefined;
  const flush = (): void => {
    if (current) items.push(current);
    current = undefined;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line === "prunable") current.prunable = true;
  }
  flush();
  return items;
}
