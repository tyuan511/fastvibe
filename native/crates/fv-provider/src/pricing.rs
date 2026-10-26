//! What a turn costs, in US dollars, from the model's own price ladder.
//!
//! The engine prices a request with one flat rate; models.dev splits some models at a context
//! threshold ("over 200K tokens costs 2×"), so the step has to be picked from the request's own
//! prompt size. That is all this does: the same `tokens × price` arithmetic, one tier at a time.
//!
//! `None` means the catalog has no price for the model, which is not the same as free — the
//! panel then shows `—` rather than `$0.000`.

use fv_core::Usage;

use crate::models_dev::{Catalog, Price, PriceTier};

/// The tier a request is billed at. The threshold is measured on the whole prompt — the uncached
/// input plus both cache buckets — which is what an upstream means by "context over N". An empty
/// ladder leaves the entry price in place.
pub fn select_price(price: Price, tiers: &[PriceTier], usage: &Usage) -> Price {
    let prompt = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    let mut selected = price;
    for tier in tiers {
        if prompt <= tier.over {
            break;
        }
        selected = tier.price;
    }
    selected
}

/// What one assistant message cost, or `None` when the model has no published price.
pub fn price_message(price: Price, tiers: &[PriceTier], usage: &Usage) -> Option<f64> {
    if usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens
        == 0
    {
        return None;
    }
    let rate = select_price(price, tiers, usage);
    Some(
        (rate.input * usage.input_tokens as f64
            + rate.output * usage.output_tokens as f64
            + rate.cache_read * usage.cache_read_tokens as f64
            + rate.cache_write * usage.cache_write_tokens as f64)
            / 1_000_000.0,
    )
}

/// The same arithmetic for a reply a transcript holds, which carries its own model label. A
/// message with no label, or one the catalog does not price, contributes nothing — an install
/// that never configured a price must not show `$0.000` as if it had measured it.
pub fn message_cost(catalog: &Catalog, label: Option<&str>, usage: &Usage) -> Option<f64> {
    let (price, tiers) = catalog.price(label?)?;
    price_message(*price, tiers, usage)
}

/// A whole conversation's cost, from the messages that are still on its branch.
pub fn history_cost(catalog: &Catalog, history: &[fv_core::Message]) -> Option<f64> {
    let mut total = 0.0f64;
    let mut priced = false;
    let mut add = |label: Option<&str>, usage: &Usage| {
        if let Some(cost) = message_cost(catalog, label, usage) {
            total += cost;
            priced = true;
        }
    };
    for message in history {
        match message {
            fv_core::Message::Assistant(a) => add(a.model.as_deref(), &a.usage),
            fv_core::Message::Compaction { usage, model, .. } => add(model.as_deref(), usage),
            _ => {}
        }
    }
    priced.then_some(total)
}

#[cfg(test)]
mod tests {
    use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};

    use super::*;

    fn price(input: f64, output: f64, read: f64, write: f64) -> Price {
        Price {
            input,
            output,
            cache_read: read,
            cache_write: write,
        }
    }

    fn usage(input: u64, output: u64, read: u64, write: u64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: read,
            cache_write_tokens: write,
        }
    }

    #[test]
    fn the_prompt_size_picks_the_step() {
        let base = price(2.0, 12.0, 0.2, 0.4);
        let dearer = price(4.0, 18.0, 0.4, 0.8);
        let tiers = vec![PriceTier {
            over: 200_000,
            price: dearer,
        }];
        // Exactly at the threshold is still the entry step: "over 200K" is a strict bound.
        assert_eq!(
            select_price(base, &tiers, &usage(150_000, 0, 50_000, 0)),
            base
        );
        assert_eq!(
            select_price(base, &tiers, &usage(150_001, 0, 50_000, 0)),
            dearer
        );
        // An empty ladder never changes the rate.
        assert_eq!(select_price(base, &[], &usage(10, 10, 0, 0)), base);
    }

    #[test]
    fn a_message_without_tokens_or_without_a_price_costs_nothing_known() {
        let base = price(2.0, 12.0, 0.2, 0.4);
        assert_eq!(price_message(base, &[], &usage(0, 0, 0, 0)), None);
        let catalog = Catalog::empty("test", false);
        assert_eq!(
            message_cost(&catalog, Some("p/m"), &usage(1, 1, 0, 0)),
            None
        );
        assert_eq!(message_cost(&catalog, None, &usage(1, 1, 0, 0)), None);
    }

    #[test]
    fn the_whole_bill_is_per_million_on_each_bucket() {
        let base = price(2.0, 12.0, 0.2, 0.4);
        let cost = price_message(
            base,
            &[],
            &usage(1_000_000, 1_000_000, 1_000_000, 1_000_000),
        )
        .unwrap();
        assert!((cost - (2.0 + 12.0 + 0.2 + 0.4)).abs() < 1e-9);
    }

    #[test]
    fn an_unpriceable_turn_does_not_drag_a_measured_one_to_zero() {
        let message = Message::Assistant(AssistantMessage {
            duration_ms: None,
            content: vec![ContentBlock::Text { text: "x".into() }],
            stop: StopReason::Stop,
            usage: usage(10, 10, 0, 0),
            model: Some("p/m".into()),
        });
        let catalog = Catalog::empty("test", false);
        assert_eq!(history_cost(&catalog, &[message]), None);
    }
}
