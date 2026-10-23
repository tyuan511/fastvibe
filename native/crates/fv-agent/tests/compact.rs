//! Making room in a conversation that is outgrowing the model's window.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{
    AgentContext, AgentEvent, CompactError, SUMMARIZATION_PROMPT, Tool, ToolCtx, ToolOutput,
    ToolRegistry, ToolSpec, TurnOutcome, compact, context_used, needs_compaction, normalize,
    run_turn,
};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Echo;

impl Tool for Echo {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "echo".into(),
            description: "echoes".into(),
            schema: json!({"type": "object"}),
        }
    }
    fn mutates(&self) -> bool {
        false
    }
    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok("echoed") })
    }
}

fn agent(model: ScriptedModel) -> (AgentContext, Arc<ScriptedModel>) {
    let model = Arc::new(model);
    let mut tools = ToolRegistry::new();
    tools.register(Echo);
    (
        AgentContext {
            model: model.clone(),
            tools: Arc::new(tools),
            system: "sys".into(),
            cwd: None,
            ui: None,
            loaded: Default::default(),
        },
        model,
    )
}

fn user(t: &str) -> Message {
    Message::User { text: t.into() }
}

fn assistant(text: &str, input_tokens: u64) -> Message {
    Message::Assistant(AssistantMessage {
        content: vec![ContentBlock::Text { text: text.into() }],
        stop: StopReason::Stop,
        usage: Usage {
            input_tokens,
            output_tokens: 5,
            ..Usage::default()
        },
        model: None,
    })
}

async fn run(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    text: &str,
) -> (TurnOutcome, Vec<AgentEvent>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let outcome = run_turn(ctx, history, text.into(), &tx, &CancellationToken::new()).await;
    drop(tx);
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    (outcome, events)
}

fn is_summary_request(r: &fv_agent::ModelRequest) -> bool {
    r.tools.is_empty()
        && matches!(r.messages.last(), Some(Message::User { text }) if text == SUMMARIZATION_PROMPT)
}

fn compaction_of(history: &[Message]) -> Option<(&Vec<String>, &String)> {
    history.iter().find_map(|m| match m {
        Message::Compaction {
            user_messages,
            summary,
        } => Some((user_messages, summary)),
        _ => None,
    })
}

#[tokio::test]
async fn a_conversation_near_its_window_is_summarized_and_the_turn_carries_on() {
    // A 1000-token window; the first reply reports 950 tokens of input, which is over 90%.
    let (ctx, model) = agent(
        ScriptedModel::new([
            Reply::new()
                .tool("c1", "echo", json!({}))
                .input_tokens(950)
                .done(),
            Reply::new()
                .text("SUMMARY: edited a.rs, b.rs is left")
                .done(),
            Reply::new().text("all done").done(),
        ])
        .with_window(1000),
    );
    let mut history = Vec::new();
    let (outcome, events) = run(&ctx, &mut history, "fix the build").await;
    assert_eq!(outcome, TurnOutcome::Completed);

    let requests = model.requests();
    assert_eq!(requests.len(), 3);
    assert!(
        is_summary_request(&requests[1]),
        "the second request was not the summary request"
    );
    assert_eq!(
        requests[1].messages.len(),
        4,
        "user, assistant, tool result, and the prompt"
    );

    // The model carries on from the summary, not from what it replaced.
    assert_eq!(requests[2].messages.len(), 1, "{:?}", requests[2].messages);
    let Message::User { text } = &requests[2].messages[0] else {
        panic!("{:?}", requests[2].messages)
    };
    assert!(
        text.contains("fix the build") && text.contains("SUMMARY: edited a.rs, b.rs is left"),
        "{text}"
    );

    // What is left in memory: the compaction, then what happened after it.
    assert!(
        matches!(&history[0], Message::Compaction { user_messages, summary } if user_messages == &["fix the build"] && summary.starts_with("SUMMARY"))
    );
    assert!(matches!(&history[1], Message::Assistant(a) if a.text() == "all done"));
    assert_eq!(history.len(), 2);

    // And it was announced, and committed in order, so it is what the transcript will hold.
    let started = events
        .iter()
        .position(|e| matches!(e, AgentEvent::CompactionStarted { .. }))
        .unwrap();
    let committed = events
        .iter()
        .position(|e| matches!(e, AgentEvent::Committed(Message::Compaction { .. })))
        .unwrap();
    let done = events
        .iter()
        .position(|e| matches!(e, AgentEvent::CompactionDone { .. }))
        .unwrap();
    assert!(started < committed && committed < done);
}

