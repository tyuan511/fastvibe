use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{
    AgentContext, AgentEvent, BlockKind, Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec,
    TurnOutcome, normalize, run_turn,
};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A tool that waits `delay`, then reports its argument. `mutates` decides whether it may overlap.
struct Slow {
    name: &'static str,
    delay: Duration,
    mutates: bool,
}

impl Tool for Slow {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.into(),
            description: "test".into(),
            schema: json!({"type": "object"}),
        }
    }

    fn mutates(&self) -> bool {
        self.mutates
    }

    fn call(&self, _: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            ToolOutput::ok(format!("done {}", args["n"]))
        })
    }
}

fn agent(model: ScriptedModel, tools: Vec<Slow>) -> (AgentContext, Arc<ScriptedModel>) {
    let model = Arc::new(model);
    let mut registry = ToolRegistry::new();
    for t in tools {
        registry.register(t);
    }
    (
        AgentContext {
            model: model.clone(),
            tools: Arc::new(registry),
            system: "sys".into(),
            cwd: None,
            ui: None,
            loaded: Default::default(),
            permissions: None,
            steer: None,
            memory: None,
            budget: Default::default(),
        },
        model,
    )
}

struct Run {
    outcome: TurnOutcome,
    history: Vec<Message>,
    events: Vec<AgentEvent>,
}

async fn run(ctx: &AgentContext, cancel: &CancellationToken) -> Run {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut history = Vec::new();
    let outcome = run_turn(ctx, &mut history, "go".into(), &tx, cancel).await;
    drop(tx);
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    Run {
        outcome,
        history,
        events,
    }
}

