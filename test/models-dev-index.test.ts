/**
 * How the models.dev catalog folds into FastVibe's snapshot (`scripts/models-dev-encode.mjs`).
 *
 * The catalog lists one model under every reseller carrying it — around 9000 entries for
 * 3600 ids — and they disagree about its context window and price, often by a lot. Which
 * entry wins is a decision, and the decision used to be made by iteration order: an exact
 * tie kept whichever came first upstream, so a model's limits and its *billing* changed
 * between hourly refreshes whenever models.dev re-sorted its provider list. The rules that
 * fail silently are pinned here: the vendor's own entry wins, ties are total, and an alias
 * goes to the model that actually has that name rather than to whoever ranked higher.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex, buildSnapshot, normalize, SNAPSHOT_VERSION } from "../scripts/models-dev-encode.mjs";

type Catalog = Record<string, { models: Record<string, unknown> }>;

function model(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, limit: { context: 128_000, output: 8_192 }, ...extra };
}

function priced(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite };
}

function catalog(providers: Record<string, Record<string, unknown>[]>): Catalog {
  const out: Catalog = {};
  for (const [id, models] of Object.entries(providers)) {
    const bag: Record<string, unknown> = {};
    for (const entry of models) bag[(entry as { id: string }).id] = entry;
    out[id] = { models: bag };
  }
  return out;
}

function tupleFor(index: ReturnType<typeof buildIndex>, alias: string) {
  const position = index.aliases[alias];
  return position === undefined ? null : index.models[position];
}

/** Rebuild the same catalog with every provider and model inserted in a different order. */
function shuffled(source: Catalog, seed: number): Catalog {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const order = <T>(items: T[]) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const out: Catalog = {};
  for (const providerId of order(Object.keys(source))) {
    const models: Record<string, unknown> = {};
    for (const [id, entry] of order(Object.entries(source[providerId].models))) models[id] = entry;
    out[providerId] = { models };
  }
  return out;
}

test("the vendor's own entry wins over a reseller's, whatever order they arrive in", () => {
  const reseller = model("claude-sonnet-5-5", {
    canonical_model_id: "anthropic/claude-sonnet-5-5",
    limit: { context: 1_000_000, output: 128_000 },
    cost: priced(2, 10, 0.2, 2.5),
  });
  const vendor = model("claude-sonnet-5-5", {
    canonical_model_id: "anthropic/claude-sonnet-5-5",
    limit: { context: 1_000_000, output: 128_000 },
    cost: priced(2, 10, 0.1, 2.5),
  });

  for (const providers of [
    { opencode: [reseller], anthropic: [vendor] },
    { anthropic: [vendor], opencode: [reseller] },
  ]) {
    const tuple = tupleFor(buildIndex(catalog(providers)), "claude-sonnet-5-5");
    assert.deepEqual(tuple?.[6], [2, 10, 0.1, 2.5], "the cache-read price the vendor publishes");
  }
});

test("a provider whose id starts with the vendor's is next in line", () => {
  const reseller = model("gemini-2-5-pro", {
    canonical_model_id: "google/gemini-2-5-pro",
    limit: { context: 1_000_000, output: 64_000 },
    cost: priced(1.25, 10),
  });
  const vertex = model("gemini-2-5-pro", {
    canonical_model_id: "google/gemini-2-5-pro",
    limit: { context: 1_048_576, output: 65_536 },
    cost: priced(1.2, 9.6),
  });
  const google = model("gemini-2-5-pro", {
    canonical_model_id: "google/gemini-2-5-pro",
    limit: { context: 1_048_576, output: 65_536 },
    cost: priced(1.25, 10),
  });
  const tuple = tupleFor(buildIndex(catalog({ aihubmix: [reseller], "google-vertex": [vertex], google: [google] })), "gemini-2-5-pro");
  assert.deepEqual(tuple?.[6], [1.25, 10, 0, 0]);
  assert.equal(tuple?.[2], 1_048_576);

  const withoutVendor = tupleFor(buildIndex(catalog({ aihubmix: [reseller], "google-vertex": [vertex] })), "gemini-2-5-pro");
  assert.deepEqual(withoutVendor?.[6], [1.2, 9.6, 0, 0], "a vendor prefix still outranks an unrelated reseller");
});

