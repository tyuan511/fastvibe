//! What one model is, according to [models.dev](https://models.dev): its context window, its
//! output ceiling, what it can look at, how hard it can be asked to think, and what it costs.
//!
//! The data is a compact snapshot, not the upstream catalog: `m` holds one entry per model as a
//! tuple and `x` maps every alias to that entry's position, so a lookup is one hash hit. The same
//! format is written by `scripts/models-dev-encode.mjs` at build time and read by
//! `src/main/engine/models-dev.ts` in the Electron app; this is the other implementation of it,
//! and it decodes snapshots written by either.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ThinkingLevel;

/// What a model falls back to when no catalog describes it: usable limits, not the provider's.
pub const DEFAULT_CONTEXT: u32 = 128_000;
pub const DEFAULT_MAX_TOKENS: u32 = 8_192;

const EFFORT_ORDER: [ThinkingLevel; 6] = [
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];

/// text=1 image=2 video=4 file=8, as the snapshot packs them.
const INPUT_BITS: [(InputModality, u64); 4] = [
    (InputModality::Text, 1),
    (InputModality::Image, 2),
    (InputModality::Video, 4),
    (InputModality::File, 8),
];

/// Per-million-token prices in US dollars. A model the catalog does not price is `None`,
/// which is not the same as being free.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// The step a long prompt is billed at: `over` tokens of context, then this price.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PriceTier {
    pub over: u64,
    pub price: Price,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputModality {
    Text,
    Image,
    Video,
    File,
}

impl InputModality {
    pub fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Video => "video",
            Self::File => "file",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        // The catalog lists documents and audio under what a chat model reads them as.
        match name {
            "text" => Some(Self::Text),
            "image" => Some(Self::Image),
            "video" => Some(Self::Video),
            "file" | "pdf" | "audio" => Some(Self::File),
            _ => None,
        }
    }
}

/// A catalog entry: everything FastVibe asks a model about.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelMeta {
    /// Already clamped to the first price step, so the window guard and the bill agree.
    pub context_window: u32,
    pub max_tokens: u32,
    pub reasoning: bool,
    pub input: Vec<InputModality>,
    /// The effort levels this model answers to, weakest first. Empty means the catalog does
    /// not say, which is not the same as "cannot think".
    pub thinking_levels: Vec<ThinkingLevel>,
    pub price: Option<Price>,
    pub price_tiers: Vec<PriceTier>,
}

/// A model the catalog does not describe still needs limits, and a guess the window guard can
/// live with beats nothing: what an unknown id gets instead of being rejected.
pub fn default_meta() -> ModelMeta {
    ModelMeta {
        context_window: DEFAULT_CONTEXT,
        max_tokens: DEFAULT_MAX_TOKENS,
        reasoning: false,
        input: vec![InputModality::Text],
        thinking_levels: Vec::new(),
        price: None,
        price_tiers: Vec::new(),
    }
}

#[derive(Clone, Debug)]
pub struct CatalogEntry {
    /// What models.dev calls it, provider prefix included.
    pub id: String,
    pub name: String,
    pub meta: ModelMeta,
}

/// Which catalog is in use, for a client that has to say so.
#[derive(Clone, Debug, Default)]
pub struct CatalogStats {
    pub models: usize,
    pub aliases: usize,
    /// When the snapshot was written, epoch ms; 0 when there is none.
    pub generated_at: u64,
    /// Where it came from — the upstream URL.
    pub source: String,
    /// What is being read: the refreshed file, or the copy built into the binary.
    pub path: String,
    /// Whether the snapshot in use is the one embedded at build time.
    pub bundled: bool,
}

pub struct Catalog {
    entries: Vec<CatalogEntry>,
    aliases: HashMap<String, usize>,
    stats: CatalogStats,
    signature: Option<String>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::empty("", false)
    }
}

