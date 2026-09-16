import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ImportedItem, ImportedSession, ImportedToolCall, ImportedUsage, ImportAdapter, ImportCandidateInfo } from "../types";
import { asArray, asNumber, asRecord, asString, clipToolText, excerpt, toMillis } from "../io";
import { disposeImportDatabases, openReadOnlyDatabase } from "../sqlite";

/**
 * opencode (sst/opencode) — `~/.local/share/opencode`.
 *
 * Two stores coexist on any installed machine and must not be merged: `opencode.db`
 * is the authoritative current layout, and the `storage/**` JSON tree is what a
 * migration left behind (237 sessions there vs 557 in the DB on the author's corpus).
 * The DB is read first and JSON is only the fallback when the DB cannot be opened.
 *
 * Unlike the Claude Code and pi adapters, one opencode *message* owns its content as a
 * set of `part` rows rather than as JSONL lines, and the message row itself is nearly
 * empty — a user message carries no text at all, only a timestamp. So every message is
 * reconstructed from its parts and emitted once: text parts joined, reasoning collected,
 * and tool calls carrying their own output (`state.output`), which is why this adapter
 * never produces separate toolResult items.
 *
 * Parts that are not conversation — step markers, patch summaries, file references,
 * compaction markers, `subtask`/`agent` references — are counted and reported in
 * `skipped`. In particular a `compaction` part is deliberately *not* written as a
 * compaction entry: the engine builds the sent context from it, so emitting one would
 * hide everything before the marker from both the model and the thread.
 */
const ROOT = join(homedir(), ".local", "share", "opencode");
const DB_FILE = join(ROOT, "opencode.db");
const STORAGE = join(ROOT, "storage");

/** Chosen `read()` ids for the JSON fallback, distinct from a bare `ses_...` DB id. */
const JSON_PREFIX = "json:";

export const opencodeAdapter: ImportAdapter = {
  id: "opencode",
  name: "opencode",
  root: ROOT,

  async scan(): Promise<ImportCandidateInfo[]> {
    if (existsSync(DB_FILE)) {
      try {
        return await scanDatabase();
      } catch {
        // The DB exists but is unreadable: opencode is mid-write (SQLITE_BUSY), the file
        // is a torn copy, or the schema predates this adapter. Falling back to the JSON
        // tree is still better than an empty list, and the candidates say which store
        // they came from.
      }
    }
    return scanJson();
  },

  async read(id: string): Promise<ImportedSession> {
    if (id.startsWith(JSON_PREFIX)) return readJson(id.slice(JSON_PREFIX.length));
    return readDatabase(id);
  },

  // Shared with the zcode adapter: both read a WAL database that their agent is still
  // writing, so both may have had to copy it aside (see `../sqlite.ts`).
  dispose: disposeImportDatabases,
};

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  model: string | null;
  worktree?: string | null;
};
type StatRow = { session_id: string; c: number };
type MessageRow = { id: string; time_created: number; data: string };
type PartRow = { message_id: string; time_created: number; data: string };

async function scanDatabase(): Promise<ImportCandidateInfo[]> {
  const handle = await openReadOnlyDatabase(DB_FILE);
  try {
    const sessions = handle.db
      .prepare(
        `SELECT s.id, s.title, s.directory, s.parent_id, s.time_created, s.time_updated, s.time_archived, s.model, p.worktree
           FROM session s LEFT JOIN project p ON p.id = s.project_id
          ORDER BY s.time_created DESC`,
      )
      .all() as unknown as SessionRow[];

    // Counts only. Summing `LENGTH(data)` across the 81k `part` rows costs ~2.6s on the
    // author's corpus — it has to read every payload blob — and the DB file size says
    // nothing either (2.3 GB of the 2.8 GB is the unrelated `event` table). A message
    // count is the honest, cheap signal here, so that is what the picker gets.
    const stats = new Map<string, number>();
    for (const row of handle.db
      .prepare("SELECT session_id, COUNT(*) AS c FROM message GROUP BY session_id")
      .all() as unknown as StatRow[]) {
      stats.set(row.session_id, (stats.get(row.session_id) ?? 0) + row.c);
    }

    return sessions.map((row) => {
      const count = stats.get(row.id) ?? 0;
      const notes: string[] = [];
      if (row.parent_id) notes.push("子会话（subagent）");
      return {
        id: row.id,
        title: row.title?.trim() || row.id,
        cwd: row.directory?.trim() || row.worktree?.trim() || undefined,
        createdAt: row.time_created,
        updatedAt: row.time_updated,
        messageCount: count,
        archived: row.time_archived !== null,
        note: notes.length ? notes.join("、") : undefined,
      };
    });
  } finally {
    await handle.close();
  }
}

