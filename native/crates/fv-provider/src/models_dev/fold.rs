//! Building the snapshot from the upstream catalog: the fold that turns ~9000 provider entries
//! into one record per model, plus the alias map that resolves any name to it.
//!
//! The catalog lists the same model under every reseller that carries it, and they disagree —
//! the same id arrives with different context windows and prices that differ by more than 10×.
//! Which entry wins is therefore a decision, and it has to be a *total* order: an earlier
//! version of this file let iteration order decide ties, so a model's window and **billing**
//! drifted whenever models.dev re-sorted its provider list. The rules below are the ones
//! `scripts/models-dev-encode.mjs` implements, kept byte-for-byte equivalent in behaviour; the
//! tests in `tests/models_dev.rs` cross-check the two against one another.

use std::cmp::Ordering;

use serde_json::{Map, Value};

use super::meta::{decode_input, default_context_window, effort_name, normalize_model_key};
use crate::ThinkingLevel;

pub const SOURCE_URL: &str = "https://models.dev/api.json";

/// 1 = context/output/input/efforts, 2 = + cost, 3 = + cost tiers, 4 = dropped the feature
/// bitmask the UI no longer records, 5 = a key resolves to a vendor's own entry and ties are
/// broken by id, so the winner no longer depends on the order providers happen to appear
/// upstream. The tuple shape did not change: a v4 reader decodes a v5 snapshot unchanged.
pub const SNAPSHOT_VERSION: u32 = 5;

const EFFORT_ORDER: [ThinkingLevel; 6] = [
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];

/// `[input, output, cacheRead, cacheWrite]`, plus the long-context ladder when the model has one.
#[derive(Clone)]
struct Cost {
    base: [f64; 4],
    tiers: Vec<[f64; 5]>,
}

/// One catalog entry, with everything the ranking reads kept beside what gets written out.
struct Entry {
    id: String,
    name: String,
    provider_id: String,
    /// 0..2 — how much of the model's own vendor this entry is.
    vendor_rank: u8,
    /// Levels, reasoning, modalities, a big window, summed into one comparable number.
    capability: u8,
    context: u64,
    priced: bool,
    complete_pricing: bool,
    price_ladder: bool,
    tuple: Value,
}

impl Entry {
    /// The comparison keys, in the order the fold consults them. Larger wins.
    fn key(&self, index: usize) -> i64 {
        match index {
            0 => self.vendor_rank as i64,
            1 => self.capability as i64,
            2 => i64::from(self.complete_pricing),
            3 => i64::from(self.price_ladder),
            _ => self.context as i64,
        }
    }
}

/// Negative-ish in the JavaScript original means "a wins"; here `a` winning is `Ordering::Less`,
/// so the same field order and the same sign convention carry across.
fn compare_entries(a: &Entry, b: &Entry) -> Ordering {
    for index in 0..5 {
        let diff = b.key(index).cmp(&a.key(index));
        if diff != Ordering::Equal {
            // The field is "bigger is better", and a larger field is `Greater` — which has to
            // come back as `Less` for `a`, because `a` is the one that wins.
            return match diff {
                Ordering::Greater => Ordering::Less,
                Ordering::Less => Ordering::Greater,
                Ordering::Equal => unreachable!(),
            };
        }
    }
    a.provider_id.cmp(&b.provider_id).then_with(|| a.id.cmp(&b.id))
}

/// The winning entry for one model id, or the only one when nothing claims it twice.
///
/// An entry with no price at all is dropped whenever some candidate has one: a model priced by
/// nobody is billed at $0, which is worse than borrowing the price every other entry for the
/// same id agrees on.
fn pick_entry(list: &mut Vec<Entry>) -> Entry {
    if list.len() > 1 {
        let any_priced = list.iter().any(|entry| entry.priced);
        if any_priced {
            list.retain(|entry| entry.priced);
        }
    }
    let mut best = list.remove(0);
    for entry in list.drain(..) {
        if compare_entries(&entry, &best) == Ordering::Less {
            best = entry;
        }
    }
    best
}

