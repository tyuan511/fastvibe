import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ImportAdapter,
  ImportCandidateInfo,
  ImportedItem,
  ImportedSession,
  ImportedToolCall,
  ImportedUsage,
} from "../types";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  clipToolText,
  excerpt,
  forEachJsonLine,
  textFromBlocks,
  toMillis,
} from "../io";

/**
 * OpenAI Codex CLI — `~/.codex/sessions/<yyyy>/<MM>/<dd>/rollout-*.jsonl` and the flat
 * `~/.codex/archived_sessions/*.jsonl`, indexed by `state_<N>.sqlite:threads`.
 *
 * Three things shape this adapter:
 *
 *  - **A rollout is two streams.** `response_item` is the conversation; `event_msg`
 *    repeats it (`agent_message` mirrors the assistant turn, `user_message` the user
 *    turn). Reading both shows every turn twice, so only `response_item` becomes items;
 *    `event_msg` is read solely for its `token_count` (usage).
 *  - **Ordering is file order, not timestamp.** After the header a whole run of lines
 *    carries one identical `timestamp`; sorting by it would scramble the transcript.
 *    `forEachJsonLine` hands lines over in order, so items are appended as seen.
 *  - **The corpus is huge** (4.8 GB here, one rollout at 103 MB). Nothing slurps a
 *    file, and `scan()` reads the SQLite index first and only ever reads a bounded
 *    prefix of a rollout.
 */
const ROOT = join(homedir(), ".codex");
const SESSIONS_DIR = join(ROOT, "sessions");
const ARCHIVED_DIR = join(ROOT, "archived_sessions");

/**
 * How far a scan may read into one rollout before it gives up counting. The picker
 * only needs an approximate message count and, on the directory-walk fallback, the
 * first user sentence; stopping at these caps keeps `scan()` from turning into a full
 * parse of every multi-megabyte file. A capped count is marked in the candidate's note.
 */
const SCAN_MESSAGE_CAP = 200;
const SCAN_LINE_CAP = 1200;

/** Upper bound on commands lifted out of one `exec` program, so a hostile script cannot fan out. */
const MAX_EXEC_COMMANDS = 12;

/**
 * Thrown to stop `forEachJsonLine` early. The helper's `finally` destroys the stream on
 * the way out — exactly what a capped scan wants (see the note in `io.ts`).
 */
const STOP_SCAN = new Error("codex scan cap reached");

/**
 * Codex writes its own scaffolding into `user`-role messages: permissions, plugin
 * lists, environment/world snapshots, the project's AGENTS.md. None of it is the
 * prompt, and a real rollout leads with several such lines before the first genuine
 * turn. Matching the marker anywhere (not just a prefix) also catches blocks nested
 * under an `<INSTRUCTIONS>` wrapper.
 */
const INJECTED_MARKERS = [
  "<permissions instructions>",
  "<recommended_plugins>",
  "<multi_agent_mode>",
  "<environment_context>",
  "<world_state>",
  "<user_instructions>",
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
];

/** Columns of `threads` this adapter reads. Older DBs may lack some — the SELECT then throws and scan falls back. */
type ThreadRow = {
  id: string | null;
  rollout_path: string | null;
  title: string | null;
  name: string | null;
  preview: string | null;
  first_user_message: string | null;
  cwd: string | null;
  model: string | null;
  model_provider: string | null;
  archived: number | null;
  created_at: number | null;
  updated_at: number | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
};

/** What the cheap prefix scan collects from a rollout. */
type RolloutSummary = {
  messages: number;
  firstUser: string;
  cwd: string | undefined;
  createdAt: number;
  lastAt: number;
  capped: boolean;
};

export const codexAdapter: ImportAdapter = {
  id: "codex",
  name: "Codex",
  root: ROOT,

  async scan(): Promise<ImportCandidateInfo[]> {
    // The SQLite index is the whole point: title, cwd, timestamps and archived state
    // without touching a rollout. Only if it is missing or unusable does the adapter
    // walk the file tree.
    const indexed = await readThreadIndex();
    if (indexed && indexed.length > 0) return scanIndexed(indexed);
    return scanDirectory();
  },

  async read(id: string): Promise<ImportedSession> {
    return readRollout(id);
  },
};

