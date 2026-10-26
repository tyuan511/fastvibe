//! Usage is a query over raw ledger records, never over a conversation's active branch.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use chrono::{DateTime, Days, NaiveDate, Utc};
use chrono_tz::Tz;
use fv_protocol::usage::*;
use fv_protocol::{ErrorObject, jsonrpc::code};
use fv_store::UsageRecord;

use crate::state::ServerState;

pub async fn collect(
    state: Arc<ServerState>,
    params: UsageParams,
) -> Result<UsageStats, ErrorObject> {
    let zone: Tz = params
        .timezone
        .parse()
        .map_err(|_| ErrorObject::new(code::INVALID_PARAMS, "Unknown IANA timezone"))?;
    tokio::task::spawn_blocking(move || {
        state.store.transcripts.capture_usage()?;
        let records = state.store.db.usage_records()?;
        let threads = state.store.db.list_threads(true)?;
        let providers = state.store.db.list_providers()?;
        Ok::<_, fv_store::StoreError>(aggregate(
            &records,
            &threads,
            &state.catalog,
            &providers,
            params.range,
            zone,
            crate::state::now_ms(),
        ))
    })
    .await
    .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?
    .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))
}

fn date(at: i64, zone: Tz) -> Option<NaiveDate> {
    DateTime::<Utc>::from_timestamp_millis(at).map(|d| d.with_timezone(&zone).date_naive())
}

fn add(to: &mut UsageMetrics, record: &UsageRecord, cost: Option<f64>) {
    let usage = &record.usage;
    to.input = to.input.saturating_add(usage.input_tokens);
    to.output = to.output.saturating_add(usage.output_tokens);
    to.cache_read = to.cache_read.saturating_add(usage.cache_read_tokens);
    to.cache_write = to.cache_write.saturating_add(usage.cache_write_tokens);
    to.tokens = to.tokens.saturating_add(
        usage
            .input_tokens
            .saturating_add(usage.output_tokens)
            .saturating_add(usage.cache_read_tokens)
            .saturating_add(usage.cache_write_tokens),
    );
    to.requests = to.requests.saturating_add(1);
    to.tool_calls = to.tool_calls.saturating_add(record.tool_calls);
    if let Some(cost) = cost {
        let sum = to.cost.unwrap_or(0.0) + cost;
        to.cost = Some(if sum.is_finite() { sum } else { f64::MAX });
    } else {
        to.unpriced_requests = to.unpriced_requests.saturating_add(1);
    }
}

