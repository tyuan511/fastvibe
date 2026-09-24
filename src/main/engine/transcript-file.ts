import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";

/**
 * Durable writes and load-time repair for session transcripts (`agent/sessions/*.jsonl`).
 *
 * The reader takes the file's *last* entry as the leaf and walks `parentId` back from it,
 * so one entry whose parent is missing from the file ends the walk there: a reopened chat
 * shows only what was written after the gap, while everything before it is still on disk.
 * Two things produced such gaps. The host used to rewrite the whole file from memory on
 * every prompt (the SDK's `_rewriteFile`: truncate, then one write per entry), so any writer
 * holding an older copy — a second process on the same data dir — dropped entries another
 * had appended, and a crash or a failed write mid-rewrite left a prefix that later appends
 * pointed past. Writes are now atomic and happen only when something is actually pending
 * (`writeTranscriptEntries`); files already broken are relinked when opened.
 */

type EntryLike = { type?: unknown; id?: unknown; parentId?: unknown };

/**
 * Replace a transcript with `entries` in one step: a temporary file, flushed, then renamed
 * over the original. An interruption leaves either the old file or the new one, never a
 * truncated mix of both.
 */
export function writeTranscriptEntries(file: string, entries: readonly unknown[]): void {
  const temporary = `${file}.${process.pid}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "w");
    for (const entry of entries) writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Reconnect every entry whose parent is not in the file to the entry just before it.
 *
 * What was lost is gone; the nearest guess for where the chain continued is the line
 * above, which is where the missing entry sat when the file was whole. Mutates `entries`
 * and returns how many were relinked. An entry is left alone when relinking it would
 * close a loop, because the SDK's branch walk has no cycle guard.
 */
export function relinkDanglingEntries(entries: EntryLike[]): number {
  const byId = new Map<string, EntryLike>();
  for (const entry of entries) {
    if (entry.type !== "session" && typeof entry.id === "string") byId.set(entry.id, entry);
  }
  let relinked = 0;
  let previous: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string") continue;
    const parent = entry.parentId;
    if (typeof parent === "string" && !byId.has(parent) && !reaches(byId, previous, entry.id)) {
      entry.parentId = previous;
      relinked += 1;
    }
    previous = entry.id;
  }
  return relinked;
}

/** Does the chain from `start` pass through `target`? */
function reaches(byId: Map<string, EntryLike>, start: string | null, target: string): boolean {
  const seen = new Set<string>();
  let current = start;
  while (current !== null && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    const parent = byId.get(current)?.parentId;
    current = typeof parent === "string" ? parent : null;
  }
  return false;
}

/**
 * Relink a transcript's dangling entries on disk before the SDK opens it.
 *
 * Only the relinked lines are re-serialised; every other line — malformed ones included,
 * which the SDK skips on its own — is written back byte for byte. A file that is missing,
 * has no session header, or needs nothing is not touched. Returns the number relinked.
 */
export function repairTranscriptFile(file: string): number {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  const parsed: Array<{ line: number; entry: EntryLike }> = [];
  for (let line = 0; line < lines.length; line += 1) {
    if (!lines[line].trim()) continue;
    try {
      const entry = JSON.parse(lines[line]) as unknown;
      if (entry && typeof entry === "object" && !Array.isArray(entry)) parsed.push({ line, entry: entry as EntryLike });
    } catch {
      // Left as it is; the SDK skips malformed lines too.
    }
  }
  if (parsed[0]?.entry.type !== "session") return 0;
  const before = parsed.map(({ entry }) => entry.parentId);
  const relinked = relinkDanglingEntries(parsed.map(({ entry }) => entry));
  if (relinked === 0) return 0;
  parsed.forEach(({ line, entry }, index) => {
    if (entry.parentId !== before[index]) lines[line] = JSON.stringify(entry);
  });
  writeTranscriptText(file, lines.join("\n"));
  return relinked;
}

function writeTranscriptText(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