fn results(history: &[Message]) -> Vec<(&str, &str, bool)> {
    history
        .iter()
        .filter_map(|m| match m {
            Message::ToolResult {
                call_id,
                content,
                is_error,
                ..
            } => Some((call_id.as_str(), content.as_str(), *is_error)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_plain_answer_streams_blocks_then_completes() {
    let (ctx, _) = agent(
        ScriptedModel::new([Reply::new().thinking("hmm").text("hello there").done()]),
        vec![],
    );
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Completed);
    assert!(
        matches!(&r.history[..], [Message::User { .. }, Message::Assistant(a)] if a.text() == "hello there")
    );

    let kinds: Vec<&str> = r
        .events
        .iter()
        .map(|e| match e {
            AgentEvent::ContextBudgetChanged { .. } => "budget",
            AgentEvent::BlockStarted {
                kind: BlockKind::Thinking,
                ..
            } => "start-thinking",
            AgentEvent::BlockStarted {
                kind: BlockKind::Text,
                ..
            } => "start-text",
            AgentEvent::BlockStarted { .. } => "start-tool",
            AgentEvent::BlockDelta { .. } => "delta",
            AgentEvent::BlockDone { .. } => "done",
            AgentEvent::MessageDone(_) => "message",
            AgentEvent::ToolResult { .. } => "result",
            AgentEvent::Committed(_) => "committed",
            AgentEvent::CompactionStarted { .. }
            | AgentEvent::CompactionDone { .. }
            | AgentEvent::CompactionFailed { .. } => "compaction",
        })
        .collect();
    // The thinking block closes before the text one opens; "hello there" streams as two words.
    assert_eq!(
        kinds,
        [
            "committed", // the user's message
            "start-thinking",
            "delta",
            "done",
            "start-text",
            "delta",
            "delta",
            "done",
            "message",
            "committed" // the reply
        ]
    );
}

#[tokio::test]
async fn committed_events_are_exactly_the_history_in_order() {
    // Tool results are committed in call order, whatever order they finished in, and a stopped
    // reply is committed as far as it got: what gets written to disk is what the next request sees.
    let model = ScriptedModel::new([
        Reply::new()
            .tool("slow", "read", json!({"n": 1}))
            .tool("fast", "read", json!({"n": 2}))
            .done(),
        Reply::new().text("partial ").then_hang(),
    ]);
    let (ctx, _) = agent(
        model,
        vec![Slow {
            name: "read",
            delay: Duration::from_millis(30),
            mutates: false,
        }],
    );
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        stopper.cancel();
    });
    let r = run(&ctx, &cancel).await;
    assert_eq!(r.outcome, TurnOutcome::Interrupted);
    let committed: Vec<Message> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Committed(m) => Some(m.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(committed, r.history);
    assert_eq!(
        r.history.len(),
        5,
        "user, assistant, two results, the stopped reply"
    );
}

#[tokio::test]
async fn tool_calls_are_run_and_their_results_fed_back() {
    let model = ScriptedModel::new([
        Reply::new()
            .text("checking")
            .tool("c1", "read", json!({"n": 1}))
            .done(),
        Reply::new().text("all done").done(),
    ]);
    let (ctx, model) = agent(
        model,
        vec![Slow {
            name: "read",
            delay: Duration::ZERO,
            mutates: false,
        }],
    );
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Completed);
    assert_eq!(results(&r.history), [("c1", "done 1", false)]);

    // The second request carries the first reply and its tool result, in that order.
    let second = &model.requests()[1];
    assert!(matches!(second.messages[1], Message::Assistant(_)));
    assert!(matches!(&second.messages[2], Message::ToolResult { call_id, .. } if call_id == "c1"));
    assert_eq!(
        second
            .tools
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["read"]
    );

    let tool_result = r.events.iter().find_map(|e| match e {
        AgentEvent::ToolResult {
            call_id,
            arguments,
            output,
            ..
        } => Some((call_id.clone(), arguments.clone(), output.clone())),
        _ => None,
    });
    assert_eq!(
        tool_result,
        Some(("c1".into(), json!({"n": 1}), "done 1".into()))
    );
}

#[tokio::test]
async fn a_tool_call_that_only_appears_in_the_final_message_is_still_announced() {
    // A provider that does not stream tool calls: Done is all there is.
    let message = AssistantMessage {
        duration_ms: None,
        content: vec![ContentBlock::ToolCall {
            id: "c1".into(),
            name: "read".into(),
            arguments: json!({"n": 2}),
        }],
        stop: StopReason::ToolUse,
        usage: Default::default(),
        model: None,
    };
    let first = vec![fv_agent::testing::Step::Event(fv_agent::ModelEvent::Done(
        message,
    ))];
    let (ctx, _) = agent(
        ScriptedModel::new([first, Reply::new().text("ok").done()]),
        vec![Slow {
            name: "read",
            delay: Duration::ZERO,
            mutates: false,
        }],
    );
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Completed);
    let starts = r
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                AgentEvent::BlockStarted {
                    kind: BlockKind::ToolCall { .. },
                    ..
                }
            )
        })
        .count();
    let dones = r
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                AgentEvent::BlockDone {
                    block: ContentBlock::ToolCall { .. },
                    ..
                }
            )
        })
        .count();
    assert_eq!((starts, dones), (1, 1));
}

#[tokio::test]
async fn reads_overlap_and_writes_wait_their_turn() {
    let delay = Duration::from_millis(150);
    let two = |name: &'static str| {
        Reply::new()
            .tool("a", name, json!({"n": "a"}))
            .tool("b", name, json!({"n": "b"}))
            .done()
    };

    let (ctx, _) = agent(
        ScriptedModel::new([two("read"), Reply::new().text("x").done()]),
        vec![Slow {
            name: "read",
            delay,
            mutates: false,
        }],
    );
    let t = Instant::now();
    let r = run(&ctx, &CancellationToken::new()).await;
    assert!(
        t.elapsed() < delay * 2 - Duration::from_millis(20),
        "reads ran one after the other: {:?}",
        t.elapsed()
    );
    assert_eq!(
        results(&r.history).iter().map(|r| r.0).collect::<Vec<_>>(),
        ["a", "b"]
    );

    let (ctx, _) = agent(
        ScriptedModel::new([two("write"), Reply::new().text("x").done()]),
        vec![Slow {
            name: "write",
            delay,
            mutates: true,
        }],
    );
    let t = Instant::now();
    let r = run(&ctx, &CancellationToken::new()).await;
    assert!(
        t.elapsed() >= delay * 2,
        "writes overlapped: {:?}",
        t.elapsed()
    );
    assert_eq!(
        results(&r.history).iter().map(|r| r.0).collect::<Vec<_>>(),
        ["a", "b"]
    );
}

