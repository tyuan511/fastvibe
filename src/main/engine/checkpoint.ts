import { execFile } from "node:child_process";
import { readFileSync, statSync, type Stats } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `git rev-parse HEAD` per workspace, held briefly.
 *
 * Capture runs once per written file, so a turn that touches fifty files would spawn
 * fifty git processes for a value that cannot change unless the agent commits. A short
 * TTL still notices a commit made mid-turn, without paying for one process per write.
 */
const headCache = new Map<string, { head: string | undefined; at: number }>();
const HEAD_TTL_MS = 3_000;

/**
 * A turn's file checkpoint — what the workspace looked like before it ran.
 *
 * Retry and edit rewind the *conversation* (`navigateTree`), but the working tree
 * stayed where the previous attempt left it. So 「重试这一轮」 re-ran the prompt against
 * code the aborted attempt had already changed, and the second run saw state the first
 * one created: a retry that tests a half-applied edit, or a `write` that is now a no-op
 * because the file already holds the new content. Both are silent — the transcript looks
 * right and only the result is wrong.
 *
 * This records enough to put the tree back: the files the turn touched, with their
 * contents from before it (text only, capped), plus whatever `git` already knew so a
 * tracked file can be restored from `HEAD` instead of copied. Deleted files are
 * recorded as such, because "restore" for a file the turn created is "remove it".
 *
 * It is deliberately *not* a general undo: one checkpoint is kept per conversation, it
 * only covers files the turn's own tools named, and the caller decides whether to apply
 * it. A workspace the user also edited by hand between the prompt and the retry is the
 * case this cannot fix — hence the explicit confirmation rather than an automatic rewind.
 */

/** Per-file bound on what is kept, so a huge generated file cannot bloat the store. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Per-conversation bound on the whole checkpoint. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Paths beyond this many files are recorded without a content copy. */
const MAX_COPIED_FILES = 200;

export type CheckpointFile = {
  /** Absolute path. */
  path: string;
  /** Content before the turn; absent when the file did not exist. */
  content?: string;
  /** True when the turn created it, so reverting means deleting it. */
  created?: boolean;
  /** True when the pre-turn content was too large / not text and could not be kept. */
  opaque?: boolean;
  /**
   * Byte length of `content`, measured when it was read.
   *
   * Carried rather than re-derived because `captureCheckpoint` runs once per written
   * file and weighs *every* file it has collected so far: a turn that writes fifty
   * files re-measured up to 32 MB of text fifty times over, on Main's event loop.
   */
  bytes?: number;
};

export type TurnCheckpoint = {
  conversationId: string;
  cwd: string;
  createdAt: number;
  /** Git revision to restore tracked files from, when the workspace is a repo. */
  head?: string;
  files: CheckpointFile[];
};

const checkpoints = new Map<string, TurnCheckpoint>();

/** Drop the checkpoint for a conversation (a new turn replaces it). */
export function clearCheckpoint(conversationId: string): void {
  checkpoints.delete(conversationId);
}

export function readCheckpoint(conversationId: string): TurnCheckpoint | undefined {
  return checkpoints.get(conversationId);
}

/** Persist the store so a checkpoint survives a reload within the same session. */
export async function saveCheckpoints(file: string): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    // Compact, not pretty: this holds whole file contents (up to 32 MB per
    // conversation) and is written while the app is quitting. Nothing reads it by eye.
    await writeFile(file, `${JSON.stringify([...checkpoints.values()])}\n`, "utf8");
  } catch {
    // A checkpoint is best-effort: losing it only means the retry prompt is not offered.
  }
}

export async function loadCheckpoints(file: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const checkpoint = item as Partial<TurnCheckpoint>;
      if (typeof checkpoint.conversationId !== "string" || !Array.isArray(checkpoint.files)) continue;
      checkpoints.set(checkpoint.conversationId, checkpoint as TurnCheckpoint);
    }
  } catch {
    // Absent or corrupt: nothing to restore from.
  }
}

/**
 * Read one file's pre-turn state.
 *
 * Synchronous on purpose: this runs from the engine's STREAM event handler on the line
 * before the tool is actually invoked, and an async read would race the very write it
 * is capturing — the original content would already be gone. Only called once per file
 * per turn (the caller caches by path).
 */
