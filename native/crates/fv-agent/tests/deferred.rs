//! Deferred tools, and pictures a tool returns.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{
    AgentContext, AgentEvent, LoadedTools, Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec,
    TurnOutcome, run_turn,
};
use fv_core::{ImagePart, ImageSource, Message};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Hidden;

impl Tool for Hidden {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "hidden".into(),
            description: "A tool nobody is told about".into(),
            schema: json!({"type": "object"}),
        }
    }
    fn deferred(&self) -> bool {
        true
    }
    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok("hidden ran") })
    }
}

/// Stands in for `tool_search`: loads the deferred tool.
struct Finder;

impl Tool for Finder {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "finder".into(),
            description: "finds".into(),
            schema: json!({"type": "object"}),
        }
    }
    fn call(&self, ctx: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            ctx.loaded.load(["hidden".to_string()]);
            ToolOutput::ok("found hidden")
        })
    }
}

/// Returns a picture.
struct Camera;

impl Tool for Camera {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "camera".into(),
            description: "takes a picture".into(),
            schema: json!({"type": "object"}),
        }
    }
    fn mutates(&self) -> bool {
        false
    }
    fn call(&self, ctx: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            if !ctx.vision {
                return ToolOutput::err("no vision");
            }
            let picture = ImagePart {
                mime: "image/png".into(),
                source: ImageSource::Base64 {
                    data: args["data"].as_str().unwrap_or("").into(),
                },
            };
            ToolOutput::ok("took a picture").with_images(vec![picture])
        })
    }
}

fn agent(model: ScriptedModel) -> (AgentContext, Arc<ScriptedModel>) {
    let model = Arc::new(model);
    let mut tools = ToolRegistry::new();
    tools.register(Hidden).register(Finder).register(Camera);
    (
        AgentContext {
            context: Default::default(),
            model: model.clone(),
            tools: Arc::new(tools),
            system: String::new(),
            cwd: None,
            ui: None,
            loaded: LoadedTools::default(),
            permissions: None,
            steer: None,
            memory: None,
            budget: Default::default(),
            compaction: None,
        },
        model,
    )
}

async fn run(ctx: &AgentContext) -> (TurnOutcome, Vec<Message>, Vec<AgentEvent>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut history = Vec::new();
    let outcome = run_turn(
        ctx,
        &mut history,
        "go".into(),
        &tx,
        &CancellationToken::new(),
    )
    .await;
    drop(tx);
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    (outcome, history, events)
}

fn offered(request: &fv_agent::ModelRequest) -> Vec<&str> {
    request.tools.iter().map(|t| t.name.as_str()).collect()
}

#[tokio::test]
async fn a_deferred_tool_is_offered_only_after_it_is_found() {
    let (ctx, model) = agent(ScriptedModel::new([
        Reply::new().tool("c1", "finder", json!({})).done(),
        Reply::new().tool("c2", "hidden", json!({})).done(),
        Reply::new().text("done").done(),
    ]));
    let (outcome, history, _) = run(&ctx).await;
    assert_eq!(outcome, TurnOutcome::Completed);

    let requests = model.requests();
    assert_eq!(
        offered(&requests[0]),
        ["camera", "finder"],
        "the deferred tool was described up front"
    );
    assert_eq!(
        offered(&requests[1]),
        ["camera", "finder", "hidden"],
        "the found tool was not offered"
    );
    let ran = history.iter().any(|m| matches!(m, Message::ToolResult { call_id, content, is_error: false, .. } if call_id == "c2" && content == "hidden ran"));
    assert!(ran, "{history:?}");
}

#[tokio::test]
async fn calling_a_deferred_tool_that_was_never_found_says_how_to_find_it() {
    let (ctx, _) = agent(ScriptedModel::new([
        Reply::new().tool("c1", "hidden", json!({})).done(),
        Reply::new().text("ok").done(),
    ]));
    let (_, history, _) = run(&ctx).await;
    let result = history.iter().find_map(|m| match m {
        Message::ToolResult {
            content, is_error, ..
        } => Some((content.clone(), *is_error)),
        _ => None,
    });
    let (content, is_error) = result.unwrap();
    assert!(
        is_error && content.contains("not loaded yet") && content.contains("tool_search"),
        "{content}"
    );
}

#[tokio::test]
async fn pictures_follow_all_the_tool_results_of_their_batch() {
    // Two calls, only the first returns a picture; the picture must not come between them.
    let (ctx, _) = agent(ScriptedModel::new([
        Reply::new()
            .tool("p1", "camera", json!({"data": "AAAA"}))
            .tool("f1", "finder", json!({}))
            .done(),
        Reply::new().text("seen").done(),
    ]));
    let (_, history, events) = run(&ctx).await;
    let shape: Vec<&str> = history
        .iter()
        .map(|m| match m {
            Message::User { .. } => "user",
            Message::Assistant(_) => "assistant",
            Message::ToolResult { call_id, .. } => {
                if call_id == "p1" {
                    "result:p1"
                } else {
                    "result:f1"
                }
            }
            Message::ToolImages { .. } => "images",
            Message::ToolAudio { .. } => "audio",
            Message::Compaction { .. } => "compaction",
            Message::MemoryContext { .. } => "memory",
        })
        .collect();
    assert_eq!(
        shape,
        [
            "user",
            "assistant",
            "result:p1",
            "result:f1",
            "images",
            "assistant"
        ]
    );

    // What was committed is what the history holds, pictures included.
    let committed: Vec<Message> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Committed(m) => Some(m.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(committed, history);
    assert!(
        matches!(&history[4], Message::ToolImages { call_id, name, images } if call_id == "p1" && name == "camera" && images.len() == 1)
    );
}

#[tokio::test]
async fn pictures_are_not_sent_back_as_a_tool_result_the_model_never_made() {
    // A call that returned nothing visual adds no picture message.
    let (ctx, _) = agent(ScriptedModel::new([
        Reply::new().tool("f1", "finder", json!({})).done(),
        Reply::new().text("x").done(),
    ]));
    let (_, history, _) = run(&ctx).await;
    assert!(
        !history
            .iter()
            .any(|m| matches!(m, Message::ToolImages { .. }))
    );
}
