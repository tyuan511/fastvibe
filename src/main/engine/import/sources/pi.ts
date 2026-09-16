import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ImportedItem, ImportedSession, ImportedToolCall, ImportAdapter, ImportCandidateInfo } from "../types";
import { asArray, asNumber, asRecord, asString, clipToolText, excerpt, forEachJsonLine, textFromBlocks, toMillis } from "../io";

/**
 * pi coding agent — the source this feature was originally about, and the only one
 * whose transcripts are already in the target format.
 *
 * The adapter still goes through the intermediate form rather than copying entries,
 * because the *content* is compatible but the rules are not: a pi file may be v1 with
 * no entry ids, may contain a `compaction` entry, and may carry tool calls whose
 * results only exist in the entries after it. Rebuilding through the writer gives one
 * validated transcript instead of a file that happens to look right.
 */
const ROOT = join(homedir(), ".pi", "agent", "sessions");

export const piAdapter: ImportAdapter = {
  id: "pi",
  name: "pi coding agent",
  root: ROOT,

  async scan(): Promise<ImportCandidateInfo[]> {
    const files = await listSessionFiles(ROOT);
    const candidates: ImportCandidateInfo[] = [];
    for (const file of files) {
      const info = await summarize(file);
      if (info) candidates.push(info);
    }
    return candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async read(id: string): Promise<ImportedSession> {
    const file = id;
    const items: ImportedItem[] = [];
    const skipped: string[] = [];
    let header: Record<string, unknown> = {};
    let title = "";
    let createdAt = 0;
    let updatedAt = 0;
    let model: ImportedSession["model"];
    let thinkingLevels = 0;
    let compaction = 0;
    let labels = 0;

    // Tool results arrive as separate entries, so they are parked here until the
    // assistant item that owns the call is closed out.
    const calls = new Map<string, ImportedToolCall>();
    let openAssistant: Extract<ImportedItem, { kind: "assistant" }> | undefined;
    let openUser: Extract<ImportedItem, { kind: "user" }> | undefined;

    await forEachJsonLine(file, (entry) => {
      const type = asString(entry.type);
      const at = toMillis(entry.timestamp) ?? 0;
      if (at > 0) updatedAt = Math.max(updatedAt, at);

      if (type === "session") {
        header = entry;
        createdAt = at;
        return;
      }
      if (type === "session_info") {
        const name = asString(entry.name)?.trim();
        if (name) title = name;
        return;
      }
      if (type === "model_change") {
        const modelId = asString(entry.modelId);
        if (modelId) model = { provider: asString(entry.provider) ?? "imported", model: modelId };
        return;
      }
      if (type === "thinking_level_change") {
        thinkingLevels += 1;
        return;
      }
      if (type === "compaction" || type === "branch_summary") {
        // Dropping the marker keeps the full history visible. Writing it as a real
        // `compaction` entry would make the engine context (and the thread, which is
        // built from that context) start at the marker and hide everything before it.
        compaction += 1;
        return;
      }
      if (type === "label") {
        labels += 1;
        return;
      }
      if (type === "custom" || type === "custom_message") {
        const text = textFromBlocks(entry.content);
        if (text.trim()) {
          openUser = undefined;
          items.push({ kind: "user", text, at });
        }
        return;
      }
      if (type !== "message") return;

      const message = asRecord(entry.message);
      if (!message) return;
      const role = asString(message.role);
      const messageAt = toMillis(message.timestamp) ?? at;

      if (role === "user") {
        const text = textFromBlocks(message.content);
        const images = imagesOf(message.content);
        if (!text.trim() && images.length === 0) return;
        openUser = { kind: "user", text, images: images.length ? images : undefined, at: messageAt };
        openAssistant = undefined;
        items.push(openUser);
        return;
      }

      if (role === "toolResult") {
        const callId = asString(message.toolCallId) ?? "";
        const call = calls.get(callId);
        const text = clipToolText(textFromBlocks(message.content));
        if (call) {
          call.result = { text, isError: message.isError === true, at: messageAt };
        } else {
          // A result with no call in this branch: keep the output rather than lose it.
          items.push({
            kind: "assistant",
            text: "",
            thinking: [],
            toolCalls: [
              {
                id: callId || "unknown",
                name: asString(message.toolName) ?? "tool",
                args: {},
                result: { text, isError: message.isError === true, at: messageAt },
              },
            ],
            at: messageAt,
          });
        }
        return;
      }

      if (role !== "assistant") return;

      const thinking: string[] = [];
      const toolCalls: ImportedToolCall[] = [];
      let text = "";
      for (const part of asArray(message.content)) {
        const record = asRecord(part);
        if (!record) continue;
        const partType = asString(record.type);
        if (partType === "thinking") thinking.push(asString(record.thinking) ?? asString(record.text) ?? "");
        else if (partType === "text") text = text ? `${text}\n${asString(record.text) ?? ""}` : asString(record.text) ?? "";
        else if (isToolCallType(partType)) {
          const call: ImportedToolCall = {
            id: asString(record.id) ?? `call_${toolCalls.length}`,
            name: asString(record.name) ?? "tool",
            args: record.arguments ?? record.input ?? {},
          };
          calls.set(call.id, call);
          toolCalls.push(call);
        }
      }
      const usage = asRecord(message.usage);
      openUser = undefined;
      openAssistant = {
        kind: "assistant",
        text,
        thinking: thinking.filter((item) => item.trim()),
        toolCalls,
        model: asString(message.model),
        provider: asString(message.provider),
        usage: usage
          ? {
              input: asNumber(usage.input) ?? 0,
              output: asNumber(usage.output) ?? 0,
              cacheRead: asNumber(usage.cacheRead) ?? 0,
              cacheWrite: asNumber(usage.cacheWrite) ?? 0,
              total: asNumber(usage.totalTokens) ?? 0,
            }
          : undefined,
        at: messageAt,
      };
      items.push(openAssistant);
    });

    if (compaction > 0) skipped.push(`已跳过 ${compaction} 条压缩/分支摘要（保留完整历史）`);
    if (thinkingLevels > 0 || labels > 0) {
      const parts: string[] = [];
      if (thinkingLevels > 0) parts.push(`${thinkingLevels} 条思考强度变更`);
      if (labels > 0) parts.push(`${labels} 个书签`);
      skipped.push(`已跳过${parts.join("、")}`);
    }

    const firstUser = items.find((item) => item.kind === "user");
    const cwd = asString(header.cwd);
    return {
      source: "pi",
      sourceId: file,
      title: title || excerpt(firstUser?.kind === "user" ? firstUser.text : "") || "导入的会话",
      cwd,
      createdAt: createdAt || updatedAt || Date.now(),
      updatedAt: updatedAt || createdAt || Date.now(),
      model,
      items,
      skipped,
    };
  },
};

/** `~/.pi/agent/sessions/<encoded-cwd>/<stamp>_<id>.jsonl`, two levels deep. */
async function listSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = join(root, dir.name);
    let entries;
    try {
      entries = await readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(full, entry.name));
    }
  }
  return files;
}