/// The whole snapshot: the compact file the app reads.
pub fn build_snapshot(catalog: &Value, generated_at: u64, source: &str) -> Value {
    let (models, aliases) = build_index(catalog);
    Value::Object(Map::from_iter([
        ("v".into(), Value::from(SNAPSHOT_VERSION)),
        ("t".into(), Value::from(generated_at)),
        ("s".into(), Value::from(source)),
        ("c".into(), Value::from(models.len())),
        ("m".into(), Value::Array(models)),
        ("x".into(), Value::Object(aliases)),
    ]))
}

/// Fold the catalog into one tuple per model id plus an alias map onto their positions.
pub fn build_index(catalog: &Value) -> (Vec<Value>, Map<String, Value>) {
    let mut groups: Vec<(String, Vec<Entry>)> = Vec::new();
    let Some(providers) = catalog.as_object() else { return (Vec::new(), Map::new()) };
    for (provider_id, provider) in providers {
        let Some(models) = provider.get("models").and_then(Value::as_object) else { continue };
        for model in models.values() {
            let Some(id) = model.get("id").and_then(Value::as_str).or_else(|| model.get("name").and_then(Value::as_str))
            else {
                continue;
            };
            let key = normalize_model_key(id);
            if key.is_empty() {
                continue;
            }
            let entry = to_entry(provider_id, id, model);
            match groups.iter_mut().find(|(known, _)| *known == key) {
                Some((_, list)) => list.push(entry),
                None => groups.push((key, vec![entry])),
            }
        }
    }

    let mut winners: Vec<(String, Entry)> = groups
        .into_iter()
        .map(|(key, mut list)| (key, pick_entry(&mut list)))
        .collect();
    // A stable model order keeps the snapshot diffable, and aliases point at these positions.
    winners.sort_by(|a, b| a.0.cmp(&b.0));

    let mut aliases: Map<String, Value> = Map::new();
    // `alias -> (position, claim)`; a claim wins on its tier first, then on the entry behind it.
    let mut claims: Vec<(String, usize, u8, usize)> = Vec::new(); // alias, position, tier, entry index
    for (position, (key, entry)) in winners.iter().enumerate() {
        for (alias, tier) in alias_claims(key, entry) {
            match claims.iter_mut().find(|(known, ..)| *known == alias) {
                Some((_, best_position, best_tier, best_entry)) => {
                    let challenger = compare_claims(*tier, position, *best_tier, *best_entry);
                    if challenger == Ordering::Less {
                        *best_position = position;
                        *best_tier = tier;
                        *best_entry = position;
                    }
                    let _ = best_position;
                }
                None => claims.push((alias, position, tier, position)),
            }
        }
    }
    for (alias, position, ..) in claims {
        aliases.insert(alias, Value::from(position));
    }
    (winners.iter().map(|(_, entry)| entry.tuple.clone()).collect(), aliases)
}

/// Lower tier is a better claim to a name; inside a tier the fold's own order decides.
fn compare_claims(a_tier: u8, a_entry: usize, b_tier: u8, b_entry: usize) -> Ordering {
    // The entries are borrowed from `winners`, which the caller owns; comparing the two through
    // the indices keeps the borrow checker out of the way.
    if a_tier != b_tier {
        return a_tier.cmp(&b_tier);
    }
    a_entry.cmp(&b_entry)
}

fn alias_claims(key: &str, entry: &Entry) -> Vec<(String, u8)> {
    let mut claims = vec![(key.to_owned(), 0u8)];
    let undated = strip_date(key);
    if !undated.is_empty() && undated != key {
        claims.push((undated.clone(), 1));
    }
    let last = normalize_model_key(entry.id.rsplit('/').next().unwrap_or(""));
    if !last.is_empty() && last != key {
        claims.push((last.clone(), 2));
        let last_undated = strip_date(&last);
        if !last_undated.is_empty()
            && last_undated != last
            && last_undated != key
            && last_undated != undated
        {
            claims.push((last_undated, 2));
        }
    }
    let name = normalize_model_key(&entry.name);
    if !name.is_empty() && name != key && name != last {
        claims.push((name, 3));
    }
    claims
}

