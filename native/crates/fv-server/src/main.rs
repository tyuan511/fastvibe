//! `fastvibe-server --data-dir DIR [--listen unix|stdio] [--model echo]`
//!
//! `unix` (default) listens on `DIR/server.sock`; `stdio` serves one client on stdin/stdout,
//! which is how a server on an SSH host is reached (`ssh host fastvibe-server --listen stdio`).

use std::path::PathBuf;
use std::sync::Arc;

use fv_agent::testing::{EchoModel, NoModel};
use fv_agent::{AgentContext, Model, ToolRegistry};
use fv_protocol::types::ClientOrigin;
use fv_server::{ServerState, UnixServer, serve_connection};

enum Listen {
    Unix,
    Stdio,
}

fn usage() -> ! {
    eprintln!("usage: fastvibe-server --data-dir DIR [--listen unix|stdio] [--model echo]");
    std::process::exit(2)
}

#[tokio::main]
async fn main() {
    let mut data_dir = None;
    let mut listen = Listen::Unix;
    let mut echo = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--listen" => {
                listen = match args.next().as_deref() {
                    Some("unix") => Listen::Unix,
                    Some("stdio") => Listen::Stdio,
                    _ => usage(),
                }
            }
            "--model" => match args.next().as_deref() {
                Some("echo") => echo = true,
                _ => usage(),
            },
            _ => usage(),
        }
    }
    let Some(data_dir) = data_dir else { usage() };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("cannot create {}: {e}", data_dir.display());
        std::process::exit(1);
    }
    // No providers exist yet: without `--model echo` every turn fails saying so.
    let model: Arc<dyn Model> = if echo {
        Arc::new(EchoModel)
    } else {
        Arc::new(NoModel)
    };
    let agent = AgentContext {
        model,
        tools: Arc::new(ToolRegistry::new()),
        system: String::new(),
        cwd: None,
    };
    let state = Arc::new(ServerState::new(data_dir.clone(), agent));

    match listen {
        Listen::Stdio => {
            // stdout carries only protocol frames; anything human-readable goes to stderr.
            serve_connection(
                state,
                ClientOrigin::Ssh,
                tokio::io::stdin(),
                tokio::io::stdout(),
            )
            .await;
        }
        Listen::Unix => {
            let server = match UnixServer::bind(state, &data_dir.join("server.sock")).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            };
            eprintln!("listening on {}", server.path().display());
            tokio::select! {
                r = server.run() => { if let Err(e) = r { eprintln!("listener stopped: {e}"); std::process::exit(1); } }
                _ = tokio::signal::ctrl_c() => {}
            }
        }
    }
}
