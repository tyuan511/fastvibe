use fv_gui::view_model::{Applied, ThreadView, flat_items};
use fv_protocol::types::*;
use fv_protocol::{RequestId, ServerNotification as N};

fn thread() -> Thread {
    Thread {
        id: "t1".into(),
        title: "t".into(),
        cwd: None,
        project: None,
        created_at: 0,
        updated_at: 0,
        archived: false,
        unread: false,
        pinned: false,
        worktree: None,
        model: None,
        thinking: None,
    }
}

fn view(seq: u64, turns: Vec<Turn>) -> ThreadView {
    ThreadView::from_snapshot(ThreadResumeResponse {
        stats: Default::default(),
        thread: thread(),
        token_usage: None,
        turns,
        seq,
        running: false,
        queue: QueueState::default(),
        suggestion: None,
    })
}

fn ev<T>(seq: u64, body: T) -> ThreadEvent<T> {
    ThreadEvent {
        thread_id: "t1".into(),
        seq,
        body,
    }
}

fn started(seq: u64, turn: &str) -> N {
    N::TurnStarted(ev(
        seq,
        TurnRef {
            turn_id: turn.into(),
            at: None,
        },
    ))
}

fn item_started(seq: u64, turn: &str, item: Item) -> N {
    N::ItemStarted(ev(
        seq,
        ItemRef {
            turn_id: turn.into(),
            item,
            at: None,
        },
    ))
}

fn delta(seq: u64, turn: &str, item: &str, text: &str) -> N {
    N::AgentMessageDelta(ev(
        seq,
        Delta {
            turn_id: turn.into(),
            item_id: item.into(),
            delta: text.into(),
        },
    ))
}

#[test]
fn a_reply_streams_into_place() {
    let mut v = view(0, vec![]);
    assert_eq!(
        v.apply(&N::ThreadStatusChanged(ev(
            1,
            ThreadStatus { running: true }
        ))),
        Applied::Changed
    );
    assert!(v.running);
    v.apply(&started(2, "u1"));
    v.apply(&item_started(
        3,
        "u1",
        Item::AgentMessage {
            id: "m".into(),
            text: String::new(),
        },
    ));
    v.apply(&delta(4, "u1", "m", "Hel"));
    v.apply(&delta(5, "u1", "m", "lo"));
    let items: Vec<_> = flat_items(&v.turns).map(|(_, i)| i.clone()).collect();
    assert_eq!(
        items,
        vec![Item::AgentMessage {
            id: "m".into(),
            text: "Hello".into()
        }]
    );

    // The finished item replaces what was built from the pieces.
    v.apply(&N::ItemCompleted(ev(
        6,
        ItemRef {
            turn_id: "u1".into(),
            item: Item::AgentMessage {
                id: "m".into(),
                text: "Hello!".into(),
            },
            at: None,
        },
    )));
    assert!(matches!(&v.turns[0].items[0], Item::AgentMessage { text, .. } if text == "Hello!"));
    assert_eq!(v.seq, 6);
}

#[test]
fn events_the_snapshot_already_holds_are_skipped_and_the_next_one_continues_it() {
    let snapshot = view(
        5,
        vec![Turn::new(
            "u1".into(),
            vec![Item::AgentMessage {
                id: "m".into(),
                text: "so far".into(),
            }],
        )],
    );
    let mut v = snapshot;
    // Event 5 is in the snapshot already: applying it again would double the text.
    assert_eq!(v.apply(&delta(5, "u1", "m", " DOUBLED")), Applied::Ignored);
    assert_eq!(v.apply(&delta(6, "u1", "m", " and more")), Applied::Changed);
    assert!(
        matches!(&v.turns[0].items[0], Item::AgentMessage { text, .. } if text == "so far and more")
    );
}

#[test]
fn a_jump_in_the_sequence_means_events_were_missed() {
    let mut v = view(5, vec![]);
    assert_eq!(v.apply(&started(8, "u1")), Applied::Gap);
    assert_eq!(v.seq, 5, "a view that knows it is behind does not move");
    assert!(v.turns.is_empty());
}

