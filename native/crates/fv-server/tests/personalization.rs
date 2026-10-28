//! Public settings calls must change the instructions of real turns, without editing history.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use tokio::sync::mpsc::UnboundedReceiver;

mod common;

type Notes = UnboundedReceiver<ServerNotification>;

async fn client(socket: &Path) -> (Client, Notes) {
    let (client, notes) = Client::connect_unix(socket).await.unwrap();
    let initialized = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "personalization-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(initialized.features.iter().any(|s| s == "personalization"));
    (client, notes)
}

async fn serve(dir: &Path, name: &str, agent: fv_agent::AgentContext) -> (Client, Notes) {
    let state = Arc::new(ServerState::new(dir.into(), agent).unwrap());
    common::disable_reply_suggestions(&state);
    let socket = dir.join(name);
    tokio::spawn(UnixServer::bind(state, &socket).await.unwrap().run());
    client(&socket).await
}

async fn idle(notes: &mut Notes) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut completed = false;
        loop {
            match notes.recv().await.expect("server connection closed") {
                ServerNotification::TurnCompleted(e) => {
                    assert_eq!(e.body.status, TurnStatus::Completed);
                    completed = true;
                }
                ServerNotification::ThreadStatusChanged(e) if completed && !e.body.running => break,
                _ => (),
            }
        }
    })
    .await
    .expect("turn completed and went idle");
}

async fn say(client: &Client, notes: &mut Notes, id: &str, text: &str) {
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id.into(),
            text: text.into(),
        })
        .await
        .unwrap();
    idle(notes).await;
}

async fn new_thread(client: &Client, cwd: Option<String>) -> String {
    client
        .call::<ThreadStart>(ThreadStartParams {
            cwd,
            ..Default::default()
        })
        .await
        .unwrap()
        .thread
        .id
}