impl Catalog {
    pub fn empty(path: impl Into<String>, bundled: bool) -> Self {
        Self {
            entries: Vec::new(),
            aliases: HashMap::new(),
            stats: CatalogStats {
                path: path.into(),
                bundled,
                ..Default::default()
            },
            signature: None,
        }
    }

    pub fn stats(&self) -> &CatalogStats {
        &self.stats
    }

    /// The catalog's identity, for the `changed` answer to a refresh. `None` when nothing is
    /// loaded, which every refresh is therefore free to call a change.
    pub fn signature(&self) -> Option<&str> {
        self.signature.as_deref()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Find an entry by any of the names it answers to: the full id as written, the same id
    /// without a date suffix, and the last segment of a namespaced one.
    pub fn entry(&self, id: &str) -> Option<&CatalogEntry> {
        let norm = normalize_model_key(id);
        let last = id.rsplit('/').next().unwrap_or("");
        for key in [norm.clone(), strip_date(&norm), normalize_model_key(last)] {
            if key.is_empty() {
                continue;
            }
            if let Some(index) = self
                .aliases
                .get(&key)
                .copied()
                .and_then(|i| self.entries.get(i))
            {
                return Some(index);
            }
        }
        None
    }

    /// What the catalog says about `id`, or nothing when it does not describe it.
    pub fn describe(&self, id: &str) -> Option<&ModelMeta> {
        self.entry(id).map(|entry| &entry.meta)
    }

    /// The price of a model by its own id or by its `provider/model` label. `None` means the
    /// catalog is silent about it, not that it is free.
    pub fn price(&self, id: &str) -> Option<(&Price, &[PriceTier])> {
        let meta = self.describe(id)?;
        meta.price
            .as_ref()
            .map(|price| (price, &meta.price_tiers[..]))
    }
}

/// The file a refreshed snapshot lives in, beside the database. The name matches the one
/// the Electron app writes into its own data directory.
pub fn local_snapshot_path(data_dir: &Path) -> PathBuf {
    data_dir.join("models-dev.json")
}

/// The copy built into this binary, when the build found one to embed.
pub fn bundled_snapshot() -> Option<&'static [u8]> {
    mod embedded {
        include!(concat!(env!("OUT_DIR"), "/models_dev_bundled.rs"));
    }
    (!embedded::MODELS_DEV_BUNDLED.is_empty()).then_some(embedded::MODELS_DEV_BUNDLED)
}

/// The catalog to use, read the way the Electron app reads it: the snapshot this machine
/// pulled wins over the one the build shipped with, and a local file that cannot be read or
/// decoded falls back to the bundled copy rather than costing the app its metadata — the
/// bundled index is the copy a build verified.
pub fn load_catalog(data_dir: &Path) -> Catalog {
    load_from(&local_snapshot_path(data_dir))
}

fn load_from(local: &Path) -> Catalog {
    if let Ok(text) = std::fs::read_to_string(local)
        && let Some(catalog) = read_snapshot(&text, local.display().to_string(), false)
    {
        return catalog;
    }
    if let Some(bundled) = bundled_snapshot()
        && let Some(catalog) = read_snapshot(
            &String::from_utf8_lossy(bundled),
            "built into this app".to_string(),
            true,
        )
    {
        return catalog;
    }
    Catalog::empty("", false)
}

/// Decode a snapshot's JSON. `None` for anything unreadable or with no models in it, which is
/// how a half-written file stops being trusted instead of being half-believed.
pub fn read_snapshot(text: &str, path: String, bundled: bool) -> Option<Catalog> {
    let value: Value = serde_json::from_str(text).ok()?;
    read_value(value, path, bundled)
}

