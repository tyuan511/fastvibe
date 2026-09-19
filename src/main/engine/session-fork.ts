import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { uiText } from "./ui-text.ts";

/** Metadata private to FastVibe; the SDK deliberately preserves unknown JSON fields. */
export const FORK_USAGE_SESSION_FIELD = "fastvibeUsageSessionId";

export class SessionForkError extends Error {
  readonly code: "empty" | "not-on-branch" | "not-assistant" | "invalid-tools";

  constructor(code: "empty" | "not-on-branch" | "not-assistant" | "invalid-tools") {
    super(code);
    this.name = "SessionForkError";
    this.code = code;
  }
}

export type ForkSessionHeader = SessionHeader & {
  fastvibeFork?: {
    sourceSessionId: string;
    /** Last inherited entry. New entries appended by the SDK are outside this boundary. */
    inheritedThroughEntryId: string | null;
  };
};

/**
 * Select the current persisted path for a new, independent session.
 *
 * A requested target must be an assistant entry on that path. Existing results for
 * its tool calls are retained, including the SDK's legal parallel shape where several
 * assistant tool-call messages precede their aggregated results. Any calls still open
 * at the fork boundary receive error results in the copy; the source is never changed
 * and no tool is executed again.
 */
export function selectForkEntries(branch: readonly SessionEntry[], assistantEntryId?: string): SessionEntry[] {
  if (branch.length === 0) throw new SessionForkError("empty");

  let selected: readonly SessionEntry[] = branch;
  if (assistantEntryId) {
    const targetIndex = branch.findIndex((entry) => entry.id === assistantEntryId);
    if (targetIndex < 0) throw new SessionForkError("not-on-branch");
    const target = branch[targetIndex];
    if (target.type !== "message" || target.message.role !== "assistant") {
      throw new SessionForkError("not-assistant");
    }

    const pending = toolCalls(target.message.content);
    let end = targetIndex;
    for (let index = targetIndex + 1; index < branch.length && pending.size > 0; index += 1) {
      const entry = branch[index];
      if (entry.type !== "message") {
        // State entries may be persisted between calls and results and belong to the
        // inherited parent chain.
        end = index;
        continue;
      }
      if (entry.message.role === "assistant") {
        const calls = toolCalls(entry.message.content);
        if (calls.size === 0) break;
        for (const [id, name] of calls) pending.set(id, name);
        end = index;
        continue;
      }
      if (entry.message.role !== "toolResult") break;
      const id = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : "";
      pending.delete(id);
      end = index;
    }
    selected = branch.slice(0, end + 1);
  }

  return repairToolHistory(selected);
}

/**
 * Clone selected entries while retaining the usage identity of inherited assistant
 * turns. The new session id is intentionally different, but copied history must not be
 * charged twice in 使用统计. A fork of a fork keeps the oldest identity entry-by-entry.
 */
export function inheritedForkEntries(entries: readonly SessionEntry[], sourceSessionId: string): SessionEntry[] {
  return entries.map((entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return { ...entry };
    const existing = (entry as unknown as Record<string, unknown>)[FORK_USAGE_SESSION_FIELD];
    return {
      ...entry,
      [FORK_USAGE_SESSION_FIELD]: typeof existing === "string" && existing ? existing : sourceSessionId,
    } as SessionEntry;
  });
}

/**
 * A fork must never retain a cwd owned by an isolated conversation. Deleting or
 * rebinding that owner removes its worktree, leaving the fork pointed at a dead path.
 * Checking every catalogued root also catches a fork-of-a-fork made before this guard,
 * whose own `worktree` field is absent even though its cwd still lies below one.
 */
export function cwdUsesWorktree(cwd: string, worktreePaths: readonly string[]): boolean {
  const candidate = resolve(cwd);
  return worktreePaths.some((path) => {
    const root = resolve(path);
    const within = relative(root, candidate);
    return within === "" || (!within.startsWith("..") && !isAbsolute(within));
  });
}

/** Pick a stable, non-empty sidebar preview from the history the fork inherits. */
export function forkPreview(entries: readonly SessionEntry[], existing?: string, fallback?: string): string {
  const prior = existing?.trim();
  if (prior) return prior.slice(0, 80);
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const content = "content" in entry.message ? entry.message.content : undefined;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => {
            if (!part || typeof part !== "object") return [];
            const value = (part as unknown as Record<string, unknown>).text;
            return typeof value === "string" ? [value] : [];
          }).join(" ")
        : "";
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact) return compact.slice(0, 80);
  }
  return fallback?.trim().slice(0, 80) || "Fork";
}