#[test]
fn other_threads_and_catalog_notices_are_not_this_ones() {
    let mut v = view(0, vec![]);
    let other = N::TurnStarted(ThreadEvent {
        thread_id: "t2".into(),
        seq: 1,
        body: TurnRef {
            turn_id: "x".into(),
            at: None,
        },
    });
    assert_eq!(v.apply(&other), Applied::Ignored);
    assert_eq!(
        v.apply(&N::CatalogChanged(CatalogChanged {})),
        Applied::Ignored
    );
    assert_eq!(v.apply(&N::ProvidersChanged(Empty {})), Applied::Ignored);
    assert_eq!(v.seq, 0);
}

#[test]
fn the_plan_the_usage_and_the_questions_are_tracked() {
    let mut v = view(0, vec![]);
    v.apply(&N::TurnPlanUpdated(ev(
        1,
        PlanUpdated {
            turn_id: "u1".into(),
            explanation: None,
            plan: vec![PlanStep {
                step: "do".into(),
                status: PlanStatus::InProgress,
            }],
        },
    )));
    assert_eq!(v.plan.as_ref().unwrap().plan.len(), 1);
    v.apply(&N::ThreadTokenUsageUpdated(ev(
        2,
        TokenUsage {
            used: 900,
            window: 1000,
        },
    )));
    assert_eq!(
        v.token_usage,
        Some(TokenUsage {
            used: 900,
            window: 1000
        })
    );

    // A question arrives as a request, not as an event; it comes down when resolved.
    let id = RequestId::String("r1".into());
    v.ask(
        id.clone(),
        UserInputRequest {
            thread_id: "t1".into(),
            turn_id: "u1".into(),
            call_id: "c".into(),
            questions: vec![],
        },
    );
    v.ask(
        id.clone(),
        UserInputRequest {
            thread_id: "t1".into(),
            turn_id: "u1".into(),
            call_id: "c".into(),
            questions: vec![],
        },
    );
    assert_eq!(
        v.questions.len(),
        1,
        "the same request, replayed, is not shown twice"
    );
    assert!(v.is_waiting_on_user());
    v.ask(
        RequestId::String("r2".into()),
        UserInputRequest {
            thread_id: "other".into(),
            turn_id: "u".into(),
            call_id: "c".into(),
            questions: vec![],
        },
    );
    assert_eq!(
        v.questions.len(),
        1,
        "another thread's question is not this one's"
    );
    v.apply(&N::ServerRequestResolved(ev(
        3,
        RequestResolved { request_id: id },
    )));
    assert!(!v.is_waiting_on_user());
}

#[test]
fn a_tool_call_item_is_replaced_by_its_finished_form() {
    let mut v = view(0, vec![]);
    v.apply(&started(1, "u1"));
    v.apply(&item_started(
        2,
        "u1",
        Item::ToolCall {
            id: "c1".into(),
            name: "exec_command".into(),
            arguments: serde_json::Value::Null,
            output: None,
            is_error: false,
        },
    ));
    v.apply(&N::ItemCompleted(ev(
        3,
        ItemRef {
            turn_id: "u1".into(),
            item: Item::ToolCall {
                id: "c1".into(),
                name: "exec_command".into(),
                arguments: serde_json::json!({"cmd": "ls"}),
                output: Some("a\nb".into()),
                is_error: false,
            },
            at: None,
        },
    )));
    assert_eq!(v.turns[0].items.len(), 1);
    assert!(matches!(&v.turns[0].items[0], Item::ToolCall { output: Some(o), .. } if o == "a\nb"));
}

#[test]
fn stats_restore_with_the_snapshot_and_only_new_sequenced_updates_replace_them() {
    let initial = SessionStats {
        steps: 3,
        ..Default::default()
    };
    let mut v = ThreadView::from_snapshot(ThreadResumeResponse {
        thread: thread(),
        token_usage: None,
        stats: initial.clone(),
        turns: vec![],
        seq: 7,
        running: false,
        queue: QueueState::default(),
        suggestion: None,
    });
    assert_eq!(v.stats, initial);
    let updated = SessionStats {
        steps: 4,
        ..Default::default()
    };
    let note = N::ThreadStatsUpdated(ev(8, updated.clone()));
    assert_eq!(v.apply(&note), Applied::Changed);
    assert_eq!(v.stats, updated);
    assert_eq!(
        v.apply(&N::ThreadStatsUpdated(ev(7, initial))),
        Applied::Ignored
    );
    assert_eq!(v.stats, updated);
}

