import { readFile, stat } from "node:fs/promises";
import {
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const CONVERSATION_TRANSCRIPT_MAX_FILE_BYTES = 8_000_000;
export const CONVERSATION_TRANSCRIPT_MAX_QUERY_CHARS = 500;
export const CONVERSATION_TRANSCRIPT_MAX_RESULTS = 30;
export const CONVERSATION_TRANSCRIPT_MAX_CONTEXT = 3;

const MAX_BRANCH_ENTRIES = 100_000;
const MAX_ENTRY_ID_CHARS = 512;
const DEFAULT_RESULTS = 10;
const DEFAULT_CONTEXT = 1;
const SNIPPET_CHARS = 640;
const CONTEXT_CHARS = 360;
const RESULT_CHARS = 40_000;

export type ConversationTranscriptSearchRequest = {
  query: string;
  maxResults?: number;
  context?: number;
};

export type ConversationTranscriptLine = {
  entryId: string;
  role: "user" | "assistant" | "tool" | "summary" | "custom";
  timestamp: string;
  source?: string;
  text: string;
};

export type ConversationTranscriptMatch = {
  entryId: string;
  role: ConversationTranscriptLine["role"];
  timestamp: string;
  source?: string;
  snippet: string;
  before: ConversationTranscriptLine[];
  after: ConversationTranscriptLine[];
};

export type ConversationTranscriptSearchResult = {
  query: string;
  totalMatches: number;
  matches: ConversationTranscriptMatch[];
  truncated: boolean;
};

export type ConversationTranscriptErrorCode =
  | "missing"
  | "too-large"
  | "invalid"
  | "empty-query"
  | "query-too-long";

export class ConversationTranscriptError extends Error {
  readonly code: ConversationTranscriptErrorCode;

  constructor(code: ConversationTranscriptErrorCode) {
    super(code);
    this.name = "ConversationTranscriptError";
    this.code = code;
  }
}

/**
 * Open a persisted transcript as an in-memory session and select its current branch.
 * `SessionManager.open()` is intentionally not used: a legacy transcript can be
 * migrated and rewritten by a persistent manager, while this reader must never write.
 */
export async function loadConversationTranscriptBranch(
  file: string,
  cwd: string,
): Promise<SessionEntry[]> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new ConversationTranscriptError("missing");
  }
  if (!info.isFile()) throw new ConversationTranscriptError("invalid");
  if (info.size > CONVERSATION_TRANSCRIPT_MAX_FILE_BYTES) {
    throw new ConversationTranscriptError("too-large");
  }

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ConversationTranscriptError("missing");
  }
  if (Buffer.byteLength(raw, "utf8") > CONVERSATION_TRANSCRIPT_MAX_FILE_BYTES) {
    throw new ConversationTranscriptError("too-large");
  }

  const entries = parseSessionEntries(raw);
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    throw new ConversationTranscriptError("invalid");
  }
  try {
    // Old versions are repaired only in this temporary array. The in-memory manager
    // has `persist: false`, so neither this migration nor branch selection can write.
    migrateSessionEntries(entries);
    validateSessionTree(entries);
    return SessionManager.inMemory(cwd, undefined, entries).getBranch();
  } catch (error) {
    if (error instanceof ConversationTranscriptError) throw error;
    throw new ConversationTranscriptError("invalid");
  }
}

/** Search one selected branch without turning the whole transcript into GUI messages. */
export function searchConversationTranscript(
  branch: readonly SessionEntry[],
  request: ConversationTranscriptSearchRequest,
): ConversationTranscriptSearchResult {
  const query = request.query.trim();
  if (!query) throw new ConversationTranscriptError("empty-query");
  if (query.length > CONVERSATION_TRANSCRIPT_MAX_QUERY_CHARS) {
    throw new ConversationTranscriptError("query-too-long");
  }
  if (branch.length > MAX_BRANCH_ENTRIES) throw new ConversationTranscriptError("too-large");

  const maxResults = clampInteger(request.maxResults, DEFAULT_RESULTS, 1, CONVERSATION_TRANSCRIPT_MAX_RESULTS);
  const context = clampInteger(request.context, DEFAULT_CONTEXT, 0, CONVERSATION_TRANSCRIPT_MAX_CONTEXT);
  const lines: ConversationTranscriptLine[] = [];
  let searchableChars = 0;
  for (const entry of branch) {
    for (const item of projectEntry(entry)) {
      searchableChars += item.text.length;
      if (searchableChars > CONVERSATION_TRANSCRIPT_MAX_FILE_BYTES) {
        throw new ConversationTranscriptError("too-large");
      }
      lines.push(item);
    }
  }
  const matchingLines: Array<{ index: number; start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const range = caseInsensitiveRange(lines[index].text, query);
    if (range) matchingLines.push({ index, ...range });
  }

  const matches: ConversationTranscriptMatch[] = [];
  let outputChars = 0;
  for (const found of matchingLines) {
    if (matches.length >= maxResults) break;
    const { index } = found;
    const line = lines[index];
    const before = lines.slice(Math.max(0, index - context), index).map(contextLine);
    const after = lines.slice(index + 1, index + 1 + context).map(contextLine);
    const match: ConversationTranscriptMatch = {
      entryId: line.entryId,
      role: line.role,
      timestamp: line.timestamp,
      source: line.source,
      snippet: snippetAround(line.text, found.start, found.end),
      before,
      after,
    };
    const chars = match.entryId.length + match.timestamp.length + (match.source?.length ?? 0) + match.snippet.length
      + before.reduce((sum, item) => sum + item.entryId.length + item.timestamp.length + (item.source?.length ?? 0) + item.text.length, 0)
      + after.reduce((sum, item) => sum + item.entryId.length + item.timestamp.length + (item.source?.length ?? 0) + item.text.length, 0);
    if (matches.length > 0 && outputChars + chars > RESULT_CHARS) break;
    matches.push(match);
    outputChars += chars;
  }

  return {
    query,
    totalMatches: matchingLines.length,
    matches,
    truncated: matches.length < matchingLines.length,
  };
}