fn to_entry(provider_id: &str, id: &str, model: &Value) -> Entry {
    let mut mask = 0u64;
    if let Some(items) = model.get("modalities").and_then(|m| m.get("input")).and_then(Value::as_array) {
        for item in items.iter().filter_map(Value::as_str) {
            if let Some(kind) = super::meta::InputModality::from_name(item) {
                mask |= match kind {
                    super::meta::InputModality::Text => 1,
                    super::meta::InputModality::Image => 2,
                    super::meta::InputModality::Video => 4,
                    super::meta::InputModality::File => 8,
                };
            }
        }
    }
    if mask == 0 {
        mask = 1;
    }
    let context = positive(model.get("limit").and_then(|l| l.get("context")));
    let output = positive(model.get("limit").and_then(|l| l.get("output")));
    let levels = effort_levels(model);
    let cost = to_cost(model.get("cost"));
    let name = model.get("name").and_then(Value::as_str).unwrap_or(id);
    let tuple = Value::Array(vec![
        Value::from(id),
        Value::from(name),
        Value::from(context),
        Value::from(output),
        Value::from(mask),
        match &levels {
            Some(levels) if !levels.is_empty() => Value::Array(
                levels.iter().map(|level| Value::from(effort_name(*level))).collect::<Vec<_>>(),
            ),
            _ => Value::Null,
        },
        match &cost {
            Some(cost) => Value::Array(
                cost.base
                    .iter()
                    .map(|value| Value::from(*value))
                    .chain(
                        (!cost.tiers.is_empty()).then(|| {
                            Value::Array(
                                cost.tiers
                                    .iter()
                                    .map(|row| {
                                        Value::Array(row.iter().map(|v| Value::from(*v)).collect())
                                    })
                                    .collect(),
                            )
                        })
                        .flatten(),
                    )
                    .collect(),
            ),
            None => Value::Null,
        },
    ]);
    let priced = cost.is_some();
    Entry {
        id: id.to_owned(),
        name: name.to_owned(),
        provider_id: provider_id.to_owned(),
        vendor_rank: vendor_rank(provider_id, model),
        capability: capability(model, levels.as_deref(), context, mask),
        context,
        priced,
        complete_pricing: cost.as_ref().is_some_and(|cost| cost.base.iter().all(|value| *value > 0.0)),
        price_ladder: cost.as_ref().is_some_and(|cost| !cost.tiers.is_empty()),
        tuple,
    }
}

/// How much of the model's own vendor an entry is. `canonical_model_id` names the model
/// (`anthropic/claude-sonnet-5-5`), so its provider prefix is who publishes it; a reseller
/// either leaves the field out or copies the canonical id across.
///
/// A subscription plan is never the vendor: `xiaomi-token-plan-cn`, `zhipuai-coding-plan`,
/// `tencent-tokenhub` are 包月 access sold under a vendor's name, priced at nothing because a
/// plan is not charged per token. Crediting one would make a plan the authority on a model's
/// list price.
fn vendor_rank(provider_id: &str, model: &Value) -> u8 {
    let canonical = normalize_model_key(
        model.get("canonical_model_id").and_then(Value::as_str).unwrap_or("").split('/').next().unwrap_or(""),
    );
    if canonical.is_empty() {
        return 0;
    }
    let provider = normalize_model_key(provider_id);
    if provider == canonical {
        return 2;
    }
    if is_subscription_plan(&provider) {
        return 0;
    }
    u8::from(provider.starts_with(&canonical))
}

fn is_subscription_plan(provider_id: &str) -> bool {
    // The suffix is the whole signal; the catalog has no field for it, and these three shapes
    // accounted for every plan-shaped provider in it.
    provider_id.contains("-plan-")
        || provider_id.ends_with("-plan")
        || provider_id.contains("coding-plan")
        || provider_id.contains("token-plan")
        || provider_id.contains("tokenhub")
}

/// `/(?:^|-)plan(?:-|$)|coding-plan|token-plan|tokenhub/` over the normalized provider id.
fn _unused_plan_note() {}

