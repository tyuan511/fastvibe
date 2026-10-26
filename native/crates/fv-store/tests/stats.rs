use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use fv_protocol::types::SessionStats;
use fv_store::{Store, record_stats, stats_from_history};

fn answer(input: u64, output: u64, read: u64, time: Option<u64>) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: time,
        content: vec![ContentBlock::Text {
            text: "answer".into(),
        }],
        stop: StopReason::Stop,
        usage: Usage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: read,
            cache_write_tokens: 7,
        },
        model: None,
    })
}

#[test]
fn turn_totals_reset_but_session_totals_and_speed_survive_compaction_and_reopening() {
    let messages = vec![
        Message::User {
            text: "first".into(),
        },
        answer(100, 10, 50, Some(1000)),
        Message::ToolResult {
            call_id: "c".into(),
            name: "slow".into(),
            content: "tools do not add model usage".into(),
            is_error: false,
        },
        answer(200, 20, 80, Some(2000)),
        Message::Compaction {
            model: None,
            usage: Usage {
                input_tokens: 400,
                output_tokens: 30,
                ..Default::default()
            },
            user_messages: vec!["first".into()],
            summary: "summary".into(),
        },
        Message::User {
            text: "second".into(),
        },
        answer(40, 4, 20, Some(800)),
    ];
    let mut live = SessionStats::default();
    for message in &messages {
        record_stats(&mut live, message);
    }
    assert_eq!(live.tokens.input, 740);
    assert_eq!(live.tokens.output, 64);
    assert_eq!(live.tokens.cache_read, 150);
    assert_eq!(live.turn.as_ref().unwrap().input, 40);
    assert_eq!(live.turn.as_ref().unwrap().output, 4);
    assert_eq!(
        live.steps, 3,
        "assistant steps, not tool calls or compaction dividers"
    );
    assert_eq!(live.last_request.as_ref().unwrap().duration_ms, Some(800));
    assert!(live.cost.is_none());
    let dir = tempfile::tempdir().unwrap();
    {
        let store = Store::open(dir.path()).unwrap();
        store.transcripts.append("stats", &messages).unwrap();
    }
    let reopened = Store::open(dir.path()).unwrap();
    let loaded = reopened.transcripts.read("stats").unwrap();
    assert_eq!(stats_from_history(&loaded.messages), live);
    assert_eq!(fv_core::effective_history(&loaded.messages).len(), 3);
}

#[test]
fn latest_untimed_request_replaces_previous_speed_and_old_transcripts_still_load() {
    let old: Message = serde_json::from_value(serde_json::json!({"role":"assistant", "content":[], "stop":{"type":"stop"}, "usage":{"inputTokens":8,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}})).unwrap();
    let stats = stats_from_history(&[
        Message::User { text: "go".into() },
        answer(10, 5, 0, Some(100)),
        old,
    ]);
    let latest = stats.last_request.unwrap();
    assert_eq!(latest.output_tokens, 2);
    assert_eq!(latest.duration_ms, None);
    assert_eq!(stats.tokens.input, 18);
    let old_compaction: Message = serde_json::from_value(
        serde_json::json!({"role":"compaction","userMessages":["old"],"summary":"old summary"}),
    )
    .unwrap();
    assert_eq!(stats_from_history(&[old_compaction]).tokens.input, 0);
}
