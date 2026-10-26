use std::fs;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use fv_agent::testing::{Reply, ScriptedModel, Step};
use fv_client::Client;
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::json;

mod common;

fn assistant(text: &str) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![ContentBlock::Text { text: text.into() }],
        stop: StopReason::Stop,
        usage: Default::default(),
        model: None,
    })
}

fn fixture(data: &std::path::Path) -> (ServerState, Thread) {
    let state = ServerState::new(
        data.into(),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    common::disable_reply_suggestions(&state);
    let thread = state
        .create_thread(Some(data.display().to_string()), None, None, None)
        .unwrap();
    state.persist(
        &thread.id,
        &Message::User {
            text: format!(
                "Please retain this workflow. {} password=secretvalue",
                "useful context ".repeat(30)
            ),
        },
    );
    state.persist(
        &thread.id,
        &assistant("The workflow was verified and the change completed."),
    );
    let file = fs::File::open(state.store.transcripts.path(&thread.id)).unwrap();
    file.set_times(
        fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7 * 3600)),
    )
    .unwrap();
    (state, thread)
}

fn extraction() -> Vec<Step> {
    Reply::new().text(&json!({"raw_memory":"Reuse the workflow; password=secretvalue", "rollout_summary":"Verified workflow", "rollout_slug":"workflow"}).to_string()).done()
}

fn write_summary(summary: &str) -> Vec<Step> {
    Reply::new()
        .tool(
            "book",
            "memory_workspace",
            json!({"operation":"write","path":"MEMORY.md","text":"# Handbook\nVerified workflow"}),
        )
        .tool(
            "summary",
            "memory_workspace",
            json!({"operation":"write","path":"memory_summary.md","text":summary}),
        )
        .done()
}

async fn connect(
    state: Arc<ServerState>,
    data: &std::path::Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let socket = data.join("memory.sock");
    let server = tokio::spawn(UnixServer::bind(state, &socket).await.unwrap().run());
    let (client, notes) = Client::connect_unix(&socket).await.unwrap();
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "memory-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    (client, notes, server)
}

async fn settled(client: &Client) -> MemoryState {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = client.call::<MemoryRead>(Empty {}).await.unwrap();
            if state.phase == MemoryPhase::Idle {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

async fn idle(notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(note) = notes.recv().await {
            if let ServerNotification::ThreadStatusChanged(event) = note
                && !event.body.running
            {
                return;
            }
        }
        panic!("connection ended before idle");
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn memory_runs_over_the_protocol_persists_injects_counts_citations_and_clears() {
    let data = tempfile::tempdir().unwrap();
    let (mut state, thread) = fixture(data.path());
    let citation = format!(
        "normal reply\n\n<oai-mem-citation>\n<rollout_ids>\n{}\n{}\n</rollout_ids>\n</oai-mem-citation>",
        thread.id, thread.id
    );
    let main = Arc::new(ScriptedModel::new([
        Reply::new().text(&citation).done(),
        Reply::new().text("off reply").done(),
    ]));
    state.agent.model = main.clone();
    let background = Arc::new(ScriptedModel::new([
        extraction(),
        write_summary("v1\nMY_MEMORY_MAP"),
        Reply::new().text("consolidated").done(),
    ]));
    state.memory.set_model(background.clone());
    let state = Arc::new(state);
    let (client, mut notes, server) = connect(state.clone(), data.path()).await;
    let off = client.call::<MemoryRead>(Empty {}).await.unwrap();
    assert!(!off.config.enabled);
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    assert!(background.requests().is_empty());
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: true,
            model: None,
        })
        .await
        .unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    let done = settled(&client).await;
    assert!(done.ready && done.error.is_none(), "{done:?}");
    assert_eq!(done.conversations, 1);
    assert_eq!(background.requests().len(), 3);
    let request = &background.requests()[0];
    assert!(!format!("{:?}", request.messages).contains("secretvalue"));
    assert!(format!("{:?}", request.messages).contains("REDACTED_SECRET"));
    let tools = &background.requests()[1].tools;
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "memory_workspace");
    assert!(
        !fs::read_to_string(data.path().join("memories/raw_memories.md"))
            .unwrap()
            .contains("secretvalue")
    );
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    assert!(settled(&client).await.error.is_none());
    assert_eq!(
        background.requests().len(),
        3,
        "unchanged memory does not call either model again"
    );
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.id.clone(),
            text: "use memory".into(),
        })
        .await
        .unwrap();
    idle(&mut notes).await;
    assert!(format!("{:?}", main.requests()[0].messages).contains("MY_MEMORY_MAP"));
    let snapshot = client
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.id.clone(),
        })
        .await
        .unwrap();
    let rendered = format!("{:?}", snapshot.turns);
    assert!(!rendered.contains("oai-mem-citation") && !rendered.contains("MY_MEMORY_MAP"));
    assert!(
        state
            .store
            .transcripts
            .search(&thread.id, "rollout_ids")
            .unwrap()
            .is_none()
    );
    assert!(
        state
            .store
            .transcripts
            .search(&thread.id, "normal reply")
            .unwrap()
            .is_some()
    );
    let ledger: serde_json::Value = serde_json::from_str(
        &state
            .store
            .db
            .get_setting("memory.ledger.v1")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ledger["outputs"][&thread.id]["usageCount"], 1);
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: false,
            model: None,
        })
        .await
        .unwrap();
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.id.clone(),
            text: "without memory".into(),
        })
        .await
        .unwrap();
    idle(&mut notes).await;
    assert!(!format!("{:?}", main.requests()[1].messages).contains("MY_MEMORY_MAP"));
    assert!(
        state
            .store
            .transcripts
            .read(&thread.id)
            .unwrap()
            .messages
            .iter()
            .any(|m| matches!(m, Message::MemoryContext { .. }))
    );
    let reopened = ServerState::new(
        data.path().into(),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    assert_eq!(reopened.memory.state().conversations, 1);
    assert!(reopened.memory.state().ready);
    assert!(!reopened.memory.state().config.enabled);
    let cleared = client.call::<MemoryClear>(Empty {}).await.unwrap();
    assert_eq!(cleared.conversations, 0);
    assert!(!cleared.ready && !data.path().join("memories").exists());
    server.abort();
}

