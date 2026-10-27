//! `fastvibe-server --data-dir DIR [--listen unix|stdio] [--model echo | --protocol P --base-url URL --model-id ID [--thinking LEVEL]]`
//!
//! `unix` (default) listens on `DIR/server.sock`; `stdio` serves one client on stdin/stdout,
//! which is how a server on an SSH host is reached (`ssh host fastvibe-server --listen stdio`).
//!
//! Until providers are configured through the protocol, one model can be given on the command
//! line; its API key is read from `FV_API_KEY`, never from an argument.

use std::path::PathBuf;
use std::sync::Arc;

use fv_agent::Model;
use fv_agent::testing::{EchoModel, NoModel};
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
         \x20      [--model echo | --protocol chat|responses|anthropic|google --base-url URL --model-id ID [--thinking minimal|low|medium|high|xhigh|max] [--no-images]]"
    );
    std::process::exit(2)
}

fn print_help() -> ! {
    println!(
        "usage: fastvibe-server --data-dir DIR [--listen unix|stdio]\n\
         \x20      [--model echo | --protocol chat|responses|anthropic|google --base-url URL --model-id ID [--thinking minimal|low|medium|high|xhigh|max] [--no-images]]"
    );
    std::process::exit(0)
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

fn main() {
    if std::env::args().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
    }
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("fastvibe-server {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|error| fail(format!("cannot start runtime: {error}")));
    runtime.block_on(run());
    // Tokio's stdin reader uses a blocking OS read. In stdio mode it may still be waiting
    // for the SSH client's next frame when SIGTERM arrives. Cleanup above has finished;
    // never keep the whole server alive waiting for that pipe to close at runtime shutdown.
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
}

async fn run() {
    // Read before accepting clients: a later build may atomically replace this path.
    let _ = fv_server::build_fingerprint();
    let mut data_dir = None;
    let mut listen = Listen::Unix;
    let mut echo = false;
    let mut no_images = false;
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
            "--no-images" => no_images = true,
            _ => usage(),
        }
    }
    let Some(data_dir) = data_dir else { usage() };

    let environment = tokio::select! {
        environment = fv_env::initialize() => environment,
        _ = tokio::signal::ctrl_c() => return,
        _ = terminated() => return,
    };
    if let Some(warning) = environment.warning {
        eprintln!("{warning}");
    }

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
            config.images = !no_images;
            Arc::new(GenaiModel::new(config).unwrap_or_else(|e| fail(e)))
        }
        // No provider: every turn fails, saying so.
        (false, None, None, None) => Arc::new(NoModel),
        _ => usage(),
    };
    let agent = fv_server::agent_with_builtin_tools(model);
    let state = Arc::new(
        ServerState::new(data_dir.clone(), agent)
            .unwrap_or_else(|e| fail(format!("cannot open {}: {e}", data_dir.display()))),
    );

    match listen {
        Listen::Stdio => {
            state
                .schedules_recover()
                .unwrap_or_else(|e| fail(e.message));
            state
                .store
                .db
                .recover_subagents()
                .unwrap_or_else(|e| fail(e));
            state.schedules_recovery_complete();
            state.start_services();
            // stdout carries only protocol frames; anything human-readable goes to stderr.
            tokio::select! {
                _ = serve_connection(
                    state.clone(),
                    ClientOrigin::Ssh,
                    tokio::io::stdin(),
                    tokio::io::stdout(),
                ) => {},
                _ = tokio::signal::ctrl_c() => {},
                _ = terminated() => {},
            }
        }
        Listen::Unix => {
            let server = UnixServer::bind(state.clone(), &data_dir.join("server.sock"))
                .await
                .unwrap_or_else(|e| fail(e));
            state.start_services();
            eprintln!("listening on {}", server.path().display());
            tokio::select! {
                r = server.run() => { if let Err(e) = r { fail(format!("listener stopped: {e}")); } }
                _ = tokio::signal::ctrl_c() => {}
                _ = terminated() => {}
            }
        }
    }
    // A clean exit folds the write-ahead log back into the database file.
    state.shutdown_schedules().await;
    state.close_command_sessions();
    state.office.shutdown().await;
    let _ = state.store.db.checkpoint();
    state.mcp.shutdown().await;
    // `Terminals` kills every pty when it drops, which is what this line is for: a shell left
    // behind keeps its tty and any port it started open.
    drop(state);
}

/// Resolves on SIGTERM, which is how the app (or a service manager) asks the server to stop:
/// leaving through the normal path lets the database be folded back into its file.
async fn terminated() {
    use tokio::signal::unix::{SignalKind, signal};
    match signal(SignalKind::terminate()) {
        Ok(mut s) => {
            s.recv().await;
        }
        Err(_) => std::future::pending::<()>().await,
    }
}
