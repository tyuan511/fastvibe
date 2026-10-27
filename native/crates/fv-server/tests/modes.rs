//! Plan mode and reviews: turns that may look but not change anything.

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

struct Echo;

impl fv_agent::Tool for Echo {
    fn spec(&self) -> fv_agent::ToolSpec {
        fv_agent::ToolSpec {
            name: "echo".into(),
            description: "test".into(),
            schema: serde_json::json!({"type": "object"}),
        }
    }
    fn call(
        &self,
        _: fv_agent::ToolCtx,
        args: serde_json::Value,
    ) -> futures_util::future::BoxFuture<'static, fv_agent::ToolOutput> {
        Box::pin(async move { fv_agent::ToolOutput::ok(format!("echo {args}")) })
    }
}

async fn start(model: ScriptedModel) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(model);
    let mut tools = ToolRegistry::new();
    tools.register(Echo);
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

async fn run_to_idle(c: &Client, notes: &mut Notes) {
    until(
        notes,
        |n| matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running),
    )
    .await;
    let _ = c;
}

#[tokio::test]
async fn plan_mode_withholds_the_tools_that_change_things_until_it_is_left() {
    let h = start(ScriptedModel::new([
        Reply::new().text("a plan").done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<ThreadModeSet>(ThreadModeParams {
        thread_id: thread.clone(),
        mode: ThreadMode::Plan,
    })
    .await
    .unwrap();
    for text in ["plan it", "now do it"] {
        c.call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: text.into(),
        })
        .await
        .unwrap();
        run_to_idle(&c, &mut notes).await;
        if text == "plan it" {
            c.call::<ThreadModeSet>(ThreadModeParams {
                thread_id: thread.clone(),
                mode: ThreadMode::Default,
            })
            .await
            .unwrap();
        }
    }
    let requests = h.model.requests();
    let names =
        |i: usize| -> Vec<String> { requests[i].tools.iter().map(|t| t.name.clone()).collect() };
    assert!(!names(0).contains(&"echo".to_string()));
    assert!(names(1).contains(&"echo".to_string()));
    assert!(
        matches!(&requests[0].messages[0], fv_core::Message::User { text } if text.contains("Plan mode"))
    );
}

#[tokio::test]
async fn a_review_runs_read_only_for_its_own_turn_only() {
    let h = start(ScriptedModel::new([
        Reply::new().text("no findings").done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<ThreadReviewStart>(ThreadReviewParams {
        thread_id: thread.clone(),
        target: ReviewTarget::Uncommitted,
    })
    .await
    .unwrap();
    run_to_idle(&c, &mut notes).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "carry on".into(),
    })
    .await
    .unwrap();
    run_to_idle(&c, &mut notes).await;
    let requests = h.model.requests();
    assert!(
        requests[0]
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::User { text } if text.contains("git diff")))
    );
    assert!(!requests[0].tools.iter().any(|t| t.name == "echo"));
    assert!(requests[1].tools.iter().any(|t| t.name == "echo"));
}