function projectEntry(entry: SessionEntry): ConversationTranscriptLine[] {
  if (entry.type === "message") {
    const message = entry.message as unknown;
    if (!isRecord(message)) return [];
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "system" || (role === "custom" && message.display === false)) return [];
    const text = messageContentText(message.content);
    if (!text) return [];
    if (role === "user") return [line(entry, "user", text)];
    if (role === "assistant") return [line(entry, "assistant", text)];
    if (role === "toolResult") {
      const source = typeof message.toolName === "string" ? message.toolName : undefined;
      return [line(entry, "tool", text, source)];
    }
    return [line(entry, "custom", text, role || undefined)];
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const text = cleanText(entry.summary);
    return text ? [line(entry, "summary", text, entry.type)] : [];
  }

  if (entry.type === "custom_message" && entry.display !== false) {
    const text = messageContentText(entry.content);
    return text ? [line(entry, "custom", text, entry.customType)] : [];
  }

  return [];
}

function line(
  entry: SessionEntry,
  role: ConversationTranscriptLine["role"],
  text: string,
  source?: string,
): ConversationTranscriptLine {
  return {
    entryId: preview(entry.id, MAX_ENTRY_ID_CHARS),
    role,
    timestamp: preview(entry.timestamp, 64),
    source: source ? preview(source, 160) : undefined,
    text,
  };
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      const text = cleanText(part);
      if (text) parts.push(text);
      continue;
    }
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      const text = cleanText(part.text);
      if (text) parts.push(text);
      continue;
    }
    if (part.type !== "toolCall") continue;
    const name = typeof part.name === "string" && part.name ? part.name : "tool";
    const args = safeJson(part.arguments ?? part.input);
    parts.push(args ? `[${name}] ${args}` : `[${name}]`);
  }
  return parts.join("\n").trim();
}

function contextLine(item: ConversationTranscriptLine): ConversationTranscriptLine {
  return { ...item, text: preview(item.text, CONTEXT_CHARS) };
}

function snippetAround(text: string, matchStart: number, matchEnd: number): string {
  const matchLength = matchEnd - matchStart;
  const before = Math.max(0, Math.floor((SNIPPET_CHARS - matchLength) * 0.4));
  const start = Math.max(0, matchStart - before);
  const end = Math.min(text.length, Math.max(matchEnd, start + SNIPPET_CHARS));
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Map a lowercase match back to offsets in the original UTF-16 string. */
function caseInsensitiveRange(text: string, query: string): { start: number; end: number } | null {
  const folded = text.toLowerCase();
  const needle = query.toLowerCase();
  const match = folded.indexOf(needle);
  if (match < 0) return null;
  if (folded.length === text.length && needle.length === query.length) {
    return { start: match, end: match + query.length };
  }

  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const lower = character.toLowerCase();
    for (let index = 0; index < lower.length; index += 1) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  return {
    start: starts[match] ?? 0,
    end: ends[match + needle.length - 1] ?? text.length,
  };
}

function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim() : "";
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function validateSessionTree(entries: readonly FileEntry[]): void {
  if (entries.length > MAX_BRANCH_ENTRIES + 1) throw new ConversationTranscriptError("too-large");
  const parents = new Map<string, string | null>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as unknown;
    if (!isRecord(entry)) throw new ConversationTranscriptError("invalid");
    if (entry.type === "session") {
      if (index !== 0) throw new ConversationTranscriptError("invalid");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const parentId = entry.parentId;
    if (!id || id.length > MAX_ENTRY_ID_CHARS || (parentId !== null && typeof parentId !== "string")) {
      throw new ConversationTranscriptError("invalid");
    }
    if (parents.has(id) || parentId === id) throw new ConversationTranscriptError("invalid");
    parents.set(id, parentId as string | null);
  }

  for (const parentId of parents.values()) {
    if (parentId !== null && !parents.has(parentId)) throw new ConversationTranscriptError("invalid");
  }

  const complete = new Set<string>();
  for (const id of parents.keys()) {
    if (complete.has(id)) continue;
    const path: string[] = [];
    const visiting = new Set<string>();
    let current: string | null = id;
    while (current !== null && !complete.has(current)) {
      if (visiting.has(current)) throw new ConversationTranscriptError("invalid");
      visiting.add(current);
      path.push(current);
      current = parents.get(current) ?? null;
    }
    for (const item of path) complete.add(item);
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value!))) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