/** Highest-numbered `state_<N>.sqlite` in `~/.codex`; the N changes between versions. */
async function findStateDb(): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(ROOT, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { path: string; version: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^state_(\d+)\.sqlite$/.exec(entry.name);
    if (!match) continue;
    const version = Number(match[1]);
    if (!best || version > best.version) best = { path: join(ROOT, entry.name), version };
  }
  return best?.path;
}

/**
 * Read the `threads` index read-only. Codex may hold the DB open (WAL), the schema may
 * be from another generation, or the file may be missing — every one of those means
 * "fall back to the directory walk", never "fail the source".
 */
async function readThreadIndex(): Promise<ThreadRow[] | undefined> {
  const dbPath = await findStateDb();
  if (!dbPath) return undefined;
  let rows: ThreadRow[];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const statement = db.prepare(
        "SELECT id, rollout_path, title, name, preview, first_user_message, cwd, model, model_provider, archived, created_at, updated_at, created_at_ms, updated_at_ms FROM threads",
      );
      rows = statement.all() as unknown as ThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  return rows;
}

/** The one `threads` row whose rollout is the file being read, for title/cwd/model. */
async function findThreadRow(file: string): Promise<ThreadRow | undefined> {
  const rows = await readThreadIndex();
  if (!rows) return undefined;
  return rows.find((row) => row.rollout_path === file);
}

async function scanIndexed(rows: ThreadRow[]): Promise<ImportCandidateInfo[]> {
  const candidates: ImportCandidateInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const file = typeof row.rollout_path === "string" ? row.rollout_path : "";
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let size: number;
    let mtime = 0;
    try {
      const info = await stat(file);
      size = info.size;
      mtime = info.mtimeMs;
    } catch {
      // The thread is still listed but its rollout was pruned or moved. A row that
      // cannot be opened is skipped rather than listed as a broken session.
      continue;
    }
    // Deliberately no rollout read here. Counting a session's messages means opening
    // the file, and there are ~1000 of them on a working install: doing that from the
    // 导入 pane cost ~4.5s before a single row appeared. The DB row already carries the
    // title, cwd and both timestamps, and the picker shows the file size beside them.
    candidates.push({
      id: file,
      title: pickIndexedTitle(row) || basename(file),
      cwd: row.cwd?.trim() || undefined,
      createdAt: toMillis(row.created_at_ms) ?? toMillis(row.created_at) ?? Math.floor(mtime),
      updatedAt: toMillis(row.updated_at_ms) ?? toMillis(row.updated_at) ?? Math.floor(mtime),
      bytes: size,
      archived: row.archived === 1,
    });
  }
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt);
}

function pickIndexedTitle(row: ThreadRow): string {
  // `name` is Codex's own short session title; `title`/`first_user_message` are the
  // full opening prompt, so they are only used as an excerpted fallback.
  const name = row.name?.trim();
  if (name) return name;
  return excerpt(row.first_user_message ?? row.title ?? row.preview ?? "");
}

async function scanDirectory(): Promise<ImportCandidateInfo[]> {
  const files = (await listRolloutFiles(SESSIONS_DIR)).concat(await listRolloutFiles(ARCHIVED_DIR));
  const candidates: ImportCandidateInfo[] = [];
  for (const file of files) {
    const info = await summarizeRollout(file);
    if (info) candidates.push(info);
  }
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** `sessions/<yyyy>/<MM>/<dd>/rollout-*.jsonl` (three levels) plus the flat archived dir. */
async function listRolloutFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        found.push(full);
      }
    }
  }
  return found;
}