/// What the model can do, independent of who sells it. Used only to rank entries that claim the
/// same id — never to decide what a model *is*.
fn capability(model: &Value, levels: Option<&[ThinkingLevel]>, context: u64, mask: u64) -> u8 {
    let mut value = 0u8;
    if levels.is_some_and(|levels| !levels.is_empty()) {
        value += 8;
    }
    if model.get("reasoning").and_then(Value::as_bool) == Some(true) {
        value += 4;
    }
    value += mask.count_ones() as u8;
    if context >= 200_000 {
        value += 1;
    }
    value
}

/// The effort levels a model answers to, in the order we offer them — or the three the catalog
/// implies for a reasoning model that never lists any.
fn effort_levels(model: &Value) -> Option<Vec<ThinkingLevel>> {
    let values = model
        .get("reasoning_options")
        .and_then(Value::as_array)
        .and_then(|options| {
            options.iter().find(|option| option.get("type").and_then(Value::as_str) == Some("effort"))
        })
        .and_then(|option| option.get("values"))
        .and_then(Value::as_array);
    if let Some(values) = values {
        let names: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
        return Some(
            EFFORT_ORDER
                .iter()
                .copied()
                .filter(|level| names.contains(&effort_name(*level)))
                .collect(),
        );
    }
    (model.get("reasoning").and_then(Value::as_bool) == Some(true))
        .then(|| vec![ThinkingLevel::Low, ThinkingLevel::Medium, ThinkingLevel::High])
}

/// Per-million prices, or `None` when the catalog has no pricing — or only zeros, which carries
/// no information and would bill every turn at nothing.
fn to_cost(cost: Option<&Value>) -> Option<Cost> {
    let cost = cost.and_then(Value::as_object)?;
    let base = [
        non_negative(cost.get("input")),
        non_negative(cost.get("output")),
        non_negative(cost.get("cache_read")),
        non_negative(cost.get("cache_write")),
    ];
    if !base.iter().any(|value| *value > 0.0) {
        return None;
    }
    Some(Cost { base, tiers: to_tiers(cost, base) })
}

/// The context ladder, normalised to full four-field rows. A tier that omits a field (the
/// `cache_write` most Anthropic rows leave out) keeps the entry price for it rather than reading
/// as free. `context_over_200k` is the older single-threshold spelling of the same thing and is
/// only consulted for models the catalog has not moved to `tiers`.
fn to_tiers(cost: &Map<String, Value>, base: [f64; 4]) -> Vec<[f64; 5]> {
    let mut rows: Vec<[f64; 5]> = Vec::new();
    if let Some(tiers) = cost.get("tiers").and_then(Value::as_array) {
        for tier in tiers {
            let over = tier.get("size").and_then(|s| s.get("tier")).and_then(Value::as_f64);
            let Some(over) = else { continue };
            if over > 0.0 {
                rows.push(tier_row(tier, base, over));
            }
        }
    } else if let Some(over_200k) = cost.get("context_over_200k").and_then(Value::as_object) {
        rows.push(tier_row(
            &Value::Object(over_200k.clone()),
            base,
            200_000.0,
        ));
    }
    rows.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(Ordering::Equal));
    rows
}

fn tier_row(price: &Value, base: [f64; 4], over: f64) -> [f64; 5] {
    let field = |name: &str| price_or_null(price.get(name), base);
    [over, field("input"), field("output"), field("cache_read"), field("cache_write")]
}

fn price_or_null(value: Option<&Value>, fallback: f64) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n >= 0.0 => n,
        _ => fallback,
    }
}

fn positive(value: Option<&Value>) -> u64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n.floor() as u64,
        _ => 0,
    }
}

fn non_negative(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n,
        _ => 0.0,
    }
}

fn strip_date(key: &str) -> String {
    let Some((head, tail)) = key.rsplit_once('-') else { return String::new() };
    if tail.bytes().all(|b| b.is_ascii_digit()) && (4..=8).contains(&tail.len()) {
        head.to_owned()
    } else {
        String::new()
    }
}

/// The window a fold's winner implies, for callers that want the same clamp the decoder applies.
pub fn context_window(model: &Value) -> u32 {
    default_context_window(
        positive(model.get("limit").and_then(|l| l.get("context")) as u32),
        &super::meta::Vec_of_tiers(model),
    )
}

#[allow(unused_imports)]
use decode_input as _input_rule_documented_elsewhere;