#[tokio::test]
async fn clear_cancels_a_hung_extraction_and_the_pending_enable_trigger() {
    let data = tempfile::tempdir().unwrap();
    let (state, _) = fixture(data.path());
    let background = Arc::new(ScriptedModel::new([Reply::new().then_hang()]));
    state.memory.set_model(background.clone());
    let state = Arc::new(state);
    let (client, _, server) = connect(state, data.path()).await;
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: true,
            model: None,
        })
        .await
        .unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while background.requests().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let cleared =
        tokio::time::timeout(Duration::from_secs(2), client.call::<MemoryClear>(Empty {}))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(cleared.phase, MemoryPhase::Idle);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(background.requests().len(), 1);
    assert!(!data.path().join("memories").exists());
    assert_eq!(
        client
            .call::<MemoryRead>(Empty {})
            .await
            .unwrap()
            .conversations,
        0
    );
    server.abort();
}

#[tokio::test]
async fn an_invalid_consolidation_never_replaces_live_files_or_advances_its_baseline() {
    let data = tempfile::tempdir().unwrap();
    let (state, _) = fixture(data.path());
    let root = data.path().join("memories");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("MEMORY.md"), "original handbook").unwrap();
    fs::write(root.join("memory_summary.md"), "v1\nORIGINAL_MAP").unwrap();
    let background = Arc::new(ScriptedModel::new([
        extraction(),
        write_summary("v2\nINVALID"),
        Reply::new().text("done").done(),
        write_summary("v1\nRECOVERED_MAP"),
        Reply::new().text("done").done(),
    ]));
    state.memory.set_model(background.clone());
    let state = Arc::new(state);
    let (client, _, server) = connect(state, data.path()).await;
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: true,
            model: None,
        })
        .await
        .unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    assert!(settled(&client).await.error.is_some());
    assert_eq!(
        fs::read_to_string(root.join("memory_summary.md")).unwrap(),
        "v1\nORIGINAL_MAP"
    );
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    let recovered = settled(&client).await;
    assert!(recovered.error.is_none(), "{recovered:?}");
    assert!(
        fs::read_to_string(root.join("memory_summary.md"))
            .unwrap()
            .contains("RECOVERED_MAP")
    );
    assert_eq!(
        background.requests().len(),
        5,
        "stage 1 is durable even when stage 2 fails"
    );
    server.abort();
}

