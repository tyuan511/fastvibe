import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ImportedItem, ImportedSession, ImportedToolCall, ImportedUsage, ImportAdapter, ImportCandidateInfo } from "../types";
import { asNumber, asRecord, asString, clipToolText, excerpt, toMillis } from "../io";
import { disposeImportDatabases, openReadOnlyDatabase } from "../sqlite";

/**
 * zcode — z.ai's official CLI, `~/.zcode/cli/db/db.sqlite`.
 *
 * The store is opencode's schema (session / message / part, `data` as JSON text), so the
 * reading shape is the same as the opencode adapter's: a message row carries almost
 * nothing, a user message has no text at all, and everything a turn contains lives in its
 * `part` rows. Two things differ and both matter.
 *
 * **Order comes from `sequence`, not from time.** opencode is read by `(time_created, id)`
 * and that is measurably wrong here: zcode backfills `time_created` when it rewrites a
 * message, so 360 of 1511 parts and 12 of 444 messages on the author's corpus sort into a
 * different order than the one they were written in — reasoning after build output, text
 * after tool calls. `message.sequence` / `part.sequence` (autofilled by triggers) is the
 * real order, and a session whose parts were reordered reads as an incoherent reply.
 *
 * **`semantics.transcriptVisibility` says what the user saw.** zcode stores its own
 * injections — `todo_reminder`, `system_reminder`, `background_notification` — as normal
 * user messages, plus `model-only` assistant messages for subagent sidechains and forked
 * context. The agent's *own* UI hides them, so importing them would put text into the
 * imported chat that the user never wrote and never saw. Only `visible` messages are
 * carried across; the rest are counted and reported. A message that predates the field is
 * treated as visible rather than dropped.
 *
 * `providerID` is an internal UUID with no readable name anywhere in the store, so every
 * model is attributed to the literal provider `zcode` — which is what 使用统计 can act
 * on. Per-message `tokens.input` includes the cached tokens (OpenAI's own convention), so
 * it is subtracted back out to match pi's split, and `tokens.reasoning` is a subset of
 * `output`, so it is deliberately not added again.
 */
const ROOT = join(homedir(), ".zcode");
const DB_FILE = join(ROOT, "cli", "db", "db.sqlite");

/** Internal provider ids are UUIDs; this is the only provider name the store can imply. */
const PROVIDER = "zcode";

