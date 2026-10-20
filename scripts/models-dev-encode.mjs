/**
 * The models.dev snapshot format — written by both `scripts/sync-models-dev.mjs` (at
 * build time, into `resources/models-dev/`) and the app itself (hourly, and from
 * Settings → 关于, into the userData directory), and read by `src/main/engine/models-dev.ts`.
 *
 * It lives outside `src/main` (plain ESM, no build step) because the sync script is run
 * by bare `node`, while the main bundle imports it as an ordinary module.
 */

export const SOURCE_URL = "https://models.dev/api.json";

/**
 * 1 = context/output/input/efforts, 2 = + cost, 3 = + cost tiers,
 * 4 = dropped the feature bitmask the UI no longer records,
 * 5 = a key resolves to a vendor's own entry and ties are broken by id, so the
 *     winner no longer depends on the order providers happen to appear upstream.
 *     The tuple shape did not change (v4 readers decode a v5 snapshot unchanged).
 */
export const SNAPSHOT_VERSION = 5;

/** text=1 image=2 video=4 file=8 */
const INPUT_BITS = { text: 1, image: 2, video: 4, file: 8 };
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Download the upstream catalog. One place knows the URL, the agent string and the
 * budget, so a runtime update and a build-time sync fetch the same thing the same way.
 */
