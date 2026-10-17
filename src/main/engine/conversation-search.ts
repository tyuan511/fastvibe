import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Conversation, ConversationSearchHit } from "@shared/types";

type Row = { id: string; parent: string | null; entryId?: string; role: string; text: string };
type Index = { mtimeMs: number; size: number; rows: Row[]; chars: number };
const cache = new Map<string, Index>();
const MAX_CACHED_CHARS = 8_000_000;
const MAX_CACHED_ROWS = 100_000;
type QueryMemo = { mtimeMs: number; size: number; needle: string; hit?: Omit<ConversationSearchHit, "id"> };
const queries = new Map<string, QueryMemo>();
const MAX_QUERY_MEMOS = 2000;
function rememberQuery(file: string, memo: QueryMemo): void {
  queries.delete(file);
  queries.set(file, memo);
  if (queries.size > MAX_QUERY_MEMOS) queries.delete(queries.keys().next().value!);
}
let cachedChars = 0;
let cachedRows = 0;

function forget(file: string): void {
  const previous = cache.get(file);
  if (!previous) return;
  cachedChars -= previous.chars;
  cachedRows -= previous.rows.length;
  cache.delete(file);
}

function remember(file: string, index: Index, ranks: ReadonlyMap<string, number>): void {
  forget(file);
  if (index.chars > MAX_CACHED_CHARS || index.rows.length > MAX_CACHED_ROWS) return;
  const rank = ranks.get(file) ?? Infinity;
  // A full scan is not evidence that every cold file has become hot. Admit only if
  // it fits or can displace an older conversation, never evict the whole working set
  // as the scan walks to the end of a corpus larger than the cache.
  const victims = [...cache.entries()].filter(([key]) => (ranks.get(key) ?? Infinity) > rank)
    .sort(([a], [b]) => (ranks.get(b) ?? Infinity) - (ranks.get(a) ?? Infinity));
  let chars = cachedChars + index.chars;
  let rows = cachedRows + index.rows.length;
  const evict: string[] = [];
  for (const [key, candidate] of victims) {
    if (chars <= MAX_CACHED_CHARS && rows <= MAX_CACHED_ROWS) break;
    chars -= candidate.chars;
    rows -= candidate.rows.length;
    evict.push(key);
  }
  if (chars > MAX_CACHED_CHARS || rows > MAX_CACHED_ROWS) return;
  for (const key of evict) forget(key);
  cache.set(file, index);
  cachedChars += index.chars;
  cachedRows += index.rows.length;
}

/** Incrementally re-index changed conversations; large transcripts are streamed, never skipped.
 * The admission policy bounds retained text without scan pollution. An oversized index keeps only tree links and this query's
 * snippets while scanning, so it remains searchable without pinning its full text in Main. */
export async function searchConversationContent(query: string, conversations: Conversation[]): Promise<ConversationSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const files = new Set(conversations.flatMap((item) => item.sessionFile ? [item.sessionFile] : []));
  for (const file of cache.keys()) if (!files.has(file)) forget(file);
  for (const file of queries.keys()) if (!files.has(file)) queries.delete(file);
  // Do not cap before the client applies its archive/project filter: hidden hits must
  // never consume all places and make a matching visible conversation disappear.
  const ordered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const ranks = new Map(ordered.flatMap((item, rank) => item.sessionFile ? [[item.sessionFile, rank] as const] : []));
  const hits: ConversationSearchHit[] = [];
  for (const item of ordered) {
    if (!item.sessionFile) continue;
    const hit = await searchFile(item.sessionFile, needle, ranks);
    if (hit) hits.push({ id: item.id, ...hit });
  }
  return hits;
}

async function searchFile(file: string, needle: string, ranks: ReadonlyMap<string, number>): Promise<Omit<ConversationSearchHit, "id"> | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    const memo = queries.get(file);
    if (memo && memo.mtimeMs === info.mtimeMs && memo.size === info.size &&
        (memo.needle === needle || (!memo.hit && needle.includes(memo.needle)))) return memo.hit;
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      const hit = branchHit(cached.rows, needle);
      if (needle.length <= 500) rememberQuery(file, { mtimeMs: info.mtimeMs, size: info.size, needle, hit });
      return hit;
    }
    forget(file);
    const rows: Row[] = [];
    let chars = 0;
    let retain = true;
    // Store query snippets separately: dropping the text cache must not drop results.
    const snippets = new Map<string, string>();
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!isRecord(entry) || entry.type === "session") continue;
        const entryId = typeof entry.id === "string" ? entry.id : undefined;
        const id = entryId ?? `legacy:${rows.length}`;
        const message = isRecord(entry.message) ? entry.message : entry.type === "custom_message" ? entry : undefined;
        const role = typeof message?.role === "string" ? message.role : entry.type === "custom_message" ? "custom" : "";
        const text = message && message.display !== false && role !== "system" ? messageText(message.content) : "";
        const snippet = snippetAround(text, needle);
        if (snippet) snippets.set(id, snippet);
        chars += text.length;
        if (retain && (chars > MAX_CACHED_CHARS || rows.length >= MAX_CACHED_ROWS)) {
          retain = false;
          for (const row of rows) row.text = "";
        }
        rows.push({ id, entryId, role, text: retain ? text : "", parent: entry.parentId === null ? null : typeof entry.parentId === "string" ? entry.parentId : rows.at(-1)?.id ?? null });
      }
    } finally {
      lines.close();
      input.destroy();
    }
    const after = await stat(file);
    const hit = branchHit(rows, needle, snippets);
    if (after.size === info.size && after.mtimeMs === info.mtimeMs) {
      if (retain) remember(file, { rows, chars, size: info.size, mtimeMs: info.mtimeMs }, ranks);
      if (needle.length <= 500) rememberQuery(file, { mtimeMs: info.mtimeMs, size: info.size, needle, hit });
    }
    return hit;
  } catch {
    // A deleted/unreadable transcript does not prevent searching other conversations.
    forget(file);
    queries.delete(file);
    return undefined;
  }
}

function branchHit(rows: Row[], needle: string, snippets?: Map<string, string>): Omit<ConversationSearchHit, "id"> | undefined {
  const byId = new Map(rows.map((row, index) => [row.id, index]));
  const branch: Row[] = [];
  const seen = new Set<string>();
  let index: number | undefined = rows.length - 1;
  while (index !== undefined && index >= 0) {
    const row: Row = rows[index];
    if (seen.has(row.id)) break;
    seen.add(row.id);
    branch.push(row);
    // Match the transcript repair's fallback for a dangling parent.
    index = row.parent === null ? undefined : byId.get(row.parent) ?? index - 1;
  }
  let anchor: string | undefined;
  for (const row of branch.reverse()) {
    if (row.role === "user" || row.role === "assistant" || row.role === "custom") anchor = row.entryId;
    const snippet = snippets ? snippets.get(row.id) : snippetAround(row.text, needle);
    if (snippet) return { snippet, entryId: anchor };
  }
  return undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => typeof part === "string" ? [part] : isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function snippetAround(text: string, needle: string): string | undefined {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + needle.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
