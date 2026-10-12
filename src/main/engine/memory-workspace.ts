import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKSPACE_DIFF_FILE } from "./memory-templates.ts";

/**
 * What changed in the memory folder since the last consolidation that succeeded.
 *
 * Codex keeps the folder in a git repository and hands the consolidation agent
 * `phase2_workspace_diff.md`, the diff from the last baseline. FastVibe cannot count on a
 * `git` binary, so the baseline is a plain copy of the folder kept beside it, and the diff is
 * produced here in the same git style. The same file also answers the other question git
 * answered: nothing changed means there is nothing to consolidate, and the agent is not run.
 */

/** A folder as `path → content`, paths relative and `/`-separated. */
export type Tree = Map<string, string>;

/** Codex truncates the diff file at this size (`workspace_diff::MAX_BYTES`). */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const CONTEXT = 3;
/** Past this many edits Myers' trace costs more memory than the answer is worth: the file is shown replaced. */
const MAX_EDITS = 1_500;

export type FileChange = { status: "added" | "modified" | "deleted"; path: string };

/** Read every regular file under `root` (not hidden ones, not the diff file, never through a symlink). */
export async function readTree(root: string): Promise<Tree> {
  const tree: Tree = new Map();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === WORKSPACE_DIFF_FILE) continue;
      const full = join(dir, name);
      const info = await lstat(full).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(full, relative);
      else if (info.isFile()) tree.set(relative, await readFile(full, "utf8").catch(() => ""));
    }
  };
  await walk(root, "");
  return tree;
}

/**
 * A memory folder is read and written by a model; a symlink in it could point the next
 * reader anywhere. They are removed (Codex does the same) and counted, so a run that
 * produced one is not mistaken for a good one.
 */
export async function removeSymlinks(root: string): Promise<number> {
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) { await rm(full, { force: true }); removed += 1; }
      else if (info.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return removed;
}

export async function readBaseline(dir: string): Promise<Tree> {
  return readTree(dir);
}

/** Make the baseline an exact copy of `tree`. */
export async function writeBaseline(dir: string, tree: Tree): Promise<void> {
  const next = `${dir}.next`;
  await rm(next, { recursive: true, force: true });
  await mkdir(next, { recursive: true });
  for (const [path, content] of tree) {
    const file = join(next, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  await rm(dir, { recursive: true, force: true });
  await rename(next, dir);
}

export function changesBetween(baseline: Tree, current: Tree): FileChange[] {
  const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const changes: FileChange[] = [];
  for (const path of paths) {
    const before = baseline.get(path);
    const after = current.get(path);
    if (before === undefined) changes.push({ status: "added", path });
    else if (after === undefined) changes.push({ status: "deleted", path });
    else if (before !== after) changes.push({ status: "modified", path });
  }
  return changes;
}

type Op = { op: " " | "-" | "+"; line: string };

/** Myers' O(ND) line diff; `null` when the files differ by more than `MAX_EDITS` lines. */
function lineDiff(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d, offset);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], last: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = last; d >= 0; d -= 1) {
    if (d === 0) {
      while (x > 0 && y > 0) { ops.push({ op: " ", line: a[x - 1] }); x -= 1; y -= 1; }
      break;
    }
    const v = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = v[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { ops.push({ op: " ", line: a[x - 1] }); x -= 1; y -= 1; }
    if (x === previousX) ops.push({ op: "+", line: b[previousY] });
    else ops.push({ op: "-", line: a[previousX] });
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}

const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Group ops into unified hunks with `CONTEXT` lines around each change. */
function hunks(ops: Op[]): string[] {
  const position: Array<[number, number]> = [];
  let a = 1;
  let b = 1;
  for (const entry of ops) {
    position.push([a, b]);
    if (entry.op !== "+") a += 1;
    if (entry.op !== "-") b += 1;
  }
  const changed = ops.flatMap((entry, index) => (entry.op === " " ? [] : [index]));
  const out: string[] = [];
  for (let from = 0; from < changed.length;) {
    // Changes closer than two contexts apart share a hunk.
    let to = from;
    while (to + 1 < changed.length && changed[to + 1] - changed[to] <= CONTEXT * 2 + 1) to += 1;
    const start = Math.max(0, changed[from] - CONTEXT);
    const stop = Math.min(ops.length, changed[to] + CONTEXT + 1);
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((entry) => entry.op !== "+").length;
    const newCount = slice.filter((entry) => entry.op !== "-").length;
    const [oldStart, newStart] = position[start];
    out.push(`@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`);
    for (const entry of slice) out.push(`${entry.op}${entry.line}`);
    from = to + 1;
  }
  return out;
}

/** The git-style diff of one file; added and deleted files are shown whole. */
function fileDiff(path: string, before: string | undefined, after: string | undefined): string[] {
  const head = [`diff --git a/${path} b/${path}`];
  const old = linesOf(before ?? "");
  const next = linesOf(after ?? "");
  if (before === undefined) head.push("new file mode 100644", "--- /dev/null", `+++ b/${path}`);
  else if (after === undefined) head.push("deleted file mode 100644", `--- a/${path}`, "+++ /dev/null");
  else head.push(`--- a/${path}`, `+++ b/${path}`);
  const ops = lineDiff(old, next)
    ?? [...old.map((line): Op => ({ op: "-", line })), ...next.map((line): Op => ({ op: "+", line }))];
  return [...head, ...hunks(ops)];
}

/** `phase2_workspace_diff.md`, in Codex's layout: a status list, then the diff. */
export function renderWorkspaceDiff(baseline: Tree, current: Tree): string {
  const changes = changesBetween(baseline, current);
  let rendered = "# Memory Workspace Diff\n\nGenerated by FastVibe before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n## Status\n";
  if (changes.length === 0) return `${rendered}- none\n`;
  for (const change of changes) rendered += `- ${change.status} ${change.path}\n`;
  const diff = changes.flatMap((change) => fileDiff(change.path, baseline.get(change.path), current.get(change.path))).join("\n");
  rendered += "\n## Diff\n\n```diff\n";
  if (Buffer.byteLength(diff, "utf8") <= MAX_DIFF_BYTES) {
    rendered += `${diff}\n`;
  } else {
    rendered += `${Buffer.from(diff, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8").replace(/�+$/, "")}\n\n[workspace diff truncated at ${MAX_DIFF_BYTES} bytes]\n`;
  }
  return `${rendered}\`\`\`\n`;
}

/**
 * Did a consolidation leave what the readers need? `MEMORY.md` must be a file and
 * `memory_summary.md` must start with the line `v1` — the marker that lets a later run tell a
 * summary in this schema from an older one. Returns the reason it did not, or `null`.
 */
export async function validateArtifacts(root: string): Promise<string | null> {
  if (await removeSymlinks(root) > 0) return "the memory folder contained symbolic links, which were removed";
  const handbook = await lstat(join(root, "MEMORY.md")).catch(() => null);
  if (!handbook?.isFile()) return "MEMORY.md was not written";
  const summary = await readFile(join(root, "memory_summary.md"), "utf8").catch(() => null);
  if (summary === null) return "memory_summary.md was not written";
  if (summary.split("\n", 1)[0].replace(/\r$/, "") !== "v1") return "memory_summary.md does not start with the line v1";
  return null;
}