export async function downloadCatalog(url = SOURCE_URL) {
  const response = await fetch(url, {
    headers: { "User-Agent": "fastvibe-sync-models-dev" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`models.dev ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * The lookup-optimised snapshot: `m` holds unique models as tuples and `x` maps every
 * alias to an index in `m`, so runtime resolution is a single Map hit.
 */
export function buildSnapshot(catalog, options = {}) {
  const { models, aliases } = buildIndex(catalog);
  return {
    v: SNAPSHOT_VERSION,
    t: options.generatedAt ?? Date.now(),
    s: options.source ?? SOURCE_URL,
    c: models.length,
    m: models,
    x: aliases,
  };
}

/**
 * Fold the catalog into one entry per model id plus an alias map.
 *
 * The catalog lists the same model under every reseller that carries it — 9080 entries
 * for 3646 ids — and they disagree: the same id arrives with different context windows
 * and prices that can differ by more than 10×. Which one wins is therefore a decision,
 * and the first version of this file made it implicitly: entries were scored, and an
 * exact tie kept whichever appeared first upstream. Reordering `api.json` (a new
 * reseller, a re-sorted provider list) then changed the winner, so a model's context
 * window and price drifted between hourly refreshes with no data to explain it.
 *
 * The order below is a total order, so the same catalog always folds the same way:
 *
 * 1. `vendorRank` — the entry whose provider *is* the model's vendor
 *    (`canonical_model_id`'s prefix) wins, then one whose id starts with it (a
 *    `google-vertex` next to `google`). The vendor is the only publisher that actually
 *    knows the limit and the list price its resellers copy.
 * 2. `capability` — reasoning, thinking levels, modalities, a context over 200K.
 * 3. `completePricing` / `priceLadder` — a full price list, then a long-context ladder.
 * 4. `context` — the larger window.
 * 5. provider id, then model id — the tie-break that makes the order total. An id that
 *    no vendor lists (a reseller-only release) resolves by this rule alone, which is
 *    arbitrary but at least the same everywhere and every hour.
 *
 * An entry with no price at all is dropped before that comparison whenever some
 * candidate has one: a model priced by nobody is billed at $0, which is worse than
 * borrowing the price every other entry for the same id agrees on.
 */
export function buildIndex(catalog) {
  const groups = new Map(); // normalized id -> every catalog entry that claims it
  for (const [providerId, provider] of Object.entries(catalog ?? {})) {
    for (const model of Object.values(provider?.models ?? {})) {
      const id = model?.id ?? model?.name;
      if (!id || typeof id !== "string") continue;
      const key = normalize(id);
      if (!key) continue;
      const entry = toEntry(providerId, id, model);
      const list = groups.get(key);
      if (list) list.push(entry);
      else groups.set(key, [entry]);
    }
  }

  const winners = new Map();
  for (const [key, list] of groups) winners.set(key, pickEntry(list));

  // A stable model order keeps `index.json` diffable; aliases point at these positions.
  const ordered = [...winners.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const position = new Map(ordered.map(([key], index) => [key, index]));
  const aliases = {};
  for (const [alias, claim] of collectAliases(ordered)) aliases[alias] = position.get(claim.key);
  return { models: ordered.map(([, entry]) => entry.tuple), aliases };
}

/** The winning entry for one model id, or the only one when nothing claims it twice. */
function pickEntry(list) {
  const priced = list.filter((entry) => entry.priced);
  const pool = priced.length > 0 ? priced : list;
  let best = pool[0];
  for (const entry of pool) if (compareEntries(entry, best) < 0) best = entry;
  return best;
}

/** Negative when `a` is the better entry. The last keys make it a total order. */
function compareEntries(a, b) {
  for (const field of COMPARE_FIELDS) {
    const diff = (b[field] ?? 0) - (a[field] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

const COMPARE_FIELDS = ["vendorRank", "capability", "completePricing", "priceLadder", "context"];

function toEntry(providerId, id, model) {
  let mask = 0;
  for (const item of model.modalities?.input ?? []) {
    const mapped = item === "pdf" || item === "audio" ? "file" : item;
    mask |= INPUT_BITS[mapped] ?? 0;
  }
  if (mask === 0) mask = INPUT_BITS.text;
  const efforts = (model.reasoning_options ?? []).find((option) => option.type === "effort")?.values;
  const levels = Array.isArray(efforts)
    ? EFFORT_ORDER.filter((level) => efforts.includes(level))
    : model.reasoning
      ? ["low", "medium", "high"]
      : null;
  const cost = toCost(model.cost);
  const tuple = [
    id,
    model.name ?? id,
    positive(model.limit?.context),
    positive(model.limit?.output),
    mask,
    levels && levels.length > 0 ? levels : null,
    cost,
  ];
  return {
    id,
    name: model.name ?? id,
    tuple,
    providerId,
    context: positive(model.limit?.context),
    vendorRank: vendorRank(providerId, model),
    capability: capabilityOf(model, mask, levels),
    priced: cost !== null,
    completePricing: cost !== null && cost.slice(0, 4).every((field) => field > 0),
    priceLadder: hasTierLadder(cost),
  };
}

/**
 * How much of the model's own vendor the entry is. `canonical_model_id` names the model
 * (`anthropic/claude-sonnet-5-5`), so its provider prefix is who publishes it; a reseller
 * either leaves the field out or copies the canonical id across.
 *
 * The prefix match is where a subscription plan can walk in. `alibaba-token-plan`, the
 * three `xiaomi-token-plan-*` rows and the rest are a vendor's *billing plan*, not the
 * vendor: their models are what the plan covers, priced at nothing because a plan is
 * not charged per token. Treating them as the vendor's own entry would make a plan the
 * authority on a model's list price — and on a key where the plan is the only entry
 * carrying a price at all (tencent's `hy4-preview` reports the real rate on all three of
 * its rows), it would *be* the price. A plan is never the vendor, so it gets no credit
 * here; exact vendor ids never look like this (no `canonical_model_id` prefix in the
 * catalog is plan-shaped), so rank 2 is untouched.
 */
function vendorRank(providerId, model) {
  const canonical = normalize(String(model.canonical_model_id ?? "").split("/")[0] ?? "");
  if (!canonical) return 0;
  const provider = normalize(providerId);
  if (provider === canonical) return 2;
  if (isSubscriptionPlan(provider)) return 0;
  return provider.startsWith(canonical) ? 1 : 0;
}

/**
 * A vendor's subscription plan rather than the vendor itself — 包月/包年 access sold under
 * the vendor's name (`xiaomi-token-plan-cn`, `zhipuai-coding-plan`, `tencent-tokenhub`).
 * The suffix is the whole signal; the catalog has no field for it, and the three shapes
 * accounted for every plan-shaped provider in the catalog.
 */
function isSubscriptionPlan(providerId) {
  return /(?:^|-)plan(?:-|$)|coding-plan|token-plan|tokenhub/.test(providerId);
}

/**
 * Per-million-token prices as `[input, output, cacheRead, cacheWrite, tiers?]`, or null
 * when the catalog has no pricing (or only zeros, which carries no information).
 *
 * The first four values are the entry price — what a request at or below the first
 * threshold pays. `tiers` is the long-context ladder, `[[over, input, output,
 * cacheRead, cacheWrite], …]` ascending by `over`, and is omitted for the majority of
 * models that charge one flat rate.
 */
function toCost(cost) {
  if (!cost || typeof cost !== "object") return null;
  const base = [cost.input, cost.output, cost.cache_read, cost.cache_write].map(nonNegative);
  if (!base.some((value) => value > 0)) return null;
  const tiers = toTiers(cost, base);
  return tiers.length > 0 ? [...base, tiers] : base;
}

/**
 * The context ladder, normalised to full four-field rows. A tier that omits a field
 * (e.g. `cache_write` on an Anthropic model) keeps the entry price for it rather than
 * reading as free. `context_over_200k` is the older single-threshold spelling of the
 * same thing and is only consulted for models the catalog has not moved to `tiers`.
 */
function toTiers(cost, base) {
  const rows = Array.isArray(cost.tiers)
    ? cost.tiers.map((tier) => ({ over: positive(tier?.tier?.size), price: tier }))
    : cost.context_over_200k
      ? [{ over: 200_000, price: cost.context_over_200k }]
      : [];
  return rows
    .filter((row) => row.over > 0 && row.price && typeof row.price === "object")
    .map((row) => [
      row.over,
      priceOr(row.price.input, base[0]),
      priceOr(row.price.output, base[1]),
      priceOr(row.price.cache_read, base[2]),
      priceOr(row.price.cache_write, base[3]),
    ])
    .sort((a, b) => a[0] - b[0]);
}

function priceOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * What the model can do, independent of who sells it. Used only to rank entries that
 * claim the same id — never to decide what a model *is*.
 */
function capabilityOf(model, mask, levels) {
  let value = 0;
  if (levels && levels.length > 0) value += 8;
  if (model.reasoning === true) value += 4;
  value += popcount(mask);
  if (positive(model.limit?.context) >= 200_000) value += 1;
  return value;
}

function hasTierLadder(cost) {
  return Array.isArray(cost) && Array.isArray(cost[4]) && cost[4].length > 0;
}

/**
 * Aliases, and who has the better claim to each.
 *
 * Every entry carries several names that are not its id — the last path segment of
 * `zai-org/GLM-5.3`, the display name, a date-stripped form — and 913 of them are
 * claimed by more than one model. Handing an alias to whichever entry ranked highest
 * meant `llama3-3-70b` could resolve to `TEE/llama3-3-70b`'s neighbour rather than to
 * the model literally called that, and which one won moved with the catalog order.
 *
 * So claims are tiered by how well they describe the alias, and a lower tier always
 * wins: the entry's own id (tier 0, the alias *is* a key), its date-stripped form
 * (1), the last segment of a namespaced id (2), the display name (3). Within a tier the
 * ranking is the same total order that picks winners, so the answer is a function of
 * the catalog's content only.
 */
function collectAliases(ordered) {
  const claims = new Map(); // alias -> { key, tier, entry }
  for (const [key, entry] of ordered) {
    for (const { alias, tier } of aliasClaims(key, entry)) {
      const next = { key, tier, entry };
      const current = claims.get(alias);
      if (!current || compareClaims(next, current) < 0) claims.set(alias, next);
    }
  }
  return claims;
}

function compareClaims(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const byEntry = compareEntries(a.entry, b.entry);
  if (byEntry !== 0) return byEntry;
  return 0;
}

function aliasClaims(key, entry) {
  const claims = [{ alias: key, tier: 0 }];
  const undated = stripDate(key);
  if (undated && undated !== key) claims.push({ alias: undated, tier: 1 });
  const last = normalize(String(entry.id).split("/").at(-1) ?? "");
  if (last && last !== key) {
    claims.push({ alias: last, tier: 2 });
    const lastUndated = stripDate(last);
    if (lastUndated && lastUndated !== last && lastUndated !== key && lastUndated !== undated) {
      claims.push({ alias: lastUndated, tier: 2 });
    }
  }
  const name = normalize(entry.name ?? "");
  if (name && name !== key && name !== last) claims.push({ alias: name, tier: 3 });
  return claims;
}

export function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function stripDate(key) {
  return key.replace(/-\d{4,8}$/, "");
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function popcount(value) {
  let count = 0;
  let n = value;
  while (n) {
    n &= n - 1;
    count += 1;
  }
  return count;
}
