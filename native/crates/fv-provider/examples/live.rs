//! Runs one real turn (thinking, a tool call, the tool's result, the final answer) against a
//! real provider, through the same agent loop the server uses.
//!
//!   FV_API_KEY=... cargo run -p fv-provider --example live -- \
//!       --protocol chat|responses|anthropic|google --base-url URL --model ID [--thinking high]
//!
//! The key is read from the environment only and is never printed.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use fv_agent::{
    AgentContext, AgentEvent, Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec, TurnOutcome,
    run_turn,
};
use fv_core::Message;
use fv_provider::{GenaiModel, ModelConfig, Protocol, ThinkingLevel};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Add;

impl Tool for Add {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "add".into(),
            description: "Add two integers and return the sum.".into(),
            schema: json!({
                "type": "object",
                "properties": { "a": {"type": "integer"}, "b": {"type": "integer"} },
                "required": ["a", "b"]
            }),
        }
    }

    fn mutates(&self) -> bool {
        false
    }

    fn call(&self, _: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            match (args["a"].as_i64(), args["b"].as_i64()) {
                (Some(a), Some(b)) => ToolOutput::ok((a + b).to_string()),
                _ => ToolOutput::err(format!("expected integers a and b, got {args}")),
            }
        })
    }
}

#[tokio::main]
async fn main() {
    let (mut protocol, mut base, mut model, mut thinking) = (None, None, None, None);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut next = || args.next().expect("missing value");
        match a.as_str() {
            "--protocol" => {
                protocol = Some(match next().as_str() {
                    "chat" => Protocol::OpenAiChat,
                    "responses" => Protocol::OpenAiResponses,
                    "anthropic" => Protocol::Anthropic,
                    "google" => Protocol::Google,
                    other => panic!("unknown protocol {other}"),
                })
            }
            "--base-url" => base = Some(next()),
            "--model" => model = Some(next()),
            "--thinking" => {
                thinking = Some(match next().as_str() {
                    "minimal" => ThinkingLevel::Minimal,
                    "low" => ThinkingLevel::Low,
                    "medium" => ThinkingLevel::Medium,
                    "high" => ThinkingLevel::High,
                    "xhigh" => ThinkingLevel::Xhigh,
                    "max" => ThinkingLevel::Max,
                    other => panic!("unknown thinking level {other}"),
                })
            }
            other => panic!("unknown argument {other}"),
        }
    }
    let key = std::env::var("FV_API_KEY").expect("set FV_API_KEY");
    let (protocol, base, model) = (
        protocol.expect("--protocol"),
        base.expect("--base-url"),
        model.expect("--model"),
    );

    let mut config = ModelConfig::new(&format!("live/{model}"), &model, protocol, &base, &key);
    config.thinking = thinking;
    let provider = GenaiModel::new(config).expect("model");

    let mut tools = ToolRegistry::new();
    tools.register(Add);
    let ctx = AgentContext {
        model: Arc::new(provider),
        tools: Arc::new(tools),
        system: "You are a careful assistant. Use the add tool for arithmetic.".into(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let printer = tokio::spawn(async move {
        let (mut thinking_chars, mut text_chars, mut calls) = (0, 0, 0);
        while let Some(e) = rx.recv().await {
            match e {
                AgentEvent::ContextBudgetChanged { used, window } => {
                    println!("  context {used}/{window}")
                }
                AgentEvent::BlockDelta { delta, .. } => text_chars += delta.len(),
                AgentEvent::BlockStarted { kind, .. } => println!("  start {kind:?}"),
                AgentEvent::BlockDone { block, .. } => {
                    if let fv_core::ContentBlock::Thinking { text, signature } = &block {
                        thinking_chars += text.len();
                        println!(
                            "  thinking done ({} chars, signature: {})",
                            text.len(),
                            signature.is_some()
                        );
                    }
                }
                AgentEvent::ToolResult {
                    name,
                    arguments,
                    output,
                    is_error,
                    ..
                } => {
                    calls += 1;
                    println!("  tool {name}({arguments}) -> {output} (error: {is_error})");
                }
                AgentEvent::Committed(_)
                | AgentEvent::CompactionStarted { .. }
                | AgentEvent::CompactionDone { .. }
                | AgentEvent::CompactionFailed { .. } => {}
                AgentEvent::MessageDone(m) => {
                    println!("  request done: stop={:?} usage={:?}", m.stop, m.usage)
                }
            }
        }
        (thinking_chars, text_chars, calls)
    });

    let mut history = Vec::new();
    let started = std::time::Instant::now();
    let outcome = run_turn(
        &ctx,
        &mut history,
        "What is 1234 + 8765? Use the add tool, then tell me the result in one sentence.".into(),
        &tx,
        &CancellationToken::new(),
    )
    .await;
    drop(tx);
    let (thinking_chars, text_chars, calls) = printer.await.unwrap();

    println!(
        "outcome: {outcome:?} in {:.1}s",
        started.elapsed().as_secs_f32()
    );
    println!("streamed {text_chars} chars, {thinking_chars} of thinking, {calls} tool call(s)");
    if let Some(Message::Assistant(a)) = history
        .iter()
        .rev()
        .find(|m| matches!(m, Message::Assistant(_)))
    {
        println!("answer: {}", a.text());
    }
    if outcome != TurnOutcome::Completed {
        std::process::exit(1);
    }
}
