import { execFile } from "node:child_process";
import { readFileSync, statSync, type Stats } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { importLegacyJson, type Db } from "./db.ts";

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
/** An Office file is a zip. The text cap would call every one opaque and then skip the rewind. */
const MAX_OFFICE_BYTES = 16 * 1024 * 1024;
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
   * Pre-turn bytes of a binary Office file, base64. A zip has NUL bytes, so the text path
   * would drop it and a retry would leave the deck the failed attempt already wrote.
   */
  binary?: string;
  /**
   * Byte length of `content`, measured when it was read.
   *
   * Carried rather than re-derived because capture runs once per written
   * file and weighs *every* file it has collected so far: a turn that writes fifty
   * files re-measured up to 32 MB of text fifty times over, on Main's event loop.
   */
  bytes?: number;
};

export type CheckpointRepo = {
  /** `git rev-parse --show-toplevel` for the files in `paths`. */
  root: string;
  head?: string;
  paths: string[];
};

export type TurnCheckpoint = {
  conversationId: string;
  cwd: string;
  createdAt: number;
  /** Git revision of `cwd`, kept for checkpoints written before per-repo grouping. */
  head?: string;
  /**
   * One baseline per repository the turn wrote into. Absent on older checkpoints,
   * which restore from `cwd` + `head` alone.
   */
  repos?: CheckpointRepo[];
  files: CheckpointFile[];
};

/**
 * The turn's file checkpoint, in the shared database.
 *
 * §5.2: one row per conversation in `checkpoints` and one per captured file in
 * `checkpoint_files`, which hangs off it with `ON DELETE CASCADE` — replacing a
 * conversation's checkpoint is one delete of the parent, and no orphan file row can be
 * left behind to be read back into a later checkpoint.
 *
 * **Behaviour change from the JSON store: a capture is written when it happens.** The old
 * store kept everything in memory and serialized the whole `checkpoints.json` only in
 * `stop()`, so a crash or a kill lost every「重试前回退文件」snapshot the session had
 * collected — the one thing that makes a retry honest. Writing at capture costs a
 * synchronous write of up to {@link MAX_TOTAL_BYTES} on Main's thread, which is what
 * `docs/sqlite-storage.md` §8 asks to measure; the fallback if it ever proves too slow is
 * to write once per turn instead, not to go back to quitting-time-only.
 */
export class CheckpointStore {
  #db: Db;
  #checkpoints = new Map<string, TurnCheckpoint>();

  constructor(db: Db, options: { legacyFile?: string } = {}) {
    this.#db = db;
    if (options.legacyFile) {
      importLegacyJson(db, {
        name: "checkpoints",
        file: options.legacyFile,
        // The old file was a bare array of `TurnCheckpoint`; the same validation the loader
        // applied (an entry without an id or without files is not a checkpoint) decides what
        // a row is.
        load: (value) => (Array.isArray(value) ? value.filter(isCheckpoint) : []),
        // Runs inside the one-time load's own transaction, and deliberately not guarded: a
        // write that fails here must roll the whole load back rather than be swallowed and
        // reported as zero rows taken in.
        save: (list) => {
          let rows = 0;
          for (const checkpoint of list) {
            this.#writeRows(checkpoint);
            rows += 1 + checkpoint.files.length;
          }
          return rows;
        },
        count: () => db.countRows("checkpoints") + db.countRows("checkpoint_files"),
      });
    }
    this.#load();
  }

  get(conversationId: string): TurnCheckpoint | undefined {
    return this.#checkpoints.get(conversationId);
  }

  /** The checkpoint for a conversation, dropping whatever it had before. */
  async capture(conversationId: string, cwd: string, files: CheckpointFile[]): Promise<TurnCheckpoint> {
    const trimmed = trimCheckpointFiles(files);
    const previous = this.#checkpoints.get(conversationId);
    const appendFrom = previous && previous.cwd === cwd && hasStablePrefix(previous.files, trimmed)
      ? previous.files.length
      : 0;
    const head = appendFrom > 0 ? previous?.head : await gitRevision(cwd);
    const repos = appendFrom > 0
      ? await checkpointRepos(trimmed.slice(appendFrom), previous?.repos)
      : await checkpointRepos(trimmed);
    const checkpoint: TurnCheckpoint = {
      conversationId,
      cwd,
      createdAt: Date.now(),
      ...(head ? { head } : {}),
      ...(repos.length > 0 ? { repos } : {}),
      files: trimmed,
    };
    this.#checkpoints.set(conversationId, checkpoint);
    this.#persist(checkpoint, appendFrom);
    return checkpoint;
  }

