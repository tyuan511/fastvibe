/**
 * What the **current turn** spent, read off the transcript.
 *
 * `AgentSession.getSessionStats()` answers the whole-session question — it adds up every
 * entry in the file, compacted-away history and abandoned retry branches included. That
 * number is what 使用统计 and the composer's 会话 Token row want. It is not what the
 * composer's 本轮 Token row wants, and there is no engine API for it.
 *
 * So the turn is derived the same way everything else in this app is derived: from the
 * transcript, so a reload, a chat switch or a reconnecting phone computes the same number
 * Main did live. The boundary is the last user message on the current branch — a turn is
 * everything the agent did after the newest input. Three consequences worth knowing:
 *
 * - **A steer starts a new turn.** A follow-up injected mid-run is a user message, and the
 *   work counted from there is the work the latest input set off. That matches what the
 *   reader just asked for.
 * - **A goal round is a turn.** `/goal` continues itself through `sendUserMessage`, so each
 *   round re-baselines 本轮. The extension itself calls those rounds 轮, so the word means
 *   one thing across the app.
 * - **Abandoned attempts inside the turn still count.** A failed request that was retried
 *   was billed, and the row is about what this turn cost.
 *
 * Usage recorded outside assistant messages belongs to the turn too when it falls inside
 * the window: cache warming appends a `usage` entry, and a compaction carries the usage of
 * the calls that produced its summary.
 */

/** The four token buckets the engine reports, plus their sum. */
export type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/** Loose on purpose: this must take SDK entries and hand-written fixtures alike. */
type UsageRecord = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** A session entry, seen only through what this calculation reads. */
type UsageBearingEntry = {
  type: string;
  /** When the entry was persisted — the end of the round trip it describes. */
  timestamp?: string | number;
  message?: { role?: string; timestamp?: number; durationMs?: number; usage?: UsageRecord };
  usage?: UsageRecord;
};

/** What the current turn spent: tokens, and the model time behind them. */
export type TurnUsage = {
  tokens: TokenTotals;
  /**
   * Sum of this turn's round trips, in milliseconds. Measured per assistant message (its
   * request start to the moment it was persisted), so the gaps **between** messages — tool
   * execution, the wait for a tool result — are not in it. Kept for protocol compatibility;
   * output speed uses `lastRequestUsage` instead of this turn-wide total.
   */
  modelMs: number;
};

export function emptyTokenTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function add(totals: TokenTotals, usage: UsageRecord | undefined): void {
  if (!usage) return;
  totals.input += count(usage.input);
  totals.output += count(usage.output);
  totals.cacheRead += count(usage.cacheRead);
  totals.cacheWrite += count(usage.cacheWrite);
}

function finish(totals: TokenTotals): TokenTotals {
  return { ...totals, total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite };
}

/**
 * How long one round trip took.
 *
 * The engine's own `durationMs` wins: it is what the request measured, and it does not care
 * whether the entry reached disk promptly. The span from the message's request stamp to the
 * entry's persist time is the fallback for transcripts that carry no `durationMs` — an
 * imported chat from Claude Code or Codex, for instance. A message with neither contributes
 * no time rather than a lie; an in-flight reply is not in the branch at all.
 */
function roundTripMs(entry: UsageBearingEntry): number {
  const own = entry.message?.durationMs;
  if (typeof own === "number" && Number.isFinite(own) && own >= 0) return own;
  const started = entry.message?.timestamp;
  if (typeof started !== "number" || !Number.isFinite(started)) return 0;
  const ended = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(String(entry.timestamp ?? ""));
  if (!Number.isFinite(ended)) return 0;
  return Math.max(0, ended - started);
}

/**
 * The latest persisted assistant request on this branch, including tool-call replies.
 * Keep its output and time paired: compaction/usage entries and earlier requests must not
 * inflate its speed. An untimed latest request stays untimed rather than showing an older
 * request's speed. While a request is in flight, the branch still holds the previous one.
 */
export function lastRequestUsage(branch: readonly UsageBearingEntry[]): { outputTokens: number; durationMs: number } | undefined {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return { outputTokens: count(entry.message.usage?.output), durationMs: roundTripMs(entry) };
    }
  }
  return undefined;
}

/**
 * Tokens used by the turn in progress: everything after the last user message of a branch
 * given in chronological order (root → leaf, which is what `getBranch()` returns).
 *
 * A branch with no user message at all — a transcript that opens on a compaction summary,
 * or one whose earlier turns were pruned — has nothing to cut on, so the whole branch is
 * the turn. That is the honest reading of "what this conversation spent since its start".
 */
export function turnTokens(branch: readonly UsageBearingEntry[]): TurnUsage {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      start = i + 1;
      break;
    }
  }
  const totals = emptyTokenTotals();
  let modelMs = 0;
  for (let i = start; i < branch.length; i += 1) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type === "message") {
      if (entry.message?.role === "assistant") {
        add(totals, entry.message.usage);
        modelMs += roundTripMs(entry);
      }
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      add(totals, entry.usage);
    }
  }
  return { tokens: finish(totals), modelMs };
}
