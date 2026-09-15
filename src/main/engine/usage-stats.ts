import { readdir, readFile, stat } from "node:fs/promises";
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

/**
 * Usage statistics are derived from the engine's append-only session transcripts
 * (one JSONL file per conversation). Every assistant message carries the SDK's
 * `usage` block, so a scan of `sessionsDir` reconstructs tokens, cost, requests
 * and tool calls without maintaining a second ledger.
 *
 * Parsed files are cached by `mtimeMs` + `size`: transcripts only ever grow, so
 * a settings pane that switches ranges re-reads nothing it already has.
 */
type Metrics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  cost: number;
  requests: number;
  toolCalls: number;
};

type ModelBucket = {
  provider: string;
  model: string;
  days: Map<string, Metrics>;
};

type FileUsage = {
  mtimeMs: number;
  size: number;
  /** The price table the cost was computed against — see `collectUsageStats`. */
  priceKey: string;
  days: Map<string, Metrics>;
  models: Map<string, ModelBucket>;
  earliest: string;
};

const cache = new Map<string, FileUsage>();

export async function collectUsageStats(
  paths: FastVibePaths,
  range: UsageRange = "30d",
): Promise<UsageStats> {
  const files = await listSessionFiles(paths.sessionsDir);
  const prices = modelPriceIndex(paths);
  // Cost is derived from the current price table, not stored in the transcript alone, so
  // the cache key covers both: editing a provider must not leave yesterday's totals in
  // place for transcripts that have not grown since.
  const priceKey = await priceStamp(paths.providersFile);
  const parsed = await Promise.all(
    files.map((file) => parseSessionFile(file, prices, priceKey).catch(() => null)),
  );

  let earliest = "";
  for (const item of parsed) {
    if (item?.earliest && (!earliest || item.earliest < earliest)) earliest = item.earliest;
  }

  const today = localDateKey(Date.now());
  const from = rangeStart(range, earliest, today);

  const days = new Map<string, Metrics>();
  const models = new Map<string, ModelBucket>();
  let sessions = 0;

  for (const item of parsed) {
    if (!item) continue;
    sessions += 1;
    for (const [date, day] of item.days) {
      if (date < from || date > today) continue;
      addInto(days, date, day);
    }
    for (const [key, bucket] of item.models) {
      let target: ModelBucket | undefined;
      for (const [date, day] of bucket.days) {
        if (date < from || date > today) continue;
        target ??= ensureModel(models, key, bucket.provider, bucket.model);
        addInto(target.days, date, day);
      }
    }
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

  return { range, from, to: today, totals, days: dayList, models: modelList, sessions };
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

async function parseSessionFile(
  file: string,
  prices: Map<string, ModelPrice>,
  priceKey: string,
): Promise<FileUsage> {
  const info = await stat(file);
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size && cached.priceKey === priceKey) {
    return cached;
  }

  const text = await readFile(file, "utf8");
  const days = new Map<string, Metrics>();
  const models = new Map<string, ModelBucket>();
  let current: { provider: string; model: string } | undefined;
  let earliest = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    if (entry.type === "model_change" && typeof entry.provider === "string") {
      current = { provider: entry.provider, model: String(entry.modelId ?? "") };
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;

    const ms =
      typeof message.timestamp === "number"
        ? message.timestamp
        : Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(ms)) continue;

    const date = localDateKey(ms);
    if (!earliest || date < earliest) earliest = date;
    const day = ensure(days, date);
    day.requests += 1;

    let toolCalls = 0;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && isToolCallType(String(part.type ?? ""))) toolCalls += 1;
      }
    }
    day.toolCalls += toolCalls;

    const input = isRecord(message.usage) ? num(message.usage.input) : 0;
    const output = isRecord(message.usage) ? num(message.usage.output) : 0;
    const cacheRead = isRecord(message.usage) ? num(message.usage.cacheRead) : 0;
    const cacheWrite = isRecord(message.usage) ? num(message.usage.cacheWrite) : 0;
    const tokens =
      isRecord(message.usage) && num(message.usage.totalTokens)
        ? num(message.usage.totalTokens)
        : input + output + cacheRead + cacheWrite;

    const provider = typeof message.provider === "string" ? message.provider : current?.provider ?? "未知";
    const model = typeof message.model === "string" ? message.model : current?.model ?? "未知";
    const reportedCost =
      isRecord(message.usage) && isRecord(message.usage.cost) ? num(message.usage.cost.total) : 0;
    // A transcript written before the engine had a price for its model records an
    // all-zero cost even though the tokens are real. Re-price those from the model's
    // own ladder, so 统计 covers work already done instead of staying blank.
    const usage = { input, output, cacheRead, cacheWrite };
    const price = prices.get(`${provider}/${model}`) ?? prices.get(model) ?? catalogPrice(model);
    const cost = reportedCost > 0 ? reportedCost : (price && priceUsage(price, usage)) || 0;

    day.input += input;
    day.output += output;
    day.cacheRead += cacheRead;
    day.cacheWrite += cacheWrite;
    day.tokens += tokens;
    day.cost += cost;

    const key = `${provider}/${model}`;
    let bucket = models.get(key);
    if (!bucket) {
      bucket = { provider, model, days: new Map() };
      models.set(key, bucket);
    }
    const bucketDay = ensure(bucket.days, date);
    bucketDay.requests += 1;
    bucketDay.toolCalls += toolCalls;
    bucketDay.input += input;
    bucketDay.output += output;
    bucketDay.cacheRead += cacheRead;
    bucketDay.cacheWrite += cacheWrite;
    bucketDay.tokens += tokens;
    bucketDay.cost += cost;
  }

  const result: FileUsage = { mtimeMs: info.mtimeMs, size: info.size, priceKey, days, models, earliest };
  cache.set(file, result);
  return result;
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

function addInto(map: Map<string, Metrics>, key: string, add: Metrics): void {
  const target = ensure(map, key);
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cacheWrite += add.cacheWrite;
  target.tokens += add.tokens;
  target.cost += add.cost;
  target.requests += add.requests;
  target.toolCalls += add.toolCalls;
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

function isToolCallType(type: string): boolean {
  return type === "toolCall" || type === "tool_use" || type === "tool_call" || type === "toolcall";
}

/**
 * Identity of the price table a run of parsing used: the file prices are read from, and
 * when it was written. `providers.json` is the only place the app's prices change, and a
 * missing file is a legitimate "not configured yet" state rather than an error.
 */
async function priceStamp(providersFile: string): Promise<string> {
  try {
    return `${providersFile}:${(await stat(providersFile)).mtimeMs}`;
  } catch {
    return `${providersFile}:missing`;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