  /** Drop the checkpoint for a conversation (a new turn replaces it, a restore consumes it). */
  clear(conversationId: string): void {
    this.#checkpoints.delete(conversationId);
    try {
      // The cascade is the point: the file rows go with the parent, and they hold source.
      this.#db.run("DELETE FROM checkpoints WHERE conversation_id = ?", conversationId);
    } catch (error) {
      console.warn("[checkpoint] could not clear", message(error));
    }
  }

  /**
   * Persist now — this is the change from the JSON store, where nothing was written until
   * `stop()`. One transaction keeps the parent and file rows consistent. Appending is safe
   * here because the process manager holds the same CheckpointFile object for a path during
   * one turn; a new turn clears the in-memory checkpoint before its first capture.
   */
  #persist(checkpoint: TurnCheckpoint, appendFrom = 0): void {
    try {
      this.#db.transaction(() => {
        if (appendFrom <= 0 || appendFrom > checkpoint.files.length) {
          this.#writeRows(checkpoint);
          return;
        }
        this.#db.run(
          "UPDATE checkpoints SET cwd = ?, created_at = ?, head = ?, repos = ? WHERE conversation_id = ?",
          checkpoint.cwd,
          checkpoint.createdAt,
          checkpoint.head,
          checkpoint.repos ? JSON.stringify(checkpoint.repos) : undefined,
          checkpoint.conversationId,
        );
        for (const [index, file] of checkpoint.files.entries()) {
          if (index < appendFrom) continue;
          this.#db.run(
            "INSERT INTO checkpoint_files (conversation_id, seq, path, data) VALUES (?, ?, ?, ?)",
            checkpoint.conversationId,
            index,
            file.path,
            JSON.stringify(file),
          );
        }
      });
    } catch (error) {
      // A checkpoint is best-effort: losing it only means the retry prompt is not offered.
      console.warn("[checkpoint] could not save", message(error));
    }
  }

  /** The rows themselves. The caller owns the transaction; the import already holds one. */
  #writeRows(checkpoint: TurnCheckpoint): void {
    // One conversation holds one checkpoint: the parent goes with its file rows (the
    // cascade), and the pair is written again as a unit.
    this.#db.run("DELETE FROM checkpoints WHERE conversation_id = ?", checkpoint.conversationId);
    this.#db.run(
      "INSERT INTO checkpoints (conversation_id, cwd, created_at, head, repos) VALUES (?, ?, ?, ?, ?)",
      checkpoint.conversationId,
      checkpoint.cwd,
      checkpoint.createdAt,
      checkpoint.head,
      checkpoint.repos ? JSON.stringify(checkpoint.repos) : undefined,
    );
    for (const [index, file] of checkpoint.files.entries()) {
      this.#db.run(
        "INSERT INTO checkpoint_files (conversation_id, seq, path, data) VALUES (?, ?, ?, ?)",
        checkpoint.conversationId,
        index,
        file.path,
        JSON.stringify(file),
      );
    }
  }

  #load(): void {
    this.#checkpoints.clear();
    const parents = this.#db.all<{
      conversation_id: string;
      cwd: string;
      created_at: number;
      head: string | null;
      repos: string | null;
    }>("SELECT conversation_id, cwd, created_at, head, repos FROM checkpoints");
    const files = this.#db.all<{ conversation_id: string; data: string }>(
      "SELECT conversation_id, data FROM checkpoint_files ORDER BY conversation_id, seq",
    );
    const byConversation = new Map<string, CheckpointFile[]>();
    for (const row of files) {
      const list = byConversation.get(row.conversation_id) ?? [];
      try {
        list.push(JSON.parse(row.data) as CheckpointFile);
      } catch {
        // A row that is not the JSON we wrote cannot be restored; skip it.
      }
      byConversation.set(row.conversation_id, list);
    }
    for (const parent of parents) {
      const checkpoint: TurnCheckpoint = {
        conversationId: parent.conversation_id,
        cwd: parent.cwd,
        createdAt: Number(parent.created_at),
        files: byConversation.get(parent.conversation_id) ?? [],
      };
      if (parent.head) checkpoint.head = parent.head;
      if (parent.repos) {
        try {
          checkpoint.repos = JSON.parse(parent.repos) as CheckpointRepo[];
        } catch {
          // Without the per-repo baselines the restore falls back to `cwd` + `head`.
        }
      }
      this.#checkpoints.set(checkpoint.conversationId, checkpoint);
    }
  }
}

