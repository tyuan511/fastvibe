//! Hooks from `hooks.json`: block a tool, rewrite its input, add to its result, keep a turn going.

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

const HOOKS: &str = r#"{"hooks": {
  "PreToolUse": [
    {"matcher": "echo", "hooks": [{"type": "command", "command": "cat >/dev/null; case \"$FV_MODE\" in *) echo '{\"updatedInput\":{\"n\":42}}';; esac"}]}
  ],
  "PostToolUse": [
    {"matcher": "echo", "hooks": [{"type": "command", "command": "cat >/dev/null; echo '{\"additionalContext\":\"checked\"}'"}]}
  ]
}}"#;

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
    std::fs::write(dir.path().join("hooks.json"), HOOKS).unwrap();
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
async fn hooks_rewrite_a_tools_input_and_add_to_its_result() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "echo", serde_json::json!({"n": 1}))
            .done(),
        Reply::new().text("ok").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    until(
        &mut notes,
        |n| matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running),
    )
    .await;
    let requests = h.model.requests();
    let result = requests[1]
        .messages
        .iter()
        .find_map(|m| match m {
            fv_core::Message::ToolResult { content, .. } => Some(content.clone()),
            _ => None,
        })
        .unwrap();
    assert!(result.contains(r#"echo {"n":42}"#), "{result}");
    assert!(result.contains("[hook] checked"), "{result}");
}

#[tokio::test]
async fn a_hook_that_exits_with_two_blocks_the_tool() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "echo", serde_json::json!({"n": 1}))
            .done(),
        Reply::new().text("ok").done(),
    ]))
    .await;
    std::fs::write(
        h._dir.path().join("hooks.json"),
        r#"{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"cat >/dev/null; echo 'no echoing' >&2; exit 2"}]}]}}"#,
    )
    .unwrap();
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    until(
        &mut notes,
        |n| matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running),
    )
    .await;
    let requests = h.model.requests();
    let result = requests[1]
        .messages
        .iter()
        .find_map(|m| match m {
            fv_core::Message::ToolResult {
                content, is_error, ..
            } => Some((content.clone(), *is_error)),
            _ => None,
        })
        .unwrap();
    assert_eq!(result, ("Blocked by a hook: no echoing".to_string(), true));
}
