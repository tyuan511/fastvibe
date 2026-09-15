import { readFile, stat } from "node:fs/promises";
import type { Conversation, ConversationSearchHit } from "@shared/types";

type CachedTranscript = { mtimeMs: number; size: number; texts: string[] };

const cache = new Map<string, CachedTranscript>();
const MAX_FILE_BYTES = 2_000_000;
const MAX_HITS = 20;

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
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.texts;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const texts = extractTexts(raw);
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, texts });
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