function isCheckpoint(item: unknown): item is TurnCheckpoint {
  const checkpoint = item as Partial<TurnCheckpoint> | null;
  // The old loader's rule, plus one: it refused an entry with no id of type string, and an
  // id that is empty can never be read back by any conversation, so it is not a checkpoint.
  return typeof checkpoint?.conversationId === "string" && checkpoint.conversationId !== "" && Array.isArray(checkpoint.files);
}

function hasStablePrefix(previous: CheckpointFile[], next: CheckpointFile[]): boolean {
  if (previous.length === 0 || previous.length > next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (left === right) continue;
    if (
      left.path !== right.path ||
      left.content !== right.content ||
      left.binary !== right.binary ||
      left.created !== right.created ||
      left.opaque !== right.opaque ||
      left.bytes !== right.bytes
    ) return false;
  }
  return true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the first {@link MAX_COPIED_FILES} files with their content, and the rest as pointers.
 *
 * Pure, because the bounds are what decides whether a retry can actually rewind: a turn
 * that wrote 300 files restores 200 of them and says nothing about the other 100 unless
 * this rule is right.
 */
export function trimCheckpointFiles(files: CheckpointFile[]): CheckpointFile[] {
  const trimmed: CheckpointFile[] = [];
  let total = 0;
  let copied = 0;
  for (const file of files) {
    const bytes = storedBytes(file);
    const kept = file.content !== undefined || file.binary !== undefined;
    if (kept && (copied >= MAX_COPIED_FILES || total + bytes > MAX_TOTAL_BYTES)) {
      trimmed.push({ path: file.path, opaque: true });
      continue;
    }
    if (kept) {
      copied += 1;
      total += bytes;
    }
    trimmed.push(file);
  }
  return trimmed;
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
 * The pre-turn bytes of an Office file, kept even though it is a zip.
 *
 * `readBefore` refuses a NUL byte, which every docx/xlsx/pptx has. Retry would then skip
 * the file and re-run against the document the failed attempt already changed. Past
 * {@link MAX_OFFICE_BYTES} it is still opaque: a snapshot that cannot be stored must not
 * pretend it can be restored.
 */
export function readBeforeBinary(path: string): CheckpointFile {
  let info: Stats;
  try {
    info = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { path, created: true } : { path, opaque: true };
  }
  if (!info.isFile() || info.size > MAX_OFFICE_BYTES) return { path, opaque: true };
  try {
    const buffer = readFileSync(path);
    return { path, binary: buffer.toString("base64"), bytes: buffer.byteLength };
  } catch {
    return { path, opaque: true };
  }
}

/**
 * Store the turn's captured files.
 *
 * The caller decides *which* files and what their pre-turn content was, because only it
 * knows the moment before the write — this just resolves the git revision (so tracked
 * files can be restored from `HEAD` rather than from a copy) and files the checkpoint.
 */
async function gitRevision(dir: string): Promise<string | undefined> {
  const cached = headCache.get(dir);
  if (cached && Date.now() - cached.at < HEAD_TTL_MS) return cached.head;
  let head: string | undefined;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 5000 });
    head = stdout.trim() || undefined;
  } catch {
    // Not a repo, or no commits yet. The copies are then the only restore path.
  }
  headCache.set(dir, { head, at: Date.now() });
  return head;
}

const repoRootCache = new Map<string, { root: string | undefined; at: number }>();

async function gitTopLevel(dir: string): Promise<string | undefined> {
  const cached = repoRootCache.get(dir);
  if (cached && Date.now() - cached.at < HEAD_TTL_MS) return cached.root;
  let root: string | undefined;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 5000 });
    root = stdout.trim() || undefined;
  } catch {
    // Not a repo, or the directory is not readable.
  }
  repoRootCache.set(dir, { root, at: Date.now() });
  return root;
}

