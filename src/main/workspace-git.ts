import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatus } from "@shared/ipc";
import {
  classifyCommitFile,
  countPatchLines,
  parseCommitPorcelain,
  type CommitFileMaterial,
  type CommitStatusPath,
} from "./engine/commit-message";

const execFileAsync = promisify(execFile);


/**
 * `git status --short --branch` heads with `## main...origin/main [ahead 1]`,
 * `## No commits yet on main` in a fresh repo, and `## HEAD (no branch)` when
 * detached. Strip the decorations so the UI can print a bare ref name.
 */
function parseBranchHeader(header: string): string | undefined {
  const text = header.split("...")[0].trim();
  const name = (text.match(/^No commits yet on (.+)$/)?.[1] ?? text).replace(/ \(no branch\)$/, "").trim();
  return name || undefined;
}


export async function readCommitStatusFiles(cwd: string): Promise<CommitStatusPath[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseCommitPorcelain(stdout);
}


export async function collectCommitMessageMaterial(
  cwd: string,
  files: CommitStatusPath[],
): Promise<CommitFileMaterial[]> {
  const results: CommitFileMaterial[] = new Array(files.length);
  // Read bodies from at most 128 files, rotating across top-level directories so one
  // generated subtree cannot consume the whole collection budget. Every other path
  // still reaches the planner as metadata.
  const queues = new Map<string, number[]>();
  files.forEach((file, index) => {
    const kind = classifyCommitFile(file.path);
    if (file.index === "?" || file.worktree === "?" || kind === "lock" || kind === "generated") return;
    const slash = file.path.indexOf("/");
    const area = slash > 0 ? file.path.slice(0, slash) : "root";
    const queue = queues.get(area) ?? [];
    queue.push(index);
    queues.set(area, queue);
  });
  const bodyIndexes = new Set<number>();
  while (bodyIndexes.size < 128) {
    let added = false;
    for (const queue of queues.values()) {
      const index = queue.shift();
      if (index === undefined) continue;
      bodyIndexes.add(index);
      added = true;
      if (bodyIndexes.size >= 128) break;
    }
    if (!added) break;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      if (!file) return;
      const status = `${file.index}${file.worktree}`;
      const initialKind = classifyCommitFile(file.path);
      if (!bodyIndexes.has(index)) {
        results[index] = {
          path: file.displayPath,
          status,
          kind: initialKind,
          omitted: file.index === "?" || file.worktree === "?"
            ? "untracked: metadata only"
            : initialKind === "lock" || initialKind === "generated"
              ? undefined
              : "content collection limit",
        };
        continue;
      }
      // Porcelain paths are repository-root relative even when the bound workspace is
      // a subdirectory. `top` keeps the literal path anchored to that same root.
      const pathspec = `:(top,literal)${file.path}`;
      let patch = "";
      let omitted: string | undefined;
      try {
        patch = (await execFileAsync(
          "git",
          ["-C", cwd, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--unified=3", "--", pathspec],
          { timeout: 5000, maxBuffer: 128 * 1024 },
        )).stdout;
      } catch (error) {
        const partial = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "";
        if (partial) {
          patch = partial;
          omitted = "diff truncated";
        } else {
          const [staged, working] = await Promise.all([
            execFileAsync("git", ["-C", cwd, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3", "--", pathspec], { timeout: 5000, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: "" })),
            execFileAsync("git", ["-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--", pathspec], { timeout: 5000, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: "" })),
          ]);
          patch = `${staged.stdout}\n${working.stdout}`.trim();
          if (!patch) omitted = "diff unavailable";
        }
      }
      const stats = countPatchLines(patch);
      results[index] = {
        path: file.displayPath,
        status,
        patch,
        ...stats,
        kind: classifyCommitFile(file.path, patch),
        omitted,
      };
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}


function parseGitNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    const [added, removed] = line.split("\t", 3);
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }
  return { additions, deletions };
}

/**
 * A read-only git call made behind the user's back (the composer's branch chip polls).
 * `--no-optional-locks` keeps `status` and `diff` from taking `index.lock` to save a
 * refreshed index: the agent's own `git add` / `git commit` in the same tree would
 * otherwise find the lock held and fail.
 */
function gitRead(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("git", ["--no-optional-locks", "-C", cwd, ...args], { timeout: 5000, maxBuffer: 256 * 1024 });
}

/**
 * Workspaces whose last read found no repository. The poll keeps asking about them (a
 * `git init` has to be noticed), but a second process started beside `status` only to
 * fail with it is waste, so these go back to asking `status` first.
 */
const notRepositories = new Set<string>();

export async function readGitStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = { cwd, isRepository: false, changed: 0, staged: 0, additions: 0, deletions: 0, files: [] };
  // Settled to `null` on failure, so a rejection nobody is awaiting yet is never unhandled.
  const readHeadStats = () => gitRead(cwd, ["diff", "--numstat", "HEAD", "--"]).then((diff) => parseGitNumstat(diff.stdout), () => null);
  // Started beside `status`, not after it: neither needs the other's answer, and on a
  // large tree each is most of a second.
  const eager = notRepositories.has(cwd) ? undefined : readHeadStats();
  try {
    const { stdout } = await gitRead(cwd, ["status", "--short", "--branch"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const header = lines.shift() ?? "";
    if (!header.startsWith("## ")) {
      notRepositories.add(cwd);
      return empty;
    }
    notRepositories.delete(cwd);
    const branch = parseBranchHeader(header.slice(3));
    const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0);
    let changed = 0;
    let staged = 0;
    const files: GitStatus["files"] = [];
    for (const line of lines) {
      if (line.length < 2) continue;
      changed += 1;
      if (line[0] !== " " && line[0] !== "?") staged += 1;
      files.push({ index: line[0] === "?" ? "?" : line[0], worktree: line[1] ?? " ", path: line.slice(3).trim() });
    }
    let stats = await (eager ?? readHeadStats());
    if (!stats) {
      // An unborn branch has no HEAD. Its staged and unstaged layers are still useful,
      // and summing them is the closest line-level status available before first commit.
      const [stagedDiff, workingDiff] = await Promise.all([
        gitRead(cwd, ["diff", "--numstat", "--cached", "--"]).catch(() => ({ stdout: "" })),
        gitRead(cwd, ["diff", "--numstat", "--"]).catch(() => ({ stdout: "" })),
      ]);
      const stagedStats = parseGitNumstat(stagedDiff.stdout);
      const workingStats = parseGitNumstat(workingDiff.stdout);
      stats = { additions: stagedStats.additions + workingStats.additions, deletions: stagedStats.deletions + workingStats.deletions };
    }
    return { cwd, isRepository: true, branch, changed, staged, ...stats, ahead, behind, files };
  } catch {
    notRepositories.add(cwd);
    return empty;
  }
}