/** Write a fresh v3 transcript and return the manager inputs used to open it. */
export function writeForkSession(options: {
  sessionDir: string;
  cwd: string;
  sourceSessionId: string;
  sourceSessionFile?: string;
  entries: readonly SessionEntry[];
}): { sessionFile: string; sessionId: string } {
  mkdirSync(options.sessionDir, { recursive: true });
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionFile = join(options.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const inherited = inheritedForkEntries(options.entries, options.sourceSessionId);
  const header: ForkSessionHeader = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd: options.cwd,
    ...(options.sourceSessionFile ? { parentSession: options.sourceSessionFile } : {}),
    fastvibeFork: {
      sourceSessionId: options.sourceSessionId,
      inheritedThroughEntryId: inherited.at(-1)?.id ?? null,
    },
  };
  const body = [header, ...inherited].map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(sessionFile, `${body}\n`, { flag: "wx" });
  return { sessionFile, sessionId };
}

function repairToolHistory(entries: readonly SessionEntry[]): SessionEntry[] {
  const repaired: SessionEntry[] = [];

  const append = (entry: SessionEntry): void => {
    repaired.push({ ...entry, parentId: repaired.at(-1)?.id ?? null });
  };
  const appendOrphan = (entry: SessionEntry): void => {
    // A result without a call is rejected by providers. Keep its id, content, and
    // metadata, but make it ordinary user context so malformed old history survives.
    if (entry.type !== "message" || entry.message.role !== "toolResult") return;
    append({ ...entry, message: { ...entry.message, role: "user" } } as SessionEntry);
  };
  const appendMissing = (toolCallId: string, name: string, assistant: SessionEntry): void => {
    if (assistant.type !== "message" || assistant.message.role !== "assistant") return;
    const messageTimestamp = typeof assistant.message.timestamp === "number"
      ? assistant.message.timestamp
      : new Date(assistant.timestamp).getTime();
    append({
      type: "message",
      id: `fork-missing-tool-${randomUUID()}`,
      parentId: null,
      timestamp: assistant.timestamp,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: name,
        content: [{
          type: "text",
          text: uiText(
            "分叉时未取得工具结果，工具未在此分叉中执行",
            "The tool result was unavailable when forking; the tool was not executed in this fork",
          ),
        }],
        isError: true,
        timestamp: messageTimestamp,
      },
    } as SessionEntry);
  };

  for (let index = 0; index < entries.length;) {
    const original = entries[index];
    if (original.type !== "message" || original.message.role !== "assistant" || toolCalls(original.message.content).size === 0) {
      if (original.type === "message" && original.message.role === "toolResult") appendOrphan(original);
      else append(original);
      index += 1;
      continue;
    }

    // pi-ai settles pending calls whenever it reaches the next assistant. Some old
    // transcripts instead aggregate multiple tool-call assistants followed by their
    // results. Look through that entire contiguous exchange and normalize it to the
    // provider-safe A/results/A/results shape before pi-ai sees it.
    const assistants: Array<{ entry: SessionEntry; calls: Map<string, string> }> = [];
    const results: SessionEntry[] = [];
    const callOwner = new Map<string, number>();
    let cursor = index;
    while (cursor < entries.length) {
      const candidate = entries[cursor];
      if (candidate.type !== "message") break;
      if (candidate.message.role === "assistant") {
        const calls = toolCalls(candidate.message.content);
        if (calls.size === 0) break;
        const owner = assistants.length;
        for (const id of calls.keys()) {
          if (callOwner.has(id)) throw new SessionForkError("invalid-tools");
          callOwner.set(id, owner);
        }
        assistants.push({ entry: candidate, calls });
      } else if (candidate.message.role === "toolResult") {
        results.push(candidate);
      } else {
        break;
      }
      cursor += 1;
    }

    const matched = assistants.map(() => new Map<string, SessionEntry>());
    const orphans: SessionEntry[] = [];
    for (const result of results) {
      if (result.type !== "message" || result.message.role !== "toolResult") continue;
      const id = typeof result.message.toolCallId === "string" ? result.message.toolCallId : "";
      const owner = callOwner.get(id);
      if (owner === undefined || matched[owner].has(id)) orphans.push(result);
      else matched[owner].set(id, result);
    }

    for (let owner = 0; owner < assistants.length; owner += 1) {
      const assistant = assistants[owner];
      append(assistant.entry);
      for (const [id, name] of assistant.calls) {
        const result = matched[owner].get(id);
        if (result) append(result);
        else appendMissing(id, name, assistant.entry);
      }
    }
    for (const orphan of orphans) appendOrphan(orphan);
    index = cursor;
  }
  return repaired;
}

function toolCalls(content: unknown): Map<string, string> {
  const ids = new Map<string, string>();
  if (!Array.isArray(content)) return ids;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type !== "toolCall" && type !== "tool_use" && type !== "tool_call" && type !== "toolcall") continue;
    const id = typeof record.id === "string" ? record.id : typeof record.toolCallId === "string" ? record.toolCallId : "";
    if (!id || ids.has(id)) throw new SessionForkError("invalid-tools");
    const name = typeof record.name === "string" && record.name ? record.name : "unknown";
    ids.set(id, name);
  }
  return ids;
}