/** Group captured files by the repository that owns them. */
async function checkpointRepos(files: CheckpointFile[], existing: CheckpointRepo[] = []): Promise<CheckpointRepo[]> {
  const groups = new Map<string, string[]>();
  const rootsByDir = new Map<string, string | undefined>();
  for (const file of files) {
    const dir = dirname(file.path);
    let root = rootsByDir.get(dir);
    if (!rootsByDir.has(dir)) {
      root = await gitTopLevel(dir);
      rootsByDir.set(dir, root);
    }
    if (!root) continue;
    const paths = groups.get(root) ?? [];
    paths.push(file.path);
    groups.set(root, paths);
  }
  const merged = new Map<string, CheckpointRepo>();
  for (const repo of existing) merged.set(repo.root, { ...repo, paths: [...repo.paths] });
  for (const [root, paths] of groups) {
    const previous = merged.get(root);
    const known = new Set(previous?.paths ?? []);
    const nextPaths = [...(previous?.paths ?? [])];
    for (const path of paths) {
      if (!known.has(path)) nextPaths.push(path);
    }
    const head = await gitRevision(root);
    merged.set(root, { root, ...(head ? { head } : previous?.head ? { head: previous.head } : {}), paths: nextPaths });
  }
  return [...merged.values()];
}

function storedBytes(file: CheckpointFile): number {
  if (file.bytes !== undefined) return file.bytes;
  if (file.binary !== undefined) return Buffer.from(file.binary, "base64").byteLength;
  if (file.content !== undefined) return Buffer.byteLength(file.content, "utf8");
  return 0;
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
export async function restoreCheckpoint(
  checkpoint: TurnCheckpoint,
  options: {
    /**
     * Called before a file is overwritten or removed. OfficeCLI keeps a document in a resident
     * process that flushes its in-memory copy later; if that copy outlives the rewind, it
     * writes the failed attempt back over the file that was just restored.
     */
    beforeRewrite?: (path: string) => Promise<void>;
  } = {},
): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], removed: [], skipped: [] };
  const release = async (path: string): Promise<void> => {
    try {
      await options.beforeRewrite?.(path);
    } catch {
      // A resident that cannot be closed is no reason to refuse the rewind.
    }
  };

  const groups = checkpoint.repos?.length
    ? checkpoint.repos
    : checkpoint.head
      ? [{ root: checkpoint.cwd, head: checkpoint.head, paths: checkpoint.files.map((file) => file.path) }]
      : [];
  for (const group of groups) {
    if (!group.head) continue;
    const trackedPaths = group.paths.filter((path) => {
      const file = checkpoint.files.find((item) => item.path === path);
      return file && (file.content !== undefined || file.binary !== undefined || file.opaque);
    });
    if (trackedPaths.length === 0) continue;
    // One checkout per repository. A path from another checkout must not be restored
    // against this group's HEAD — that is how a multi-folder turn used to rewind the
    // wrong tree, or fail the whole batch.
    try {
      await execFileAsync("git", ["-C", group.root, "checkout", group.head, "--", ...trackedPaths], {
        timeout: 20000,
        maxBuffer: 256 * 1024,
      });
    } catch {
      for (const path of trackedPaths) {
        await execFileAsync("git", ["-C", group.root, "checkout", group.head, "--", path], {
          timeout: 10000,
          maxBuffer: 64 * 1024,
        }).catch(() => undefined);
      }
    }
  }

  for (const file of checkpoint.files) {
    await release(file.path);
    if (file.created) {
      try {
        await unlink(file.path);
        result.removed.push(file.path);
      } catch {
        // Already gone.
      }
      continue;
    }
    if (file.binary !== undefined) {
      try {
        await writeFile(file.path, Buffer.from(file.binary, "base64"));
        result.restored.push(file.path);
      } catch {
        result.skipped.push(file.path);
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

/** The legacy file's path: the import reads it once, and nothing writes it again. */
export function checkpointFile(runtimeRoot: string): string {
  return join(runtimeRoot, "checkpoints.json");
}
