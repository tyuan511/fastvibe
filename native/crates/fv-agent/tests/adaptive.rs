use fv_agent::testing::{Reply, ScriptedModel, Step};
use fv_agent::{
    AgentContext, AgentEvent, CompactError, ModelRequest, SUMMARIZATION_PROMPT, TurnOutcome,
    compact, effective_context_window, run_turn,
};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn context(model: ScriptedModel) -> (AgentContext, Arc<ScriptedModel>) {
    let model = Arc::new(model);
    (
        AgentContext { context: Default::default(),
            model: model.clone(),
            tools: Default::default(),
            system: "sys".into(),
            cwd: None,
            ui: None,
            loaded: Default::default(),
            permissions: None,
            steer: None,
            memory: None,
            budget: Default::default(),
            compaction: None,
        },
        model,
    )
}
fn user(text: &str) -> Message {
    Message::User { text: text.into() }
}
fn assistant(text: &str, input: u64) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![ContentBlock::Text { text: text.into() }],
        stop: StopReason::Stop,
        usage: Usage {
            input_tokens: input,
            ..Usage::default()
        },
        model: None,
    })
}
fn is_summary(request: &ModelRequest) -> bool {
    matches!(request.messages.last(), Some(Message::User { text }) if text == SUMMARIZATION_PROMPT)
}
async fn run(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    text: &str,
) -> (TurnOutcome, Vec<AgentEvent>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = run_turn(ctx, history, text.into(), &tx, &CancellationToken::new()).await;
    drop(tx);
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    (result, events)
}

#[tokio::test]
async fn repeated_refusals_after_a_summary_learn_again_and_success_ends_recovery() {
    let (ctx, model) = context(
        ScriptedModel::new([
            Reply::new().then_overflow(),
            Reply::new()
                .text(&format!("SUMMARY: {}", "progress ".repeat(100)))
                .done(),
            Reply::new().then_overflow(),
            Reply::new().text("SUMMARY: concise checkpoint").done(),
            Reply::new().text("done").done(),
            Reply::new().text("next answer").done(),
        ])
        .with_window(1_000_000),
    );
    let mut history = vec![
        user("keep requirement"),
        assistant(&"old content ".repeat(600), 2000),
    ];
    let (outcome, events) = run(&ctx, &mut history, "continue work").await;
    assert_eq!(outcome, TurnOutcome::Completed, "{outcome:?}");
    assert_eq!(model.requests().iter().filter(|r| is_summary(r)).count(), 2);
    let mut windows: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ContextBudgetChanged { window, .. } => Some(*window),
            _ => None,
        })
        .collect();
    windows.dedup();
    assert_eq!(windows.len(), 2);
    assert!(windows[1] < windows[0]);
    let learned = effective_context_window(&ctx);
    assert!(learned < 10_000);
    assert!(model.requests().last().unwrap().max_output_tokens.is_some());
    assert_eq!(
        run(&ctx, &mut history, "next").await.0,
        TurnOutcome::Completed
    );
    assert_eq!(
        effective_context_window(&ctx),
        learned,
        "a success must not forget the physical ceiling"
    );
    assert_eq!(model.requests().len(), 6);
}

#[tokio::test]
async fn oversized_unicode_and_tool_evidence_is_processed_in_full_in_bounded_parts() {
    let (ctx, model) = context(
        ScriptedModel::new((0..128).map(|_| {
            Reply::new()
                .text("CHECKPOINT: preserve requirements")
                .done()
        }))
        .with_window(4096),
    );
    let evidence = format!(
        "FIRST-EVIDENCE\n{}LAST-EVIDENCE",
        (0..6000)
            .map(|i| format!("数据-{i:04}-🙂\n"))
            .collect::<String>()
    );
    let mut call = match assistant("called tool", 10) {
        Message::Assistant(a) => a,
        _ => unreachable!(),
    };
    call.content.push(ContentBlock::ToolCall {
        id: "call-id".into(),
        name: "exec_command".into(),
        arguments: serde_json::json!({"cmd":"read-evidence"}),
    });
    let mut history = vec![
        user("original requirement"),
        Message::Assistant(call),
        Message::ToolResult {
            call_id: "call-id".into(),
            name: "exec_command".into(),
            content: evidence.clone(),
            is_error: false,
        },
    ];
    assert_eq!(
        run(&ctx, &mut history, "finish").await.0,
        TurnOutcome::Completed
    );
    let requests = model.requests();
    let summaries: Vec<_> = requests.iter().filter(|r| is_summary(r)).collect();
    assert!(summaries.len() > 2);
    let mut packed = String::new();
    for request in &summaries {
        assert!(request.tools.is_empty());
        assert_eq!(request.max_output_tokens, Some(1024));
        assert!(fv_agent::budget::request_tokens(request) <= 2560);
        for message in &request.messages {
            if let Message::User { text } = message
                && let Some(part) = text.strip_prefix("Conversation evidence, next part:\n")
            {
                packed.push_str(part);
            }
        }
    }
    assert!(
        packed.contains(&evidence),
        "evidence was cut out between parts"
    );
    assert!(
        packed.contains("TOOL CALL call-id exec_command")
            && packed.contains("TOOL RESULT call-id exec_command")
    );
    let Message::Compaction {
        usage,
        user_messages,
        ..
    } = &history[0]
    else {
        panic!("missing checkpoint")
    };
    assert_eq!(usage.input_tokens, summaries.len() as u64 * 10);
    assert_eq!(user_messages, &["original requirement", "finish"]);
}