async function summarizeRollout(file: string): Promise<ImportCandidateInfo | undefined> {
  let size = 0;
  let mtime = 0;
  try {
    const info = await stat(file);
    size = info.size;
    mtime = info.mtimeMs;
  } catch {
    return undefined;
  }
  const summary = await countRollout(file);
  return {
    id: file,
    title: excerpt(summary.firstUser) || basename(file).replace(/\.jsonl$/, ""),
    cwd: summary.cwd,
    createdAt: summary.createdAt || Math.floor(mtime),
    updatedAt: summary.lastAt || summary.createdAt || Math.floor(mtime),
    messageCount: summary.messages,
    bytes: size,
    // The walk fallback has no `threads` row, but the directory the rollout lives in
    // is the same signal: everything under `archived_sessions/` is archived.
    archived: file.startsWith(ARCHIVED_DIR),
    note: summary.capped ? "消息数为估算值" : undefined,
  };
}

/**
 * Bounded prefix scan: counts importable messages and grabs the first real user
 * sentence. It deliberately stops early by throwing `STOP_SCAN`, which is the only way
 * to break out of `forEachJsonLine` without a second JSONL reader.
 */
async function countRollout(file: string): Promise<RolloutSummary> {
  let messages = 0;
  let firstUser = "";
  let cwd: string | undefined;
  let createdAt = 0;
  let lastAt = 0;
  let capped = false;
  try {
    await forEachJsonLine(file, (entry, lineNumber) => {
      if (lineNumber > SCAN_LINE_CAP || messages >= SCAN_MESSAGE_CAP) {
        capped = true;
        throw STOP_SCAN;
      }
      const at = toMillis(entry.timestamp);
      if (at !== undefined) {
        if (!createdAt) createdAt = at;
        lastAt = at;
      }
      const type = asString(entry.type);
      if (type === "session_meta") {
        // The fallback has no DB row, so cwd comes from the header.
        if (!cwd) cwd = asString(asRecord(entry.payload)?.cwd);
        return;
      }
      if (type !== "response_item") return;
      const payload = asRecord(entry.payload);
      if (!payload || asString(payload.type) !== "message") return;
      const role = asString(payload.role);
      if (role === "assistant") {
        messages += 1;
        return;
      }
      if (role !== "user") return;
      const text = textFromBlocks(payload.content);
      if (isInjected(text)) return;
      messages += 1;
      if (!firstUser) firstUser = text;
    });
  } catch (error) {
    if (error !== STOP_SCAN) throw error;
  }
  return { messages, firstUser, cwd, createdAt, lastAt, capped };
}

