import { basename } from "node:path";
import { MEMORY_MAX_SOURCES, memoryExpired, memoryRetentionClock, memoryRetentionScore, reinforceMemory, type MemoryRetention } from "../../engine/memory-retention.ts";
import type { MemoryTree } from "./files.ts";
import type { ViviMemoryRead } from "./types.ts";

export type NoteRetentions = Record<string, MemoryRetention>;
const isNote = (path: string): boolean => /^rollout_summaries\/[^/]+\.md$/.test(path);

function retentionFor(path: string, text: string, records: NoteRetentions, now: number): MemoryRetention {
  if (records[path]) return records[path];
  const stamp = /^created_at:\s*(\d+)\s*$/m.exec(text);
  const generatedAt = stamp ? Number(stamp[1]) : now;
  return records[path] = { generatedAt: Number.isFinite(generatedAt) ? generatedAt : now };
}

/** Plan only in the background copy: publication must also consolidate the handbook. */
export function retainSourceNotes(tree: MemoryTree, records: NoteRetentions, now: number): string[] {
  const notes = [...tree].filter(([path]) => isNote(path));
  for (const [path, text] of notes) retentionFor(path, text, records, now);
  const retained = notes.filter(([path]) => !memoryExpired(records[path], now)).sort(([a], [b]) =>
    memoryRetentionScore(records[b], now) - memoryRetentionScore(records[a], now)
    || memoryRetentionClock(records[b]) - memoryRetentionClock(records[a])
    || a.localeCompare(b),
  ).slice(0, MEMORY_MAX_SOURCES);
  const keep = new Set(retained.map(([path]) => path));
  const removed: string[] = [];
  for (const [path] of notes) if (!keep.has(path)) { tree.delete(path); delete records[path]; removed.push(path); }
  for (const path of Object.keys(records)) if (!tree.has(path)) delete records[path];
  const raw: string[] = [];
  let rawBytes = Buffer.byteLength("# Raw memories\n");
  for (const [path, text] of retained) {
    const excerpt = (text.split(/^## Raw memory\s*$/m)[1]?.trim() ?? text.trim()).slice(0, 1_000);
    const entry = `\n## ${path}\n\n${excerpt}\n`;
    if (rawBytes + Buffer.byteLength(entry) > 400_000) continue;
    raw.push(entry);
    rawBytes += Buffer.byteLength(entry);
  }
  tree.set("raw_memories.md", `# Raw memories\n${raw.join("")}`);
  return removed;
}

/** Match complete provenance identifiers, never a substring of another note/id. */
function mentions(text: string, identifier: string): boolean {
  if (!identifier) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_./-])${escaped}(?![\\p{L}\\p{N}_./-])`, "u").test(text);
}
function sourceId(text: string): string | undefined {
  const value = /^source_id:\s*(.+)$/m.exec(text)?.[1];
  if (!value) return undefined;
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === "string" ? parsed : undefined; }
  catch { return value.trim(); }
}

/** Summary injection, raw collections and search results cannot renew the whole library. */
export function reinforceSourceNotes(tree: MemoryTree, records: NoteRetentions, read: Pick<ViviMemoryRead, "path" | "content">, now: number): boolean {
  if (read.path !== "MEMORY.md" && !isNote(read.path)) return false;
  let changed = false;
  for (const [path, text] of tree) {
    if (!isNote(path)) continue;
    const id = sourceId(text);
    if (read.path !== path && !(read.path === "MEMORY.md" && [path, basename(path), id].some(value => value && mentions(read.content, value)))) continue;
    const previous = records[path];
    const record = retentionFor(path, text, records, now);
    const next = reinforceMemory(record, now);
    records[path] = next;
    if (!previous || next !== record) changed = true;
  }
  return changed;
}

/** Reject dangling filename citations; semantic removal still belongs to consolidation. */
export function assertForgottenReferences(tree: MemoryTree, removed: readonly string[]): void {
  for (const path of new Set(removed)) {
    if (tree.has(path)) continue;
    // A surviving source with the same basename still supports that filename citation.
    const name = basename(path);
    const supported = [...tree.keys()].some(candidate => isNote(candidate) && basename(candidate) === name);
    for (const document of ["MEMORY.md", "memory_summary.md"]) {
      const text = tree.get(document) ?? "";
      if (mentions(text, path) || (!supported && mentions(text, name))) throw new Error(`Forgotten memory reference remains in ${document}: ${path}`);
    }
  }
}
