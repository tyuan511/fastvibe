//! `fastvibe-server --data-dir DIR [--listen unix|stdio] [--model echo | --protocol P --base-url URL --model-id ID [--thinking LEVEL]]`
//!
//! `unix` (default) listens on `DIR/server.sock`; `stdio` serves one client on stdin/stdout,
//! which is how a server on an SSH host is reached (`ssh host fastvibe-server --listen stdio`).
//!
//! Until providers are configured through the protocol, one model can be given on the command
//! line; its API key is read from `FV_API_KEY`, never from an argument.

use std::path::PathBuf;
use std::sync::Arc;

use fv_agent::testing::{EchoModel, NoModel};
use fv_agent::{AgentContext, Model, ToolRegistry};
use fv_protocol::types::ClientOrigin;
use fv_provider::{GenaiModel, ModelConfig, Protocol, ThinkingLevel};
use fv_server::{ServerState, UnixServer, serve_connection};

enum Listen {
    Unix,
    Stdio,
}

fn usage() -> ! {
    eprintln!(
        "usage: fastvibe-server --data-dir DIR [--listen unix|stdio]\n\
         \x20      [--model echo | --protocol chat|responses|anthropic|google --base-url URL --model-id ID [--thinking minimal|low|medium|high|xhigh|max]]"
    );
    std::process::exit(2)
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(1)
}

fn protocol(name: &str) -> Protocol {
    match name {
        "chat" => Protocol::OpenAiChat,
        "responses" => Protocol::OpenAiResponses,
        "anthropic" => Protocol::Anthropic,
        "google" => Protocol::Google,
        _ => usage(),
    }
}

fn thinking(name: &str) -> ThinkingLevel {
    match name {
        "minimal" => ThinkingLevel::Minimal,
        "low" => ThinkingLevel::Low,
        "medium" => ThinkingLevel::Medium,
        "high" => ThinkingLevel::High,
        "xhigh" => ThinkingLevel::Xhigh,
        "max" => ThinkingLevel::Max,
        _ => usage(),
    }
}

#[tokio::main]
async fn main() {
    let mut data_dir = None;
    let mut listen = Listen::Unix;
    let mut echo = false;
    let (mut proto, mut base_url, mut model_id, mut level) = (None, None, None, None);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().unwrap_or_else(|| usage());
        match arg.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value())),
            "--listen" => {
                listen = match value().as_str() {
                    "unix" => Listen::Unix,
                    "stdio" => Listen::Stdio,
                    _ => usage(),
                }
            }
            "--model" if value() == "echo" => echo = true,
            "--protocol" => proto = Some(protocol(&value())),
            "--base-url" => base_url = Some(value()),
            "--model-id" => model_id = Some(value()),
            "--thinking" => level = Some(thinking(&value())),
            _ => usage(),
        }
    }
    let Some(data_dir) = data_dir else { usage() };

    let model: Arc<dyn Model> = match (echo, proto, base_url, model_id) {
        (true, None, None, None) => Arc::new(EchoModel),
        (false, Some(protocol), Some(base_url), Some(model_id)) => {
            let key = std::env::var("FV_API_KEY").unwrap_or_else(|_| fail("set FV_API_KEY"));
            let mut config = ModelConfig::new(
                &format!("cli/{model_id}"),
                &model_id,
                protocol,
                &base_url,
                &key,
            );
            config.thinking = level;
            Arc::new(GenaiModel::new(config).unwrap_or_else(|e| fail(e)))
        }
        // No provider: every turn fails, saying so.
        (false, None, None, None) => Arc::new(NoModel),
        _ => usage(),
    };
    let agent = AgentContext {
        model,
        tools: Arc::new(ToolRegistry::new()),
        system: String::new(),
        cwd: None,
    };
    let state = Arc::new(
        ServerState::new(data_dir.clone(), agent)
            .unwrap_or_else(|e| fail(format!("cannot open {}: {e}", data_dir.display()))),
    );

    match listen {
        Listen::Stdio => {
            // stdout carries only protocol frames; anything human-readable goes to stderr.
            serve_connection(
                state.clone(),
                ClientOrigin::Ssh,
                tokio::io::stdin(),
                tokio::io::stdout(),
            )
            .await;
        }
        Listen::Unix => {
            let server = UnixServer::bind(state.clone(), &data_dir.join("server.sock"))
                .await
                .unwrap_or_else(|e| fail(e));
            eprintln!("listening on {}", server.path().display());
            tokio::select! {
                r = server.run() => { if let Err(e) = r { fail(format!("listener stopped: {e}")); } }
                _ = tokio::signal::ctrl_c() => {}
            }
        }
    }
    // A clean exit folds the write-ahead log back into the database file.
    let _ = state.store.db.checkpoint();
}
