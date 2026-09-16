import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportedSession } from "./types";

/**
 * Turn an intermediate session into a pi v3 transcript the embedded engine can open,
 * continue, and count (see `docs/import-from-other-agents.md` §2).
 *
 * Everything load-bearing about a session file happens here and nowhere else:
 *
 *  - the first line is the `session` header, or the SDK treats the file as invalid;
 *  - `version: 3` means no migration pass rewrites the file (and every id in it);
 *  - entries form a linear `parentId` chain in file order, because the reader takes
 *    the *last* entry as the leaf and walks back from it;
 *  - a tool result is written immediately after the assistant that made the call, and
 *    a call with no recorded output still gets one — a dangling `toolCall` is only
 *    rejected later, on the next real request;
 *  - thinking is written without a signature, which is what makes pi downgrade it to
 *    plain text instead of replaying a foreign (and invalid) provider signature.
 */
export type WrittenSession = {
  sessionFile: string;
  sessionId: string;
  /** Where the session runs: the original project when it still exists, else scratch. */
  cwd: string;
  /** The source's working directory, when it exists and was kept as the project binding. */
  project?: string;
  title: string;
  preview?: string;
  createdAt: number;
  updatedAt: number;
  /** Written message entries (user + assistant + tool results). */
  messages: number;
};

/** Short ids, matching the engine's own transcript style (`624b20d9`, `1ea5d812`). */
function entryId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** `--Users-me-code-repo--`, identical to the SDK's own session-dir encoding. */
export function sessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** One line of the transcript, and the preview/title fallbacks derived from it. */
function previewOf(item: { kind: string; text?: string }): string | undefined {
  if (item.kind !== "user") return undefined;
  const text = (item.text ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : undefined;
}

export function writeImportedSession(
  session: ImportedSession,
  options: { sessionsDir: string; scratchDir: string },
): WrittenSession {
  // A source's working directory often no longer exists (deleted worktree, moved
  // repo). Binding the conversation to a missing path would hand the agent a cwd it
  // cannot use, so those imports land in the shared scratch workspace instead.
  const original = session.cwd?.trim();
  const project = original && isDirectory(original) ? original : undefined;
  const cwd = project ?? options.scratchDir;

  const sessionId = randomUUID();
  const createdAt = Number.isFinite(session.createdAt) && session.createdAt > 0 ? session.createdAt : Date.now();
  const updatedAt = Number.isFinite(session.updatedAt) && session.updatedAt > 0 ? session.updatedAt : createdAt;

  const entries: unknown[] = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(createdAt).toISOString(),
      cwd,
    },
  ];

  let parentId: string | null = null;
  let messages = 0;

  const push = (entry: Record<string, unknown>): string => {
    const id = entryId();
    entries.push({ ...entry, id, parentId, timestamp: new Date(Number(entry.at ?? createdAt)).toISOString() });
    parentId = id;
    return id;
  };

  if (session.model?.model) {
    // Placed before every message: a `model_change` with no message before it is the
    // model the session was created on, not a switch, so it never reaches the
    // transcript as a divider (it only gives usage a provider/model fallback).
    push({ type: "model_change", at: createdAt, provider: session.model.provider, modelId: session.model.model });
  }

  for (const item of session.items) {
    if (item.kind === "user") {
      const images = item.images ?? [];
      const content: unknown[] = [];
      if (item.text.trim()) content.push({ type: "text", text: item.text });
      for (const image of images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      if (content.length === 0) continue;
      push({
        type: "message",
        at: item.at,
        // Keep the engine's own shape: a single text block stays a plain string.
        message: {
          role: "user",
          content: content.length === 1 && content[0] && (content[0] as { type: string }).type === "text"
            ? item.text
            : content,
          timestamp: item.at,
        },
      });
      messages += 1;
      continue;
    }

    const content: unknown[] = [];
    for (const thought of item.thinking) {
      if (thought.trim()) content.push({ type: "thinking", thinking: thought });
    }
    if (item.text.trim()) content.push({ type: "text", text: item.text });
    for (const call of item.toolCalls) {
      content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} });
    }
    if (content.length === 0) continue;
    // An assistant turn with no text, thinking or calls carries nothing to show and
    // nothing to send, and the renderer would drop it (map-messages.ts).
    const usage = item.usage;
    push({
      type: "message",
      at: item.at,
      message: {
        role: "assistant",
        content,
        // The api recorded on a message is never read back — the model in use chooses
        // the wire format — so this only has to be plausible.
        api: apiFor(item.provider),
        provider: item.provider ?? session.model?.provider ?? "imported",
        model: item.model ?? session.model?.model ?? "unknown",
        usage: usage
          ? {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              totalTokens: usage.total || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            }
          : {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
        stopReason: "stop",
        timestamp: item.at,
      },
    });
    messages += 1;

    // Results ride directly behind their call, before any later message can slip in.
    for (const call of item.toolCalls) {
      const at = call.result?.at ?? item.at;
      push({
        type: "message",
        at,
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: call.result?.text ?? "（该工具调用在原 agent 中没有返回结果，运行被中断）",
            },
          ],
          isError: call.result ? call.result.isError : true,
          timestamp: at,
        },
      });
      messages += 1;
    }
  }

  const preview = nextPreview(session);
  entries.push({
    type: "session_info",
    id: entryId(),
    parentId,
    timestamp: new Date(updatedAt).toISOString(),
    name: session.title,
  });

  const dir = join(options.sessionsDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const fileStamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
  const sessionFile = join(dir, `${fileStamp}_${sessionId}.jsonl`);
  // Write-then-rename: a half-written transcript would look like a valid session with
  // a truncated last line, which is worse than no file at all.
  const temp = `${sessionFile}.tmp`;
  writeFileSync(temp, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  renameSync(temp, sessionFile);

  return {
    sessionFile,
    sessionId,
    cwd,
    project,
    title: session.title,
    preview,
    createdAt,
    updatedAt,
    messages,
  };
}

/** The first thing the user said, which is what the sidebar's search and preview read. */
function nextPreview(session: ImportedSession): string | undefined {
  for (const item of session.items) {
    const preview = previewOf(item);
    if (preview) return preview;
    if (item.kind === "assistant" && item.text.trim()) return item.text.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return undefined;
}

function apiFor(provider: string | undefined): string {
  switch ((provider ?? "").toLowerCase()) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
    case "azure-openai":
      return "openai-responses";
    case "google":
    case "google-vertex":
      return "google-generative-ai";
    default:
      return "openai-completions";
  }
}

/** True once a path exists as a directory — used by adapters to report a stale cwd. */
export function directoryExists(path: string): boolean {
  return existsSync(path) && isDirectory(path);
}