async function summarize(file: string): Promise<ImportCandidateInfo | undefined> {
  let size = 0;
  let mtime = 0;
  try {
    const info = await stat(file);
    size = info.size;
    mtime = info.mtimeMs;
  } catch {
    return undefined;
  }
  let id = "";
  let cwd: string | undefined;
  let createdAt = 0;
  let firstUser = "";
  let name = "";
  let messages = 0;
  let lastAt = 0;

  await forEachJsonLine(file, (entry) => {
    const type = asString(entry.type);
    const at = toMillis(entry.timestamp) ?? 0;
    if (type === "session") {
      id = asString(entry.id) ?? "";
      cwd = asString(entry.cwd);
      createdAt = at;
      return;
    }
    if (type === "session_info") {
      const value = asString(entry.name)?.trim();
      if (value) name = value;
      return;
    }
    if (type !== "message") return;
    const message = asRecord(entry.message);
    if (!message) return;
    if (message.role === "user") {
      messages += 1;
      if (!firstUser) firstUser = textFromBlocks(message.content);
      lastAt = Math.max(lastAt, toMillis(message.timestamp) ?? at);
    } else if (message.role === "assistant") {
      messages += 1;
      lastAt = Math.max(lastAt, toMillis(message.timestamp) ?? at);
    }
  });

  if (!id) return undefined;
  return {
    id: file,
    title: name || excerpt(firstUser) || relative(ROOT, file),
    cwd,
    createdAt: createdAt || mtime,
    updatedAt: Math.max(lastAt, createdAt, Math.floor(mtime)) || createdAt,
    messageCount: messages,
    bytes: size,
  };
}

function imagesOf(content: unknown): { data: string; mimeType: string }[] {
  return asArray(content).flatMap((part) => {
    const record = asRecord(part);
    if (!record || record.type !== "image") return [];
    const data = asString(record.data);
    if (!data) return [];
    return [{ data, mimeType: asString(record.mimeType) ?? "image/png" }];
  });
}

function isToolCallType(type: string | undefined): boolean {
  return type === "toolCall" || type === "tool_use" || type === "toolcall" || type === "tool_call";
}
