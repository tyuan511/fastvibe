import { randomUUID } from "node:crypto";
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

/** A transcript as lines, with every line that parses to an object kept beside its position. */
type TranscriptLines = { lines: string[]; parsed: Array<{ line: number; entry: MessageEntryLike }> };

function readTranscriptLines(file: string): TranscriptLines | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const parsed: TranscriptLines["parsed"] = [];
  for (let line = 0; line < lines.length; line += 1) {
    if (!lines[line].trim()) continue;
    try {
      const entry = JSON.parse(lines[line]) as unknown;
      if (entry && typeof entry === "object" && !Array.isArray(entry)) parsed.push({ line, entry: entry as MessageEntryLike });
    } catch {
      // Left as it is; the SDK skips malformed lines too.
    }
  }
  return parsed[0]?.entry.type === "session" ? { lines, parsed } : null;
}

/** Relink in place, re-serialising only the lines that changed. Returns how many were relinked. */
function relinkLines(transcript: TranscriptLines): number {
  const before = transcript.parsed.map(({ entry }) => entry.parentId);
  const relinked = relinkDanglingEntries(transcript.parsed.map(({ entry }) => entry));
  if (relinked === 0) return 0;
  transcript.parsed.forEach(({ line, entry }, index) => {
    if (entry.parentId !== before[index]) transcript.lines[line] = JSON.stringify(entry);
  });
  return relinked;
}

/** The file as it now reads: every line kept byte for byte unless relinked, then `appended`. */
function writeTranscriptLines(file: string, transcript: TranscriptLines, appended: readonly unknown[]): void {
  const body = transcript.lines.join("\n");
  if (appended.length === 0) {
    writeTranscriptText(file, body);
    return;
  }
  const lines = appended.map((entry) => JSON.stringify(entry)).join("\n");
  writeTranscriptText(file, `${body.endsWith("\n") ? body : `${body}\n`}${lines}\n`);
}

/**
 * Relink a transcript's dangling entries on disk before the SDK opens it.
 *
 * Only the relinked lines are re-serialised; every other line — malformed ones included,
 * which the SDK skips on its own — is written back byte for byte. A file that is missing,
 * has no session header, or needs nothing is not touched. Returns the number relinked.
 */
export function repairTranscriptFile(file: string): number {
  const transcript = readTranscriptLines(file);
  if (!transcript) return 0;
  const relinked = relinkLines(transcript);
  if (relinked > 0) writeTranscriptLines(file, transcript, []);
  return relinked;
}

type ToolCallLike = { type?: unknown; id?: unknown; name?: unknown };
type MessageEntryLike = EntryLike & { message?: { role?: unknown; content?: unknown; stopReason?: unknown; toolCallId?: unknown } };

/**
 * Close the tool calls an interrupted run left without a result.
 *
 * The assistant message that requests a tool is written when it ends, before the tool runs.
 * A process that died while the tool was running therefore leaves a transcript whose last
 * reply asks for a call nothing ever answered. The provider projection papers over that with
 * a synthetic "No result provided", but only when the next request is built: the composer
 * offers no 继续 for that shape, search and usage read an unfinished call, and the model is
 * never told the call may have half-run.
 *
 * This appends a real error result for each such call, after the last entry, so the
 * transcript is self-consistent for every reader and ends on a `toolResult` — which is
 * already resumable. It only looks at the end of the current branch: an assistant that was
 * followed by a user message was interrupted on purpose and the projection handles it, and a
 * reply that stopped on `error` / `aborted` / `length` never ran its tools.
 *
 * Meant for a file no run owns, i.e. just before a session is opened in this process. The
 * caller supplies the wording because the text is read by the model as well as the user.
 * Returns the number of calls closed.
 */
export function closeOrphanToolCalls(file: string, text: (toolName: string) => string, now: Date = new Date()): number {
  const transcript = readTranscriptLines(file);
  if (!transcript) return 0;
  const appended = orphanResults(transcript.parsed.map(({ entry }) => entry), text, now);
  if (appended.length > 0) writeTranscriptLines(file, transcript, appended);
  return appended.length;
}

/** What opening a transcript found and fixed, and the entries it read on the way. */
export type PreparedTranscript = {
  /** Every entry of the file as it now stands, in order: what `SessionManager` would read. */
  entries: Array<Record<string, unknown>>;
  relinked: number;
  closed: number;
};

