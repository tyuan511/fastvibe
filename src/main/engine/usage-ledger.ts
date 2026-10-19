import { appendFileSync, readFileSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { FORK_USAGE_SESSION_FIELD } from "./session-fork.ts";

/**
 * One finalized assistant turn, in the raw terms the engine reported it.
 *
 * Deliberately *not* priced here: `usage-stats.ts` re-derives the cost from the current
 * price table at read time, exactly as it does for transcripts, so editing a provider
 * still re-prices history. The ledger stores only what cannot be recomputed — which
 * model, which tokens, when, and the price the engine itself recorded as a fallback.
 */
export type UsageTurn = {
  /** Session id (the transcript header id), so a turn survives its file. */
  sessionId: string;
  /** Session entry id of the assistant message; unique within the session. */
  entryId: string;
  provider: string;
  model: string;
  /** Request time in epoch ms. */
  at: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  /** USD the provider reported (0 when it did not). */
  cost: number;
  toolCalls: number;
};

/** Stable identity of a turn across the live ledger and a parsed transcript. */
export function turnKey(turn: Pick<UsageTurn, "sessionId" | "entryId">): string {
  return `${turn.sessionId}\u0000${turn.entryId}`;
}

type ParsedSession = { sessionId: string; turns: UsageTurn[] };

/** Parsed transcripts, keyed by path and invalidated by `mtimeMs` + `size`. */
const sessionCache = new Map<string, ParsedSession & { mtimeMs: number; size: number }>();

type CachedParse = ParsedSession & { mtimeMs: number; size: number };

/**
 * The same parses, kept in a file between launches.
 *
 * The in-memory memo above is empty at every start, so the first 使用统计 of a session read and
 * scanned every transcript again — 2 to 3.7 s on 294 MB. A transcript only grows, and a parse is
 * valid for exactly the `mtimeMs` + `size` it was made at, so the result is stored under that
 * and the next launch parses only the files that changed since.
 *
 * Deliberately a file of its own and not a table in `fastvibe.db`: it is derived data that can
 * be deleted at any time, and a new table would be a schema step — which makes every older
 * build refuse to open the shared database. A missing, torn or foreign-version file is an empty
 * cache, never an error.
 */
class ParseCacheFile {
  static readonly VERSION = 1;
  #file: string;
  #entries = new Map<string, CachedParse>();
  #loading: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;

  constructor(file: string) {
    this.#file = file;
  }

  async ready(): Promise<void> {
    this.#loading ??= this.#load();
    await this.#loading;
  }

  async #load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as { version?: unknown; files?: unknown };
      if (parsed.version !== ParseCacheFile.VERSION || !isRecord(parsed.files)) return;
      for (const [path, value] of Object.entries(parsed.files)) {
        if (!isRecord(value) || typeof value.sessionId !== "string" || !Array.isArray(value.turns)) continue;
        if (typeof value.mtimeMs !== "number" || typeof value.size !== "number") continue;
        this.#entries.set(path, value as unknown as CachedParse);
      }
    } catch {
      // Absent or unreadable: start empty.
    }
  }

  get(path: string, mtimeMs: number, size: number): CachedParse | undefined {
    const entry = this.#entries.get(path);
    return entry && entry.mtimeMs === mtimeMs && entry.size === size ? entry : undefined;
  }

  set(path: string, entry: CachedParse): void {
    this.#entries.set(path, entry);
    this.#schedule();
  }

  /** Forget transcripts that no longer exist, so deleted chats do not pile up in the file. */
  retain(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const path of [...this.#entries.keys()]) {
      if (!keep.has(path)) {
        this.#entries.delete(path);
        this.#dirty = true;
      }
    }
    if (this.#dirty) this.#schedule();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, 2_000);
    this.#timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    const files: Record<string, CachedParse> = {};
    for (const [path, entry] of this.#entries) files[path] = entry;
    const temp = `${this.#file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: ParseCacheFile.VERSION, files }), { mode: 0o600 });
      await rename(temp, this.#file);
    } catch {
      // A cache that cannot be written costs the next launch a re-parse, nothing more.
      this.#dirty = true;
    }
  }
}

let parseCacheFile: ParseCacheFile | null = null;
let parseCachePath = "";

/** Keep transcript parses in `file` between launches. Safe to call on every read. */
export function usePersistentParseCache(file: string): void {
  if (parseCacheFile && parseCachePath === file) return;
  parseCacheFile = new ParseCacheFile(file);
  parseCachePath = file;
}

/** Drop the cached parses of transcripts that are gone, and write what changed. */
export async function settleParseCache(livePaths: Iterable<string>): Promise<void> {
  if (!parseCacheFile) return;
  parseCacheFile.retain(livePaths);
  await parseCacheFile.flush();
}

/**
 * Every assistant turn recorded in one transcript, in file order.
 *
 * The same walk `usage-stats` used to do inline, lifted here so a transcript can be
 * parsed both for live statistics and — the moment a session is deleted — to seed the
 * ledger with history that predates it. Transcripts only ever grow, so results are
 * memoised on `mtimeMs` + `size`.
 */
/**
 * A tool result or a prompt, told from its envelope without parsing the line.
 *
 * They carry no usage and are nearly all of a transcript's bytes — one screenshot result is
 * hundreds of KB of base64 — so parsing them only to throw them away was most of what reading
 * the statistics cost. The entry's own `"message":` key is the first one on the line (`type`,
 * `id`, `parentId` and `timestamp` hold plain strings), and only its role counts: a tool call's
 * arguments can hold the same words further in, and such a line is parsed as before.
 */
function carriesNoUsage(line: string): boolean {
  if (!line.startsWith('{"type":"message"')) return false;
  const at = line.indexOf('"message":');
  if (at < 0 || at > 1024) return false;
  const role = line.slice(at, at + 40);
  return role.startsWith('"message":{"role":"toolResult"') || role.startsWith('"message":{"role":"user"');
}

export async function parseSessionTurns(
  file: string,
  options?: { since?: number },
): Promise<ParsedSession> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return { sessionId: "", turns: [] };
  }
  const cached = sessionCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { sessionId: cached.sessionId, turns: cached.turns };
  }
  if (parseCacheFile) {
    await parseCacheFile.ready();
    const stored = parseCacheFile.get(file, info.mtimeMs, info.size);
    if (stored) {
      sessionCache.set(file, stored);
      return { sessionId: stored.sessionId, turns: stored.turns };
    }
  }
  // A transcript's last write is no earlier than its last turn, so a file untouched
  // since before the window being asked about holds nothing that window can show —
  // and reading it would mean loading and JSON-parsing a whole conversation to throw
  // every line away. The caller's cutoff is already slackened by a day, which covers a
  // clock that was wrong when a turn was recorded.
  if (options?.since !== undefined && info.mtimeMs < options.since) return { sessionId: "", turns: [] };

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { sessionId: "", turns: [] };
  }

  let sessionId = "";
  let current: { provider: string; model: string } | undefined;
  const turns: UsageTurn[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (carriesNoUsage(trimmed)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    if (!sessionId && entry.type === "session" && typeof entry.id === "string") {
      sessionId = entry.id;
      continue;
    }
    if (entry.type === "model_change" && typeof entry.provider === "string") {
      current = { provider: entry.provider, model: String(entry.modelId ?? "") };
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;

    const at =
      typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(at)) continue;
    const entryId = typeof entry.id === "string" ? entry.id : "";
    if (!entryId) continue;

    const usage = isRecord(message.usage) ? message.usage : undefined;
    const input = usage ? num(usage.input) : 0;
    const output = usage ? num(usage.output) : 0;
    const cacheRead = usage ? num(usage.cacheRead) : 0;
    const cacheWrite = usage ? num(usage.cacheWrite) : 0;
    const reported = usage && num(usage.totalTokens);
    const tokens = reported ? num(usage?.totalTokens) : input + output + cacheRead + cacheWrite;

    let toolCalls = 0;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && isToolCallType(String(part.type ?? ""))) toolCalls += 1;
      }
    }

    // Forked transcripts retain the copied entry id but have a new session header.
    // The per-entry origin keeps inherited usage on its original identity, so the
    // transcript/ledger union counts it once even after either conversation is deleted.
    const usageSessionId =
      typeof entry[FORK_USAGE_SESSION_FIELD] === "string" && entry[FORK_USAGE_SESSION_FIELD]
        ? String(entry[FORK_USAGE_SESSION_FIELD])
        : sessionId;
    turns.push({
      sessionId: usageSessionId,
      entryId,
      provider: typeof message.provider === "string" ? message.provider : current?.provider ?? "unknown",
      model: typeof message.model === "string" ? message.model : current?.model ?? "unknown",
      at,
      input,
      output,
      cacheRead,
      cacheWrite,
      tokens,
      cost: usage && isRecord(usage.cost) ? num(usage.cost.total) : 0,
      toolCalls,
    });
  }

  // A transcript normally leads with its session header, which is also what
  // `session.sessionId` reports while the session is live — so the two sources share a
  // key. A corrupt header (a truncated first line) leaves no id to recover, and the
  // filename's UUID is unrelated to it; fall back to a path-derived segment that cannot
  // collide with a real session id, accepting that such a file will not dedup. Stamp the
  // fallback onto every turn too, so `capture()` can still record a damaged transcript.
  const resolvedId = sessionId || `file:${file}`;
  for (const turn of turns) {
    // Only turns without an explicit fork origin still carry the empty header id.
    if (!turn.sessionId) turn.sessionId = resolvedId;
  }
  const result = { sessionId: resolvedId, turns };
  const entry = { ...result, mtimeMs: info.mtimeMs, size: info.size };
  sessionCache.set(file, entry);
  parseCacheFile?.set(file, entry);
  return result;
}

/**
 * Append-only ledger of finalized turns.
 *
 * 使用统计 must not change when a conversation is deleted. Transcripts are the natural
 * source of usage, but deleting a conversation unlinks its transcript, so a ledger that
 * records each turn as it finishes is what keeps history whole. It records raw usage
 * (never a computed price) so a later provider edit still re-prices the ledger exactly
 * like the transcripts beside it, and it is append-only so it can never rewrite itself.
 *
 * The ledger is a *supplement*, not a replacement: `usage-stats` unions it with the
 * transcripts still on disk. The two overlap for every live session, deduplicated by
 * `sessionId` + `entryId`, so a live transcript stays the primary source and the ledger
 * only adds what deletion (or a pre-ledger build) would otherwise erase.
 *
 * Appends are synchronous: a turn is one line, produced once per assistant message, and
 * a capture that precedes an unlink has to be durable before the file disappears.
 */
export class UsageLedger {
  #file: string;
  #turns = new Map<string, UsageTurn>();
  #loaded = false;

  constructor(file: string) {
    this.#file = file;
  }

  /** Append turns that are not already recorded. Returns how many were new. */
  record(turns: UsageTurn[]): number {
    this.#load();
    const fresh: UsageTurn[] = [];
    for (const turn of turns) {
      if (!turn.sessionId || !turn.entryId) continue;
      const key = turnKey(turn);
      if (this.#turns.has(key)) continue;
      this.#turns.set(key, turn);
      fresh.push(turn);
    }
    if (fresh.length > 0) {
      const payload = fresh.map((turn) => `${JSON.stringify(turn)}\n`).join("");
      try {
        appendFileSync(this.#file, payload);
      } catch {
        // A statistics detail is never worth failing a run over; the in-memory copy
        // still serves this process, and the next run re-reads what reached disk.
      }
    }
    return fresh.length;
  }

  /**
   * Fold every turn of a transcript into the ledger. Used before the transcript is
   * unlinked, so a session whose history predates the ledger is not lost with it.
   */
  async capture(sessionFile: string): Promise<void> {
    const parsed = await parseSessionTurns(sessionFile);
    this.record(parsed.turns);
  }

  /** Every recorded turn. The ledger is append-only and small enough to read whole. */
  all(): UsageTurn[] {
    this.#load();
    return [...this.#turns.values()];
  }

  /** No-op hook for the engine's shutdown flush; appends are already synchronous. */
  flush(): void {}

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const turn = cleanTurn(entry);
      if (turn) this.#turns.set(turnKey(turn), turn);
    }
  }
}

/** Repair one persisted line into a `UsageTurn`, or drop it if it is not one. */
function cleanTurn(value: unknown): UsageTurn | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  const entryId = typeof value.entryId === "string" ? value.entryId : "";
  if (!sessionId || !entryId) return undefined;
  return {
    sessionId,
    entryId,
    provider: typeof value.provider === "string" ? value.provider : "unknown",
    model: typeof value.model === "string" ? value.model : "unknown",
    at: num(value.at),
    input: num(value.input),
    output: num(value.output),
    cacheRead: num(value.cacheRead),
    cacheWrite: num(value.cacheWrite),
    tokens: num(value.tokens),
    cost: num(value.cost),
    toolCalls: num(value.toolCalls),
  };
}

function isToolCallType(type: string): boolean {
  return type === "toolCall" || type === "tool_use" || type === "tool_call" || type === "toolcall";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Exposed for tests / tooling: drop the memoised transcript parses. */
export function clearSessionUsageCache(): void {
  sessionCache.clear();
  parseCacheFile = null;
}

/**
 * The ledger for a file path, shared process-wide.
 *
 * Both the engine (which appends turns as they finish) and 使用统计 (which reads them)
 * must see the same instance: a turn recorded in memory is immediately visible to the
 * statistics pane without waiting for a re-read, and the file is parsed only once.
 */
const ledgers = new Map<string, UsageLedger>();

export function usageLedgerFor(file: string): UsageLedger {
  let ledger = ledgers.get(file);
  if (!ledger) {
    ledger = new UsageLedger(file);
    ledgers.set(file, ledger);
  }
  return ledger;
}