pub fn read_value(value: Value, path: String, bundled: bool) -> Option<Catalog> {
    let version = value
        .get("v")
        .and_then(natural)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0);
    let tuples = value.get("m")?.as_array()?;
    if tuples.is_empty() {
        return None;
    }
    let entries: Vec<CatalogEntry> = tuples
        .iter()
        .map(|tuple| decode_entry(tuple, version))
        .collect();
    let mut aliases = HashMap::new();
    if let Some(map) = value.get("x").and_then(Value::as_object) {
        for (alias, index) in map {
            // An alias pointing past the end is a truncated write: drop that one name rather
            // than the catalog, and let the rest of the file still answer.
            if let Some(index) = natural(index)
                .and_then(|i| usize::try_from(i).ok())
                .filter(|i| *i < entries.len())
            {
                aliases.insert(alias.clone(), index);
            }
        }
    }
    let stats = CatalogStats {
        models: entries.len(),
        aliases: aliases.len(),
        generated_at: value.get("t").and_then(natural).unwrap_or(0),
        source: value
            .get("s")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        path,
        bundled,
    };
    Some(Catalog {
        entries,
        aliases,
        stats,
        signature: Some(snapshot_signature_of(&value)),
    })
}

/// `[v, m, x]`, serialized by this crate so both sources compare on the same terms: the file
/// the build script wrote and the one a refresh writes here parse to the same signature.
pub fn snapshot_signature_of(value: &Value) -> String {
    let picked = Value::Array(vec![
        value.get("v").cloned().unwrap_or(Value::Null),
        value.get("m").cloned().unwrap_or(Value::Null),
        value.get("x").cloned().unwrap_or(Value::Null),
    ]);
    serde_json::to_string(&canonical(&picked)).unwrap_or_default()
}