async function readRollout(file: string): Promise<ImportedSession> {
  const row = await findThreadRow(file);
  const items: ImportedItem[] = [];
  const skipped: string[] = [];

  // A tool call and its output are separate `response_item`s; the call is pushed into
  // an item immediately, so the result is attached by mutating the same object later.
  const callsById = new Map<string, ImportedToolCall[]>();
  const orphanOutputs = new Map<string, { text: string; at: number }>();

  let pendingThinking: string[] = [];
  let meta: Record<string, unknown> | undefined;
  let metaMatched = false;
  let modelFromTurn: string | undefined;
  let createdAt = 0;
  let updatedAt = 0;
  let lastAt = 0;

  let injected = 0;
  let system = 0;
  let compaction = 0;
  let stateEvents = 0;
  let unknown = 0;
  let itemCompleted = 0;
  let expandedExecs = 0;

  // The file name ends in the thread id; a rollout can begin with a fork header whose
  // `session_meta` id differs, and that is the one to ignore.
  const fileId = trailingId(file);

  await forEachJsonLine(file, (entry) => {
    const type = asString(entry.type);
    const at = toMillis(entry.timestamp) ?? lastAt;
    if (at > 0) {
      if (!createdAt) createdAt = at;
      lastAt = at;
      updatedAt = Math.max(updatedAt, at);
    }

    if (type === "session_meta") {
      const payload = asRecord(entry.payload);
      if (!payload) return;
      const id = asString(payload.id) ?? asString(payload.session_id);
      if (fileId && id === fileId) {
        meta = payload;
        metaMatched = true;
      } else if (!metaMatched) {
        // Until the thread's own header shows up, keep the latest one we saw.
        meta = payload;
      }
      return;
    }

    if (type === "event_msg") {
      const payload = asRecord(entry.payload);
      const kind = asString(payload?.type);
      if (kind === "token_count") {
        const usage = usageFromTokenCount(payload);
        if (usage) attachUsage(items, usage);
      } else if (kind === "context_compacted" || kind === "compacted") {
        compaction += 1;
      } else if (kind === "item_completed") {
        itemCompleted += 1;
      }
      // Every other `event_msg` mirrors a `response_item`; importing both would show
      // each turn twice, so nothing else is taken from this stream.
      return;
    }

    if (type === "turn_context") {
      // Not conversation, but the latest turn records the model actually in use.
      const payload = asRecord(entry.payload);
      modelFromTurn = asString(payload?.model) ?? modelFromTurn;
      stateEvents += 1;
      return;
    }
    if (type === "world_state") {
      stateEvents += 1;
      return;
    }
    if (type === "compacted" || type === "context_compacted" || type === "token_usage_record") {
      if (type === "token_usage_record") stateEvents += 1;
      else compaction += 1;
      return;
    }
    if (type !== "response_item") {
      unknown += 1;
      return;
    }

    const payload = asRecord(entry.payload);
    if (!payload) {
      unknown += 1;
      return;
    }
    const kind = asString(payload.type);

    if (kind === "message") {
      const role = asString(payload.role);
      if (role === "developer" || role === "system") {
        system += 1;
        return;
      }
      const text = textFromBlocks(payload.content);
      if (role === "user") {
        if (!text.trim()) return;
        if (isInjected(text)) {
          injected += 1;
          return;
        }
        pendingThinking = [];
        items.push({ kind: "user", text, at });
        return;
      }
      if (role !== "assistant") {
        unknown += 1;
        return;
      }
      const thinking = takeThinking(pendingThinking);
      pendingThinking = [];
      if (!text.trim() && thinking.length === 0) return;
      items.push({ kind: "assistant", text, thinking, toolCalls: [], at });
      return;
    }

    if (kind === "reasoning") {
      // `encrypted_content` is provider-bound and is never carried across; only the
      // human-readable summary survives.
      const summary = asArray(payload.summary)
        .map((part) => (typeof part === "string" ? part : asString(asRecord(part)?.text) ?? ""))
        .filter((value) => value.trim())
        .join("\n\n");
      if (summary.trim()) pendingThinking.push(summary);
      return;
    }

    if (kind === "function_call" || kind === "custom_tool_call") {
      const callId = asString(payload.call_id) ?? `call_${items.length}`;
      const name = asString(payload.name) ?? "tool";
      const extracted =
        kind === "function_call"
          ? [{ name, args: parseArguments(payload.arguments) }]
          : customCalls(name, asString(payload.input) ?? "");
      if (extracted.length > 1) expandedExecs += 1;

      // One tool call in the source, several underneath (an `exec` program can wrap a
      // handful of commands). Ids must stay unique for the writer's pairing, but the
      // output belongs to the program as a whole, so every derived call shares it.
      const created: ImportedToolCall[] =
        extracted.length <= 1
          ? [{ id: callId, name: extracted[0]?.name ?? name, args: extracted[0]?.args ?? {} }]
          : extracted.map((command, index) => ({ id: `${callId}:${index}`, name: command.name, args: command.args }));

      callsById.set(callId, created);
      const orphan = orphanOutputs.get(callId);
      if (orphan) applyOutput(created, orphan.text, orphan.at, lastAt);
      const thinking = takeThinking(pendingThinking);
      pendingThinking = [];
      items.push({ kind: "assistant", text: "", thinking, toolCalls: created, at });
      return;
    }

    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const callId = asString(payload.call_id);
      if (!callId) return;
      // `output` is a string for old `function_call_output`s and an array of text
      // blocks for `custom_tool_call_output`; `textFromBlocks` flattens either.
      const text = textFromBlocks(payload.output);
      const created = callsById.get(callId);
      if (created) applyOutput(created, text, at, lastAt);
      else orphanOutputs.set(callId, { text, at });
      return;
    }

    // `local_shell_call` and anything the adapter does not know about.
    unknown += 1;
  });

  if (injected > 0) skipped.push(`已跳过 ${injected} 条注入的用户消息`);
  if (system > 0) skipped.push(`已跳过 ${system} 条 developer/system 消息`);
  if (compaction > 0) skipped.push(`已跳过 ${compaction} 条压缩标记（保留完整历史）`);
  if (stateEvents > 0) skipped.push(`已跳过 ${stateEvents} 条 UI/状态事件（turn_context/world_state 等）`);
  if (expandedExecs > 0) skipped.push(`已将 ${expandedExecs} 个 exec 脚本展开为底层命令`);
  if (unknown > 0) skipped.push(`已跳过 ${unknown} 条未知类型条目`);
  if (items.length === 0 && itemCompleted > 0) {
    skipped.push("该会话没有 response_item（可能只写入了新版事件流），未导入任何消息");
  }

  const cwd = row?.cwd?.trim() || asString(meta?.cwd);
  const provider = row?.model_provider?.trim() || asString(meta?.model_provider);
  const model = row?.model?.trim() || modelFromTurn;
  const firstUser = items.find((item) => item.kind === "user");
  const title =
    row?.name?.trim() ||
    excerpt(row?.first_user_message ?? row?.title ?? "") ||
    excerpt(firstUser?.kind === "user" ? firstUser.text : "") ||
    basename(file).replace(/\.jsonl$/, "");

  const createdAtMs =
    toMillis(row?.created_at_ms) ?? toMillis(row?.created_at) ?? (createdAt || Date.now());
  const updatedAtMs =
    toMillis(row?.updated_at_ms) ?? toMillis(row?.updated_at) ?? (updatedAt || createdAtMs);

  return {
    source: "codex",
    sourceId: file,
    title,
    cwd,
    createdAt: createdAtMs,
    updatedAt: updatedAtMs,
    model: model ? { provider: provider || "openai", model } : undefined,
    items,
    skipped,
  };
}