export const zcodeAdapter: ImportAdapter = {
  id: "zcode",
  name: "zcode",
  root: ROOT,

  async scan(): Promise<ImportCandidateInfo[]> {
    if (!existsSync(DB_FILE)) return [];
    const handle = await openReadOnlyDatabase(DB_FILE);
    try {
      const sessions = handle.db
        .prepare(
          `SELECT id, title, directory, parent_id, time_created, time_updated, time_archived
             FROM session ORDER BY time_updated DESC`,
        )
        .all() as unknown as SessionRow[];

      // The count is of messages that would *actually import*, not of rows: zcode stores
      // its own injections and its model-only sidechain turns as ordinary messages, and a
      // trailing assistant row can hold nothing but structural parts. Counting raw rows
      // overstates a session by roughly a tenth on the author's corpus (19 where 17 turns
      // exist); the predicate below reproduces `assemble()`'s own keep-rule, and costs
      // 4ms against 5ms because the `EXISTS` is an index lookup per candidate message.
      // It is paid here rather than on the opencode side, where nothing distinguishes the
      // two counts.
      const counts = new Map<string, number>();
      for (const row of handle.db
        .prepare(
          `SELECT m.session_id AS session_id, COUNT(*) AS c
             FROM message m
            WHERE json_extract(m.data, '$.role') IN ('user', 'assistant')
              AND coalesce(json_extract(m.data, '$.semantics.kind'), '') <> 'timeline_event'
              AND coalesce(json_extract(m.data, '$.semantics.transcriptVisibility'),
                   coalesce(json_extract(m.data, '$.metadata.visibility'), 'visible')) = 'visible'
              AND EXISTS (
                SELECT 1 FROM part p
                 WHERE p.message_id = m.id
                   AND json_extract(p.data, '$.type') IN ('text', 'reasoning', 'tool')
                   AND (json_extract(p.data, '$.type') <> 'text'
                        OR length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0))
            GROUP BY m.session_id`,
        )
        .all() as unknown as CountRow[]) {
        counts.set(row.session_id, row.c);
      }

      const candidates: ImportCandidateInfo[] = [];
      for (const row of sessions) {
        const count = counts.get(row.id) ?? 0;
        // Nothing to show: zcode records side chats (`selection_side_chat`) whose every
        // message is model-only, and a row that would import an empty conversation is one
        // the picker should not offer at all.
        if (count === 0) continue;
        const notes: string[] = [];
        if (row.parent_id) notes.push("子会话（subagent / 侧边对话）");
        candidates.push({
          id: row.id,
          title: row.title?.trim() || row.id,
          cwd: row.directory?.trim() || undefined,
          createdAt: toMillis(row.time_created) ?? 0,
          updatedAt: toMillis(row.time_updated) ?? 0,
          messageCount: count,
          archived: row.time_archived !== null && row.time_archived !== undefined,
          note: notes.length ? notes.join("、") : undefined,
        });
      }
      return candidates;
    } finally {
      await handle.close();
    }
  },

  async read(id: string): Promise<ImportedSession> {
    if (!existsSync(DB_FILE)) throw new Error("未找到 zcode 数据库");
    const handle = await openReadOnlyDatabase(DB_FILE);
    try {
      const session = handle.db
        .prepare(
          `SELECT id, title, directory, parent_id, time_created, time_updated, time_archived
             FROM session WHERE id = ?`,
        )
        .get(id) as unknown as SessionRow | undefined;
      if (!session) throw new Error(`zcode 数据库中找不到会话 ${id}`);

      const partsByMessage = new Map<string, RawPart[]>();
      for (const row of orderedParts(handle.db, id)) {
        const data = parseRecord(row.data);
        if (!data) continue;
        const list = partsByMessage.get(row.message_id) ?? [];
        list.push(data);
        partsByMessage.set(row.message_id, list);
      }

      const messages: RawMessage[] = [];
      for (const row of orderedMessages(handle.db, id)) {
        const data = parseRecord(row.data);
        if (!data) continue;
        messages.push({ at: toMillis(row.time_created) ?? 0, data, parts: partsByMessage.get(row.id) ?? [] });
      }

      return assemble({
        id: session.id,
        title: session.title?.trim() ?? "",
        directory: session.directory?.trim() || undefined,
        createdAt: toMillis(session.time_created) ?? 0,
        updatedAt: toMillis(session.time_updated) ?? 0,
      }, messages);
    } finally {
      await handle.close();
    }
  },

  dispose: disposeImportDatabases,
};

type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  parent_id: string | null;
  time_created: number | null;
  time_updated: number | null;
  time_archived: number | null;
};
type CountRow = { session_id: string; c: number };
type MessageRow = { id: string; time_created: number | null; data: string };
type PartRowFlat = { message_id: string; data: string };
type RawMessage = { at: number; data: Record<string, unknown>; parts: Record<string, unknown>[] };
type RawPart = Record<string, unknown>;

/**
 * `sequence` exists on every table of the shipped schema (a trigger autofills it), but
 * the column is read through a probe rather than assumed: a database written before the
 * migration has no such column, and `rowid` — insertion order — is the closest thing to
 * the truth it can offer. Ordering such a database by `time_created` instead would look
 * plausible and be wrong, because zcode rewrites that field.
 *
 * The probe is memoised per connection: `read()` asks twice (message and part), and a
 * `PRAGMA` per call would be a query for something that cannot change mid-run.
 */
const sequenceColumns = new WeakMap<DatabaseSync, Map<string, boolean>>();

function hasSequence(db: DatabaseSync, table: "message" | "part"): boolean {
  let memo = sequenceColumns.get(db);
  if (!memo) {
    memo = new Map();
    sequenceColumns.set(db, memo);
  }
  const cached = memo.get(table);
  if (cached !== undefined) return cached;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  const present = columns.some((column) => column.name === "sequence");
  memo.set(table, present);
  return present;
}

