import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Reading foreign transcripts.
 *
 * A source's files can be enormous — the biggest Codex rollout on the author's machine
 * is 103 MB — so nothing here slurps a whole file. Lines are streamed, and a line that
 * fails to parse or that exceeds a sane bound is skipped rather than thrown: every one
 * of these formats accumulates junk (partial writes, vendor extensions, embedded
 * screenshots), and one bad line must not fail an import.
 */

/** One absurd line (an inlined image, a dumped binary) should not become the import. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Tool output kept per result; the rest is replaced by a marker. */
export const MAX_TOOL_TEXT = 200_000;

export async function forEachJsonLine(
  file: string,
  handler: (entry: Record<string, unknown>, lineNumber: number) => void,
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > MAX_LINE_BYTES) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        handler(parsed as Record<string, unknown>, lineNumber);
      }
    }
  } finally {
    // Destroying the stream is what actually releases the fd here: the import is
    // allowed to stop early (a cap, a parse bail) without leaking a handle.
    reader.close();
    stream.destroy();
  }
}

/** Trim a tool result to something a transcript can hold, saying so when it does. */
export function clipToolText(text: string, max = MAX_TOOL_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（输出过长，已截断 ${text.length - max} 字符）`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms from whatever a source used: number (s or ms), numeric string, or ISO. */
export function toMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Seconds and milliseconds are told apart by magnitude: nothing real sits in
    // between (1e9 s is 2001, 1e9 ms is 1970).
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return toMillis(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Text of a message whose content is either a string or a list of `{type:"text"}` blocks. */
export function textFromBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => {
      const record = asRecord(part);
      return record ? asString(record.text) ?? "" : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** First line-ish excerpt, for titles and previews built from message text. */
export function excerpt(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
