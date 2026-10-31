use std::collections::BTreeMap;

use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_protocol::types::{Item, TurnStatus};
use fv_store::TranscriptStore;

#[test]
fn reasoning_durations_survive_reload_renumbering_and_fork() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sessions");
    let store = TranscriptStore::new(path.clone()).unwrap();
    store.start_turn("source", "original-turn").unwrap();
    let messages = vec![
        Message::User {
            text: "Think twice".into(),
        },
        Message::Assistant(AssistantMessage {
            content: vec![
                ContentBlock::Thinking {
                    text: "first".into(),
                    signature: None,
                },
                ContentBlock::Thinking {
                    text: "  ".into(),
                    signature: None,
                },
                ContentBlock::Thinking {
                    text: "second".into(),
                    signature: None,
                },
            ],
            stop: StopReason::Stop,
            usage: Default::default(),
            model: None,
            duration_ms: None,
        }),
    ];
    store.append("source", &messages).unwrap();
    // Ordinals refer to visible thoughts; blank blocks never consume one.
    store
        .finish_turn_with_reasoning(
            "source",
            "original-turn",
            TurnStatus::Completed,
            None,
            BTreeMap::from([(0, 3500), (1, 1100)]),
        )
        .unwrap();
    drop(store);

    let store = TranscriptStore::new(path).unwrap();
    let loaded = store.read("source").unwrap();
    let turns = loaded.turns();
    let thoughts: Vec<_> = turns[0]
        .items
        .iter()
        .filter_map(|item| {
            if let Item::Reasoning { id, text } = item {
                Some((text.as_str(), turns[0].reasoning_durations.get(id).copied()))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(thoughts, [("first", Some(3500)), ("second", Some(1100))]);
    assert_eq!(loaded.messages, messages);

    store
        .copy_loaded("fork", &loaded, &loaded.messages)
        .unwrap();
    assert_eq!(store.read("fork").unwrap().turns(), turns);
}
