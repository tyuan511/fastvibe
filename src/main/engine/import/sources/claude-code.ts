import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ImportedItem, ImportedSession, ImportedToolCall, ImportedUsage, ImportAdapter, ImportCandidateInfo } from "../types";
import { asArray, asNumber, asRecord, asString, clipToolText, excerpt, forEachJsonLine, toMillis } from "../io";

/**
 * Claude Code — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * The whole adapter pivots on one detail: Claude Code writes **one JSONL line per
 * content block**, not per message. A single API response that thought and then called
 * a tool lands as two lines sharing a `message.id`, with `uuid`/`parentUuid` bookkeeping
 * around them. Read naively it becomes a string of half-empty assistant turns, so lines
 * are grouped back into one assistant item per `message.id`.
 *
 * Tool results are the mirror image: separate `type:"user"` entries carrying a
 * `tool_result` block. They are collected up front and attached to the call that owns
 * them, because the writer decides where in the transcript they belong.
 *
 * Everything else in the file — attachments, queue operations, titles, latching state —
 * is bookkeeping for Claude Code's own UI and is not conversation.
 */
const ROOT = join(homedir(), ".claude", "projects");

export const claudeCodeAdapter: ImportAdapter = {
  id: "claude-code",
  name: "Claude Code",
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
    // Pass one: the metadata that is not inside a message (cwd, titles) plus the tool
    // results, which can appear in the file before the call that produced them.
    const results = new Map<string, { text: string; isError: boolean; at: number }>();
    let cwd: string | undefined;
    let aiTitle = "";
    let customTitle = "";
    let createdAt = 0;
    let updatedAt = 0;

    await forEachJsonLine(id, (entry) => {
      const type = asString(entry.type);
      const at = toMillis(entry.timestamp) ?? 0;
      if (at > 0) {
        if (!createdAt) createdAt = at;
        updatedAt = Math.max(updatedAt, at);
      }
      if (!cwd) cwd = asString(entry.cwd);
      if (type === "ai-title") aiTitle = asString(entry.aiTitle)?.trim() || aiTitle;
      else if (type === "custom-title") customTitle = asString(entry.customTitle)?.trim() || customTitle;
      else if (type === "user") {
        const message = asRecord(entry.message);
        for (const part of asArray(message?.content)) {
          const record = asRecord(part);
          if (!record || record.type !== "tool_result") continue;
          const callId = asString(record.tool_use_id);
          if (callId) results.set(callId, { text: toolResultText(record.content), isError: record.is_error === true, at });
        }
      }
    });

    // Pass two: the conversation itself.
    const items: ImportedItem[] = [];
    const skipped: string[] = [];
    let sidechains = 0;
    let injected = 0;
    let lastModel: string | undefined;
    let current: Extract<ImportedItem, { kind: "assistant" }> | undefined;
    let currentId = "";

    await forEachJsonLine(id, (entry) => {
      const type = asString(entry.type);
      if (type !== "user" && type !== "assistant") return;
      if (entry.isSidechain === true) {
        // A subagent's private transcript shares the file. Folding it into the main
        // thread would reorder the conversation and invent turns the user never saw.
        sidechains += 1;
        return;
      }
      const message = asRecord(entry.message);
      if (!message) return;
      const at = toMillis(entry.timestamp) ?? 0;

      if (type === "user") {
        if (entry.isMeta === true) {
          injected += 1;
          return;
        }
        const content = message.content;
        const text = stripSynthetic(typeof content === "string" ? content : textBlocks(content));
        const images = imagesOf(content);
        if (!text.trim() && images.length === 0) return;
        current = undefined;
        currentId = "";
        items.push({ kind: "user", text, images: images.length ? images : undefined, at });
        return;
      }

      const messageId = asString(message.id) ?? `at:${at}`;
      const thinking: string[] = [];
      const toolCalls: ImportedToolCall[] = [];
      let text = "";
      for (const part of asArray(message.content)) {
        const record = asRecord(part);
        if (!record) continue;
        const partType = asString(record.type);
        if (partType === "thinking") {
          // The signature is intentionally dropped: it is bound to the provider and
          // model that produced it, and replaying it under another is rejected.
          const thought = asString(record.thinking);
          if (thought?.trim()) thinking.push(thought);
        } else if (partType === "text") {
          const value = asString(record.text) ?? "";
          text = text ? `${text}\n${value}` : value;
        } else if (partType === "tool_use") {
          const call: ImportedToolCall = {
            id: asString(record.id) ?? `call_${toolCalls.length}`,
            name: asString(record.name) ?? "tool",
            args: record.input ?? {},
          };
          const result = results.get(call.id);
          if (result) call.result = { text: clipToolText(result.text), isError: result.isError, at: result.at };
          toolCalls.push(call);
        }
      }

      const model = asString(message.model);
      if (model) lastModel = model;
      const usage = usageOf(message.usage);

      // Same API response → same item. Later lines carry the final usage.
      if (current && currentId === messageId) {
        if (text) current.text = current.text ? `${current.text}\n${text}` : text;
        current.thinking.push(...thinking);
        current.toolCalls.push(...toolCalls);
        if (usage) current.usage = usage;
        if (model) current.model = model;
        return;
      }

      currentId = messageId;
      current = {
        kind: "assistant",
        text,
        thinking,
        toolCalls,
        model,
        provider: "anthropic",
        usage,
        at,
      };
      items.push(current);
    });

    if (sidechains > 0) skipped.push(`已跳过 ${sidechains} 条子 agent 消息`);
    if (injected > 0) skipped.push(`已跳过 ${injected} 条系统注入消息`);

    const firstUser = items.find((item) => item.kind === "user");
    return {
      source: "claude-code",
      sourceId: id,
      title: customTitle || aiTitle || (firstUser?.kind === "user" ? excerpt(firstUser.text) : "") || basename(dirname(id)),
      // `cwd` is recorded on every entry; the directory name encodes it lossily (a
      // dash could be a separator or part of a name), so it is never decoded back.
      cwd,
      createdAt: createdAt || updatedAt || Date.now(),
      updatedAt: updatedAt || createdAt || Date.now(),
      model: lastModel ? { provider: "anthropic", model: lastModel } : undefined,
      items,
      skipped,
    };
  },
};