/**
 * `repairTranscriptFile` then `closeOrphanToolCalls`, from one read and one parse.
 *
 * Opening a chat used to read and parse the whole file three times on Main's thread — the
 * relink, the orphan close, then the SDK's own load — which for a transcript carrying tens of
 * megabytes of tool screenshots was half a second before the session existed. The entries
 * parsed here are handed to `openSessionFile`, so the SDK does not read the file again; the
 * file is written once, only when something was fixed. `null` for a file with no session
 * header (or none at all), which the SDK's own open then reports as it always has.
 */
export function prepareTranscriptForOpen(file: string, text: (toolName: string) => string, now: Date = new Date()): PreparedTranscript | null {
  const transcript = readTranscriptLines(file);
  if (!transcript) return null;
  const relinked = relinkLines(transcript);
  const entries = transcript.parsed.map(({ entry }) => entry);
  const appended = orphanResults(entries, text, now);
  if (relinked > 0 || appended.length > 0) writeTranscriptLines(file, transcript, appended);
  return { entries: [...entries, ...appended] as Array<Record<string, unknown>>, relinked, closed: appended.length };
}

/** The error results that close the current branch's unanswered tool calls, chained after its leaf. */
function orphanResults(entries: readonly MessageEntryLike[], text: (toolName: string) => string, now: Date): Array<Record<string, unknown>> {
  const byId = new Map<string, MessageEntryLike>();
  let leaf: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leaf = entry.id;
  }
  if (leaf === null) return [];

  // Walk the branch from the leaf back to its last assistant message; what lies between is
  // the results that already answered it. A user message in between means it was answered
  // by being interrupted.
  const answered = new Set<string>();
  const seen = new Set<string>();
  let assistant: MessageEntryLike | undefined;
  for (let id: string | null = leaf; id !== null && !seen.has(id); ) {
    seen.add(id);
    const entry: MessageEntryLike | undefined = byId.get(id);
    if (!entry) break;
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "user") return [];
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") answered.add(message.toolCallId);
    if (message?.role === "assistant") {
      assistant = entry;
      break;
    }
    id = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  const message = assistant?.message;
  if (!assistant || !message || message.stopReason !== "toolUse" || !Array.isArray(message.content)) return [];
  const open = (message.content as ToolCallLike[]).filter(
    (part) => part && part.type === "toolCall" && typeof part.id === "string" && !answered.has(part.id),
  );

  const results: Array<Record<string, unknown>> = [];
  let parentId = leaf;
  for (const call of open) {
    let id = randomUUID().slice(0, 8);
    while (byId.has(id)) id = randomUUID().slice(0, 8);
    const toolName = typeof call.name === "string" ? call.name : "tool";
    byId.set(id, { id });
    results.push({
      type: "message",
      id,
      parentId,
      timestamp: now.toISOString(),
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName,
        content: [{ type: "text", text: text(toolName) }],
        isError: true,
        timestamp: now.getTime(),
      },
    });
    parentId = id;
  }
  return results;
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

/**
 * What a transcript says about whether its chat is empty: any `message` entry at all, and the
 * first thing the user said (the text a sidebar row previews).
 *
 * The catalog calls a chat empty when it has no `preview`, which `recordPrompt` sets on the
 * first send. A chat whose first messages were written another way — an extension's
 * `ctx.newSession` seeding a handoff, a switch to a session file — has content and no preview,
 * so it was hidden from the sidebar and handed back by 新对话 as if it were the project's blank
 * draft. This is the check that tells the two apart.
 */
export function transcriptPrompt(entries: Iterable<unknown>): { hasMessages: boolean; prompt?: string } {
  let hasMessages = false;
  for (const entry of entries) {
    const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (!record || record.type !== "message" || !record.message) continue;
    hasMessages = true;
    if (record.message.role !== "user") continue;
    const content = record.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => {
            const value = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
            return typeof value === "string" ? [value] : [];
          }).join(" ")
        : "";
    const prompt = text.replace(/\s+/g, " ").trim();
    if (prompt) return { hasMessages, prompt: prompt.slice(0, 80) };
  }
  return { hasMessages };
}

/** `transcriptPrompt` over a session file on disk; an unreadable file reads as empty. */
export function readTranscriptPrompt(file: string): { hasMessages: boolean; prompt?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { hasMessages: false };
  }
  let hasMessages = false;
  for (const line of text.split("\n")) {
    // Only message lines matter, and a long transcript should not be parsed whole for them.
    if (!line.includes('"type":"message"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A torn line is not a message.
    }
    const found = transcriptPrompt([entry]);
    hasMessages ||= found.hasMessages;
    if (found.prompt) return { hasMessages, prompt: found.prompt };
  }
  return { hasMessages };
}