#[tokio::test]
async fn large_original_user_messages_stay_in_the_checkpoint_while_the_request_projection_fits() {
    let (ctx, model) = context(
        ScriptedModel::new((0..64).map(|_| {
            Reply::new()
                .text("CHECKPOINT: complete user requirements")
                .done()
        }))
        .with_window(4096),
    );
    let original = format!(
        "HEAD-REQUIREMENT\n{}\nTAIL-REQUIREMENT",
        "用户的原始要求🙂\n".repeat(2500)
    );
    let mut history = vec![user(&original), assistant("earlier answer", 10)];
    assert_eq!(
        run(&ctx, &mut history, "continue").await.0,
        TurnOutcome::Completed
    );
    let Message::Compaction { user_messages, .. } = &history[0] else {
        panic!("checkpoint")
    };
    assert_eq!(user_messages[0], original);
    let request = model.requests().last().unwrap().clone();
    assert!(fv_agent::budget::request_tokens(&request) < 4096 * 9 / 10);
    let Message::User { text } = &request.messages[0] else {
        panic!("projection")
    };
    assert!(text.contains("HEAD-REQUIREMENT") && text.contains("TAIL-REQUIREMENT"));
}

#[tokio::test]
async fn exhausted_capacity_does_not_spend_more_requests_on_continuations_but_editing_unlocks_it() {
    let (ctx, model) = context(
        ScriptedModel::new((0..20).map(|_| Reply::new().then_overflow())).with_window(1_000_000),
    );
    let mut history = vec![user("work"), assistant(&"evidence ".repeat(2000), 4000)];
    let (outcome, _) = run(&ctx, &mut history, "go").await;
    assert!(matches!(outcome, TurnOutcome::Failed(_)));
    let calls = model.requests().len();
    assert!(calls <= 7, "capacity recovery was not bounded: {calls}");
    assert!(matches!(
        run(&ctx, &mut history, "continue").await.0,
        TurnOutcome::Failed(_)
    ));
    assert_eq!(model.requests().len(), calls);
    history.clear();
    run(&ctx, &mut history, "edited request").await;
    assert!(
        model.requests().len() > calls,
        "a different history stayed blocked"
    );
}

#[tokio::test]
async fn manual_probe_restores_prior_protection_on_auth_failure_and_cancel_then_commits_on_success()
{
    let (ctx, model) = context(
        ScriptedModel::new([
            Reply::new().then_fail("401 credentials"),
            Reply::new().then_hang(),
            Reply::new().text("new checkpoint").done(),
        ])
        .with_window(1_000_000),
    );
    let mut history = vec![user("requirements"), assistant("previous work", 10)];
    assert!(ctx.budget.reject(ctx.model.as_ref(), 20_000, 4096));
    ctx.budget.block(ctx.model.as_ref(), &history);
    let old_window = effective_context_window(&ctx);
    let before = history.clone();
    let (tx, _) = mpsc::unbounded_channel();
    assert!(matches!(
        compact(&ctx, &mut history, &tx, &CancellationToken::new()).await,
        Err(CompactError::Failed(_))
    ));
    assert_eq!(history, before);
    assert_eq!(effective_context_window(&ctx), old_window);
    assert!(ctx.budget.blocked(ctx.model.as_ref(), &history));
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        stopper.cancel();
    });
    assert_eq!(
        compact(&ctx, &mut history, &tx, &cancel).await,
        Err(CompactError::Interrupted)
    );
    assert_eq!(history, before);
    assert_eq!(effective_context_window(&ctx), old_window);
    compact(&ctx, &mut history, &tx, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(effective_context_window(&ctx), 1_000_000);
    assert!(!ctx.budget.blocked(ctx.model.as_ref(), &history));
    assert_eq!(model.requests().len(), 3);
}