// Alias object order and integral JSON number spellings have no semantic meaning. Both encoders
// use this identity, so a JavaScript-written index and a Rust-written one need not rebind models.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        Value::Object(m) => {
            let ordered = m.iter().collect::<std::collections::BTreeMap<_, _>>();
            Value::Object(
                ordered
                    .into_iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect(),
            )
        }
        Value::Number(n) if n.is_f64() => {
            let f = n.as_f64().unwrap();
            if (0.0..=9_007_199_254_740_991.0).contains(&f) && f.fract() == 0.0 {
                Value::from(f as u64)
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

fn field(tuple: &Value, index: usize) -> Option<&Value> {
    tuple.as_array()?.get(index)
}

fn decode_entry(tuple: &Value, version: u32) -> CatalogEntry {
    // Where `cost` sits: a `v <= 3` snapshot keeps the retired feature bitmask in the slot the
    // price occupies from v4 on, so reading by version stops a stale file from decoding a mask
    // as dollars.
    let cost_slot = if version >= 4 { 6 } else { 7 };
    let thinking_levels = decode_efforts(field(tuple, 5));
    let (price, price_tiers) = decode_cost(field(tuple, cost_slot));
    let context = positive(field(tuple, 2)) as u32;
    let max = positive(field(tuple, 3)) as u32;
    CatalogEntry {
        id: text(field(tuple, 0)).unwrap_or_default().to_owned(),
        name: text(field(tuple, 1)).unwrap_or_default().to_owned(),
        meta: ModelMeta {
            context_window: default_context_window(context, &price_tiers),
            max_tokens: if max > 0 { max } else { DEFAULT_MAX_TOKENS },
            reasoning: !thinking_levels.is_empty(),
            input: decode_input(positive(field(tuple, 4))),
            thinking_levels,
            price,
            price_tiers,
        },
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn decode_input(mask: u64) -> Vec<InputModality> {
    let input: Vec<InputModality> = INPUT_BITS
        .iter()
        .filter(|(_, bit)| mask & bit != 0)
        .map(|(kind, _)| *kind)
        .collect();
    if input.is_empty() {
        vec![InputModality::Text]
    } else {
        input
    }
}

/// Translate the catalog's effort values into the levels FastVibe offers.
///
/// `off` is deliberately absent: it is not a capability the catalog reports but the absence of
/// thinking, and FastVibe never asks for it, because an upstream whose model reasons by default
/// rejects the parameter. The levels come back ordered weakest-first however the snapshot lists
/// them.
fn decode_efforts(levels: Option<&Value>) -> Vec<ThinkingLevel> {
    let Some(Value::Array(levels)) = levels else {
        return Vec::new();
    };
    let mut seen: Vec<ThinkingLevel> = Vec::new();
    for raw in levels {
        let Some(name) = raw.as_str() else { continue };
        let Some(level) = EFFORT_ORDER
            .iter()
            .copied()
            .find(|level| effort_name(*level) == name)
        else {
            continue;
        };
        if !seen.contains(&level) {
            seen.push(level);
        }
    }
    seen.sort_by_key(|level| {
        EFFORT_ORDER
            .iter()
            .position(|known| known == level)
            .unwrap_or(usize::MAX)
    });
    seen
}

fn decode_cost(cost: Option<&Value>) -> (Option<Price>, Vec<PriceTier>) {
    // A v1/v2 tuple ends after the four prices; v3 appended the long-context ladder.
    let Some(Value::Array(fields)) = cost.filter(|value| !value.is_null()) else {
        return (None, Vec::new());
    };
    if fields.len() < 4 {
        return (None, Vec::new());
    }
    let number = |index: usize| fields.get(index).and_then(Value::as_f64).unwrap_or(0.0);
    let price = Price {
        input: number(0),
        output: number(1),
        cache_read: number(2),
        cache_write: number(3),
    };
    let tiers = fields
        .get(4)
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let row = row.as_array()?;
                    if row.len() < 5 {
                        return None;
                    }
                    let row_number =
                        |index: usize| row.get(index).and_then(Value::as_f64).unwrap_or(0.0);
                    Some(PriceTier {
                        over: row_number(0).max(0.0) as u64,
                        price: Price {
                            input: row_number(1),
                            output: row_number(2),
                            cache_read: row_number(3),
                            cache_write: row_number(4),
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (Some(price), tiers)
}

/// What a newly added model gets as its window: the catalog's, unless a price ladder starts
/// below it.
///
/// Long-context prices are usually split at a smaller first segment (200K tokens, then a dearer
/// rate). Keeping a model inside that first segment by default beats silently taking the
/// provider's full window and surprising the user with the higher price.
pub fn default_context_window(catalog_context: u32, tiers: &[PriceTier]) -> u32 {
    let context = if catalog_context > 0 {
        catalog_context
    } else {
        DEFAULT_CONTEXT
    };
    let Some(first) = tiers
        .iter()
        .map(|tier| tier.over)
        .filter(|over| *over > 0)
        .min()
    else {
        return context;
    };
    if catalog_context > 0 {
        context.min(first as u32)
    } else {
        first as u32
    }
}

/// Must stay identical to `normalize` in `scripts/models-dev-encode.mjs` and to
/// `normalizeModelKey` in the Electron app.
pub fn normalize_model_key(id: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for c in id.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if pending {
                out.push('-');
                pending = false;
            }
            out.push(c);
        } else if !out.is_empty() {
            pending = true;
        }
    }
    out
}

/// `claude-sonnet-4-5-20250929` without its date, or nothing when the key carries no date.
/// A run of 4 to 8 digits after the last hyphen and nothing else: a longer or shorter run is
/// part of the name, not a version.
fn strip_date(key: &str) -> String {
    let Some((head, tail)) = key.rsplit_once('-') else {
        return String::new();
    };
    if tail.bytes().all(|b| b.is_ascii_digit()) && (4..=8).contains(&tail.len()) {
        head.to_owned()
    } else {
        String::new()
    }
}

fn natural(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|n| (0.0..=9_007_199_254_740_991.0).contains(n) && n.fract() == 0.0)
            .map(|n| n as u64)
    })
}

fn positive(value: Option<&Value>) -> u64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n.floor() as u64,
        _ => 0,
    }
}

