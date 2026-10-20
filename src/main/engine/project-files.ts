import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectFileHit } from "@shared/types";
import { folderName } from "../../shared/project-folders.ts";

const execFileAsync = promisify(execFile);

/** How many rows the composer menu can show. Filtering is the way past this. */
const RESULT_LIMIT = 12;
/** A non-git walk stops here so a huge tree cannot be read whole into the menu. */
const WALK_CAP = 8_000;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX = 8;

/**
 * Directories the file tree never shows. A mention list that offered them would
 * be noise the tree itself refuses to draw.
 */
const HIDDEN = new Set([".git", "node_modules"]);

type CacheEntry = { at: number; files: string[] };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string[]>>();

/**
 * Files under `cwd` that match `query`, best first.
 *
 * A git work tree is listed with `ls-files` so ignored build output stays out.
 * Anything else is walked, skipping the same heavy directories the file tree
 * hides, and never following a symlink (that would leave the project). The list
 * is cached briefly: the menu filters on every keystroke, and spawning git each
 * time is the slow part.
 *
 * `otherFolders` are a multi-folder project's other folders. Their files are ranked
 * together with the working directory's, and named after their folder
 * (`web/src/App.tsx`), the way the transcript names them, so two `README.md` can be
 * told apart. A file reachable from two roots (a folder nested in another) is listed
 * once, under the first.
 */
export async function searchProjectFiles(cwd: unknown, query: unknown, otherFolders: readonly unknown[] = []): Promise<ProjectFileHit[]> {
  const root = await projectRoot(cwd);
  if (!root) return [];
  const roots = [root];
  for (const folder of otherFolders) {
    const extra = await projectRoot(folder);
    if (extra && !roots.includes(extra)) roots.push(extra);
  }
  // The working directory's listing failing is an error the menu reports; another
  // folder that went missing only drops out of the results.
  const listed = await Promise.all(roots.map((item, index) => (index === 0 ? listFiles(item) : listFiles(item).catch(() => []))));
  const hits: ProjectFileHit[] = [];
  const seen = new Set<string>();
  roots.forEach((item, index) => {
    const prefix = index === 0 ? "" : `${folderName(item)}/`;
    for (const file of listed[index] ?? []) {
      if (!safeRelative(file)) continue;
      const path = join(item, ...file.split("/"));
      if (seen.has(path)) continue;
      seen.add(path);
      hits.push({ relative: prefix + file, path });
    }
  });
  return rankBy(hits, (hit) => hit.relative, normalizeQuery(query), RESULT_LIMIT);
}

export function rankProjectFiles(files: readonly string[], query: string, limit: number): string[] {
  return rankBy(files.filter((file) => safeRelative(file)), (file) => file, normalizeQuery(query), limit);
}

function rankBy<T>(items: readonly T[], label: (item: T) => string, q: string, limit: number): T[] {
  const scored = items.map((item) => ({ item, file: label(item), score: scoreFile(label(item), q) }));
  const matched = q ? scored.filter((entry) => entry.score > 0) : scored;
  matched.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const cap = Number.isFinite(limit) ? Math.max(0, Math.min(RESULT_LIMIT, Math.floor(limit))) : RESULT_LIMIT;
  return matched.slice(0, cap).map((entry) => entry.item);
}

function normalizeQuery(query: unknown): string {
  if (typeof query !== "string") return "";
  return query.replace(/\\/g, "/").replace(/^\.\//, "").trim().slice(0, 200).toLowerCase();
}

function safeRelative(file: string): boolean {
  if (!file || file.includes("\0") || file.startsWith("/") || file.includes("\\")) return false;
  return !file.split("/").includes("..");
}

function scoreFile(file: string, query: string): number {
  const path = file.toLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!query) return 100 - Math.min(99, path.split("/").length);
  if (name === query || path === query) return name === query ? 1000 : 950;
  if (name.startsWith(query)) return 800 - Math.min(100, name.length);
  if (path.endsWith(`/${query}`)) return 750;
  const nameAt = name.indexOf(query);
  if (nameAt >= 0) return 600 - nameAt;
  const pathAt = path.indexOf(query);
  if (pathAt >= 0) return 400 - Math.min(200, pathAt);
  // Fuzzy only the file name, and only from a boundary. A subsequence across the
  // whole path matches almost everything (`nope` inside `compact-notice`).
  const fuzzyName = fuzzyScore(name, query);
  return fuzzyName > 0 && boundaryAt(name, name.indexOf(query[0] ?? "")) ? 200 + fuzzyName : 0;
}

function boundaryAt(text: string, index: number): boolean {
  if (index <= 0) return index === 0;
  const prev = text[index - 1];
  return prev === "/" || prev === "-" || prev === "_" || prev === ".";
}

/** Consecutive hits score higher, and a hit on a path boundary scores higher still. */
function fuzzyScore(text: string, query: string): number {
  let score = 0;
  let from = 0;
  let streak = 0;
  for (const ch of query) {
    const found = text.indexOf(ch, from);
    if (found < 0) return 0;
    streak = found === from ? streak + 1 : 1;
    score += streak * 3;
    const boundary = found === 0 || text[found - 1] === "/" || text[found - 1] === "-" || text[found - 1] === "_" || text[found - 1] === ".";
    if (boundary) score += 4;
    from = found + 1;
  }
  return score;
}

async function projectRoot(cwd: unknown): Promise<string | null> {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.includes("\0")) return null;
  const root = resolve(cwd);
  try {
    const info = await stat(root);
    return info.isDirectory() ? root : null;
  } catch {
    return null;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;
  const pending = inflight.get(root);
  if (pending) return pending;
  const job = loadFiles(root).then((files) => {
    cache.set(root, { at: Date.now(), files });
    if (cache.size > CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    inflight.delete(root);
    return files;
  }).catch((error: unknown) => {
    inflight.delete(root);
    throw error;
  });
  inflight.set(root, job);
  return job;
}

async function loadFiles(root: string): Promise<string[]> {
  const fromGit = await gitFiles(root);
  if (fromGit) return fromGit.filter(safeRelative);
  return walkFiles(root);
}

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    // Not a work tree, or git is missing. The walk is the other answer.
    return null;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length < WALK_CAP) {
    const dir = queue.shift() ?? "";
    let entries;
    try {
      entries = await readdir(dir ? join(root, ...dir.split("/")) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (HIDDEN.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) dirs.push(relative);
      else if (entry.isFile()) files.push(relative);
      if (files.length >= WALK_CAP) break;
    }
    dirs.sort((a, b) => a.localeCompare(b));
    queue.push(...dirs);
  }
  return files;
}
