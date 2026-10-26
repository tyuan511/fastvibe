//! 回复推荐 over the wire: after a reply that ended in prose, the server asks the conversation's
//! own model what the user is likely to say next and publishes it as the composer's placeholder.

mod common;

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};

/// The conversation's model is a two-reply script; the placeholder's request is a *separate*
/// model, so the script that drives the dialogue is never spent on the guess. That is also how
/// the production path is wired: it is the same `Model` trait, and the test decides what it says.
struct Harness {
    _dir: tempfile::TempDir,
    sock: std::path::PathBuf,
}

async fn start(dialogue: ScriptedModel, answer: Option<&'static str>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let dialogue = Arc::new(dialogue);
    // A second model answers the placeholder. `providers::model_for` is what a real install gives
    // it; here the agent's own model is used, so the test swaps it out for the guess.
    let agent = fv_server::agent_with_builtin_tools(dialogue.clone());
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    if let Some(answer) = answer {
        state.set_suggestion_model(Arc::new(ScriptedModel::new([Reply::new()
            .text(&format!("{answer}\nand then it explains itself"))
            .done()])));
    }
    let sock = dir.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Harness { _dir: dir, sock }
}

async fn client(
    sock: &std::path::Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (c, n) = Client::connect_unix(sock).await.unwrap();
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

async fn until_idle(
    notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        let idle = matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
        seen.push(n);
        if idle {
            return seen;
        }
    }
}

/// Read until the placeholder is published or withdrawn.
async fn until_suggestion(
    notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) -> Option<String> {
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        if let ServerNotification::ThreadSuggestionChanged(e) = n {
            return e.body.text;
        }
    }
}

async fn new_thread(c: &Client) -> String {
    c.call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id
}

#[tokio::test]
async fn a_reply_that_ends_in_prose_leaves_a_suggestion_behind() {
    let h = start(
        ScriptedModel::new([Reply::new().text("I added the test").done()]),
        Some("Also update the changelog"),
    )
    .await;
    let (c, mut notes) = client(&h.sock).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "add a test".into(),
    })
    .await
    .unwrap();
    until_idle(&mut notes).await;
    let suggestion = until_suggestion(&mut notes).await;
    assert_eq!(
        suggestion.as_deref(),
        Some("Also update the changelog"),
        "only the first line is the suggestion"
    );
    // A client that opens the thread later is offered the same guess.
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        snapshot.suggestion.as_deref(),
        Some("Also update the changelog")
    );
}

#[tokio::test]
async fn a_failed_turn_leaves_no_suggestion() {
    let h = start(
        ScriptedModel::new([Reply::new().then_fail("upstream said no")]),
        Some("this must not be published"),
    )
    .await;
    let (c, mut notes) = client(&h.sock).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    until_idle(&mut notes).await;
    // Nothing is published within a short window: the guess is not made at all.
    let quiet = tokio::time::timeout(Duration::from_millis(400), notes.recv()).await;
    if let Ok(Some(ServerNotification::ThreadSuggestionChanged(e))) = quiet {
        panic!("a failed turn published {:?}", e.body.text);
    }
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    assert_eq!(snapshot.suggestion, None);
}

#[tokio::test]
async fn a_new_turn_withdraws_the_standing_suggestion() {
    let h = start(
        ScriptedModel::new([
            Reply::new().text("first answer").done(),
            Reply::new().text("working ").then_hang(),
        ]),
        Some("next thing"),
    )
    .await;
    let (c, mut notes) = client(&h.sock).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    until_idle(&mut notes).await;
    assert_eq!(
        until_suggestion(&mut notes).await.as_deref(),
        Some("next thing")
    );

    // The user's own prompt answers the guess, so it is taken back as the next run starts.
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "two".into(),
    })
    .await
    .unwrap();
    assert_eq!(
        until_suggestion(&mut notes).await,
        None,
        "a guess about a conversation that moved on is withdrawn"
    );
    c.call::<TurnInterrupt>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
}