#[test]
fn reasoning_tracks_duration_and_timing() {
    let mut v = view(0, vec![]);
    v.apply(&N::TurnStarted(ev(
        1,
        TurnRef {
            turn_id: "u1".into(),
            at: Some(1000),
        },
    )));
    v.apply(&N::ItemStarted(ev(
        2,
        ItemRef {
            turn_id: "u1".into(),
            item: Item::Reasoning {
                id: "r1".into(),
                text: String::new(),
            },
            at: Some(1000),
        },
    )));
    assert_eq!(v.reasoning_starts.get("r1").copied(), Some(1000));
    v.apply(&N::ReasoningDelta(ev(
        3,
        Delta {
            turn_id: "u1".into(),
            item_id: "r1".into(),
            delta: "Thinking...".into(),
        },
    )));
    // 3500ms elapsed -> Math.ceil(3.5) = 4s
    v.apply(&N::ItemCompleted(ev(
        4,
        ItemRef {
            turn_id: "u1".into(),
            item: Item::Reasoning {
                id: "r1".into(),
                text: "Thinking...".into(),
            },
            at: Some(4500),
        },
    )));
    assert_eq!(v.reasoning_durations.get("r1").copied(), Some(4));
}

#[test]
fn reasoning_falls_back_to_turn_started_at_if_item_start_missing() {
    let mut v = view(0, vec![]);
    v.apply(&N::TurnStarted(ev(
        1,
        TurnRef {
            turn_id: "u1".into(),
            at: Some(2000),
        },
    )));
    v.apply(&N::ItemCompleted(ev(
        2,
        ItemRef {
            turn_id: "u1".into(),
            item: Item::Reasoning {
                id: "r2".into(),
                text: "Thought".into(),
            },
            at: Some(5100),
        },
    )));
    // 5100 - 2000 = 3100ms -> ceil is 4s
    assert_eq!(v.reasoning_durations.get("r2").copied(), Some(4));
}

/// A retry takes the turn and everything after it out of the drawn transcript, so the run that
/// replaces it appears once rather than as a second reply to the same prompt.
#[test]
fn a_rewind_drops_the_turn_and_what_followed_it() {
    let mut v = view(
        0,
        vec![
            Turn::new(
                "t0".into(),
                vec![Item::UserMessage {
                    id: "a".into(),
                    text: "first".into(),
                }],
            ),
            Turn::new(
                "t1".into(),
                vec![Item::UserMessage {
                    id: "b".into(),
                    text: "second".into(),
                }],
            ),
        ],
    );
    let note = N::TurnRewound(ev(
        1,
        Rewound {
            turn_id: "t1".into(),
        },
    ));
    assert_eq!(v.apply(&note), Applied::Changed);
    assert_eq!(
        v.turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["t0"]
    );
    // A turn that is not there changes nothing (a late event after a reload).
    let again = N::TurnRewound(ev(
        2,
        Rewound {
            turn_id: "t9".into(),
        },
    ));
    assert_eq!(v.apply(&again), Applied::Changed);
    assert_eq!(v.turns.len(), 1);
}

/// The queue the server pushes is what the tray draws, pause flag included.
#[test]
fn the_queue_arrives_whole_and_replaces_the_previous_one() {
    let mut v = view(0, vec![]);
    let note = N::ThreadQueueChanged(ev(
        1,
        QueueState {
            items: vec![
                QueueItem {
                    id: "q1".into(),
                    text: "first".into(),
                    at: 1,
                },
                QueueItem {
                    id: "q2".into(),
                    text: "second".into(),
                    at: 2,
                },
            ],
            pause: Some(QueuePauseReason::Failed),
        },
    ));
    assert_eq!(v.apply(&note), Applied::Changed);
    assert_eq!(v.queue.items.len(), 2);
    assert_eq!(v.queue.pause, Some(QueuePauseReason::Failed));
    // A later push is the whole queue again, not a delta to merge.
    let note = N::ThreadQueueChanged(ev(
        2,
        QueueState {
            items: vec![],
            pause: None,
        },
    ));
    assert_eq!(v.apply(&note), Applied::Changed);
    assert!(v.queue.items.is_empty());
    assert_eq!(v.queue.pause, None);
}
