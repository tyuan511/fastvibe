import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import type { GitComparison, GitCommitOptions, GitDiffSource, GitHistory, GitHistoryScope, GitReference, GitStatus } from "../shared/ipc.ts";
import { uiText } from "./engine/ui-text.ts";
import { readGitStatus } from "./workspace-git.ts";

const exec = promisify(execFile);
const LIMIT = 4 * 1024 * 1024;

async function git(cwd: string, args: string[], diffExit = false, timeout = 15_000): Promise<string> {
  if (!cwd || cwd.includes("\0")) throw new Error("Invalid repository path");
  try {
    return (await exec("git", ["--no-optional-locks", "--literal-pathspecs", "-C", cwd, ...args], {
      timeout, maxBuffer: LIMIT,
    })).stdout;
  } catch (error) {
    // --no-index returns 1 for a successfully produced patch, not a failed read.
    if (diffExit && error && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string") return error.stdout;
    throw error;
  }
}

async function hasHead(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
}

async function comparison(cwd: string, revision?: string): Promise<{ base: string; target: string; args: string[] }> {
  if (revision) {
    // History opens immutable commits, never caller-supplied revision expressions/options.
    if (!/^[0-9a-f]{40,64}$/i.test(revision)) throw new Error("Invalid commit id");
    const hash = (await git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
    const parents = (await git(cwd, ["rev-list", "--parents", "-n", "1", hash])).trim().split(" ").slice(1);
    return { base: parents[0] ?? "", target: hash, args: ["diff-tree", "--root", "--no-commit-id", "-r", ...(parents[0] ? [parents[0], hash] : [hash])] };
  }
  // Match the patch to the exact same merge base used to enumerate the files.
  const base = (await git(cwd, ["merge-base", "@{upstream}", "HEAD"])).trim();
  return { base, target: "HEAD", args: ["diff", base, "HEAD"] };
}

export async function readGitComparison(cwd: string, revision?: string): Promise<GitComparison> {
  const plan = await comparison(cwd, revision);
  const [output, prefixText] = await Promise.all([
    git(cwd, [...plan.args, "--name-status", "--no-renames", "--no-relative", "-z", "--"]),
    git(cwd, ["rev-parse", "--show-prefix"]),
  ]);
  const prefix = prefixText.replace(/\r?\n$/, "");
  const records = output.split("\0");
  const files: GitStatus["files"] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    if (records[i] && records[i + 1]) files.push({ path: prefix ? posix.relative(prefix, records[i + 1]) : records[i + 1], index: " ", worktree: records[i][0] });
  }
  return { base: plan.base, target: plan.target, files };
}

export async function readGitDiff(cwd: string, path?: string, source: GitDiffSource = "unstaged", revision?: string): Promise<string> {
  if (path?.includes("\0")) throw new Error("Invalid file path");
  const options = ["--no-ext-diff", "--no-textconv", "--no-color", "--unified=5"];
  if (revision || source === "branch") {
    const plan = await comparison(cwd, revision);
    return git(cwd, [...plan.args, "-p", "--no-renames", ...options, "--", ...(path ? [path] : [])]);
  }
  if (path && source !== "staged") {
    const status = await readGitStatus(cwd);
    const file = status.files.find((item) => resolve(cwd, item.path) === resolve(cwd, path));
    if (file?.index === "?" || (source === "last-turn" && file?.index === "A" && !await hasHead(cwd))) return git(cwd, ["diff", "--no-index", ...options, "--", "/dev/null", resolve(cwd, path)], true);
  }
  const args = ["diff", ...options];
  if (source === "staged") args.push("--cached");
  else if (source === "last-turn" && await hasHead(cwd)) args.push("HEAD");
  args.push("--", ...(path ? source === "staged" ? await includeRenameSources(cwd, [path]) : [path] : []));
  return git(cwd, args);
}

/** Read real topology and decorated refs. Pagination keeps its original tips across new commits. */
export async function readGitHistory(cwd: string, skip = 0, scope: GitHistoryScope = "all", tips?: string[]): Promise<GitHistory> {
  const offset = Number.isSafeInteger(skip) ? Math.min(100_000, Math.max(0, skip)) : 0;
  await git(cwd, ["rev-parse", "--git-dir"]);
  const [headText, branchText, refText] = await Promise.all([
    git(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    git(cwd, ["for-each-ref", "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)%00%(symref)", "refs/heads", "refs/remotes", "refs/tags"]),
  ]);
  const head = headText.trim() || undefined;
  const branch = branchText.trim() || undefined;
  const references = new Map<string, GitReference[]>();
  for (const line of refText.split("\n").filter(Boolean)) {
    const [object, type, peeled, peeledType, ref, symbolic] = line.split("\0");
    const hash = type === "commit" ? object : peeledType === "commit" ? peeled : undefined;
    if (!hash || !ref || symbolic) continue;
    const kind = ref.startsWith("refs/heads/") ? "local" : ref.startsWith("refs/remotes/") ? "remote" : "tag";
    const name = ref.replace(/^refs\/(heads|remotes|tags)\//, "");
    const entry: GitReference = { name, kind, ...(kind === "local" && name === branch ? { current: true } : {}) };
    references.set(hash, [...(references.get(hash) ?? []), entry]);
  }
  if (tips !== undefined && (!Array.isArray(tips) || tips.length > 2048 || tips.some((tip) => typeof tip !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tip)))) throw new Error("Invalid history cursor");
  const roots = tips ?? [...new Set([...(head ? [head] : []), ...(scope === "all" ? references.keys() : [])])];
  if (!roots.length) return { commits: [], hasMore: false, tips: roots, head, branch };
  const output = await git(cwd, ["log", "--topo-order", "--max-count=51", `--skip=${offset}`, "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%B", "-z", ...roots, "--"]);
  const fields = output.split("\0");
  const commits: GitHistory["commits"] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    commits.push({ hash: fields[i], parents: fields[i + 1].split(" ").filter(Boolean), subject: fields[i + 2], author: fields[i + 3], date: fields[i + 4], body: fields[i + 5].trimEnd(), refs: references.get(fields[i]) ?? [], isHead: fields[i] === head });
  }
  return { commits: commits.slice(0, 50), hasMore: commits.length > 50, tips: roots, head, branch };
}

function validPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || !paths.length || paths.some((path) => typeof path !== "string" || !path || path.includes("\0"))) throw new Error("No valid files selected");
  return paths;
}