#[tokio::test]
async fn nothing_is_summarized_while_there_is_room() {
    let (ctx, model) = agent(
        ScriptedModel::new([
            Reply::new()
                .tool("c1", "echo", json!({}))
                .input_tokens(500)
                .done(),
            Reply::new().text("done").done(),
        ])
        .with_window(1000),
    );
    let mut history = Vec::new();
    let (outcome, events) = run(&ctx, &mut history, "go").await;
    assert_eq!(outcome, TurnOutcome::Completed);
    assert_eq!(model.requests().len(), 2);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::CompactionStarted { .. }))
    );
}

#[tokio::test]
async fn a_request_the_provider_refused_as_too_large_is_summarized_and_asked_again() {
    let (ctx, model) = agent(
        ScriptedModel::new([
            Reply::new().then_overflow(),
            Reply::new().text("SUMMARY").done(),
            Reply::new().text("answered").done(),
        ])
        .with_window(1_000_000),
    );
    let mut history = vec![user("earlier question"), assistant("earlier answer", 10)];
    let (outcome, _) = run(&ctx, &mut history, "new question").await;
    assert_eq!(outcome, TurnOutcome::Completed);
    assert_eq!(model.requests().len(), 3);
    assert!(is_summary_request(&model.requests()[1]));
    let (users, summary) = compaction_of(&history).unwrap();
    assert_eq!(
        users,
        &["earlier question", "new question"],
        "the user's words, in order"
    );
    assert_eq!(summary, "SUMMARY");
}

#[tokio::test]
async fn a_second_refusal_is_not_answered_with_a_second_summary() {
    let (ctx, model) = agent(
        ScriptedModel::new([
            Reply::new().then_overflow(),
            Reply::new().text("SUMMARY").done(),
            Reply::new().then_overflow(),
        ])
        .with_window(1_000_000),
    );
    let mut history = Vec::new();
    let (outcome, _) = run(&ctx, &mut history, "go").await;
    assert!(
        matches!(&outcome, TurnOutcome::Failed(m) if m.contains("maximum context length")),
        "{outcome:?}"
    );
    assert_eq!(model.requests().len(), 3, "it kept trying");
}

#[tokio::test]
async fn a_summary_request_that_is_itself_too_big_drops_the_oldest_messages() {
    let (ctx, model) = agent(
        ScriptedModel::new([
            Reply::new().then_overflow(),
            Reply::new().then_overflow(),
            Reply::new().text("SUMMARY").done(),
        ])
        .with_window(1_000_000),
    );
    let mut history: Vec<Message> = (0..4)
        .flat_map(|i| [user(&format!("q{i}")), assistant(&format!("a{i}"), 10)])
        .collect();
    let (tx, _rx) = mpsc::unbounded_channel();
    compact(&ctx, &mut history, &tx, &CancellationToken::new())
        .await
        .unwrap();

    let lengths: Vec<usize> = model.requests().iter().map(|r| r.messages.len()).collect();
    assert_eq!(
        lengths,
        [9, 8, 7],
        "each refusal drops the oldest message: {lengths:?}"
    );
    assert!(model.requests().iter().all(is_summary_request));
    // Whatever was dropped from the request, the user's own words are all kept.
    let (users, _) = compaction_of(&history).unwrap();
    assert_eq!(users, &["q0", "q1", "q2", "q3"]);
}

