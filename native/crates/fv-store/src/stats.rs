use fv_core::{Message, Usage};
use fv_protocol::types::{RequestUsage, SessionStats, TokenCounts};

fn add(to: &mut TokenCounts, usage: &Usage) {
    to.input = to.input.saturating_add(usage.input_tokens);
    to.output = to.output.saturating_add(usage.output_tokens);
    to.cache_read = to.cache_read.saturating_add(usage.cache_read_tokens);
    to.cache_write = to.cache_write.saturating_add(usage.cache_write_tokens);
}

/// Fold one committed message into the stats. `after_compaction` is the caller's memory of
/// whether the previous message was a summary: the answer a compaction carries over is
/// committed again right after it, and that copy is not a request the model made.
pub fn record_stats(stats: &mut SessionStats, message: &Message, after_compaction: &mut bool) {
    let carried = std::mem::replace(
        after_compaction,
        matches!(message, Message::Compaction { .. }),
    );
    let usage = match message {
        Message::User { .. } => {
            stats.turn = Some(TokenCounts::default());
            return;
        }
        Message::Assistant(_) if carried => return,
        Message::Assistant(a) => {
            stats.steps = stats.steps.saturating_add(1);
            // A latest sample without timing/output must show unknown, never an older speed.
            stats.last_request = Some(RequestUsage {
                output_tokens: a.usage.output_tokens,
                duration_ms: a.duration_ms,
            });
            &a.usage
        }
        Message::Compaction { usage, .. } => usage,
        _ => return,
    };
    add(&mut stats.tokens, usage);
    if let Some(turn) = &mut stats.turn {
        add(turn, usage);
    }
}

pub fn stats_from_history(messages: &[Message]) -> SessionStats {
    let mut stats = SessionStats::default();
    let mut after_compaction = false;
    for message in messages {
        record_stats(&mut stats, message, &mut after_compaction);
    }
    stats
}