#[tokio::test]
async fn deleting_a_conversation_prunes_its_outputs_and_supplies_the_deletion_diff() {
    let data = tempfile::tempdir().unwrap();
    let (state, thread) = fixture(data.path());
    let background = Arc::new(ScriptedModel::new([
        extraction(),
        write_summary("v1\nFIRST_MAP"),
        Reply::new().text("done").done(),
        Reply::new()
            .tool(
                "diff",
                "memory_workspace",
                json!({"operation":"read","path":"phase2_workspace_diff.md"}),
            )
            .done(),
        write_summary("v1\nEMPTY_MAP"),
        Reply::new().text("done").done(),
    ]));
    state.memory.set_model(background.clone());
    let state = Arc::new(state);
    let (client, _, server) = connect(state, data.path()).await;
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: true,
            model: None,
        })
        .await
        .unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    assert_eq!(settled(&client).await.conversations, 1);
    client
        .call::<ThreadDelete>(ThreadIdParams {
            thread_id: thread.id.clone(),
        })
        .await
        .unwrap();
    // A previously published baseline must still reach phase 2 after every live file vanished.
    fs::remove_dir_all(data.path().join("memories")).unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    let pruned = settled(&client).await;
    assert_eq!(pruned.conversations, 0);
    assert!(pruned.error.is_none(), "{pruned:?}");
    let requests = background.requests();
    assert_eq!(requests.len(), 6);
    let diff = requests[4]
        .messages
        .iter()
        .find_map(|m| match m {
            Message::ToolResult {
                call_id, content, ..
            } if call_id == "diff" => Some(content),
            _ => None,
        })
        .unwrap();
    assert!(
        diff.contains("deleted:") && diff.contains(&thread.id),
        "{diff}"
    );
    assert!(
        !fs::read_to_string(data.path().join("memories/raw_memories.md"))
            .unwrap()
            .contains(&thread.id)
    );
    server.abort();
}

#[tokio::test]
async fn an_empty_extraction_is_successful_and_does_not_start_consolidation() {
    let data = tempfile::tempdir().unwrap();
    let (state, _) = fixture(data.path());
    let background = Arc::new(ScriptedModel::new([Reply::new()
        .text("{\"raw_memory\":\"\"}")
        .done()]));
    state.memory.set_model(background.clone());
    let state = Arc::new(state);
    let (client, _, server) = connect(state, data.path()).await;
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: true,
            model: None,
        })
        .await
        .unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    let empty = settled(&client).await;
    assert!(
        empty.error.is_none() && !empty.ready && empty.conversations == 0,
        "{empty:?}"
    );
    assert_eq!(background.requests().len(), 1);
    assert!(!data.path().join("memories").exists());
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    assert!(settled(&client).await.error.is_none());
    assert_eq!(
        background.requests().len(),
        1,
        "an unchanged empty rollout is not read twice"
    );
    server.abort();
}

#[tokio::test]
async fn failed_extraction_redacts_diagnostics_and_respects_the_retry_delay() {
    let data = tempfile::tempdir().unwrap();
    let (state, _) = fixture(data.path());
    let background = Arc::new(ScriptedModel::new([Reply::new()
        .then_fail("provider rejected password=secretvalue sk-abcdefghijklmnopqrstuvwx")]));
    state.memory.set_model(background.clone());
    let state = Arc::new(state);
    let (client, _, server) = connect(state, data.path()).await;
    client
        .call::<MemoryConfigure>(MemoryConfig {
            enabled: true,
            model: None,
        })
        .await
        .unwrap();
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    let error = settled(&client).await.error.unwrap();
    assert!(error.contains("REDACTED_SECRET"));
    assert!(!error.contains("secretvalue") && !error.contains("sk-"));
    client.call::<MemoryRun>(Empty {}).await.unwrap();
    settled(&client).await;
    assert_eq!(background.requests().len(), 1);
    assert!(!data.path().join("memories").exists());
    server.abort();
}
