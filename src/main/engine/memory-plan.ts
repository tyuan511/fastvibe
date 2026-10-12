import type { Conversation } from "@shared/types";
import { redactSecrets } from "./memory-transcript.ts";

/**
 * The pure half of the memory pipeline: which conversations to distil, which of the
 * distilled ones to consolidate, and how the files the agent reads are named and laid
 * out. Nothing here touches the disk or a model, so the rules can be pinned by tests.
 *
 * The numbers and file formats are Codex's (`codex-rs/memories`, `codex-config`): a
 * conversation is read after 6 idle hours and while it is at most 10 days old, 256
 * distilled conversations feed consolidation, and one unused for 30 days drops out.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A conversation must have been quiet this long before its memory is extracted (`min_rollout_idle_hours`). */
export const MIN_IDLE_MS = 6 * HOUR;
/** Older conversations are not distilled (`max_rollout_age_days`). */
export const MAX_AGE_MS = 10 * DAY;
/** Conversations distilled per pass (`max_rollouts_per_startup`). */
export const MAX_PER_PASS = 2;
export const EXTRACT_CONCURRENCY = 2;
/** How many distilled conversations consolidation keeps in view (`max_raw_memories_for_consolidation`). */
export const MAX_CONSOLIDATED = 256;
/** A distilled conversation unused for this long drops out, and is pruned (`max_unused_days`). */
export const MAX_UNUSED_MS = 30 * DAY;
/** A failed extraction is tried again after this long (`JOB_RETRY_DELAY_SECONDS`), a few times. */
export const RETRY_DELAY_MS = HOUR;
export const MAX_ATTEMPTS = 3;
const ROLLOUT_SLUG_MAX_LEN = 60;

/** What stage 1 produced for one conversation (Codex's `Stage1Output`). */
export type Stage1Output = {
  conversationId: string;
  /** The conversation's working directory. */
  cwd: string;
  /** The transcript file, which a later agent may search for evidence. */
  rolloutPath: string;
  /** When the conversation was created; with the id it names the recap file, so the name is stable. */
  createdAt: number;
  /** The transcript file's modification time when it was read. */
  sourceUpdatedAt: number;
  generatedAt: number;
  rawMemory: string;
  rolloutSummary: string;
  slug: string | null;
  usageCount: number;
  lastUsage?: number;
};

export type Failure = { sourceUpdatedAt: number; attempts: number; retryAfter: number };

export type MemoryStateFile = {
  version: 1;
  outputs: Record<string, Stage1Output>;
  /** Conversations read and found to hold nothing worth keeping, by the mtime they were read at. */
  empty: Record<string, number>;
  failures: Record<string, Failure>;
  lastRunAt?: number;
  error?: string;
};

export function emptyState(): MemoryStateFile {
  return { version: 1, outputs: {}, empty: {}, failures: {} };
}

export type Candidate = { conversation: Conversation; sourceUpdatedAt: number };

/**
 * The conversations to read now, newest first.
 *
 * A side chat belongs to the one it was opened from; a running chat is not finished; and a
 * conversation already read at its current file time (or refused as empty, or failing too
 * recently) is left alone until the transcript changes.
 */
export function pickCandidates(
  conversations: readonly Conversation[],
  mtimes: ReadonlyMap<string, number>,
  state: MemoryStateFile,
  running: ReadonlySet<string>,
  now: number,
): Candidate[] {
  const out: Candidate[] = [];
  for (const conversation of conversations) {
    if (conversation.kind === "side-chat" || !conversation.sessionFile) continue;
    if (running.has(conversation.id)) continue;
    const sourceUpdatedAt = mtimes.get(conversation.id);
    if (sourceUpdatedAt === undefined) continue;
    if (now - sourceUpdatedAt < MIN_IDLE_MS) continue;
    if (now - sourceUpdatedAt > MAX_AGE_MS) continue;
    if ((state.outputs[conversation.id]?.sourceUpdatedAt ?? -1) >= sourceUpdatedAt) continue;
    if ((state.empty[conversation.id] ?? -1) >= sourceUpdatedAt) continue;
    const failure = state.failures[conversation.id];
    if (failure && failure.sourceUpdatedAt === sourceUpdatedAt && (failure.attempts >= MAX_ATTEMPTS || failure.retryAfter > now)) continue;
    out.push({ conversation, sourceUpdatedAt });
  }
  return out.sort((a, b) => b.sourceUpdatedAt - a.sourceUpdatedAt);
}

export function failureAfter(previous: Failure | undefined, sourceUpdatedAt: number, now: number): Failure {
  const attempts = previous && previous.sourceUpdatedAt === sourceUpdatedAt ? previous.attempts + 1 : 1;
  return { sourceUpdatedAt, attempts, retryAfter: now + RETRY_DELAY_MS };
}

