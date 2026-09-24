import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { uiText } from "../engine/ui-text";
import { defaultWorktreePath, expandUserPath, parseWorktreePorcelain, sanitizeSegment, type GitWorktreeInfo } from "../engine/worktree";

const execFileAsync = promisify(execFile);

export async function gitToplevel(cwd: string): Promise<string> {
  const root = (await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 })).stdout.trim();
  if (!root) throw new Error(uiText("无法识别 Git 项目", "Not a Git project"));
  return root;
}

export async function gitCommonRoot(cwd: string): Promise<string> {
  const raw = (await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { timeout: 5000 })).stdout.trim();
  if (!raw) throw new Error(uiText("无法识别 Git 项目", "Not a Git project"));
  const common = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return common.endsWith(".git") ? dirname(common) : await gitToplevel(cwd);
}

export async function gitBranch(cwd: string): Promise<string> {
  const branch = (await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5000 })).stdout.trim();
  return branch && branch !== "HEAD" ? branch : "HEAD";
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function createGitWorktree(project: string, id: string, options?: { path?: string; branch?: string; label?: string }): Promise<{ path: string; branch: string }> {
  const root = await gitToplevel(project);
  const projectName = basename(root);
  const safe = sanitizeSegment(options?.label || options?.branch || "run") || "run";
  const branch = (options?.branch?.trim() || `fastvibe/${safe}-${id.slice(0, 8)}`).replace(/^\/+/, "");
  if (!branch || branch.startsWith("-") || branch.includes("\0") || /\s/.test(branch)) {
    throw new Error(uiText("分支名称无效", "Invalid branch name"));
  }
  let path = options?.path?.trim()
    ? expandUserPath(options.path)
    : defaultWorktreePath(projectName, `${safe}-${id.slice(0, 8)}`);
  if (existsSync(path)) {
    if (options?.path?.trim()) throw new Error(uiText("该路径已存在", "That path already exists"));
    path = `${path}-${id.slice(0, 8)}`;
  }
  await mkdir(dirname(path), { recursive: true });
  const exists = await branchExists(root, branch);
  if (exists) {
    await execFileAsync("git", ["-C", root, "worktree", "add", path, branch], { timeout: 30000, maxBuffer: 128 * 1024 });
  } else {
    await execFileAsync("git", ["-C", root, "worktree", "add", "-b", branch, path, "HEAD"], { timeout: 30000, maxBuffer: 128 * 1024 });
  }
  return { path, branch };
}

export async function removeGitWorktree(path: string, project?: string): Promise<void> {
  const root = project && existsSync(project) ? project : path;
  await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", path], { timeout: 30000, maxBuffer: 128 * 1024 }).catch(() => undefined);
}

export async function listGitWorktrees(cwd: string | undefined, project: string | undefined): Promise<GitWorktreeInfo[]> {
  const root = cwd || project;
  if (!root) return [];
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5000, maxBuffer: 256 * 1024 });
    const cwdResolved = cwd ? resolve(cwd) : "";
    return parseWorktreePorcelain(stdout).map((item) => ({
      ...item,
      current: Boolean(cwdResolved) && resolve(item.path) === cwdResolved,
    }));
  } catch {
    return [];
  }
}
