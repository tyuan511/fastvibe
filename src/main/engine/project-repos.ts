import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectRepo } from "../../shared/types.ts";
import { type FolderPromptInfo } from "../../shared/project-folders.ts";

const execFileAsync = promisify(execFile);

export async function gitTopLevel(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function gitBranch(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One entry per git repository. Two folders inside the same checkout (a repo and
 * one of its subdirectories) collapse to that checkout, so the same changes are
 * not counted twice.
 */
export async function resolveProjectRepos(folders: string[]): Promise<ProjectRepo[]> {
  const byRoot = new Map<string, ProjectRepo>();
  for (const folder of folders) {
    const root = await gitTopLevel(folder);
    if (!root) continue;
    const existing = byRoot.get(root);
    if (existing) {
      if (!existing.folders.includes(folder)) existing.folders.push(folder);
      continue;
    }
    byRoot.set(root, { root, folders: [folder], branch: await gitBranch(root) });
  }
  return [...byRoot.values()];
}

export async function describeProjectFolders(paths: string[], primary: string): Promise<FolderPromptInfo[]> {
  const repos = await resolveProjectRepos(paths);
  const byFolder = new Map<string, ProjectRepo>();
  for (const repo of repos) {
    for (const folder of repo.folders) byFolder.set(folder, repo);
  }
  return paths.map((path) => {
    const repo = byFolder.get(path);
    return {
      path,
      primary: path === primary,
      repository: Boolean(repo),
      branch: repo?.branch,
    };
  });
}