test("a subscription plan is never the vendor, however its id is spelled", () => {
  // 包月 access sold under the vendor's name. It is not charged per token, so a rate it
  // publishes is either zero (dropped by the price gate) or a copy of the vendor's — but
  // it must never be credited as *the vendor's own entry*, or a plan becomes the
  // authority on a list price it does not pay.
  const planIds = [
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams",
    "alibaba-token-plan",
    "zhipuai-coding-plan",
    "minimax-cn-coding-plan",
    "stepfun-ai-step-plan",
    "kimi-code-plan-global",
    "tencent-tokenhub",
  ];
  for (const planId of planIds) {
    const plan = model("acme-1", {
      canonical_model_id: "acme/acme-1",
      limit: { context: 1_000_000, output: 64_000 },
      cost: priced(9, 9),
    });
    const vendor = model("acme-1", {
      canonical_model_id: "acme/acme-1",
      limit: { context: 1_000_000, output: 64_000 },
      cost: priced(1, 2),
    });
    // Alphabetically the plan sorts before `acme`, so only the rank keeps it out.
    const index = buildIndex(catalog({ [planId]: [plan], acme: [vendor] }));
    assert.deepEqual(tupleFor(index, "acme-1")?.[6], [1, 2, 0, 0], `${planId} outranked the vendor`);
  }
});

test("a plan still beats an unrelated reseller when the vendor is absent", () => {
  // Demoted means "not the vendor", not "not a source": the plan's numbers are still
  // better than an unrelated reseller's, so it keeps rank 0 and competes normally.
  const plan = model("acme-1", {
    canonical_model_id: "acme/acme-1",
    limit: { context: 1_000_000, output: 64_000 },
    cost: priced(1, 2),
  });
  const reseller = model("acme-1", { limit: { context: 1_000_000, output: 64_000 }, cost: priced(3, 4) });
  const index = buildIndex(catalog({ "acme-token-plan": [plan], reseller: [reseller] }));
  const reversed = buildIndex(catalog({ reseller: [reseller], "acme-token-plan": [plan] }));
  assert.deepEqual(tupleFor(reversed, "acme-1"), tupleFor(index, "acme-1"));
});

test("a model nobody prices is not chosen over one that is", () => {
  const free = model("kimi-k3", { canonical_model_id: "moonshotai/kimi-k3", limit: { context: 1_048_576, output: 131_072 } });
  const pricedEntry = model("kimi-k3", {
    canonical_model_id: "moonshotai/kimi-k3",
    limit: { context: 1_048_576, output: 131_072 },
    cost: priced(3, 15),
  });
  for (const providers of [
    { freehost: [free], reseller: [pricedEntry] },
    { reseller: [pricedEntry], freehost: [free] },
  ]) {
    const tuple = tupleFor(buildIndex(catalog(providers)), "kimi-k3");
    assert.deepEqual(tuple?.[6], [3, 15, 0, 0], "a $0 model would bill every turn at zero");
  }
});

test("a reseller-only id ties by provider id rather than by arrival order", () => {
  const a = model("acme-1", { limit: { context: 100_000, output: 8_000 }, cost: priced(1, 2) });
  const b = model("acme-1", { limit: { context: 100_000, output: 8_000 }, cost: priced(1, 2) });
  const first = tupleFor(buildIndex(catalog({ zeta: [a], alpha: [b] })), "acme-1");
  const second = tupleFor(buildIndex(catalog({ alpha: [b], zeta: [a] })), "acme-1");
  assert.deepEqual(first, second);
  assert.equal(first?.[0], "acme-1");
});