#[tokio::test]
async fn non_capacity_errors_and_intentional_output_caps_do_not_shrink_or_auto_retry() {
    let mut length = Reply::new().text("short because of the output cap").done();
    if let Some(Step::Event(fv_agent::ModelEvent::Done(message))) = length.last_mut() {
        message.stop = StopReason::Length;
    }
    let (ctx, model) = context(
        ScriptedModel::new([Reply::new().then_fail("429 quota"), length]).with_window(100_000),
    );
    let mut history = Vec::new();
    assert!(matches!(
        run(&ctx, &mut history, "one").await.0,
        TurnOutcome::Failed(_)
    ));
    assert_eq!(effective_context_window(&ctx), 100_000);
    assert!(
        matches!(run(&ctx, &mut history, "two").await.0, TurnOutcome::Failed(m) if m.contains("output limit"))
    );
    assert_eq!(effective_context_window(&ctx), 100_000);
    assert_eq!(model.requests().len(), 2);
    assert!(
        !history
            .iter()
            .any(|m| matches!(m, Message::Compaction { .. }))
    );
}

#[tokio::test]
async fn summary_output_leaves_room_for_required_instructions_in_the_ordinary_request() {
    let (mut ctx, model) = context(
        ScriptedModel::new((0..128).map(|_| Reply::new().text("CONCISE CHECKPOINT").done()))
            .with_window(1_000_000),
    );
    ctx.system = "required instruction ".repeat(400);
    assert!(ctx.budget.reject(ctx.model.as_ref(), 40_000, 4096));
    assert!(ctx.budget.reject(ctx.model.as_ref(), 8000, 4096));
    let mut history = vec![
        user("keep requirements"),
        assistant(&"facts ".repeat(6000), 10),
    ];
    assert_eq!(
        run(&ctx, &mut history, "finish").await.0,
        TurnOutcome::Completed
    );
    let requests = model.requests();
    let summaries: Vec<_> = requests.iter().filter(|r| is_summary(r)).collect();
    assert!(!summaries.is_empty());
    assert!(
        summaries
            .iter()
            .all(|r| r.max_output_tokens.is_some_and(|cap| cap < 1024))
    );
    assert!(
        fv_agent::budget::request_tokens(requests.last().unwrap()) < effective_context_window(&ctx)
    );
}

#[tokio::test]
async fn a_length_stop_does_not_execute_even_a_parseable_tool_call() {
    let mut reply = Reply::new()
        .tool("cut-call", "must-not-run", serde_json::json!({}))
        .done();
    if let Some(Step::Event(fv_agent::ModelEvent::Done(message))) = reply.last_mut() {
        message.stop = StopReason::Length;
    }
    let (ctx, model) = context(ScriptedModel::new([reply]));
    let mut history = Vec::new();
    assert!(
        matches!(run(&ctx, &mut history, "work").await.0, TurnOutcome::Failed(m) if m.contains("output limit"))
    );
    assert_eq!(model.requests().len(), 1);
    assert!(
        matches!(history.last(), Some(Message::ToolResult { is_error: true, content, .. }) if content.contains("not executed"))
    );
}

#[tokio::test]
async fn cancelling_an_already_blocked_conversation_is_an_interruption() {
    let (ctx, model) = context(ScriptedModel::default());
    let mut history = vec![user("blocked work")];
    ctx.budget.block(ctx.model.as_ref(), &history);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let (tx, _) = mpsc::unbounded_channel();
    assert_eq!(
        run_turn(&ctx, &mut history, "continue".into(), &tx, &cancel).await,
        TurnOutcome::Interrupted
    );
    assert!(model.requests().is_empty());
}

#[tokio::test]
async fn a_large_model_output_limit_does_not_become_a_large_summary_budget() {
    use fv_agent::{Model, ModelError, ModelEvent};
    struct WideOutput(Arc<ScriptedModel>);
    impl Model for WideOutput {
        fn context_window(&self) -> Option<u32> {
            Some(1_000_000)
        }
        fn max_output_tokens(&self) -> Option<u32> {
            Some(128_000)
        }
        fn stream(
            &self,
            request: ModelRequest,
        ) -> futures_util::stream::BoxStream<'static, Result<ModelEvent, ModelError>> {
            self.0.stream(request)
        }
    }
    let (mut ctx, model) = context(ScriptedModel::new([
        Reply::new().text("CHECKPOINT").done(),
        Reply::new().text("done").done(),
    ]));
    ctx.model = Arc::new(WideOutput(model.clone()));
    let mut history = vec![user("requirements"), assistant("past work", 950_000)];
    assert_eq!(
        run(&ctx, &mut history, "finish").await.0,
        TurnOutcome::Completed
    );
    assert_eq!(model.requests()[0].max_output_tokens, Some(4096));
}