#[tokio::test]
async fn results_stay_in_call_order_even_when_they_finish_out_of_order() {
    // The first call is slower than the second; history must still list them as asked.
    struct Varying;
    impl Tool for Varying {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "v".into(),
                description: String::new(),
                schema: json!({}),
            }
        }
        fn mutates(&self) -> bool {
            false
        }
        fn call(&self, _: ToolCtx, a: Value) -> BoxFuture<'static, ToolOutput> {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(a["ms"].as_u64().unwrap())).await;
                ToolOutput::ok("ok")
            })
        }
    }
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("slow", "v", json!({"ms": 120}))
            .tool("fast", "v", json!({"ms": 5}))
            .done(),
        Reply::new().text("x").done(),
    ]));
    let mut registry = ToolRegistry::new();
    registry.register(Varying);
    let ctx = AgentContext {
        model,
        tools: Arc::new(registry),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
    };
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(
        results(&r.history).iter().map(|r| r.0).collect::<Vec<_>>(),
        ["slow", "fast"]
    );
    // ...while the events report each as soon as it is done.
    let order: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolResult { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(order, ["fast", "slow"]);
}

#[tokio::test]
async fn an_unknown_tool_is_an_error_result_not_the_end_of_the_turn() {
    let (ctx, _) = agent(
        ScriptedModel::new([
            Reply::new().tool("c1", "nope", json!({})).done(),
            Reply::new().text("sorry").done(),
        ]),
        vec![],
    );
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Completed);
    let res = results(&r.history);
    assert!(res[0].2 && res[0].1.contains("Unknown tool"), "{res:?}");
}

#[tokio::test]
async fn stopping_mid_reply_keeps_what_arrived() {
    let model = ScriptedModel::new([Reply::new().text("partial answer").then_hang()]);
    let (ctx, _) = agent(model, vec![]);
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        stopper.cancel();
    });
    let r = run(&ctx, &cancel).await;
    assert_eq!(r.outcome, TurnOutcome::Interrupted);
    match &r.history[..] {
        [Message::User { .. }, Message::Assistant(a)] => {
            assert_eq!(a.text(), "partial answer");
            assert_eq!(a.stop, StopReason::Aborted);
        }
        other => panic!("{other:?}"),
    }
    // The block that was open is closed, so a client does not leave it spinning.
    assert!(r.events.iter().any(|e| matches!(e, AgentEvent::BlockDone { block: ContentBlock::Text { text }, .. } if text == "partial answer")));
}

#[tokio::test]
async fn stopping_before_anything_arrives_leaves_no_empty_reply() {
    let (ctx, _) = agent(ScriptedModel::new([Reply::new().then_hang()]), vec![]);
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        stopper.cancel();
    });
    let r = run(&ctx, &cancel).await;
    assert_eq!(r.outcome, TurnOutcome::Interrupted);
    assert!(matches!(&r.history[..], [Message::User { .. }]));
}

