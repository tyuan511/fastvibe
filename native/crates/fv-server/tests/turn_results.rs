//! Terminal failures have no model message of their own; exercise their storage through
//! the public protocol, including fork/retry and a failed manual compaction.

use futures_util::{StreamExt, stream::BoxStream};
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{Model, ModelError, ModelEvent, ModelRequest};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

mod common;

struct Run {
    state: Arc<ServerState>,
    listener: tokio::task::JoinHandle<std::io::Result<()>>,
    client: Client,
    notes: UnboundedReceiver<ServerNotification>,
}

impl Drop for Run {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

impl Run {
    async fn open(dir: &Path, name: &str, model: Arc<dyn Model>) -> Self {
        let state = Arc::new(
            ServerState::new(dir.into(), fv_server::agent_with_builtin_tools(model)).unwrap(),
        );
        common::disable_reply_suggestions(&state);
        let socket = dir.join(format!("{name}.sock"));
        let listener = tokio::spawn(
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
        Self {
            state,
            listener,
            client,
            notes,
        }
    }

    async fn thread(&self) -> String {
        self.client
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

    async fn idle(&mut self) -> Vec<ServerNotification> {
        let mut seen = Vec::new();
        loop {
            let note = tokio::time::timeout(Duration::from_secs(15), self.notes.recv())
                .await
                .unwrap()
                .unwrap();
            let done =
                matches!(&note, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
            seen.push(note);
            if done {
                return seen;
            }
        }
    }

    async fn say(&mut self, thread: &str, text: &str) -> String {
        let id = self
            .client
            .call::<TurnStart>(TurnStartParams {
                thread_id: thread.into(),
                text: text.into(),
            })
            .await
            .unwrap()
            .turn_id;
        self.idle().await;
        id
    }

    async fn read(&self, id: &str) -> Vec<Turn> {
        self.client
            .call::<ThreadResume>(ThreadIdParams {
                thread_id: id.into(),
            })
            .await
            .unwrap()
            .turns
    }
}

fn errors(turns: &[Turn]) -> Vec<(String, String, String)> {
    turns
        .iter()
        .flat_map(|t| {
            t.items.iter().filter_map(|i| match i {
                Item::Error { id, message } => Some((t.id.clone(), id.clone(), message.clone())),
                _ => None,
            })
        })
        .collect()
}

#[tokio::test]
async fn failures_before_and_after_partial_output_survive_restart_fork_and_retry() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new().then_fail("401: no credentials"),
        Reply::new()
            .text("partial answer")
            .then_fail("503: upstream failed"),
    ]));
    let mut run = Run::open(dir.path(), "first", model).await;
    let thread = run.thread().await;
    let first = run.say(&thread, "one").await;
    let second = run.say(&thread, "two").await;
    let live = errors(&run.read(&thread).await);
    assert_eq!(
        live.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        [&first, &second]
    );
    drop(run);

    let model = Arc::new(ScriptedModel::new([Reply::new().text("fixed").done()]));
    let mut run = Run::open(dir.path(), "second", model.clone()).await;
    let restored = run.read(&thread).await;
    assert_eq!(errors(&restored), live);
    assert!(
        restored[1]
            .items
            .iter()
            .any(|i| matches!(i, Item::AgentMessage { text, .. } if text == "partial answer"))
    );
    let fork = run
        .client
        .call::<ThreadFork>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap()
        .thread
        .id;
    assert_eq!(errors(&run.read(&fork).await), live);
    run.client
        .call::<TurnRewind>(TurnRewindParams {
            thread_id: thread.clone(),
            turn_id: first,
            text: Some("replacement".into()),
            rewind_files: false,
        })
        .await
        .unwrap();
    run.idle().await;
    assert!(errors(&run.read(&thread).await).is_empty());
    assert_eq!(errors(&run.read(&fork).await), live);
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        matches!(requests[0].messages.as_slice(), [fv_core::Message::User { text }] if text == "replacement")
    );
    drop(run);
    let run = Run::open(dir.path(), "third", Arc::new(ScriptedModel::default())).await;
    assert!(errors(&run.read(&thread).await).is_empty());
    assert_eq!(errors(&run.read(&fork).await), live);
}

#[tokio::test]
async fn failed_manual_compaction_gets_its_own_turn_and_a_later_retry_uses_absolute_history() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("first answer").done(),
        Reply::new().then_fail("cannot summarize now"),
        Reply::new().text("SUMMARY").done(),
        Reply::new().text("later answer").done(),
        Reply::new().text("retried answer").done(),
    ]));
    let mut run = Run::open(dir.path(), "first", model.clone()).await;
    let thread = run.thread().await;
    run.say(&thread, "first prompt").await;
    run.client
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    run.idle().await;
    let live = run.read(&thread).await;
    assert_eq!(live.len(), 2);
    let failed_id = live[1].id.clone();
    assert_eq!(errors(&live).len(), 1);
    // Retrying a manual turn must not borrow the next turn's prompt.
    run.client
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    run.idle().await;
    let later_id = run.say(&thread, "later prompt").await;
    assert!(
        run.client
            .call::<TurnRewind>(TurnRewindParams {
                thread_id: thread.clone(),
                turn_id: failed_id.clone(),
                text: None,
                rewind_files: false,
            })
            .await
            .is_err()
    );
    run.client
        .call::<TurnRewind>(TurnRewindParams {
            thread_id: thread.clone(),
            turn_id: later_id,
            text: None,
            rewind_files: false,
        })
        .await
        .unwrap();
    run.idle().await;
    let requests = model.requests();
    let last = requests.last().unwrap();
    assert!(
        matches!(last.messages.last(), Some(fv_core::Message::User { text }) if text == "later prompt")
    );
    assert!(
        last.messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::User { text } if text.contains("SUMMARY")))
    );
    let live_errors = errors(&run.read(&thread).await);
    drop(run);
    let run = Run::open(dir.path(), "second", Arc::new(ScriptedModel::default())).await;
    assert_eq!(errors(&run.read(&thread).await), live_errors);
    assert_eq!(live_errors[0].0, failed_id);
    assert_eq!(run.read(&thread).await.len(), 4);
}

struct PanicsOnce {
    first: AtomicBool,
    next: ScriptedModel,
}
impl Model for PanicsOnce {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        if self.first.swap(false, Ordering::SeqCst) {
            futures_util::stream::once(async { panic!("a provider task panicked") }).boxed()
        } else {
            self.next.stream(request)
        }
    }
}

#[tokio::test]
async fn a_model_panic_keeps_committed_messages_and_records_one_error_without_wedging_the_thread() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(PanicsOnce {
        first: AtomicBool::new(true),
        next: ScriptedModel::new([Reply::new().text("recovered").done()]),
    });
    let mut run = Run::open(dir.path(), "first", model).await;
    let thread = run.thread().await;
    let id = run.say(&thread, "first prompt").await;
    assert!(!run.state.runtime(&thread).is_running());
    assert_eq!(errors(&run.read(&thread).await).len(), 1);
    run.say(&thread, "second prompt").await;
    let loaded = run.state.store.transcripts.read(&thread).unwrap();
    assert!(
        matches!(loaded.messages.first(), Some(fv_core::Message::User { text }) if text == "first prompt")
    );
    drop(run);
    let run = Run::open(dir.path(), "second", Arc::new(ScriptedModel::default())).await;
    let errors = errors(&run.read(&thread).await);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, id);
    assert_eq!(errors[0].2, "Internal error.");
}