#[tokio::test]
async fn stopping_while_summarizing_changes_nothing() {
    let (ctx, _) = agent(ScriptedModel::new([Reply::new().then_hang()]));
    let mut history = vec![user("a"), assistant("b", 10)];
    let before = history.clone();
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stopper.cancel();
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = compact(&ctx, &mut history, &tx, &cancel).await;
    assert_eq!(result, Err(CompactError::Interrupted));
    assert_eq!(history, before);
    drop(tx);
    let mut saw_failed = false;
    while let Some(e) = rx.recv().await {
        saw_failed |= matches!(e, AgentEvent::CompactionFailed { .. });
        assert!(
            !matches!(e, AgentEvent::Committed(_)),
            "a compaction was committed though it was stopped"
        );
    }
    assert!(
        saw_failed,
        "clients were left showing a compaction in progress"
    );
}

#[tokio::test]
async fn a_failed_summary_fails_the_turn_and_keeps_the_history() {
    let (ctx, _) = agent(
        ScriptedModel::new([
            Reply::new()
                .tool("c1", "echo", json!({}))
                .input_tokens(950)
                .done(),
            Reply::new().then_fail("quota exceeded"),
        ])
        .with_window(1000),
    );
    let mut history = Vec::new();
    let (outcome, _) = run(&ctx, &mut history, "go").await;
    assert!(
        matches!(&outcome, TurnOutcome::Failed(m) if m.contains("could not be summarized") && m.contains("quota exceeded")),
        "{outcome:?}"
    );
    assert!(
        compaction_of(&history).is_none(),
        "the history was replaced although the summary failed"
    );
    assert!(history.len() >= 3, "{history:?}");
}

#[tokio::test]
async fn a_message_too_big_for_any_window_is_reported_not_looped_on() {
    // 100 tokens of window, a 2000-byte message: summarizing cannot make it fit.
    let (ctx, model) =
        agent(ScriptedModel::new([Reply::new().text("SUMMARY").done()]).with_window(100));
    let mut history = Vec::new();
    let (outcome, _) = run(&ctx, &mut history, &"x".repeat(2000)).await;
    assert!(
        matches!(&outcome, TurnOutcome::Failed(m) if m.contains("too large to continue")),
        "{outcome:?}"
    );
    assert_eq!(model.requests().len(), 1, "only the summary was asked for");
}

#[tokio::test]
async fn the_users_words_accumulate_across_compactions() {
    let (ctx, _) = agent(
        ScriptedModel::new([
            Reply::new().text("first summary").done(),
            Reply::new().text("second summary").done(),
        ])
        .with_window(1_000_000),
    );
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut history = vec![user("first ask"), assistant("done", 10)];
    compact(&ctx, &mut history, &tx, &CancellationToken::new())
        .await
        .unwrap();
    history.push(user("second ask"));
    history.push(assistant("done too", 10));
    compact(&ctx, &mut history, &tx, &CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(history.len(), 1);
    let (users, summary) = compaction_of(&history).unwrap();
    assert_eq!(
        users,
        &["first ask", "second ask"],
        "an earlier ask survived being summarized twice"
    );
    assert_eq!(summary, "second summary");
}

#[test]
fn size_comes_from_the_providers_count_when_there_is_one() {
    // The reply says the request was 800 tokens; what was added after it is estimated.
    let history = vec![user("q"), assistant("a", 800), user(&"x".repeat(400))];
    assert_eq!(context_used(&history), 800 + 5 + 100);
    // With no provider count at all, everything is estimated.
    assert_eq!(context_used(&[user(&"x".repeat(400))]), 100);
}

#[tokio::test]
async fn ninety_percent_is_the_line() {
    let (ctx, _) = agent(ScriptedModel::new([]).with_window(1000));
    assert!(
        !needs_compaction(&ctx, &[assistant("a", 880)]),
        "885 of 1000"
    );
    assert!(
        needs_compaction(&ctx, &[assistant("a", 900)]),
        "905 of 1000"
    );
}

#[test]
fn a_compaction_reaches_the_model_as_one_user_message() {
    let out = normalize(&[
        Message::Compaction {
            user_messages: vec!["ask".into()],
            summary: "did it".into(),
        },
        assistant("later", 10),
    ]);
    assert!(
        matches!(&out[0], Message::User { text } if text.contains("ask") && text.contains("did it"))
    );
    assert!(matches!(&out[1], Message::Assistant(_)));
}
