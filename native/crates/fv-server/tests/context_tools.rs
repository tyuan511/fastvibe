//! The tools that let the model see and reset its own context window.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{AgentContext, ToolRegistry};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use tokio::sync::mpsc::UnboundedReceiver;

mod common;

type Notes = UnboundedReceiver<ServerNotification>;

struct Harness {
    _dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    model: Arc<ScriptedModel>,
}

async fn start(model: ScriptedModel) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(model);
    let mut tools = ToolRegistry::new();
    tools.register(fv_tools::GetContextRemainingTool);
    tools.register(fv_tools::NewContextWindowTool);
    let agent = AgentContext {
        context: Default::default(),
        hooks: None,
        model: model.clone(),
        tools: Arc::new(tools),
        system: "sys".into(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
        compaction: None,
    };
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    common::disable_reply_suggestions(&state);
    let sock = dir.path().join("q.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Harness {
        _dir: dir,
        sock,
        model,
    }
}

async fn client(h: &Harness) -> (Client, Notes) {
    let (c, n) = Client::connect_unix(&h.sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "t".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    (c, n)
}

async fn new_thread(c: &Client) -> String {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: None,
        project: None,
        model: None,
        thinking: None,
    })
    .await
    .unwrap()
    .thread
    .id
}

async fn until(
    notes: &mut Notes,
    mut done: impl FnMut(&ServerNotification) -> bool,
) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), notes.recv())
            .await
            .expect("timed out waiting for a notification")
            .expect("connection closed");
        if matches!(n.method(), "catalog/changed" | "thread/started") {
            continue;
        }
        if std::env::var_os("FV_TEST_TRACE").is_some() {
            eprintln!(
                "NOTE {} {}",
                n.method(),
                serde_json::to_string(&n).unwrap_or_default()
            );
        }
        let stop = done(&n);
        seen.push(n);
        if stop {
            return seen;
        }
    }
}

#[tokio::test]
async fn the_model_can_read_its_window_and_start_a_new_one_from_its_own_summary() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "get_context_remaining", serde_json::json!({}))
            .done(),
        Reply::new()
            .tool(
                "c2",
                "new_context_window",
                serde_json::json!({"summary": "SUMMARY-MARKER: build is half done"}),
            )
            .done(),
        Reply::new().text("continuing").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "do the work".into(),
    })
    .await
    .unwrap();
    until(
        &mut notes,
        |n| matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running),
    )
    .await;
    let requests = h.model.requests();
    assert_eq!(requests.len(), 3);
    // The first answer carries the window report.
    let report = requests[1]
        .messages
        .iter()
        .find_map(|m| match m {
            fv_core::Message::ToolResult { content, .. } => Some(content.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        report.contains("tokens used") && report.contains("remaining"),
        "{report}"
    );
    // After the reset the model sees the summary and the user's words, not the old exchange.
    let last = &requests[2].messages;
    assert!(
        last.iter().any(
            |m| matches!(m, fv_core::Message::User { text } if text.contains("SUMMARY-MARKER"))
        )
    );
    assert!(
        !last
            .iter()
            .any(|m| matches!(m, fv_core::Message::ToolResult { .. }))
    );
}