const lastTouched = (output: Stage1Output): number => output.lastUsage ?? output.generatedAt;

/** Distilled conversations that nothing has used for the whole window; they are deleted, not just left out. */
export function staleOutputIds(outputs: readonly Stage1Output[], now: number): string[] {
  return outputs.filter((output) => now - lastTouched(output) > MAX_UNUSED_MS).map((output) => output.conversationId);
}

/**
 * The distilled conversations consolidation works from: the ones used or written inside the
 * window, most used first, then the most recently touched — so what the agent actually
 * reaches for stays.
 */
export function selectForConsolidation(outputs: readonly Stage1Output[], now: number): Stage1Output[] {
  return outputs
    .filter((output) => now - lastTouched(output) <= MAX_UNUSED_MS)
    .sort((a, b) => b.usageCount - a.usageCount || (b.lastUsage ?? b.sourceUpdatedAt) - (a.lastUsage ?? a.sourceUpdatedAt) || a.conversationId.localeCompare(b.conversationId))
    .slice(0, MAX_CONSOLIDATED);
}

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHORT_HASH_SPACE = 14_776_336; // 62^4

function shortHash(id: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  let seed = 0;
  if (uuid) {
    seed = Number.parseInt(id.slice(-8), 16);
  } else {
    for (let index = 0; index < id.length; index += 1) seed = (Math.imul(seed, 31) + (id.charCodeAt(index) & 0xff)) >>> 0;
  }
  let value = seed % SHORT_HASH_SPACE;
  const chars = ["0", "0", "0", "0"];
  for (let index = 3; index >= 0; index -= 1) {
    chars[index] = BASE62[value % 62];
    value = Math.floor(value / 62);
  }
  return chars.join("");
}

/** `2026-02-17T21-23-02-LN3m-weekly_report`: creation time, a short id hash, and the slug (Codex's `rollout_summary_file_stem`). */
export function rolloutFileStem(output: Pick<Stage1Output, "conversationId" | "createdAt" | "slug">): string {
  const prefix = `${new Date(output.createdAt).toISOString().slice(0, 19).replace(/:/g, "-")}-${shortHash(output.conversationId)}`;
  let slug = "";
  for (const ch of output.slug ?? "") {
    if (slug.length >= ROLLOUT_SLUG_MAX_LEN) break;
    slug += /[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : "_";
  }
  slug = slug.replace(/_+$/, "");
  return slug ? `${prefix}-${slug}` : prefix;
}

export const rolloutFileName = (output: Pick<Stage1Output, "conversationId" | "createdAt" | "slug">): string => `${rolloutFileStem(output)}.md`;

const rfc3339 = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** `raw_memories.md`: every selected conversation's note, in stable ascending id order so a rerun is byte-identical. */
export function renderRawMemories(selected: readonly Stage1Output[]): string {
  if (selected.length === 0) return "# Raw Memories\n\nNo raw memories yet.\n";
  const sorted = [...selected].sort((a, b) => (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0));
  let body = "# Raw Memories\n\nMerged stage-1 raw memories (stable ascending thread-id order):\n\n";
  for (const output of sorted) {
    body += `## Thread \`${output.conversationId}\`\n`;
    body += `updated_at: ${rfc3339(output.sourceUpdatedAt)}\n`;
    body += `cwd: ${output.cwd}\n`;
    body += `rollout_path: ${output.rolloutPath}\n`;
    body += `rollout_summary_file: ${rolloutFileName(output)}\n\n`;
    body += `${output.rawMemory.trim()}\n\n`;
  }
  return body;
}

export function renderRolloutSummary(output: Stage1Output): string {
  return [
    `thread_id: ${output.conversationId}`,
    `updated_at: ${rfc3339(output.sourceUpdatedAt)}`,
    `rollout_path: ${output.rolloutPath}`,
    `cwd: ${output.cwd}`,
    "",
    `${output.rolloutSummary}\n`,
  ].join("\n");
}

export type Stage1Result = { rawMemory: string; rolloutSummary: string; slug: string | null };

/**
 * Read the model's stage-1 answer. `null` means it could not be understood (a failure to
 * retry); an answer with an empty summary or note is a successful "nothing worth keeping".
 */
export function parseStage1(text: string): Stage1Result | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!("raw_memory" in record) && !("rollout_summary" in record)) return null;
  const field = (key: string): string => (typeof record[key] === "string" ? (record[key] as string).trim() : "");
  const slug = field("rollout_slug");
  return { rawMemory: redactSecrets(field("raw_memory")), rolloutSummary: redactSecrets(field("rollout_summary")), slug: slug || null };
}
