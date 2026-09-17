import { test } from "node:test";
import assert from "node:assert/strict";
import { priceUsage, selectCost, type TokenUsage } from "../src/main/engine/pricing.ts";

/**
 * The price ladder is the one place FastVibe bills money itself, and it exists because
 * pi prices a run with a single flat rate. A model that charges more past a context
 * threshold therefore has to be billed per request — and getting the threshold wrong
 * (measuring only uncached input, or picking the first step that matches) is a silent
 * accounting error, not a crash. Hence the boundary cases below.
 */

const ENTRY = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const TIER = { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 };
const LADDER = { cost: ENTRY, costTiers: [{ over: 200_000, cost: TIER }] };

function usage(patch: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...patch };
}

test("a prompt at the threshold keeps the entry price", () => {
  // "over 200k" is exclusive: exactly 200k is still the base rate.
  assert.deepEqual(selectCost(LADDER, usage({ input: 200_000 })), ENTRY);
});

test("one token past the threshold moves to the next step", () => {
  assert.deepEqual(selectCost(LADDER, usage({ input: 200_001 })), TIER);
});

test("the threshold counts the whole prompt, cache buckets included", () => {
  // The tiers are about *context size*, and a cached prompt is still context: an
  // implementation that summed only `input` would bill a 250k cached request at the
  // base rate.
  assert.deepEqual(selectCost(LADDER, usage({ input: 100_000, cacheRead: 100_001 })), TIER);
  assert.deepEqual(selectCost(LADDER, usage({ input: 100_000, cacheWrite: 100_001 })), TIER);
});

test("a model with no price reports unknown rather than free", () => {
  // `undefined` is what lets a caller fall back to the engine's own figure; returning
  // 0 would claim the turn was free.
  assert.equal(priceUsage({}, usage({ input: 1000 })), undefined);
});

test("a model with a price but no usage costs zero", () => {
  assert.equal(priceUsage({ cost: ENTRY }, usage()), 0);
});

test("the arithmetic is per million tokens", () => {
  const cost = priceUsage({ cost: ENTRY }, usage({ input: 1_000_000, output: 1_000_000 }));
  assert.equal(cost, 18);
});

test("the highest step the prompt clears wins", () => {
  // The ladder is written ascending and read as such; a caller handing over an
  // unordered list must still land on the top step it qualifies for.
  const unordered = {
    cost: ENTRY,
    costTiers: [
      { over: 500_000, cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } },
      { over: 200_000, cost: TIER },
    ],
  };
  assert.deepEqual(selectCost(unordered, usage({ input: 600_000 }))?.input, 9);
  assert.deepEqual(selectCost(unordered, usage({ input: 250_000 }))?.input, 6);
});