/** Drain accumulated reasoning summaries into the item that follows them. */
function takeThinking(pending: string[]): string[] {
  return pending.filter((value) => value.trim());
}

/**
 * Attach a program's single output to the call(s) it produced. A plain `exec_command`
 * has one call; a `Promise.all` program may have several and no per-command output was
 * recorded, so the shared result goes to each rather than leaving the writer to invent
 * an "interrupted" result for the rest.
 */
function applyOutput(
  calls: ImportedToolCall[],
  text: string,
  at: number,
  fallback: number,
): void {
  const result = {
    text: clipToolText(text),
    isError: looksLikeError(text),
    at: at > 0 ? at : fallback,
  };
  for (const call of calls) call.result = result;
}

/**
 * Usage arrives only as `event_msg/token_count`. `last_token_usage` is the turn's own
 * usage; `total_token_usage` is cumulative over the whole thread and would multiply the
 * real total by the number of turns.
 */
function usageFromTokenCount(payload: Record<string, unknown> | undefined): ImportedUsage | undefined {
  const info = asRecord(payload?.info);
  const last = asRecord(info?.last_token_usage);
  if (!last) return undefined;
  const input = asNumber(last.input_tokens) ?? 0;
  const output = asNumber(last.output_tokens) ?? 0;
  const cacheRead = asNumber(last.cached_input_tokens) ?? 0;
  const cacheWrite = asNumber(last.cache_write_input_tokens) ?? 0;
  const total = asNumber(last.total_tokens) ?? input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

/** Give the usage to the newest assistant item that has none — one model call, one item. */
function attachUsage(items: ImportedItem[], usage: ImportedUsage): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "assistant" && !item.usage) {
      item.usage = usage;
      return;
    }
  }
}