async fn set_prompt(client: &Client, text: &str) -> AppSettings {
    client
        .call::<SettingsSet>(AppSettingsPatch {
            custom_system_prompt: Some(text.into()),
            ..Default::default()
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn personalization_is_broadcast_persisted_and_concurrent_saves_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let agent = || fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let (a, _) = serve(dir.path(), "first.sock", agent()).await;
    let (b, mut notes) = client(&dir.path().join("first.sock")).await;
    assert!(
        a.call::<SettingsGet>(Empty {})
            .await
            .unwrap()
            .custom_system_prompt
            .is_empty()
    );
    let first = "  第一份说明。\nPreserve API names.\n";
    assert_eq!(set_prompt(&a, first).await.custom_system_prompt, first);
    let heard = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ServerNotification::SettingsChanged(s)) = notes.recv().await {
                break s;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(heard.custom_system_prompt, first);
    set_prompt(&b, "other window").await;
    let stale = a
        .call::<SettingsSet>(AppSettingsPatch {
            custom_system_prompt: Some("lost update".into()),
            expected_custom_system_prompt: Some(first.into()),
            glass: Some(true),
            ..Default::default()
        })
        .await;
    assert!(stale.is_err());
    let current = a.call::<SettingsGet>(Empty {}).await.unwrap();
    assert_eq!(current.custom_system_prompt, "other window");
    assert!(
        !current.glass,
        "a rejected patch must not write its other fields"
    );
    assert!(
        a.call::<SettingsSet>(AppSettingsPatch {
            expected_custom_system_prompt: Some("other window".into()),
            ..Default::default()
        })
        .await
        .is_err()
    );
    let changed = a
        .call::<SettingsSet>(AppSettingsPatch {
            glass: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(changed.custom_system_prompt, "other window");
    let (restored, _) = serve(dir.path(), "restarted.sock", agent()).await;
    let settings = restored.call::<SettingsGet>(Empty {}).await.unwrap();
    assert_eq!(settings.custom_system_prompt, "other window");
    assert!(settings.glass);
    restored
        .call::<SettingsSet>(AppSettingsPatch {
            custom_system_prompt: Some(String::new()),
            expected_custom_system_prompt: Some("other window".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let (cleared, _) = serve(dir.path(), "cleared.sock", agent()).await;
    assert!(
        cleared
            .call::<SettingsGet>(Empty {})
            .await
            .unwrap()
            .custom_system_prompt
            .is_empty()
    );
}

#[tokio::test]
async fn existing_and_new_threads_use_the_latest_suffix_without_polluting_transcripts() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("AGENTS.md"), "PROJECT_INSTRUCTIONS").unwrap();
    let model = Arc::new(ScriptedModel::new(
        (0..5).map(|_| Reply::new().text("ok").done()),
    ));
    let mut agent = fv_server::agent_with_builtin_tools(model.clone());
    agent.system = "SERVER_INSTRUCTIONS".into();
    let (c, mut notes) = serve(dir.path(), "s.sock", agent).await;
    let id = new_thread(&c, Some(workspace.path().display().to_string())).await;
    set_prompt(&c, "  FIRST_CUSTOM_INSTRUCTIONS\n").await;
    say(&c, &mut notes, &id, "one").await;
    let request = &model.requests()[0];
    assert!(request.system.starts_with("You are FastVibe"));
    assert!(
        request
            .project_context()
            .is_some_and(|c| c.contains("PROJECT_INSTRUCTIONS"))
    );
    // The AI 偏好语言 requirement sits between the server's instructions and the user's own.
    assert!(
        request
            .system
            .contains("SERVER_INSTRUCTIONS\n\nLanguage requirement:")
    );
    assert!(
        request
            .system
            .ends_with("before this one.\n\nFIRST_CUSTOM_INSTRUCTIONS")
    );
    assert_eq!(
        request.system.matches("FIRST_CUSTOM_INSTRUCTIONS").count(),
        1
    );
    set_prompt(&c, "SECOND_CUSTOM_INSTRUCTIONS").await;
    say(&c, &mut notes, &id, "two").await;
    let other = new_thread(&c, None).await;
    say(&c, &mut notes, &other, "another thread").await;
    for request in &model.requests()[1..3] {
        assert!(request.system.ends_with("SECOND_CUSTOM_INSTRUCTIONS"));
        assert!(!request.system.contains("FIRST_CUSTOM_INSTRUCTIONS"));
        assert_eq!(
            request.system.matches("SECOND_CUSTOM_INSTRUCTIONS").count(),
            1
        );
    }
    c.call::<ThreadCompactStart>(ThreadIdParams {
        thread_id: id.clone(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    assert!(
        model.requests()[3]
            .system
            .contains("SECOND_CUSTOM_INSTRUCTIONS")
    );
    set_prompt(&c, " \n\t").await;
    say(&c, &mut notes, &id, "three").await;
    let request = &model.requests()[4];
    assert!(
        request
            .system
            .contains("SERVER_INSTRUCTIONS\n\nLanguage requirement:")
    );
    assert!(request.system.ends_with("before this one."));
    assert!(!request.system.contains("CUSTOM_INSTRUCTIONS"));
    let transcript =
        std::fs::read_to_string(dir.path().join("sessions").join(format!("{id}.jsonl"))).unwrap();
    assert!(!transcript.contains("CUSTOM_INSTRUCTIONS"));
}

#[tokio::test]
async fn a_running_turn_keeps_its_prompt_and_the_queued_turn_reads_the_changed_setting() {
    use futures_util::future::BoxFuture;
    use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
    use tokio::sync::Notify;
    struct Gate {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }
    impl Tool for Gate {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "gate".into(),
                description: "test gate".into(),
                schema: serde_json::json!({"type":"object"}),
            }
        }
        fn mutates(&self) -> bool {
            false
        }
        fn call(&self, _: ToolCtx, _: serde_json::Value) -> BoxFuture<'static, ToolOutput> {
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                ToolOutput::ok("released")
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("gate-call", "gate", serde_json::json!({}))
            .done(),
        Reply::new().text("first finished").done(),
        Reply::new().text("next finished").done(),
    ]));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut tools = ToolRegistry::new();
    tools.register(Gate {
        entered: entered.clone(),
        release: release.clone(),
    });
    let mut agent = fv_server::agent_with_builtin_tools(model.clone());
    agent.tools = Arc::new(tools);
    let (c, mut notes) = serve(dir.path(), "s.sock", agent).await;
    let id = new_thread(&c, None).await;
    set_prompt(&c, "BEFORE_CHANGE").await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: id.clone(),
        text: "work".into(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .unwrap();
    c.call::<TurnEnqueue>(TurnEnqueueParams {
        thread_id: id.clone(),
        text: "next".into(),
    })
    .await
    .unwrap();
    set_prompt(&c, "AFTER_CHANGE").await;
    release.notify_one();
    idle(&mut notes).await;
    let requests = model.requests();
    assert_eq!(requests.len(), 3);
    for request in &requests[..2] {
        assert!(request.system.ends_with("BEFORE_CHANGE"));
    }
    assert!(requests[2].system.ends_with("AFTER_CHANGE"));
    assert!(!requests[2].system.contains("BEFORE_CHANGE"));
}