export function readBefore(path: string): CheckpointFile {
  let info: Stats;
  try {
    info = statSync(path);
  } catch (error) {
    // Only "no such file" means the turn is about to create it (so reverting means
    // deleting it). Anything else — a permission error, a broken symlink — is a file
    // that already exists and that this cannot snapshot; treating it as "created"
    // made restore delete something the turn never created.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { path, created: true } : { path, opaque: true };
  }
  // Measured before it is read, because the read is synchronous and on Main's event
  // loop: `readFileSync` on the 300 MB file an agent just generated would freeze the
  // whole app (and spike its memory) only to have the size check below discard it.
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return { path, opaque: true };
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    // Raced by the very write this is capturing, or unreadable: either way there is
    // no pre-turn content to keep, and the file demonstrably existed a moment ago.
    return { path, opaque: true };
  }
  // A NUL byte is the cheap, reliable "this is binary" signal `git` also uses.
  if (buffer.includes(0) || buffer.byteLength > MAX_FILE_BYTES) return { path, opaque: true };
  return { path, content: buffer.toString("utf8"), bytes: buffer.byteLength };
}

/**
 * Store the turn's captured files.
 *
 * The caller decides *which* files and what their pre-turn content was, because only it
 * knows the moment before the write — this just resolves the git revision (so tracked
 * files can be restored from `HEAD` rather than from a copy) and files the checkpoint.
 */
export async function captureCheckpoint(
  conversationId: string,
  cwd: string,
  files: CheckpointFile[],
): Promise<TurnCheckpoint> {
  // Keep the first `MAX_COPIED_FILES` with content; the rest are kept without it.
  const trimmed: CheckpointFile[] = [];
  let total = 0;
  let copied = 0;
  for (const file of files) {
    const bytes = file.content === undefined ? 0 : file.bytes ?? Buffer.byteLength(file.content, "utf8");
    if (file.content !== undefined && (copied >= MAX_COPIED_FILES || total + bytes > MAX_TOTAL_BYTES)) {
      trimmed.push({ path: file.path, opaque: true });
      continue;
    }
    if (file.content !== undefined) {
      copied += 1;
      total += bytes;
    }
    trimmed.push(file);
  }

  let head: string | undefined;
  const cached = headCache.get(cwd);
  if (cached && Date.now() - cached.at < HEAD_TTL_MS) {
    head = cached.head;
  } else {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 5000 });
      head = stdout.trim() || undefined;
    } catch {
      // Not a repo, or no commits yet. The copies are then the only restore path.
    }
    headCache.set(cwd, { head, at: Date.now() });
  }

  const checkpoint: TurnCheckpoint = {
    conversationId,
    cwd,
    createdAt: Date.now(),
    ...(head ? { head } : {}),
    files: trimmed,
  };
  checkpoints.set(conversationId, checkpoint);
  return checkpoint;
}

export type RestoreResult = { restored: string[]; removed: string[]; skipped: string[] };

/**
 * Put the workspace back to the checkpoint.
 *
 * Tracked files are restored from git first (one checkout), then the content copies are
 * written over — the copies are authoritative because they also cover untracked files
 * and because the git revision may be older than the turn. Files the turn created are
 * removed, but only when the file still exists.
 */
export async function restoreCheckpoint(checkpoint: TurnCheckpoint): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], removed: [], skipped: [] };

  const trackedPaths = checkpoint.files.filter((file) => file.content !== undefined || file.opaque).map((file) => file.path);
  if (checkpoint.head && trackedPaths.length > 0) {
    // One checkout for the whole set, falling back to per-path. A single path that is
    // not in `HEAD` — an untracked but pre-existing file, anything gitignored — makes the
    // batched form fail as a whole, which would leave every *opaque* file (too large or
    // binary to copy, so git is its only restore path) sitting at the turn's output while
    // the call still reported success for the rest.
    try {
      await execFileAsync("git", ["-C", checkpoint.cwd, "checkout", checkpoint.head, "--", ...trackedPaths], {
        timeout: 20000,
        maxBuffer: 256 * 1024,
      });
    } catch {
      for (const path of trackedPaths) {
        await execFileAsync("git", ["-C", checkpoint.cwd, "checkout", checkpoint.head, "--", path], {
          timeout: 10000,
          maxBuffer: 64 * 1024,
        }).catch(() => undefined);
      }
    }
  }

  for (const file of checkpoint.files) {
    if (file.created) {
      try {
        await unlink(file.path);
        result.removed.push(file.path);
      } catch {
        // Already gone.
      }
      continue;
    }
    if (file.content === undefined) {
      result.skipped.push(file.path);
      continue;
    }
    try {
      await writeFile(file.path, file.content, "utf8");
      result.restored.push(file.path);
    } catch {
      result.skipped.push(file.path);
    }
  }
  return result;
}

/** The store's directory, so a checkpoint can be written next to the other runtime data. */
export function checkpointFile(runtimeRoot: string): string {
  return join(runtimeRoot, "checkpoints.json");
}
