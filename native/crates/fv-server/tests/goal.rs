//! A conversation's goal: rounds follow one another by themselves until the model says it is done.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{NoModel, Reply, ScriptedModel};
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
    tools.register(fv_tools::GoalCompleteTool);
    let agent = AgentContext {
        context: Default::default(),
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

fn idle(n: &ServerNotification) -> bool {
    matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running)
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

async fn goal_of(c: &Client, thread: &str) -> Option<Goal> {
    c.call::<ThreadResume>(ThreadIdParams {
        thread_id: thread.into(),
    })
    .await
    .unwrap()
    .goal
}

#[tokio::test]
async fn rounds_follow_each_other_until_the_model_declares_the_goal_done() {
    let h = start(ScriptedModel::new([
        Reply::new().text("round one").done(),
        Reply::new()
            .tool("g1", "goal_complete", serde_json::json!({}))
            .done(),
        Reply::new().text("all done").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<ThreadGoalSet>(GoalSetParams {
        thread_id: thread.clone(),
        objective: "ship it".into(),
    })
    .await
    .unwrap();
    // Idle only once, at the end of the last round: the rounds are one stretch of work.
    let seen = until(&mut notes, |n| {
        matches!(n, ServerNotification::ThreadGoalChanged(e) if matches!(&e.body.goal, Some(g) if g.status == GoalStatus::Complete))
    })
    .await;
    let rounds: Vec<u32> = seen
        .iter()
        .filter_map(|n| match n {
            ServerNotification::ThreadGoalChanged(e) => e.body.goal.as_ref().map(|g| g.round),
            _ => None,
        })
        .collect();
    assert_eq!(rounds, vec![1, 2, 2]);
    assert_eq!(
        goal_of(&c, &thread).await.unwrap().status,
        GoalStatus::Complete
    );
    // The model heard the goal on every round, and could end it only while it ran.
    let requests = h.model.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().all(|r| matches!(&r.messages[0], fv_core::Message::User { text } if text.contains("Long-term goal: ship it"))));
    assert!(requests[0].tools.iter().any(|t| t.name == "goal_complete"));
}

#[tokio::test]
async fn a_stopped_goal_is_paused_and_a_cleared_one_is_gone() {
    let h = start(ScriptedModel::new([Reply::new().text("one").done()])).await;
    let (c, _notes) = client(&h).await;
    let thread = new_thread(&c).await;
    assert!(goal_of(&c, &thread).await.is_none());
    c.call::<ThreadGoalSet>(GoalSetParams {
        thread_id: thread.clone(),
        objective: "x".into(),
    })
    .await
    .unwrap();
    c.call::<ThreadGoalPause>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    assert_eq!(
        goal_of(&c, &thread).await.unwrap().status,
        GoalStatus::Paused
    );
    c.call::<ThreadGoalClear>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    assert!(goal_of(&c, &thread).await.is_none());
}