fn price(catalog: &fv_provider::Catalog, record: &UsageRecord) -> Option<f64> {
    let u = &record.usage;
    u.input_tokens
        .checked_add(u.output_tokens)?
        .checked_add(u.cache_read_tokens)?
        .checked_add(u.cache_write_tokens)?;
    fv_provider::message_cost(catalog, record.model.as_deref(), u)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

fn aggregate(
    records: &[UsageRecord],
    threads: &[fv_protocol::types::Thread],
    catalog: &fv_provider::Catalog,
    providers: &[fv_store::StoredProvider],
    range: UsageRange,
    zone: Tz,
    now: i64,
) -> UsageStats {
    let today = date(now, zone).unwrap_or(NaiveDate::from_ymd_opt(1970, 1, 1).unwrap());
    let dated: Vec<_> = records
        .iter()
        .filter_map(|r| date(r.at, zone).map(|d| (r, d)))
        .collect();
    let span = match range {
        UsageRange::Week => 7,
        UsageRange::Month => 30,
        UsageRange::Quarter => 90,
        UsageRange::Year | UsageRange::All => 365,
    };
    let from = if range == UsageRange::All {
        dated
            .iter()
            .filter(|(_, d)| *d <= today)
            .map(|(_, d)| *d)
            .min()
    } else {
        None
    }
    .unwrap_or_else(|| today.checked_sub_days(Days::new(span - 1)).unwrap_or(today));
    let thread_map: HashMap<_, _> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut totals = UsageTotals::default();
    let mut days = BTreeMap::<NaiveDate, UsageMetrics>::new();
    let mut models =
        BTreeMap::<(String, String), (UsageMetrics, BTreeMap<NaiveDate, UsageMetrics>)>::new();
    let mut conversations = BTreeMap::<String, UsageConversation>::new();
    let mut session_times = HashMap::<String, (i64, i64)>::new();
    for &(record, day) in &dated {
        if day < from || day > today {
            continue;
        }
        let cost = price(catalog, record);
        add(&mut totals.metrics, record, cost);
        add(days.entry(day).or_default(), record, cost);
        let label = record.model.as_deref().unwrap_or("unknown/unknown");
        let (provider, model) = label.split_once('/').unwrap_or(("unknown", label));
        let model = models.entry((provider.into(), model.into())).or_default();
        add(&mut model.0, record, cost);
        add(model.1.entry(day).or_default(), record, cost);
        let id = &record.origin.thread_id;
        let conversation = conversations.entry(id.clone()).or_insert_with(|| {
            let thread = thread_map.get(id.as_str());
            UsageConversation {
                session_id: id.clone(),
                thread_id: thread.map(|t| t.id.clone()),
                title: thread.map(|t| t.title.clone()),
                project: thread.and_then(|t| t.project.clone()),
                metrics: Default::default(),
            }
        });
        add(&mut conversation.metrics, record, cost);
        session_times
            .entry(id.clone())
            .and_modify(|times| {
                times.0 = times.0.min(record.at);
                times.1 = times.1.max(record.at);
            })
            .or_insert((record.at, record.at));
    }
    let active: BTreeSet<_> = days.keys().copied().collect();
    totals.active_days = active.len() as u64;
    let mut current_streak = 0;
    let mut cursor = today;
    while active.contains(&cursor) {
        current_streak += 1;
        let Some(previous) = cursor.pred_opt() else {
            break;
        };
        cursor = previous;
    }
    let (mut longest_streak, mut run, mut previous) = (0, 0, None);
    for &day in &active {
        run = if previous.and_then(|d: NaiveDate| d.succ_opt()) == Some(day) {
            run + 1
        } else {
            1
        };
        longest_streak = longest_streak.max(run);
        previous = Some(day);
    }
    let to_days = |days: BTreeMap<NaiveDate, UsageMetrics>| {
        days.into_iter()
            .map(|(date, metrics)| UsageDay {
                date: date.to_string(),
                metrics,
            })
            .collect()
    };
    let mut models: Vec<_> = models
        .into_iter()
        .map(|((provider, model), (metrics, days))| UsageModel {
            provider_name: providers
                .iter()
                .find(|p| p.id == provider)
                .map(|p| p.name.clone()),
            provider,
            model,
            metrics,
            days: to_days(days),
        })
        .collect();
    models.sort_by(|a, b| {
        b.metrics
            .tokens
            .cmp(&a.metrics.tokens)
            .then_with(|| a.provider.cmp(&b.provider))
            .then_with(|| a.model.cmp(&b.model))
    });
    let mut conversations: Vec<_> = conversations.into_values().collect();
    conversations.sort_by(|a, b| {
        b.metrics
            .cost
            .unwrap_or(0.0)
            .total_cmp(&a.metrics.cost.unwrap_or(0.0))
            .then_with(|| b.metrics.tokens.cmp(&a.metrics.tokens))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    UsageStats {
        range,
        timezone: zone.name().into(),
        from: from.to_string(),
        to: today.to_string(),
        totals,
        days: to_days(days),
        models,
        conversations,
        sessions: session_times.len() as u64,
        longest_session_minutes: session_times
            .values()
            .map(|(a, b)| b.saturating_sub(*a) as f64 / 60_000.0)
            .fold(0.0, f64::max),
        current_streak,
        longest_streak,
        invalid_timestamps: (records.len() - dated.len()) as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::aggregate;
    use fv_core::Usage;
    use fv_protocol::usage::UsageRange;
    use fv_store::{UsageOrigin, UsageRecord};
    fn at(value: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
    }
    fn record(id: &str, at: i64) -> UsageRecord {
        UsageRecord {
            origin: UsageOrigin {
                thread_id: "thread".into(),
                entry_id: id.into(),
            },
            at,
            model: Some("p/m".into()),
            usage: Usage {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
            },
            tool_calls: 1,
        }
    }

    #[test]
    fn viewer_timezone_dst_date_windows_and_streaks_use_calendar_days() {
        let records = [
            record("old", at("2026-03-01T12:00:00Z")),
            record("before", at("2026-03-08T04:30:00Z")),
            record("after", at("2026-03-09T03:30:00Z")),
            record("future", at("2026-03-10T12:00:00Z")),
        ];
        let now = at("2026-03-09T03:59:00Z");
        let catalog = fv_provider::Catalog::default();
        let stats = aggregate(
            &records,
            &[],
            &catalog,
            &[],
            UsageRange::Week,
            chrono_tz::America::New_York,
            now,
        );
        assert_eq!(
            (stats.from.as_str(), stats.to.as_str()),
            ("2026-03-02", "2026-03-08")
        );
        assert_eq!(stats.totals.metrics.requests, 2);
        assert_eq!(
            (stats.current_streak, stats.longest_streak, stats.sessions),
            (2, 2, 1)
        );
        assert_eq!(stats.longest_session_minutes, 23.0 * 60.0);
        assert_eq!(
            stats
                .days
                .iter()
                .map(|d| d.date.as_str())
                .collect::<Vec<_>>(),
            ["2026-03-07", "2026-03-08"]
        );
        assert_eq!(stats.totals.metrics.tokens, 38);
        assert_eq!(stats.totals.metrics.cost, None);
        assert_eq!(stats.totals.metrics.unpriced_requests, 2);
        let all = aggregate(
            &records,
            &[],
            &catalog,
            &[],
            UsageRange::All,
            chrono_tz::Asia::Shanghai,
            now,
        );
        assert_eq!(all.from, "2026-03-01");
        assert_eq!(all.totals.metrics.requests, 3);
        assert_eq!(all.days.last().unwrap().date, "2026-03-09");
    }

    #[test]
    fn prices_are_recomputed_per_request_with_cache_tiers_and_unknown_costs_stay_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = |factor: f64| {
            std::fs::write(dir.path().join("models-dev.json"), serde_json::json!({"v":4,"m":[["p/m","M",1000000,4096,0,null,[2.0*factor,10.0*factor,0.2*factor,0.4*factor,[[200000,4.0*factor,20.0*factor,0.4*factor,0.8*factor]]]]],"x":{"p-m":0,"m":0}}).to_string()).unwrap();
            fv_provider::load_catalog(dir.path())
        };
        let now = at("2026-10-26T00:00:00Z");
        let mut first = record("one", now);
        first.usage = Usage {
            input_tokens: 150000,
            output_tokens: 1000,
            cache_read_tokens: 50000,
            cache_write_tokens: 0,
        };
        let mut second = first.clone();
        second.origin.entry_id = "two".into();
        second.usage.input_tokens += 1;
        let mut unknown = record("three", now);
        unknown.model = Some("missing/unknown".into());
        let records = [first, second, unknown];
        let stats = aggregate(
            &records,
            &[],
            &catalog(1.0),
            &[],
            UsageRange::All,
            chrono_tz::UTC,
            now,
        );
        assert!((stats.totals.metrics.cost.unwrap() - 0.960004).abs() < 1e-10);
        assert_eq!(stats.totals.metrics.unpriced_requests, 1);
        let repriced = aggregate(
            &records,
            &[],
            &catalog(2.0),
            &[],
            UsageRange::All,
            chrono_tz::UTC,
            now,
        );
        assert!((repriced.totals.metrics.cost.unwrap() - 1.920008).abs() < 1e-10);
        assert_eq!(repriced.totals.metrics.tokens, stats.totals.metrics.tokens);
    }

    #[test]
    fn empty_invalid_and_extreme_records_do_not_panic_or_invent_a_zero_price() {
        let now = at("2026-10-26T00:00:00Z");
        let catalog = fv_provider::Catalog::default();
        let empty = aggregate(
            &[],
            &[],
            &catalog,
            &[],
            UsageRange::All,
            chrono_tz::UTC,
            now,
        );
        assert_eq!(empty.totals.metrics.requests, 0);
        assert_eq!(empty.totals.metrics.cost, None);
        assert_eq!(empty.current_streak, 0);
        let mut big = record("large", now);
        big.usage.input_tokens = u64::MAX;
        let invalid = record("invalid", i64::MAX);
        let stats = aggregate(
            &[big, invalid],
            &[],
            &catalog,
            &[],
            UsageRange::Week,
            chrono_tz::UTC,
            now,
        );
        assert_eq!(stats.totals.metrics.tokens, u64::MAX);
        assert_eq!(stats.invalid_timestamps, 1);
        assert_eq!(stats.totals.metrics.cost, None);
        assert!(serde_json::to_string(&stats).is_ok());
    }
}