export async function stageGitFiles(cwd: string, paths?: string[], all = false): Promise<GitStatus> {
  await git(cwd, ["add", ...(all || !paths?.length ? ["-A"] : []), "--", ...(paths?.length ? validPaths(paths) : [])]);
  return readGitStatus(cwd);
}

async function includeRenameSources(cwd: string, paths: string[]): Promise<string[]> {
  const output = await git(cwd, ["diff", "--cached", "--name-status", "--find-renames", "--no-relative", "-z", "--"]);
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "");
  const fields = output.split("\0");
  const result = new Set(paths);
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const from = fields[i++];
    if (!status || !from) break;
    if (status[0] === "R" || status[0] === "C") {
      const to = fields[i++];
      const oldPath = prefix ? posix.relative(prefix, from) : from;
      const newPath = prefix ? posix.relative(prefix, to) : to;
      if (status[0] === "R" && paths.some((path) => resolve(cwd, path) === resolve(cwd, newPath))) result.add(oldPath);
    }
  }
  return [...result];
}

export async function unstageGitFiles(cwd: string, paths: string[]): Promise<GitStatus> {
  validPaths(paths);
  paths = await includeRenameSources(cwd, paths);
  await git(cwd, await hasHead(cwd) ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-f", "--", ...paths]);
  return readGitStatus(cwd);
}

export async function discardGitFiles(cwd: string, paths: string[]): Promise<GitStatus> {
  validPaths(paths);
  const status = await readGitStatus(cwd);
  const files = paths.map((path) => {
    const file = status.files.find((item) => resolve(cwd, item.path) === resolve(cwd, path));
    if (!file || /U/.test(file.index + file.worktree) || ["AA", "DD"].includes(file.index + file.worktree)) throw new Error("Refresh changes before discarding this file");
    return file;
  });
  const tracked = files.filter((file) => file.index !== "?");
  // Restore from the index, preserving the user's staged version of a partially staged file.
  if (tracked.length) await git(cwd, ["restore", "--worktree", "--", ...tracked.map((file) => file.path)]);
  // Status lists individual untracked files. Never recursively remove directories.
  for (const file of files.filter((item) => item.index === "?")) await unlink(resolve(cwd, file.path));
  return readGitStatus(cwd);
}

/** Commit the index only; amend may keep the previous message when the input is empty. */
export async function commitGitChanges(cwd: string, message: string, options?: GitCommitOptions): Promise<GitStatus> {
  const subject = typeof message === "string" ? message.trim() : "";
  const amend = options?.amend === true;
  if (!subject && !amend) throw new Error(uiText("提交信息不能为空", "Commit message cannot be empty"));
  if (subject.length > 5000) throw new Error(uiText("提交信息过长", "Commit message is too long"));
  if (amend && !await hasHead(cwd)) throw new Error(uiText("还没有可修订的提交", "There is no commit to amend"));
  await git(cwd, ["commit", ...(amend ? ["--amend"] : []), ...(subject ? ["-m", subject] : ["--no-edit"])], false, 30_000);
  return readGitStatus(cwd);
}