pub(crate) fn effort_name(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_ignores_update_age_alias_order_and_integral_number_spellings() {
        let a: Value = serde_json::from_str(
            r#"{"v":5,"t":1,"m":[["m","M",128000,8000,1,null,[2,10,0,0]]],"x":{"m":0,"alias":0}}"#,
        )
        .unwrap();
        let b: Value = serde_json::from_str(r#"{"v":5.0,"t":9999.0,"m":[["m","M",128000,8000,1,null,[2.0,10.0,0.0,0.0]]],"x":{"alias":0.0,"m":0.0}}"#).unwrap();
        assert_eq!(snapshot_signature_of(&a), snapshot_signature_of(&b));
        let decoded_a = read_value(a.clone(), "a".into(), false).unwrap();
        let decoded_b = read_value(b.clone(), "b".into(), false).unwrap();
        assert_eq!(decoded_a.price("alias"), decoded_b.price("alias"));
        assert!(
            decoded_b.price("alias").is_some(),
            "equivalent numbers also decode identically"
        );
        let mut changed = b.clone();
        changed["m"][0][6][0] = Value::from(2.1);
        assert_ne!(snapshot_signature_of(&a), snapshot_signature_of(&changed));
        changed = b;
        changed["x"]["alias"] = Value::from(1);
        assert_ne!(snapshot_signature_of(&a), snapshot_signature_of(&changed));
    }

    #[test]
    fn normalize_folds_separators_and_case() {
        assert_eq!(
            normalize_model_key("Claude-Sonnet 4.5"),
            "claude-sonnet-4-5"
        );
        assert_eq!(normalize_model_key("  a__b  "), "a-b");
        assert_eq!(normalize_model_key("---"), "");
        assert_eq!(normalize_model_key("zai-org/GLM-5.3"), "zai-org-glm-5-3");
    }

    #[test]
    fn strip_date_only_removes_a_real_date_suffix() {
        assert_eq!(
            strip_date("claude-sonnet-4-5-20250929"),
            "claude-sonnet-4-5"
        );
        assert_eq!(strip_date("llama-3-3-70b"), "");
        // Too few and too many digits are both part of the name.
        assert_eq!(strip_date("model-123"), "");
        assert_eq!(strip_date("model-123456789"), "");
        assert_eq!(strip_date("model-1234"), "model");
    }

    #[test]
    fn a_ladder_pulls_the_default_window_below_its_first_step() {
        let tiers = vec![PriceTier {
            over: 200_000,
            price: Price::default(),
        }];
        assert_eq!(default_context_window(1_000_000, &tiers), 200_000);
        assert_eq!(default_context_window(128_000, &tiers), 128_000);
        assert_eq!(default_context_window(0, &tiers), 200_000);
        assert_eq!(default_context_window(0, &[]), DEFAULT_CONTEXT);
    }

    fn catalog(m: Vec<Value>, x: Value) -> Catalog {
        catalog_v(5, m, x)
    }

    fn catalog_v(v: u32, m: Vec<Value>, x: Value) -> Catalog {
        read_value(
            serde_json::json!({ "v": v, "t": 7, "s": "https://models.dev/api.json", "m": m, "x": x }),
            "test".into(),
            false,
        )
        .unwrap()
    }

    #[test]
    fn efforts_are_ordered_deduplicated_and_limited_to_what_we_offer() {
        let catalog = catalog(
            vec![serde_json::json!([
                "p/m",
                "M",
                100_000,
                4_000,
                3,
                ["high", "off", "low", "high"],
                null
            ])],
            serde_json::json!({ "p-m": 0, "m": 0 }),
        );
        let meta = catalog.describe("p/m").unwrap();
        assert_eq!(
            meta.thinking_levels,
            vec![ThinkingLevel::Low, ThinkingLevel::High]
        );
        assert!(meta.reasoning);
        assert_eq!(meta.input, vec![InputModality::Text, InputModality::Image]);
        assert_eq!(meta.max_tokens, 4_000);
        assert!(meta.price.is_none());
        assert_eq!(meta.context_window, 100_000);
    }

    #[test]
    fn a_ladder_is_decoded_and_clamps_the_window() {
        let catalog = catalog(
            vec![serde_json::json!([
                "google/gemini-3.1-pro",
                "Gemini 3.1 Pro",
                1_048_576,
                65_536,
                15,
                ["low"],
                [2.0, 12.0, 0.2, 0.375, [[200_000, 4.0, 18.0, 0.4, 0.375]]]
            ])],
            serde_json::json!({ "gemini-3-1-pro": 0 }),
        );
        let meta = catalog.describe("gemini-3.1-pro").unwrap();
        assert_eq!(meta.context_window, 200_000);
        assert_eq!(meta.price.unwrap().input, 2.0);
        assert_eq!(meta.price_tiers.len(), 1);
        assert_eq!(meta.price_tiers[0].price.output, 18.0);
    }

    #[test]
    fn an_older_snapshot_version_reads_its_price_from_the_right_slot() {
        // v3 kept the feature bitmask at index 6 and the price at 7.
        let catalog = catalog_v(
            3,
            vec![serde_json::json!([
                "p/m",
                "M",
                100,
                200,
                1,
                null,
                0,
                [1.0, 2.0, 0.1, 0.2]
            ])],
            serde_json::json!({ "p-m": 0 }),
        );
        let meta = catalog.describe("p/m").unwrap();
        assert_eq!(
            meta.price,
            Some(Price {
                input: 1.0,
                output: 2.0,
                cache_read: 0.1,
                cache_write: 0.2
            })
        );
    }

    #[test]
    fn a_lookup_tries_the_whole_id_its_date_then_its_last_segment() {
        let catalog = catalog(
            vec![serde_json::json!([
                "anthropic/claude-sonnet-4.5-20250929",
                "Sonnet",
                200_000,
                8_000,
                3,
                ["low"],
                null
            ])],
            serde_json::json!({
                "anthropic-claude-sonnet-4-5-20250929": 0,
                "anthropic-claude-sonnet-4-5": 0,
                "claude-sonnet-4-5-20250929": 0,
                "claude-sonnet-4-5": 0
            }),
        );
        for id in [
            "anthropic/claude-sonnet-4.5-20250929",
            "claude-sonnet-4.5",
            "claude-sonnet-4-5-20250929",
        ] {
            assert_eq!(
                catalog.describe(id).map(|m| m.context_window),
                Some(200_000),
                "{id}"
            );
        }
        assert!(catalog.describe("gpt-9").is_none());
    }

    #[test]
    fn a_corrupt_local_file_falls_back_to_the_bundled_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models-dev.json");
        std::fs::write(&path, "{ \"m\": [").unwrap();
        let catalog = load_from(&path);
        // Whether the build embedded anything decides the answer; what must not happen is a
        // half-read file being believed, or the bundled copy being discarded for it.
        assert_eq!(catalog.is_empty(), bundled_snapshot().is_none());
        std::fs::remove_file(&path).unwrap();
        assert_eq!(load_from(&path).is_empty(), bundled_snapshot().is_none());
    }

    /// The snapshot this build carries, if the build found one: it has to decode, and the ids
    /// the app actually meets have to be in it.
    #[test]
    fn the_bundled_snapshot_decodes() {
        let Some(bytes) = bundled_snapshot() else {
            return;
        };
        let catalog = read_snapshot(&String::from_utf8_lossy(bytes), "bundled".into(), true)
            .expect("the embedded snapshot decodes");
        assert!(catalog.len() > 1_000, "{} models", catalog.len());
        assert_eq!(catalog.stats().models, catalog.len());
        assert!(catalog.stats().bundled);
        for id in [
            "claude-sonnet-5",
            "gpt-5.1",
            "deepseek-v3.2",
            "gemini-2.5-pro",
        ] {
            assert!(
                catalog.describe(id).is_some(),
                "{id} is not in the bundled snapshot"
            );
        }
    }
}