function usageOf(value: unknown): ImportedUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = asNumber(usage.input_tokens) ?? 0;
  const output = asNumber(usage.output_tokens) ?? 0;
  const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = asNumber(usage.cache_creation_input_tokens) ?? 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function textBlocks(content: unknown): string {
  return asArray(content)
    .flatMap((part) => {
      const record = asRecord(part);
      if (!record || record.type !== "text") return [];
      const value = asString(record.text);
      return value ? [value] : [];
    })
    .join("\n");
}

/** `{type:"image", source:{type:"base64", media_type, data}}` → the engine's inline image. */
function imagesOf(content: unknown): { data: string; mimeType: string }[] {
  return asArray(content).flatMap((part) => {
    const record = asRecord(part);
    if (!record || record.type !== "image") return [];
    const source = asRecord(record.source);
    const data = asString(source?.data);
    if (!data) return [];
    return [{ data, mimeType: asString(source?.media_type) ?? "image/png" }];
  });
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .flatMap((part) => {
      const record = asRecord(part);
      if (!record) return [];
      const text = asString(record.text);
      if (text !== undefined) return [text];
      const image = asRecord(record.source)?.data;
      return typeof image === "string" ? ["（图片输出）"] : [];
    })
    .join("\n");
}

/**
 * Strip the wrappers Claude Code adds around its own plumbing. Injected reminders and
 * slash-command echoes are not things the user said, and they read as noise beside the
 * actual prompt.
 */
function stripSynthetic(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .trim();
}

/** `<root>/<encoded-cwd>/<sessionId>.jsonl` — one level, no index to read. */
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
  let cwd: string | undefined;
  let createdAt = 0;
  let lastAt = 0;
  let firstUser = "";
  let messages = 0;
  let sidechain = false;

  await forEachJsonLine(file, (entry) => {
    const type = asString(entry.type);
    const at = toMillis(entry.timestamp) ?? 0;
    if (!cwd) cwd = asString(entry.cwd);
    if (at > 0) {
      if (!createdAt) createdAt = at;
      lastAt = Math.max(lastAt, at);
    }
    if (entry.isSidechain === true) {
      sidechain = true;
      return;
    }
    if (type !== "user" && type !== "assistant") return;
    const message = asRecord(entry.message);
    if (!message) return;
    if (type === "assistant") {
      messages += 1;
      return;
    }
    if (entry.isMeta === true) return;
    const content = message.content;
    const text = stripSynthetic(typeof content === "string" ? content : textBlocks(content));
    if (!text.trim()) return;
    messages += 1;
    if (!firstUser) firstUser = text;
  });

  return {
    id: file,
    title: excerpt(firstUser) || basename(dirname(file)),
    cwd,
    createdAt: createdAt || Math.floor(mtime),
    updatedAt: lastAt || createdAt || Math.floor(mtime),
    messageCount: messages,
    bytes: size,
    note: sidechain ? "含子 agent 轨迹，导入时会跳过" : undefined,
  };
}