test("folding the same catalog twice, in any provider order, is byte-identical", () => {
  const providers: Record<string, Record<string, unknown>[]> = {
    anthropic: [
      model("claude-sonnet-5-5", {
        canonical_model_id: "anthropic/claude-sonnet-5-5",
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
        cost: priced(2, 10, 0.1, 2.5),
      }),
    ],
    azure: [
      model("claude-sonnet-5-5", {
        canonical_model_id: "anthropic/claude-sonnet-5-5",
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
        cost: priced(2, 10, 0.2, 2.5),
      }),
    ],
    opencode: [
      model("claude-sonnet-5-5", {
        canonical_model_id: "anthropic/claude-sonnet-5-5",
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
        cost: priced(2, 10, 0.3, 3.75),
      }),
      model("glm-5.3", {
        canonical_model_id: "zhipuai/glm-5.3",
        limit: { context: 1_000_000, output: 131_072 },
        cost: priced(1.4, 4.4, 0.26),
      }),
    ],
    zhipuai: [
      model("glm-5.3", {
        canonical_model_id: "zhipuai/glm-5.3",
        limit: { context: 1_000_000, output: 131_072 },
        cost: priced(1.19516, 4.18306, 0.29879),
      }),
    ],
    tinfoil: [
      model("deepseek-v4-1-flash", { reasoning: true, limit: { context: 1_048_576, output: 384_000 }, cost: priced(0.65, 1.45) }),
      model("glm-5.3", { reasoning: true, limit: { context: 1_048_576, output: 131_072 }, cost: priced(1.8, 5.75) }),
    ],
    "deepseek-ai": [
      model("DeepSeek-V4.1-Flash", { limit: { context: 1_000_000, output: 384_000 }, cost: priced(0.3, 1.2) }),
    ],
  };
  const base = buildSnapshot(catalog(providers), { generatedAt: 1 });
  for (let seed = 1; seed <= 25; seed += 1) {
    const other = buildSnapshot(shuffled(catalog(providers), seed), { generatedAt: 1 });
    assert.deepEqual(other.m, base.m, `model rows moved under shuffle ${seed}`);
    assert.deepEqual(other.x, base.x, `alias map moved under shuffle ${seed}`);
  }
});

test("an alias goes to the model that has that name, not to a better-ranked neighbour", () => {
  // `TEE/llama3-3-70b` contributes the last segment only; the model literally called
  // `llama3-3-70b` must keep the alias even when the other entry ranks higher.
  const named = model("llama3-3-70b", { limit: { context: 131_072, output: 16_384 }, cost: priced(1.75, 2.75) });
  const namespaced = model("TEE/llama3-3-70b", {
    limit: { context: 131_072, output: 16_384 },
    cost: priced(1.75, 2.75, 0.5, 0.5),
  });
  const index = buildIndex(catalog({ tinfoil: [named], "nano-gpt": [namespaced] }));
  assert.equal(tupleFor(index, "llama3-3-70b")?.[0], "llama3-3-70b");
  assert.equal(tupleFor(index, "tee-llama3-3-70b")?.length, 7, "the namespaced id keeps its own key");

  // ...and the reverse order gives the same answer.
  const reversed = buildIndex(catalog({ "nano-gpt": [namespaced], tinfoil: [named] }));
  assert.deepEqual(reversed.aliases, index.aliases);
});

test("a namespaced id reaches its bare id and its display name", () => {
  const index = buildIndex(
    catalog({
      "z-ai": [model("zai-org/GLM-5.3", { name: "GLM 5.3", limit: { context: 1_048_576, output: 131_072 } })],
    }),
  );
  for (const alias of ["zai-org-glm-5-3", "glm-5-3", normalize("GLM 5.3")]) {
    assert.ok(alias in index.aliases, `expected ${alias} to resolve`);
  }
  assert.equal(tupleFor(index, "glm-5-3")?.[0], "zai-org/GLM-5.3");
});

test("a dated id also answers to its undated form", () => {
  const index = buildIndex(
    catalog({
      anthropic: [model("claude-haiku-4-5-20251001", { limit: { context: 200_000, output: 64_000 }, cost: priced(1, 5) })],
    }),
  );
  assert.equal(tupleFor(index, "claude-haiku-4-5-20251001")?.[0], "claude-haiku-4-5-20251001");
  assert.equal(tupleFor(index, "claude-haiku-4-5")?.[0], "claude-haiku-4-5-20251001");
});

test("the snapshot version moved past the order-dependent one", () => {
  // The encoder changed which entry wins and how aliases are claimed, so a snapshot
  // cached on a user's machine must be re-derived instead of trusted.
  assert.equal(SNAPSHOT_VERSION, 5);
  const snapshot = buildSnapshot(catalog({ x: [model("m")] }), { generatedAt: 7 });
  assert.equal(snapshot.v, 5);
  assert.equal(snapshot.t, 7);
  assert.equal(snapshot.c, snapshot.m.length);
});