function orderedMessages(db: DatabaseSync, sessionId: string): MessageRow[] {
  const order = hasSequence(db, "message") ? "sequence, time_created, id" : "rowid";
  return db
    .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY ${order}`)
    .all(sessionId) as unknown as MessageRow[];
}

/**
 * Parts are read through a join on `message` rather than by `part.session_id`: both
 * columns are populated, but the join is what makes the read independent of a column an
 * older database may not have filled in, and it costs nothing measurable.
 */
function orderedParts(db: DatabaseSync, sessionId: string): PartRowFlat[] {
  const order = hasSequence(db, "part") ? "p.sequence, p.time_created, p.id" : "p.rowid";
  return db
    .prepare(
      `SELECT p.message_id AS message_id, p.data AS data
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE m.session_id = ?
        ORDER BY ${order}`,
    )
    .all(sessionId) as unknown as PartRowFlat[];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

type SessionMeta = {
  id: string;
  title: string;
  directory?: string;
  createdAt: number;
  updatedAt: number;
};

type Counts = {
  injected: number;
  hidden: number;
  structural: number;
  system: number;
  files: number;
  empty: number;
  unknown: number;
};

function assemble(meta: SessionMeta, messages: RawMessage[]): ImportedSession {
  const items: ImportedItem[] = [];
  const counts: Counts = { injected: 0, hidden: 0, structural: 0, system: 0, files: 0, empty: 0, unknown: 0 };
  // The model in force at the last visible assistant message. A change between two of
  // them is a real switch and becomes a transcript divider; the first one is the model
  // the session was created on, which the writer emits as a leading `model_change` the
  // reader drops (it is not a switch).
  let current: { provider: string; model: string } | undefined;

  for (const message of messages) {
    const role = asString(message.data.role);
    if (role === "system") {
      counts.system += 1;
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    if (!isVisible(message.data)) {
      // zcode's own injections and its model-only sidechain turns. `visibility` is on
      // `semantics`; the older `metadata.visibility` spelling is accepted as a fallback.
      if (role === "user") counts.injected += 1;
      else counts.hidden += 1;
      continue;
    }
    // A `timeline_event` assistant row is zcode's own transcript marker (it is what
    // *carries* the model-change divider). The divider is rebuilt from the model on the
    // assistant messages themselves, so the marker row has nothing to add.
    if (role === "assistant" && asString(asRecord(message.data.semantics)?.kind) === "timeline_event") continue;

    if (role === "user") {
      const texts: string[] = [];
      for (const part of message.parts) {
        const type = asString(part.type);
        if (type === "text") {
          const value = asString(part.text);
          if (value?.trim()) texts.push(value.trim());
        } else if (type === "file" || type === "image") {
          // zcode keeps a path reference rather than inline base64, so an attachment
          // cannot become an `ImportedImage`; it is counted and reported instead.
          counts.files += 1;
        } else {
          classifyPart(type, counts);
        }
      }
      const text = texts.join("\n\n");
      if (!text) {
        counts.empty += 1;
        continue;
      }
      items.push({ kind: "user", text, at: message.at });
      continue;
    }

    const texts: string[] = [];
    const thinking: string[] = [];
    const toolCalls: ImportedToolCall[] = [];
    for (const part of message.parts) {
      switch (asString(part.type)) {
        case "text": {
          const value = asString(part.text);
          if (value?.trim()) texts.push(value);
          break;
        }
        case "reasoning": {
          const value = asString(part.text);
          if (value?.trim()) thinking.push(value);
          break;
        }
        case "tool":
          toolCalls.push(toolCallOf(part, toolCalls.length));
          break;
        case "file":
          counts.files += 1;
          break;
        default:
          classifyPart(asString(part.type), counts);
          break;
      }
    }

    const text = texts.join("\n\n");
    if (!text.trim() && thinking.length === 0 && toolCalls.length === 0) {
      counts.empty += 1;
      continue;
    }

    const model = asString(message.data.modelID)?.trim();
    if (model) {
      // `providerID` is a UUID with no name in the store, so every model is attributed to
      // the same provider and only the model id can change.
      if (current && current.model !== model) {
        items.push({ kind: "switch", provider: PROVIDER, model, at: message.at });
      }
      current = { provider: PROVIDER, model };
    }

    items.push({
      kind: "assistant",
      text,
      thinking,
      toolCalls,
      model: model || current?.model,
      provider: current?.provider ?? PROVIDER,
      usage: usageOf(message.data),
      at: message.at,
    });
  }

  const skipped: string[] = [];
  if (counts.injected) skipped.push(`已跳过 ${counts.injected} 条 zcode 自身注入的用户消息（回忆提醒等）`);
  if (counts.hidden) skipped.push(`已跳过 ${counts.hidden} 条仅供模型可见的回复（子 agent / 分支上下文）`);
  if (counts.system) skipped.push(`已跳过 ${counts.system} 条系统消息`);
  if (counts.structural) skipped.push(`已跳过 ${counts.structural} 个结构性 part（step-start / step-finish / timeline）`);
  if (counts.files) skipped.push(`已跳过 ${counts.files} 个附件或图片引用`);
  if (counts.empty) skipped.push(`已跳过 ${counts.empty} 条空消息`);
  if (counts.unknown) skipped.push(`已跳过 ${counts.unknown} 个未知 part`);

  const firstUser = items.find((item) => item.kind === "user");
  // A source session can be entirely model-only — zcode records a "selection side chat"
  // whose every message is `hidden` — and importing one would register a conversation
  // that renders as nothing at all. That is worse than a per-session failure the user can
  // read, because it looks like the import silently did nothing.
  if (items.length === 0) {
    throw new Error("该会话没有用户可见的对话内容（全部为 zcode 内部消息）");
  }
  return {
    source: "zcode",
    sourceId: meta.id,
    title: meta.title || excerpt(firstUser?.kind === "user" ? firstUser.text : "") || meta.id,
    cwd: meta.directory,
    createdAt: meta.createdAt || meta.updatedAt || Date.now(),
    updatedAt: meta.updatedAt || meta.createdAt || Date.now(),
    model: current,
    items,
    skipped,
  };
}

/** `semantics.transcriptVisibility`, with the older `metadata.visibility` as a fallback. */
function isVisible(data: Record<string, unknown>): boolean {
  const semantics = asRecord(data.semantics);
  const value = asString(semantics?.transcriptVisibility) ?? asString(asRecord(data.metadata)?.visibility);
  // No marker at all predates the field; such a message was shown.
  return value === undefined || value === "visible";
}

function classifyPart(type: string | undefined, counts: Counts): void {
  if (!type || type === "step-start" || type === "step-finish" || type === "timeline" || type === "compaction") {
    // `step-start` / `step-finish` bracket a round trip and `timeline` carries the
    // transcript's own separators; `compaction` is deliberately not written as a
    // compaction entry, because the engine builds the sent context from one and writing
    // it would hide everything before the marker from both the model and the thread.
    counts.structural += 1;
    return;
  }
  counts.unknown += 1;
}

/**
 * A `tool` part carries its own output, so a result never becomes a separate item. A
 * `pending` / `running` status means the run was interrupted before anything came back —
 * the result is left undefined and the writer synthesises the "no result" marker, which
 * is what keeps the next request from being rejected for a dangling tool call.
 */
function toolCallOf(part: Record<string, unknown>, index: number): ImportedToolCall {
  const state = asRecord(part.state) ?? {};
  const status = asString(state.status);
  const time = asRecord(state.time);
  const at = toMillis(time?.end) ?? toMillis(time?.start);
  const call: ImportedToolCall = {
    id: asString(part.callID) ?? `call_${index}`,
    name: asString(part.tool) ?? "tool",
    args: state.input ?? {},
  };
  if (status === "completed") {
    call.result = { text: clipToolText(outputText(state.output)), isError: false, at };
  } else if (status === "error") {
    const message = asString(state.error) || outputText(state.output) || "工具调用失败";
    call.result = { text: clipToolText(message), isError: true, at };
  }
  return call;
}

/** Structured output (`state.output` is normally a string) is stringified defensively. */
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * zcode stores OpenAI's raw usage, where `input` already contains the cached tokens, so
 * the cache counts are subtracted back out — the same normalisation pi applies to a
 * Responses payload. `tokens.reasoning` is a subset of `output` and is not added again.
 */
function usageOf(data: Record<string, unknown>): ImportedUsage | undefined {
  const tokens = asRecord(data.tokens);
  if (!tokens) return undefined;
  const cache = asRecord(tokens.cache);
  const cacheRead = asNumber(cache?.read) ?? 0;
  const cacheWrite = asNumber(cache?.write) ?? 0;
  const rawInput = asNumber(tokens.input) ?? 0;
  const total = asNumber(tokens.total);
  if (rawInput === 0 && total === undefined && (asNumber(tokens.output) ?? 0) === 0) return undefined;
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  const output = asNumber(tokens.output) ?? 0;
  return { input, output, cacheRead, cacheWrite, total: total ?? input + output + cacheRead + cacheWrite };
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}