async function readDatabase(id: string): Promise<ImportedSession> {
  if (!existsSync(DB_FILE)) throw new Error("未找到 opencode 数据库");
  const handle = await openReadOnlyDatabase(DB_FILE);
  try {
    const session = handle.db
      .prepare("SELECT id, title, directory, parent_id, time_created, time_updated, time_archived, model, NULL AS worktree FROM session WHERE id = ?")
      .get(id) as unknown as SessionRow | undefined;
    if (!session) throw new Error(`opencode 数据库中找不到会话 ${id}`);

    // One query per table, each scoped by `session_id`: a session on this corpus can hold
    // ~10k parts, so nothing is ever fetched for the whole database.
    const partsByMessage = new Map<string, RawPart[]>();
    for (const row of handle.db
      .prepare("SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, rowid")
      .all(id) as unknown as PartRow[]) {
      const data = parseRecord(row.data);
      if (!data) continue;
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push({ at: row.time_created, data });
      partsByMessage.set(row.message_id, list);
    }

    const messages: RawMessage[] = [];
    for (const row of handle.db
      .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(id) as unknown as MessageRow[]) {
      const data = parseRecord(row.data);
      if (!data) continue;
      messages.push({ id: row.id, at: row.time_created, data, parts: partsByMessage.get(row.id) ?? [] });
    }

    return assemble(
      {
        id: session.id,
        title: session.title?.trim() ?? "",
        directory: session.directory?.trim() || undefined,
        createdAt: session.time_created,
        updatedAt: session.time_updated,
        model: modelOf(session.model),
      },
      messages,
    );
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Legacy JSON store (fallback only)
// ---------------------------------------------------------------------------

async function scanJson(): Promise<ImportCandidateInfo[]> {
  const candidates: ImportCandidateInfo[] = [];
  for (const projectDir of await listDirs(join(STORAGE, "session"))) {
    for (const file of await listJson(projectDir)) {
      const data = await readRecord(file);
      const id = asString(data?.id);
      if (!data || !id) continue;

      let messageCount = 0;
      let bytes = 0;
      for (const messageFile of await listJson(join(STORAGE, "message", id))) {
        messageCount += 1;
        bytes += await sizeOf(messageFile);
        for (const partFile of await listJson(join(STORAGE, "part", basename(messageFile, ".json")))) {
          bytes += await sizeOf(partFile);
        }
      }

      const created = toMillis(asRecord(data.time)?.created);
      const updated = toMillis(asRecord(data.time)?.updated);
      const notes = ["opencode.db 不可用，读取旧版 JSON 存储"];
      if (asString(data.parentID)) notes.push("子会话（subagent）");
      candidates.push({
        id: `${JSON_PREFIX}${id}`,
        title: asString(data.title)?.trim() || id,
        cwd: asString(data.directory)?.trim() || undefined,
        createdAt: created ?? 0,
        updatedAt: updated ?? created ?? 0,
        messageCount,
        bytes,
        note: notes.join("、"),
      });
    }
  }
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readJson(sessionId: string): Promise<ImportedSession> {
  const file = await findSessionFile(sessionId);
  if (!file) throw new Error(`opencode 旧版 JSON 存储中找不到会话 ${sessionId}`);
  const data = await readRecord(file);
  if (!data) throw new Error(`无法解析 opencode 会话文件：${file}`);

  const messages: RawMessage[] = [];
  for (const messageFile of await listJson(join(STORAGE, "message", sessionId))) {
    const record = await readRecord(messageFile);
    if (!record) continue;
    const id = asString(record.id) ?? basename(messageFile, ".json");

    // Legacy part files carry no top-level timestamp, but their ids are time-prefixed,
    // so the name-sorted order from `listJson` is already chronological. Message files do
    // carry `time.created`, used here as the primary key.
    const parts: RawPart[] = [];
    for (const partFile of await listJson(join(STORAGE, "part", id))) {
      const part = await readRecord(partFile);
      if (part) parts.push({ at: 0, data: part });
    }
    const at = toMillis(asRecord(record.time)?.created) ?? toMillis(asRecord(record.time)?.completed) ?? 0;
    messages.push({ id, at, data: record, parts });
  }
  messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  // `directory` is authoritative and almost always present; the project file is only a
  // fallback for a session written before that column existed.
  let directory = asString(data.directory)?.trim() || undefined;
  if (!directory) {
    const projectId = asString(data.projectID);
    if (projectId) {
      const project = await readRecord(join(STORAGE, "project", `${projectId}.json`));
      directory = asString(project?.worktree)?.trim() || undefined;
    }
  }

  return assemble(
    {
      id: asString(data.id) ?? sessionId,
      title: asString(data.title)?.trim() ?? "",
      directory,
      createdAt: toMillis(asRecord(data.time)?.created) ?? 0,
      updatedAt: toMillis(asRecord(data.time)?.updated) ?? 0,
      model: modelOf(data.model),
    },
    messages,
  );
}

async function findSessionFile(sessionId: string): Promise<string | undefined> {
  for (const projectDir of await listDirs(join(STORAGE, "session"))) {
    const candidate = join(projectDir, `${sessionId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared assembly
// ---------------------------------------------------------------------------

type RawPart = { at: number; data: Record<string, unknown> };
type RawMessage = { id: string; at: number; data: Record<string, unknown>; parts: RawPart[] };
type SessionMeta = {
  id: string;
  title: string;
  directory?: string;
  createdAt: number;
  updatedAt: number;
  model?: { provider: string; model: string };
};

function assemble(meta: SessionMeta, messages: RawMessage[]): ImportedSession {
  const items: ImportedItem[] = [];
  const counts = { systemPrompts: 0, compaction: 0, patch: 0, file: 0, subtask: 0, agent: 0, synthetic: 0, noText: 0, empty: 0, unknown: 0 };
  let last: { provider?: string; model?: string } = {};

  for (const message of messages) {
    const role = asString(message.data.role);

    if (role === "user") {
      const texts: string[] = [];
      for (const part of message.parts) {
        const type = asString(part.data.type);
        if (type === "text") {
          // `synthetic` marks opencode's own injections — file dumps and tool-call echoes
          // it prepends to the prompt. They are not what the user typed.
          if (part.data.synthetic === true) {
            counts.synthetic += 1;
            continue;
          }
          const value = asString(part.data.text);
          if (value?.trim()) texts.push(value);
        } else if (type === "file") {
          // A `file` part is a path reference (`file://…`), not inline base64, so it
          // cannot become an ImportedImage.
          counts.file += 1;
        }
      }
      const text = texts.join("\n\n");
      if (!text.trim()) {
        counts.noText += 1;
        continue;
      }
      items.push({ kind: "user", text, at: message.at });
      continue;
    }

    if (role !== "assistant") continue;

    const texts: string[] = [];
    const thinking: string[] = [];
    const toolCalls: ImportedToolCall[] = [];
    let stepUsage: ImportedUsage | undefined;
    for (const part of message.parts) {
      switch (asString(part.data.type)) {
        case "text": {
          if (part.data.synthetic === true) {
            counts.synthetic += 1;
            break;
          }
          const value = asString(part.data.text);
          if (value?.trim()) texts.push(value);
          break;
        }
        case "reasoning": {
          const value = asString(part.data.text);
          if (value?.trim()) thinking.push(value);
          break;
        }
        case "tool":
          toolCalls.push(toolCallOf(part.data, part.at, toolCalls.length));
          break;
        case "step-finish":
          // Only a fallback: `message.data.tokens` is the message total when present.
          stepUsage = mergeUsage(stepUsage, usageFromTokens(part.data.tokens));
          break;
        case "compaction":
          counts.compaction += 1;
          break;
        case "patch":
          counts.patch += 1;
          break;
        case "file":
          counts.file += 1;
          break;
        case "subtask":
          counts.subtask += 1;
          break;
        case "agent":
          counts.agent += 1;
          break;
        case "step-start":
          break;
        default:
          counts.unknown += 1;
          break;
      }
    }

    // The assistant `system[]` is the full system prompt repeated on every message; it
    // would be sent as the first thing the model reads and is never imported.
    if (asArray(message.data.system).length > 0) counts.systemPrompts += 1;

    const model = asString(message.data.modelID);
    const provider = asString(message.data.providerID);
    if (model) last = { provider, model };

    const usage = usageFromTokens(message.data.tokens) ?? stepUsage;
    let text = texts.join("\n\n");
    if (!text.trim() && thinking.length === 0 && toolCalls.length === 0) {
      // A failed request can leave nothing but the error. Keeping it makes the gap in the
      // transcript explainable; without one this is an empty shell the writer would drop.
      const failure = errorText(message.data.error);
      if (!failure) {
        counts.empty += 1;
        continue;
      }
      text = `（该回合请求失败：${failure}）`;
    }

    items.push({ kind: "assistant", text, thinking, toolCalls, model, provider, usage, at: message.at });
  }

  const skipped: string[] = [];
  if (counts.systemPrompts) skipped.push(`已跳过 ${counts.systemPrompts} 条系统提示词（assistant.system）`);
  if (counts.compaction) skipped.push(`已跳过 ${counts.compaction} 个压缩标记（保留完整历史）`);
  if (counts.patch) skipped.push(`已跳过 ${counts.patch} 个文件变更汇总（patch part）`);
  if (counts.file) skipped.push(`已跳过 ${counts.file} 个附件引用（opencode 只记录文件路径，无法内联）`);
  if (counts.subtask) skipped.push(`已跳过 ${counts.subtask} 条子任务调用（subtask part）`);
  if (counts.agent) skipped.push(`已跳过 ${counts.agent} 条 agent 引用`);
  if (counts.synthetic) skipped.push(`已跳过 ${counts.synthetic} 段注入文本（synthetic part）`);
  if (counts.noText) skipped.push(`已跳过 ${counts.noText} 条无正文的用户消息`);
  if (counts.empty) skipped.push(`已跳过 ${counts.empty} 条空 assistant 消息`);
  if (counts.unknown) skipped.push(`已跳过 ${counts.unknown} 个未知 part`);

  const firstUser = items.find((item) => item.kind === "user");
  return {
    source: "opencode",
    sourceId: meta.id,
    title: meta.title || excerpt(firstUser?.kind === "user" ? firstUser.text : "") || meta.id,
    cwd: meta.directory,
    createdAt: meta.createdAt || meta.updatedAt || Date.now(),
    updatedAt: meta.updatedAt || meta.createdAt || Date.now(),
    model: meta.model ?? (last.model ? { provider: last.provider ?? "opencode", model: last.model } : undefined),
    items,
    skipped,
  };
}

/**
 * A `tool` part carries its own output, so a result never becomes a separate item. A
 * `pending`/`running` status means the run was interrupted before anything came back —
 * the result is left undefined and the writer synthesises the "no result" marker, which
 * is what keeps the next request from being rejected for a dangling tool call.
 */
function toolCallOf(data: Record<string, unknown>, partAt: number, index: number): ImportedToolCall {
  const state = asRecord(data.state);
  const status = asString(state?.status);
  const time = asRecord(state?.time);
  const at = toMillis(time?.end) ?? toMillis(time?.start) ?? partAt;
  const call: ImportedToolCall = {
    id: asString(data.callID) ?? `call_${index}`,
    name: asString(data.tool) ?? "tool",
    args: state?.input ?? {},
  };
  if (status === "completed") {
    call.result = { text: clipToolText(outputText(state?.output)), isError: false, at };
  } else if (status === "error") {
    const message = outputText(state?.output) || errorText(state?.error) || "工具调用失败";
    call.result = { text: clipToolText(message), isError: true, at };
  }
  return call;
}

/** Structured output (`state.output` is usually a string) is stringified defensively. */
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const message = asString(asRecord(record?.data)?.message) ?? asString(record?.message);
  if (message) return message;
  return asString(record?.name) ?? outputText(value);
}

/**
 * `tokens.reasoning` is already part of `output` in opencode (it reports the reasoning
 * count alongside a total that includes it), so it is deliberately not added again.
 */
function usageFromTokens(value: unknown): ImportedUsage | undefined {
  const tokens = asRecord(value);
  if (!tokens) return undefined;
  const input = asNumber(tokens.input) ?? 0;
  const output = asNumber(tokens.output) ?? 0;
  const cache = asRecord(tokens.cache);
  const cacheRead = asNumber(cache?.read) ?? 0;
  const cacheWrite = asNumber(cache?.write) ?? 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function mergeUsage(a: ImportedUsage | undefined, b: ImportedUsage | undefined): ImportedUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

/** `session.model` is a JSON string in the DB and an object in the legacy files. */
function modelOf(value: unknown): { provider: string; model: string } | undefined {
  const record = asRecord(value) ?? (typeof value === "string" ? parseRecord(value) : undefined);
  if (!record) return undefined;
  const model = asString(record.id) ?? asString(record.modelID) ?? asString(record.model);
  if (!model) return undefined;
  return { provider: asString(record.providerID) ?? asString(record.provider) ?? "opencode", model };
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

async function readRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return parseRecord(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}
