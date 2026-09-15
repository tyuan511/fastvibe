import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelPrice,
  UsageDay,
  UsageMetrics,
  UsageModelBreakdown,
  UsageRange,
  UsageStats,
  UsageTotals,
} from "@shared/types";
import { catalogPrice } from "./models-dev";
import type { FastVibePaths } from "./paths";
import { priceUsage } from "./pricing";
import { modelPriceIndex } from "./providers";
import { parseSessionTurns, turnKey, usageLedgerFor, type UsageTurn } from "./usage-ledger";

/**
 * Usage statistics are derived from the engine's append-only session transcripts (one
 * JSONL file per conversation), unioned with the append-only usage ledger.
 *
 * Every assistant message carries the SDK's `usage` block, so the transcripts alone
 * reconstruct tokens, cost, requests and tool calls. But deleting a conversation
 * unlinks its transcript, which would silently rewrite history — so each finalized turn
 * is also recorded in the ledger (`usage-ledger.ts`) the moment it lands. A transcript
 * still on disk is the primary source; the ledger supplies the turns whose file is gone.
 * The two overlap for every live session and are deduplicated by `sessionId` + entry id.
 *
 * Cost is never stored; it is re-derived here from the current price table, so editing a
 * provider re-prices both sources exactly alike. Transcripts are parsed once and
 * memoised on `mtimeMs` + `size` (see `parseSessionTurns`).
 */
type Metrics = UsageMetrics;

type ModelBucket = {
  provider: string;
  model: string;
  days: Map<string, Metrics>;
};

export async function collectUsageStats(
  paths: FastVibePaths,
  range: UsageRange = "30d",
): Promise<UsageStats> {
  const files = await listSessionFiles(paths.sessionsDir);
  const prices = modelPriceIndex(paths);
  const parsed = await Promise.all(files.map((file) => parseSessionTurns(file).catch(() => null)));

  // A transcript on disk wins over the ledger for the same turn; either way the key is
  // `sessionId` + entry id, so a session deleted and reimported cannot double-count.
  // `parseSessionTurns` guarantees a non-empty session id (path-derived if the header
  // was unreadable), so the ledger's keys cannot collide with a damaged transcript.
  const turns = new Map<string, UsageTurn>();
  for (const file of parsed) {
    if (!file) continue;
    for (const turn of file.turns) turns.set(turnKey(turn), turn);
  }
  for (const turn of usageLedgerFor(paths.usageLedgerFile).all()) {
    const key = turnKey(turn);
    if (turns.has(key)) continue;
    turns.set(key, turn);
  }

  let earliestMs = Number.POSITIVE_INFINITY;
  for (const turn of turns.values()) {
    if (turn.at > 0 && turn.at < earliestMs) earliestMs = turn.at;
  }
  const earliest = Number.isFinite(earliestMs) ? localDateKey(earliestMs) : "";

  const today = localDateKey(Date.now());
  const from = rangeStart(range, earliest, today);

  const days = new Map<string, Metrics>();
  const models = new Map<string, ModelBucket>();
  const contributing = new Set<string>();

  for (const turn of turns.values()) {
    const date = localDateKey(turn.at);
    if (date < from || date > today) continue;

    const cost = priceTurn(turn, prices);
    const day = ensure(days, date);
    addTurn(day, turn, cost);

    const key = `${turn.provider}/${turn.model}`;
    const bucket = ensureModel(models, key, turn.provider, turn.model);
    addTurn(ensure(bucket.days, date), turn, cost);

    contributing.add(turn.sessionId);
  }

  const dayList: UsageDay[] = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, metrics]) => ({ date, ...metrics }));

  const totals: UsageTotals = { ...emptyMetrics(), activeDays: 0 };
  for (const day of days.values()) {
    totals.input += day.input;
    totals.output += day.output;
    totals.cacheRead += day.cacheRead;
    totals.cacheWrite += day.cacheWrite;
    totals.tokens += day.tokens;
    totals.cost += day.cost;
    totals.requests += day.requests;
    totals.toolCalls += day.toolCalls;
    totals.activeDays += 1;
  }

  const modelList: UsageModelBreakdown[] = [...models.values()]
    .map((bucket) => {
      const metrics = sumDays(bucket.days);
      return { provider: bucket.provider, model: bucket.model, ...metrics };
    })
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
    .slice(0, 12);

  // Sessions with at least one turn inside the window; the ledger keeps a deleted
  // session's id alive even though its transcript is gone.
  const sessions = contributing.size;

  return { range, from, to: today, totals, days: dayList, models: modelList, sessions };
}

/**
 * The USD a turn costs, re-priced from the current price table so the long-context
 * ladder is honoured (the engine records one flat rate per run) and so a provider edit
 * re-prices history. The stored engine cost is only the fallback, used when the table
 * cannot price the model at all — which is why the ledger keeps it.
 */
function priceTurn(turn: UsageTurn, prices: Map<string, ModelPrice>): number {
  const usage = {
    input: turn.input,
    output: turn.output,
    cacheRead: turn.cacheRead,
    cacheWrite: turn.cacheWrite,
  };
  const price = prices.get(`${turn.provider}/${turn.model}`) ?? prices.get(turn.model) ?? catalogPrice(turn.model);
  const priced = price ? priceUsage(price, usage) : undefined;
  return priced ?? turn.cost;
}

function addTurn(metrics: Metrics, turn: UsageTurn, cost: number): void {
  metrics.input += turn.input;
  metrics.output += turn.output;
  metrics.cacheRead += turn.cacheRead;
  metrics.cacheWrite += turn.cacheWrite;
  metrics.tokens += turn.tokens;
  metrics.cost += cost;
  metrics.requests += 1;
  metrics.toolCalls += turn.toolCalls;
}

async function listSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      }),
    );
  };
  await walk(root);
  return files;
}

function rangeStart(range: UsageRange, earliest: string, today: string): string {
  if (range === "all") return earliest || shiftDate(today, -364);
  const span = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 365;
  return shiftDate(today, -(span - 1));
}

function shiftDate(date: string, deltaDays: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return localDateKey(new Date(year, month - 1, day + deltaDays).getTime());
}

/** Stable local-time `YYYY-MM-DD`; UTC keys would split a day at the wrong hour. */
function localDateKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyMetrics(): Metrics {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, requests: 0, toolCalls: 0 };
}

function ensure(map: Map<string, Metrics>, key: string): Metrics {
  let value = map.get(key);
  if (!value) {
    value = emptyMetrics();
    map.set(key, value);
  }
  return value;
}

function ensureModel(
  map: Map<string, ModelBucket>,
  key: string,
  provider: string,
  model: string,
): ModelBucket {
  let value = map.get(key);
  if (!value) {
    value = { provider, model, days: new Map() };
    map.set(key, value);
  }
  return value;
}

function sumDays(days: Map<string, Metrics>): Metrics {
  const total = emptyMetrics();
  for (const metrics of days.values()) {
    total.input += metrics.input;
    total.output += metrics.output;
    total.cacheRead += metrics.cacheRead;
    total.cacheWrite += metrics.cacheWrite;
    total.tokens += metrics.tokens;
    total.cost += metrics.cost;
    total.requests += metrics.requests;
    total.toolCalls += metrics.toolCalls;
  }
  return total;
}
