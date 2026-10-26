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
    connect_at(dir, "test.sock", model).await
}

async fn connect_at(
    dir: &Path,
    socket_name: &str,
    model: Arc<dyn Model>,
) -> (
    Client,
    UnboundedReceiver<ServerNotification>,
    Arc<ServerState>,
) {
    let state =
        Arc::new(ServerState::new(dir.into(), fv_server::agent_with_builtin_tools(model)).unwrap());
    common::disable_reply_suggestions(&state);
    let socket = dir.join(socket_name);
    tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, notes) = Client::connect_unix(&socket).await.unwrap();
    let initialized = client
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
    assert!(initialized.features.iter().any(|f| f == "autoCompaction"));
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

#[tokio::test]
async fn the_auto_compaction_setting_is_shared_live_and_restored_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let plan = || {
        Reply::new()
            .tool(
                "plan",
                "update_plan",
                serde_json::json!({"plan":[{"step":"work","status":"in_progress"}]}),
            )
            .input_tokens(61_000)
            .done()
    };
    let model = Arc::new(
        ScriptedModel::new([
            plan(),
            Reply::new().text("AUTO CHECKPOINT").done(),
            Reply::new().text("after enable").done(),
            Reply::new().text("MANUAL CHECKPOINT").done(),
        ])
        .with_window(64_000),
    );
    let (client, mut notes, _) = connect(dir.path(), model.clone()).await;
    assert!(
        client
            .call::<SettingsGet>(Empty {})
            .await
            .unwrap()
            .auto_compaction_enabled
    );
    let saved = client
        .call::<SettingsSet>(AppSettingsPatch {
            auto_compaction_enabled: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!saved.auto_compaction_enabled);
    // A separate client sees the same setting; unrelated patches do not reset it.
    let (other, mut other_notes) = Client::connect_unix(&dir.path().join("test.sock"))
        .await
        .unwrap();
    other
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "other".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    client
        .call::<SettingsSet>(AppSettingsPatch {
            glass: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    let heard = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ServerNotification::SettingsChanged(s)) = other_notes.recv().await {
                break s;
            }
        }
    })
    .await
    .unwrap();
    assert!(!heard.auto_compaction_enabled && heard.glass);
    let id = thread(&client).await;
    let events = say(&client, &mut notes, &id, "work").await;
    assert_eq!(status(&events), TurnStatus::Failed);
    assert!(events.iter().any(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(&e.body.item, Item::Error { message, .. } if message.contains("automatic compaction is disabled")))));
    assert_eq!(model.requests().len(), 1);
    assert!(!events.iter().any(|n| matches!(n, ServerNotification::ItemStarted(e) if matches!(e.body.item, Item::ContextCompaction { .. }))));
    other
        .call::<SettingsSet>(AppSettingsPatch {
            auto_compaction_enabled: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        status(&say(&client, &mut notes, &id, "continue").await),
        TurnStatus::Completed
    );
    assert_eq!(model.requests().len(), 3);
    client
        .call::<SettingsSet>(AppSettingsPatch {
            auto_compaction_enabled: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    client
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(status(&idle(&mut notes).await), TurnStatus::Completed);
    assert_eq!(
        model.requests().len(),
        4,
        "explicit compaction must still run while automatic compaction is off"
    );

    let restarted_model = Arc::new(
        ScriptedModel::new([plan(), Reply::new().text("must not summarize").done()])
            .with_window(64_000),
    );
    let (restarted, mut restarted_notes, _) =
        connect_at(dir.path(), "restarted.sock", restarted_model.clone()).await;
    let restored = restarted.call::<SettingsGet>(Empty {}).await.unwrap();
    assert!(!restored.auto_compaction_enabled && restored.glass);
    let events = say(&restarted, &mut restarted_notes, &id, "after restart").await;
    assert_eq!(status(&events), TurnStatus::Failed);
    assert!(events.iter().any(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(&e.body.item, Item::Error { message, .. } if message.contains("automatic compaction is disabled")))));
    assert_eq!(restarted_model.requests().len(), 1);
}
