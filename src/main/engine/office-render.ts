import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { officeSnapshotSeed, type OfficeSnapshotIdentity } from "../../shared/office.ts";
import { officeCliInstall, type OfficeCliInstall } from "./office-cli.ts";
import { getFastVibePaths } from "./paths.ts";
import { uiText } from "./ui-text.ts";

/**
 * A static Office preview: `officecli view <file> html -o <page>`, and the page it writes.
 *
 * This is the default rendering for every Office file the app shows — the transcript's viewer,
 * the side pane, a file on an SSH host, and later the phone. One short-lived subprocess per
 * file: no server, no port, no resident process behind a preview nobody asked to keep open. The
 * live `watch` server is the *other* rendering, and it belongs to the side pane alone, where a
 * person is actually reading while the agent edits.
 *
 * The output is a cache, and two things make keeping it safe: the key carries the file's
 * realpath, mtime and size plus the OfficeCLI version that rendered it, and the page is served
 * through the same `fastvibe-media://` handler as any other HTML file — so nothing here streams
 * bytes or holds anything open.
 *
 * Electron-free, with every side effect (the spawn, the install, the directory) injectable,
 * which is what lets `test/office-render-cache.test.ts` cover the cache key, the deduplication
 * and the eviction on a machine that has no OfficeCLI at all.
 */

/** One render is a whole document layout; past this the reader has given up, not hung. */
export const RENDER_TIMEOUT_MS = 60_000;
/** Headroom for a few hundred documents: a rendered page is tens of kilobytes. */
export const CACHE_BUDGET_BYTES = 512 * 1024 * 1024;
/** How much of the oldest page to hand back once the budget is over, so the sweep is not per-render. */
const CACHE_EVICTION_FLOOR = 0.75;
const MAX_STDERR_CHARS = 4_000;
/** An Office file is a zip; past this there is no honest render to attempt inside a minute. */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

export type OfficeRenderDeps = {
  /** Where the binary is. Defaults to what this install ships. */
  install?: OfficeCliInstall;
  /** Where pages are written; created on demand. */
  cacheDir?: string;
  /** Injectable for the test: run the renderer and resolve once the page exists. */
  render?: (input: { binary: string; source: string; target: string; timeoutMs: number }) => Promise<void>;
  timeoutMs?: number;
  cacheBudgetBytes?: number;
};

export type OfficeRenderResult = {
  /**
   * The rendered page, on the machine that rendered it — a path rather than a URL, because
   * that is what a client turns into `fastvibe-media://`, and what the gateway namespaces when
   * the page lives on an SSH host (`engine/remote-media.ts`).
   */
  path: string;
};

/** One render per key in flight, so two windows opening one file share one process. */
const inFlight = new Map<string, Promise<void>>();

function snapshotFile(identity: OfficeSnapshotIdentity, cacheDir: string): { key: string; path: string } {
  const key = createHash("sha256").update(officeSnapshotSeed(identity)).digest("hex").slice(0, 32);
  return { key, path: join(cacheDir, `${key}.html`) };
}

/**
 * Render one document, or hand back the page already cached for exactly this file and version.
 *
 * Throws a message meant for the preview surface: a failure here is the user's to see (an
 * encrypted, corrupt or unsaved document), and the pane shows it beside a retry.
 */
export async function renderOfficeSnapshot(sourcePath: string, deps: OfficeRenderDeps = {}): Promise<OfficeRenderResult> {
  const install = deps.install ?? officeCliInstall();
  const binary = install.binary;
  if (!binary) {
    throw new Error(uiText(
      "这台机器上的 FastVibe 没有内置 OfficeCLI，无法预览这个文件",
      "This FastVibe install carries no OfficeCLI, so the file cannot be previewed",
    ));
  }
  let info;
  try {
    info = statSync(sourcePath);
  } catch {
    throw new Error(uiText("文件不存在", "The file does not exist"));
  }
  if (!info.isFile()) throw new Error(uiText("不是文件", "Not a file"));
  if (info.size > MAX_SOURCE_BYTES) {
    throw new Error(uiText("文件太大，无法渲染预览", "File is too large to render a preview for"));
  }
  const realPath = realpathOf(sourcePath);
  const cacheDir = deps.cacheDir ?? officePreviewCacheDir();
  const { key, path } = snapshotFile(
    { realPath, mtimeMs: info.mtimeMs, size: info.size, version: install.version ?? "unknown" },
    cacheDir,
  );

  // A cached page stands for *this* file only while the identity that produced it holds — which
  // the key already encodes. `pageIsUsable` then checks the page itself: a half-written or
  // evicted file falls through to a fresh render rather than being served.
  if (pageIsUsable(path)) {
    touch(path);
    return { path };
  }

  // One render per key. A second window opening the same document waits on the first and takes
  // its result — including its failure, which is why the promise is awaited rather than
  // swallowed and retried: a corrupt file asked twice a second would be a render storm.
  const running = inFlight.get(key);
  if (running) {
    await running;
    return { path };
  }

  const promise = (async () => {
    mkdirSync(cacheDir, { recursive: true });
    const run = deps.render ?? runOfficeCli;
    try {
      await run({ binary, source: realPath, target: path, timeoutMs: deps.timeoutMs ?? RENDER_TIMEOUT_MS });
    } catch (error) {
      rmSync(path, { force: true });
      throw error instanceof Error && error.message.trim()
        ? error
        : new Error(uiText("渲染预览失败", "Could not render the preview"));
    }
    if (!pageIsUsable(path)) {
      rmSync(path, { force: true });
      throw new Error(uiText("渲染没有产出预览页面", "The renderer produced no preview page"));
    }
    trimCache(cacheDir, deps.cacheBudgetBytes ?? CACHE_BUDGET_BYTES);
  })();
  inFlight.set(key, promise);
  try {
    await promise;
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
  return { path };
}

function pageIsUsable(path: string): boolean {
  try {
    const page = statSync(path);
    return page.isFile() && page.size > 0;
  } catch {
    return false;
  }
}

/**
 * Make a cache hit look recently used without rewriting it.
 *
 * The eviction below orders pages by their own mtime, which is otherwise the moment they were
 * rendered: without this, a document being read for twenty minutes would be the first thing the
 * next render throws away.
 */
function touch(path: string): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // A cache that cannot be reordered is still a cache; the next sweep just orders by age.
  }
}