#[tokio::test]
async fn disabling_automatic_compaction_preserves_history_and_manual_compaction_still_works() {
    use std::sync::atomic::AtomicBool;
    let (mut ctx, model) = context(
        ScriptedModel::new([
            Reply::new().text("MANUAL CHECKPOINT").done(),
            Reply::new().text("continued").done(),
        ])
        .with_window(10_000),
    );
    ctx.compaction = Some(Arc::new(AtomicBool::new(false)));
    let mut history = vec![
        user("original requirement"),
        assistant("previous work", 9500),
    ];
    let before = history.clone();
    let (outcome, events) = run(&ctx, &mut history, "new requirement").await;
    assert!(
        matches!(outcome, TurnOutcome::Failed(m) if m.contains("automatic compaction is disabled"))
    );
    assert!(model.requests().is_empty());
    assert!(history.starts_with(&before));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::CompactionStarted { .. }))
    );
    let (tx, _) = mpsc::unbounded_channel();
    compact(&ctx, &mut history, &tx, &CancellationToken::new())
        .await
        .unwrap();
    assert!(
        matches!(history.first(), Some(Message::Compaction { summary, .. }) if summary == "MANUAL CHECKPOINT")
    );
    assert_eq!(
        run(&ctx, &mut history, "continue").await.0,
        TurnOutcome::Completed
    );
    assert_eq!(model.requests().len(), 2);
}

#[tokio::test]
async fn disabled_compaction_reports_a_real_overflow_without_starting_recovery() {
    use std::sync::atomic::AtomicBool;
    let (mut ctx, model) =
        context(ScriptedModel::new([Reply::new().then_overflow()]).with_window(1_000_000));
    ctx.compaction = Some(Arc::new(AtomicBool::new(false)));
    let mut history = vec![
        user("requirements"),
        assistant(&"earlier work ".repeat(300), 800),
    ];
    let (outcome, events) = run(&ctx, &mut history, "continue").await;
    assert!(
        matches!(outcome, TurnOutcome::Failed(m) if m.contains("automatic compaction is disabled"))
    );
    assert_eq!(model.requests().len(), 1);
    assert!(
        effective_context_window(&ctx) < 1_000_000,
        "real capacity evidence should still be retained"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::CompactionStarted { .. }))
    );
    assert!(
        !history
            .iter()
            .any(|m| matches!(m, Message::Compaction { .. }))
    );
}

#[tokio::test]
async fn a_live_setting_change_is_read_at_the_next_request_boundary() {
    use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
    use std::sync::atomic::{AtomicBool, Ordering};
    struct TurnOff(Arc<AtomicBool>);
    impl Tool for TurnOff {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "turn_off".into(),
                description: "test setting update".into(),
                schema: serde_json::json!({"type":"object"}),
            }
        }
        fn mutates(&self) -> bool {
            false
        }
        fn call(
            &self,
            _: ToolCtx,
            _: serde_json::Value,
        ) -> futures_util::future::BoxFuture<'static, ToolOutput> {
            self.0.store(false, Ordering::Release);
            Box::pin(async { ToolOutput::ok("setting changed") })
        }
    }
    let (mut ctx, model) = context(
        ScriptedModel::new([
            Reply::new()
                .tool("flip", "turn_off", serde_json::json!({}))
                .input_tokens(9500)
                .done(),
            Reply::new().text("must not summarize").done(),
        ])
        .with_window(10_000),
    );
    let enabled = Arc::new(AtomicBool::new(true));
    let mut tools = fv_agent::ToolRegistry::new();
    tools.register(TurnOff(enabled.clone()));
    ctx.tools = Arc::new(tools);
    ctx.compaction = Some(enabled);
    let mut history = Vec::new();
    assert!(
        matches!(run(&ctx, &mut history, "work").await.0, TurnOutcome::Failed(m) if m.contains("automatic compaction is disabled"))
    );
    assert_eq!(model.requests().len(), 1);
    assert!(
        !history
            .iter()
            .any(|m| matches!(m, Message::Compaction { .. }))
    );
}
