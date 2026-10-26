use futures_util::{StreamExt, stream::BoxStream};
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{Model, ModelError, ModelEvent, ModelRequest, SUMMARIZATION_PROMPT};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

mod common;

async fn connect(
    dir: &Path,
    model: Arc<dyn Model>,
) -> (
    Client,
    UnboundedReceiver<ServerNotification>,
    Arc<ServerState>,
) {
    let state =
        Arc::new(ServerState::new(dir.into(), fv_server::agent_with_builtin_tools(model)).unwrap());
    common::disable_reply_suggestions(&state);
    let socket = dir.join("test.sock");
    tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, notes) = Client::connect_unix(&socket).await.unwrap();
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    (client, notes, state)
}
async fn thread(client: &Client) -> String {
    client
        .call::<ThreadStart>(ThreadStartParams {
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
async fn idle(notes: &mut UnboundedReceiver<ServerNotification>) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let note = tokio::time::timeout(Duration::from_secs(15), notes.recv())
            .await
            .unwrap()
            .unwrap();
        let done = matches!(&note, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
        seen.push(note);
        if done {
            return seen;
        }
    }
}
async fn say(
    client: &Client,
    notes: &mut UnboundedReceiver<ServerNotification>,
    id: &str,
    text: &str,
) -> Vec<ServerNotification> {
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id.into(),
            text: text.into(),
        })
        .await
        .unwrap();
    idle(notes).await
}
async fn window(client: &Client, id: &str) -> u64 {
    client
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: id.into(),
        })
        .await
        .unwrap()
        .token_usage
        .unwrap()
        .window
}
fn status(notes: &[ServerNotification]) -> TurnStatus {
    notes
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnCompleted(e) => Some(e.body.status),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn learned_windows_are_reported_in_pushes_and_resumes_and_do_not_leak_to_other_threads() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(
        ScriptedModel::new([
            Reply::new()
                .tool(
                    "plan",
                    "update_plan",
                    serde_json::json!({"plan":[{"step":"work","status":"in_progress"}]}),
                )
                .input_tokens(32_000)
                .done(),
            Reply::new().then_overflow(),
            Reply::new().text("CHECKPOINT").done(),
            Reply::new().text("finished").done(),
            Reply::new().text("other thread").done(),
            Reply::new().then_fail("401 auth"),
        ])
        .with_window(1_000_000),
    );
    let (client, mut notes, _) = connect(dir.path(), model).await;
    let a = thread(&client).await;
    let b = thread(&client).await;
    let events = say(&client, &mut notes, &a, "work").await;
    assert_eq!(status(&events), TurnStatus::Completed, "{events:?}");
    let learned = window(&client, &a).await;
    assert!(learned < 1_000_000);
    assert!(events.iter().any(
        |n| matches!(n, ServerNotification::ThreadTokenUsageUpdated(e) if e.body.window == learned)
    ));
    assert_eq!(
        status(&say(&client, &mut notes, &b, "independent").await),
        TurnStatus::Completed
    );
    assert_eq!(window(&client, &b).await, 1_000_000);
    client
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: a.clone(),
        })
        .await
        .unwrap();
    assert_eq!(status(&idle(&mut notes).await), TurnStatus::Failed);
    assert_eq!(
        window(&client, &a).await,
        learned,
        "auth failure discarded the prior guard"
    );
}

struct CapacityGate {
    refuse: AtomicBool,
    requests: Mutex<Vec<ModelRequest>>,
}
impl Model for CapacityGate {
    fn context_window(&self) -> Option<u32> {
        Some(1_000_000)
    }
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let summary = matches!(request.messages.last(), Some(fv_core::Message::User { text }) if text == SUMMARIZATION_PROMPT);
        self.requests.lock().unwrap().push(request.clone());
        if self.refuse.load(Ordering::SeqCst) {
            futures_util::stream::once(async {
                Err(ModelError::context_overflow("actual endpoint capacity"))
            })
            .boxed()
        } else {
            ScriptedModel::new([Reply::new()
                .text(if summary {
                    "CHECKPOINT: recovered"
                } else {
                    "done"
                })
                .done()])
            .stream(request)
        }
    }
}

#[tokio::test]
async fn exhausted_capacity_fails_visibly_and_manual_compaction_unlocks_the_real_protocol() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(CapacityGate {
        refuse: AtomicBool::new(true),
        requests: Mutex::default(),
    });
    let (client, mut notes, state) = connect(dir.path(), model.clone()).await;
    let id = thread(&client).await;
    let events = say(&client, &mut notes, &id, "work").await;
    assert_eq!(status(&events), TurnStatus::Failed);
    assert!(events.iter().any(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(e.body.item, Item::Error { .. }))));
    let calls = model.requests.lock().unwrap().len();
    assert!(calls <= 7);
    assert_eq!(
        status(&say(&client, &mut notes, &id, "continue").await),
        TurnStatus::Failed
    );
    assert_eq!(model.requests.lock().unwrap().len(), calls);
    assert!(!state.runtime(&id).is_running());
    model.refuse.store(false, Ordering::SeqCst);
    client
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: id.clone(),
        })
        .await
        .unwrap();
    let compacted = idle(&mut notes).await;
    assert_eq!(status(&compacted), TurnStatus::Completed);
    let pushed = compacted
        .iter()
        .rev()
        .find_map(|n| match n {
            ServerNotification::ThreadTokenUsageUpdated(e) => Some(e.body),
            _ => None,
        })
        .unwrap();
    let snapshot = client
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        snapshot.token_usage,
        Some(pushed),
        "resume must use the same request projection as the last push"
    );
    assert_eq!(window(&client, &id).await, 1_000_000);
    assert_eq!(
        status(&say(&client, &mut notes, &id, "finish").await),
        TurnStatus::Completed
    );
    let loaded = state.store.transcripts.read(&id).unwrap();
    assert!(loaded.messages.iter().any(|m| matches!(m, fv_core::Message::Compaction { user_messages, .. } if user_messages == &["work", "continue"])));
}