function realpathOf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export type OfficeCliRenderInput = {
  binary: string;
  source: string;
  target: string;
  timeoutMs: number;
};

/**
 * `officecli view <file> html -o <page>`, asynchronously, killable, and atomic.
 *
 * Async rather than `execFileSync`, which is what the preview did before: a synchronous render
 * blocked the main process for the whole document layout. And the page is written to a private
 * name then renamed, because a killed renderer leaves a truncated file behind, and the next
 * `pageIsUsable` check would have called that a preview.
 */
function runOfficeCli(input: OfficeCliRenderInput): Promise<void> {
  const partial = `${input.target}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(input.binary, ["view", input.source, "html", "-o", partial], {
        stdio: ["ignore", "ignore", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(spawnFailure(error));
      return;
    }
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      // Kill first, then reject on the `close` that follows, so the partial file is always
      // removed and never renamed.
      child.kill("SIGKILL");
      settle(new Error(uiText("渲染预览超时", "Rendering the preview took too long")));
    }, input.timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error) => {
      settle(spawnFailure(error));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        try {
          mkdirSync(dirname(input.target), { recursive: true });
          renameSync(partial, input.target);
          settle();
        } catch (error) {
          settle(spawnFailure(error));
        }
        return;
      }
      settle(new Error(officeRenderFailure(code, stderr)));
    });

    function settle(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(partial, { force: true });
      if (error) rejectPromise(error);
      else resolvePromise();
    }
  });
}

function spawnFailure(error: unknown): Error {
  if (error instanceof Error && error.message.trim()) return error;
  return new Error(uiText("无法启动 OfficeCLI", "Could not start OfficeCLI"));
}

/**
 * OfficeCLI's own last words, when it has any.
 *
 * A nonzero exit is usually a specific complaint — the file is encrypted, the package is
 * corrupt, the format is not one it accepts — and that sentence is what makes the pane's failure
 * state actionable instead of a retry loop.
 */
function officeRenderFailure(code: number | null, stderr: string): string {
  const reason = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Note:"))
    .join(" ");
  const tail = code === null ? "" : ` (code ${code})`;
  if (reason) return `${reason}${tail}`;
  return `${uiText("渲染预览失败", "Could not render the preview")}${tail}`;
}

/**
 * Keep the cache under its budget, least recently read first.
 *
 * Runs after a successful render, when there is a new page to account for. Over budget it drops
 * whole pages oldest-first down to 75%, so a long session does not sweep on every single file.
 */
function trimCache(cacheDir: string, budgetBytes: number): void {
  const pages: Array<{ path: string; mtimeMs: number; size: number }> = [];
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".html")) continue;
    const path = join(cacheDir, name);
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      pages.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      total += info.size;
    } catch {
      // Vanished mid-sweep; there is nothing to free.
    }
  }
  if (total <= budgetBytes) return;
  const floor = budgetBytes * CACHE_EVICTION_FLOOR;
  for (const page of pages.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= floor) break;
    try {
      rmSync(page.path, { force: true });
      total -= page.size;
    } catch {
      // Leave it and let the next render try again.
    }
  }
}

let resolvedCacheDir: string | null = null;

/** `runtime/engine/office-preview/`, created on first use. */
export function officePreviewCacheDir(): string {
  if (!resolvedCacheDir) {
    resolvedCacheDir = join(getFastVibePaths().runtimeRoot, "office-preview");
    mkdirSync(resolvedCacheDir, { recursive: true });
  }
  return resolvedCacheDir;
}

/** A test seam, so a suite can point the cache at a temporary directory. */
export function setOfficePreviewCacheDir(dir: string | null): void {
  resolvedCacheDir = dir;
  inFlight.clear();
}

/** Absolute or nothing: a relative path would resolve against this process's cwd, not the caller's. */
export function assertAbsolutePreviewPath(filePath: unknown): string {
  const value = typeof filePath === "string" ? filePath.trim() : "";
  if (!value || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(uiText("路径无效", "Invalid path"));
  }
  return value;
}

/** The page for a file, already in the cache — used by the tests to read back what was rendered. */
export function readCachedPage(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