/**
 * Tools lifted out of a custom `input` string.
 *
 * `apply_patch` carries a patch body. `exec` carries a small JavaScript program that
 * calls `tools.<name>({...})` one or more times; the underlying commands are what the
 * user cares about, so they are extracted. Anything unparseable falls back to the raw
 * input so the call is never silently lost.
 */
function customCalls(name: string, input: string): Array<{ name: string; args: unknown }> {
  if (name === "apply_patch") {
    return [{ name: "apply_patch", args: { patch: clipToolText(input) } }];
  }
  if (name === "exec") {
    const commands = extractExecCommands(input);
    if (commands.length > 0) return commands;
  }
  return [{ name, args: { script: clipToolText(input) } }];
}

/** Find `tools.<name>(...)` calls and pair each name with its parsed argument. */
function extractExecCommands(script: string): Array<{ name: string; args: unknown }> {
  const commands: Array<{ name: string; args: unknown }> = [];
  const pattern = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    if (commands.length >= MAX_EXEC_COMMANDS) break;
    const argument = captureArgument(script, match.index + match[0].length);
    if (!argument) continue;
    commands.push({ name: match[1], args: parseObjectLiteral(argument) });
  }
  return commands;
}

/** The raw source of the argument to a call, from just after `(`. */
function captureArgument(source: string, start: number): string | undefined {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (index >= source.length) return undefined;
  const first = source[index];
  if (first === "{" || first === "[" || first === "(") {
    const close = first === "{" ? "}" : first === "[" ? "]" : ")";
    const end = matchBalanced(source, index, first, close);
    return end === -1 ? undefined : source.slice(index, end + 1);
  }
  // A positional (non-object) argument: read up to the next top-level `,` or `)`.
  let depth = 0;
  let quote: string | undefined;
  let cursor = index;
  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (quote) {
      if (char === "\\") cursor += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === "," && depth === 0) break;
  }
  const token = source.slice(index, cursor).trim();
  return token || undefined;
}

/** Index of the `close` that balances the `open` at `start`, ignoring brackets inside strings. */
function matchBalanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * `{...}` from an `exec` program is a JavaScript object literal, not JSON: keys may be
 * bare (`{session_id:33234,chars:""}`) and strings single-quoted. Try JSON first, then
 * a light normalisation, then keep the raw source so nothing is lost.
 */
function parseObjectLiteral(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(toJson(trimmed));
    } catch {
      return { raw: clipToolText(trimmed) };
    }
  }
}

/** Best-effort JS-object → JSON: quote bare keys, swap single quotes, drop trailing commas. */
function toJson(source: string): string {
  return source
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_full, body: string) =>
      `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`,
    )
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
}

/** `function_call.arguments` is a JSON string; keep the raw text when it will not parse. */
function parseArguments(value: unknown): unknown {
  const text = asString(value);
  if (text === undefined) return value ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: clipToolText(text) };
  }
}

/**
 * Whether tool text clearly reports a failure. Codex records no error flag, and the
 * cost of a wrong `true` (a red card for a successful command) is worse than a wrong
 * `false`, so only unambiguous signals count.
 */
function looksLikeError(text: string): boolean {
  if (/^\s*Script failed\b/i.test(text)) return true;
  if (/^\s*(?:Error|error):/m.test(text)) return true;
  const exit = /\b(?:exited with|exit) code[:\s]+(-?\d+)/i.exec(text);
  if (exit && exit[1] !== "0") return true;
  return false;
}

function isInjected(text: string): boolean {
  return INJECTED_MARKERS.some((marker) => text.includes(marker));
}

/** Trailing thread id in `rollout-<stamp>-<uuid>.jsonl` (some files append `_<uuid>`). */
function trailingId(file: string): string | undefined {
  const base = basename(file).replace(/\.jsonl$/i, "");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return match?.[1];
}
