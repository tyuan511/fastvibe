import type { CostTier, ModelCost, ModelPrice } from "@shared/types";

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * What one turn costs in USD, using a model's own price ladder.
 *
 * pi prices a run with a single flat rate (`Model.cost`), so a model that charges more
 * past a context threshold — "over 200K prompt tokens", say — can only be billed
 * correctly by picking the step per request. That is what this does: the same
 * `tokens × price` arithmetic the engine runs, but against the tier the request's
 * prompt size actually lands in.
 *
 * Returns `undefined` when the model has no price at all, so callers can tell "free"
 * from "unknown" and fall back to what the engine recorded.
 */
export function priceUsage(price: ModelPrice, usage: TokenUsage): number | undefined {
  const cost = selectCost(price, usage);
  if (!cost) return undefined;
  return (
    (cost.input * usage.input +
      cost.output * usage.output +
      cost.cacheRead * usage.cacheRead +
      cost.cacheWrite * usage.cacheWrite) /
    1_000_000
  );
}

/**
 * The tier a request is billed at. The threshold is measured on the whole prompt — the
 * uncached input plus both cache buckets — which is what upstreams mean by "context
 * over N". An empty or unreadable ladder leaves the entry price in place.
 */
export function selectCost(price: ModelPrice, usage: TokenUsage): ModelCost | undefined {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  let selected = price.cost;
  for (const tier of tierLadder(price.costTiers)) {
    if (prompt <= tier.over) break;
    selected = tier.cost;
  }
  return selected;
}

/** Ascending by threshold, so the highest step the prompt clears wins. */
function tierLadder(tiers: CostTier[] | undefined): CostTier[] {
  if (!tiers || tiers.length === 0) return [];
  return [...tiers].sort((a, b) => a.over - b.over);
}