#[tokio::test]
async fn stopping_during_a_tool_still_answers_every_call() {
    let model = ScriptedModel::new([Reply::new()
        .tool("c1", "slow", json!({}))
        .tool("c2", "slow", json!({}))
        .done()]);
    let (ctx, _) = agent(
        model,
        vec![Slow {
            name: "slow",
            delay: Duration::from_secs(30),
            mutates: true,
        }],
    );
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        stopper.cancel();
    });
    let t = Instant::now();
    let r = run(&ctx, &cancel).await;
    assert!(
        t.elapsed() < Duration::from_secs(2),
        "the stop did not reach the tools"
    );
    assert_eq!(r.outcome, TurnOutcome::Interrupted);
    let res = results(&r.history);
    assert_eq!(res.len(), 2);
    assert!(
        res.iter().all(|r| r.2 && r.1.contains("Stopped")),
        "{res:?}"
    );
    // Both calls were reported, so no client item is left running.
    let reported = r
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .count();
    assert_eq!(reported, 2);
}

#[tokio::test]
async fn model_failures_end_the_turn_with_the_reason() {
    let (ctx, _) = agent(
        ScriptedModel::new([Reply::new().text("half").then_fail("quota exceeded")]),
        vec![],
    );
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Failed("quota exceeded".into()));
    // What arrived before the failure is kept.
    assert!(
        matches!(&r.history[..], [Message::User { .. }, Message::Assistant(a)] if a.text() == "half")
    );

    // A stream that just stops, with no final message.
    let cut = vec![fv_agent::testing::Step::Event(fv_agent::ModelEvent::Text(
        "hi".into(),
    ))];
    let (ctx, _) = agent(ScriptedModel::new([cut]), vec![]);
    let r = run(&ctx, &CancellationToken::new()).await;
    assert!(matches!(r.outcome, TurnOutcome::Failed(m) if m.contains("ended before")));
}

#[test]
fn normalize_fills_gaps_and_drops_strays() {
    let call = |id: &str| ContentBlock::ToolCall {
        id: id.into(),
        name: "t".into(),
        arguments: json!({}),
    };
    let assistant = |content: Vec<ContentBlock>| {
        Message::Assistant(AssistantMessage {
            duration_ms: None,
            content,
            stop: StopReason::ToolUse,
            usage: Default::default(),
            model: None,
        })
    };
    let result = |id: &str| Message::ToolResult {
        call_id: id.into(),
        name: "t".into(),
        content: "r".into(),
        is_error: false,
    };
    let user = |t: &str| Message::User { text: t.into() };

    // c2 never got a result and the user spoke again; "ghost" answers nothing.
    let out = normalize(&[
        user("a"),
        assistant(vec![call("c1"), call("c2")]),
        result("c1"),
        result("ghost"),
        user("b"),
    ]);
    let shape: Vec<String> = out
        .iter()
        .map(|m| match m {
            Message::User { text } => format!("user:{text}"),
            Message::Assistant(_) => "assistant".into(),
            Message::ToolResult {
                call_id, is_error, ..
            } => format!("result:{call_id}:{is_error}"),
            Message::ToolImages { call_id, .. } => format!("images:{call_id}"),
            Message::Compaction { .. } => "compaction".into(),
            Message::MemoryContext { .. } => "memory".into(),
        })
        .collect();
    assert_eq!(
        shape,
        [
            "user:a",
            "assistant",
            "result:c1:false",
            "result:c2:true",
            "user:b"
        ]
    );

    // Calls left open at the very end are closed too.
    let out = normalize(&[user("a"), assistant(vec![call("c1")])]);
    assert!(
        matches!(out.last(), Some(Message::ToolResult { call_id, is_error: true, .. }) if call_id == "c1")
    );

    // Already well-formed history is returned unchanged.
    let fine = vec![user("a"), assistant(vec![call("c1")]), result("c1")];
    assert_eq!(normalize(&fine), fine);
}

