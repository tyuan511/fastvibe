import { readFile, stat } from "node:fs/promises";
import type { Conversation, ConversationSearchHit } from "@shared/types";

type CachedTranscript = { mtimeMs: number; size: number; texts: string[]; chars: number };

const cache = new Map<string, CachedTranscript>();
const MAX_FILE_BYTES = 2_000_000;
const MAX_HITS = 20;
/**
 * How much transcript text stays parsed between searches.
 *
 * The cache exists so typing in the palette does not re-read every session file, but
 * it used to keep the extracted text of every conversation ever searched, for the life
 * of the process — one palette search over a few hundred chats pinned hundreds of
 * megabytes that nothing would ever release. Past the cap the least recently used
 * entries go; re-reading one costs a file read the search was going to do anyway.
 */
const MAX_CACHED_CHARS = 8_000_000;
let cachedChars = 0;

function remember(file: string, entry: CachedTranscript): void {
  const existing = cache.get(file);
  if (existing) cachedChars -= existing.chars;
  cache.set(file, entry);
  cachedChars += entry.chars;
  while (cachedChars > MAX_CACHED_CHARS && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === file) break;
    cachedChars -= cache.get(oldest)?.chars ?? 0;
    cache.delete(oldest);
  }
}

/**
 * Scan session transcripts for `query` without spinning up AgentSessions.
 * Title/preview matching stays in the renderer; this only adds body hits.
 */
export async function searchConversationContent(
  query: string,
  conversations: Conversation[],
): Promise<ConversationSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const hits: ConversationSearchHit[] = [];
  for (const item of conversations) {
    if (hits.length >= MAX_HITS) break;
    if (!item.sessionFile) continue;
    const texts = await textsFor(item.sessionFile);
    if (texts.length === 0) continue;
    const snippet = snippetAround(texts, needle);
    if (snippet) hits.push({ id: item.id, snippet });
  }
  return hits;
}

async function textsFor(file: string): Promise<string[]> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return [];
  }
  if (info.size > MAX_FILE_BYTES) return [];
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    // Re-inserted so key order is recency order, which is what the cap evicts by.
    cache.delete(file);
    cache.set(file, cached);
    return cached.texts;
  }

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const texts = extractTexts(raw);
  let chars = 0;
  for (const text of texts) chars += text.length;
  remember(file, { mtimeMs: info.mtimeMs, size: info.size, texts, chars });
  return texts;
}

function extractTexts(raw: string): string[] {
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    pushMessageText(entry.message, texts);
  }
  return texts;
}

function pushMessageText(message: Record<string, unknown>, into: string[]): void {
  const content = message.content;
  if (typeof content === "string") {
    const text = content.trim();
    if (text) into.push(text);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (typeof part === "string") {
      const text = part.trim();
      if (text) into.push(text);
      continue;
    }
    if (!isRecord(part) || typeof part.text !== "string") continue;
    const text = part.text.trim();
    if (text) into.push(text);
  }
}

function snippetAround(texts: string[], needle: string): string | undefined {
  for (const text of texts) {
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 24);
    const end = Math.min(text.length, index + needle.length + 40);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return `${prefix}${text.slice(start, end).replace(/\s+/g, " ")}${suffix}`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