#[tokio::test]
async fn request_timing_includes_first_token_wait_and_leaves_tool_execution_out() {
    let tool_delay = Duration::from_millis(250);
    let (ctx, _) = agent(
        ScriptedModel::new([
            Reply::new()
                .wait(Duration::from_millis(30))
                .tool("c", "slow", json!({"n":1}))
                .done(),
            Reply::new()
                .wait(Duration::from_millis(30))
                .text("done")
                .done(),
        ]),
        vec![Slow {
            name: "slow",
            delay: tool_delay,
            mutates: false,
        }],
    );
    let wall = Instant::now();
    let result = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(result.outcome, TurnOutcome::Completed);
    let times: Vec<_> = result
        .history
        .iter()
        .filter_map(|m| match m {
            Message::Assistant(a) => Some(a.duration_ms.expect("each completed request is timed")),
            _ => None,
        })
        .collect();
    assert_eq!(times.len(), 2);
    assert!(
        times.iter().all(|ms| *ms >= 30),
        "first token wait is part of each request"
    );
    assert!(
        wall.elapsed().as_millis() >= times.iter().sum::<u64>() as u128 + tool_delay.as_millis()
    );
}

/// A tool that steers while it runs — the only way to be certain the words arrived *during*
/// the turn rather than before it.
struct SteerDuring {
    steers: Arc<fv_agent::Steers>,
}

impl Tool for SteerDuring {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "steer_me".into(),
            description: "test".into(),
            schema: json!({"type": "object"}),
        }
    }
    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        let steers = self.steers.clone();
        Box::pin(async move {
            steers.push("do it the other way".into());
            ToolOutput::ok("ok")
        })
    }
}

/// Words said mid-run join the *same* turn, at the top of the next model request, after the
/// tool results — never between a call and its result.
#[tokio::test]
async fn a_steer_mid_run_is_sent_with_the_next_request_in_the_same_turn() {
    let steers = Arc::new(fv_agent::Steers::new());
    let model = Arc::new(ScriptedModel::new([
        Reply::new().tool("c1", "steer_me", json!({})).done(),
        Reply::new().text("ok then").done(),
    ]));
    let mut registry = ToolRegistry::new();
    registry.register(SteerDuring {
        steers: steers.clone(),
    });
    let ctx = AgentContext {
        model: model.clone(),
        tools: Arc::new(registry),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: Some(steers),
        memory: None,
        budget: Default::default(),
    };
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Completed);
    let requests = model.requests();
    assert_eq!(requests.len(), 2, "one turn, two requests");
    let second = &requests[1].messages;
    // The steer is in the request, and it comes after the tool result it was said during.
    let steer_at = second
        .iter()
        .position(|m| matches!(m, Message::User { text } if text == "do it the other way"));
    let result_at = second
        .iter()
        .position(|m| matches!(m, Message::ToolResult { call_id, .. } if call_id == "c1"));
    assert!(steer_at.is_some(), "{second:?}");
    assert!(result_at.unwrap() < steer_at.unwrap(), "{second:?}");
}

/// A steer that arrives once the model has already answered still runs: its words were never
/// seen by the request that answered, so the turn continues instead of ending.
#[tokio::test]
async fn a_steer_that_arrives_after_the_answer_keeps_the_turn_going() {
    let steers = Arc::new(fv_agent::Steers::new());
    // The answer is produced first; QueuedTool pushes a steer while that request's stream is
    // being consumed, which is after the request was built.
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("first answer").done(),
        Reply::new().text("second answer").done(),
    ]));
    let ctx = AgentContext {
        model: model.clone(),
        tools: Arc::new(ToolRegistry::new()),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: Some(steers.clone()),
        memory: None,
        budget: Default::default(),
    };
    // Push the words just before the run: a steer present at the top of the loop is drained
    // before the first request, so this covers the ordinary path; the late path is covered by
    // the server test where a real client races a real run.
    steers.push("stay on it".into());
    let r = run(&ctx, &CancellationToken::new()).await;
    assert_eq!(r.outcome, TurnOutcome::Completed);
    let requests = model.requests();
    assert!(
        requests[0]
            .messages
            .iter()
            .any(|m| matches!(m, Message::User { text } if text == "stay on it")),
        "{:?}",
        requests[0].messages
    );
}
