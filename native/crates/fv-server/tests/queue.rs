//! The queue behind a reply: what happens to a prompt typed while the agent is still working,
//! and what 「立即」 does to the run in front of it.

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
    /// The database behind the server, for what a restart would read back.
    db: Arc<fv_store::Db>,
}

impl Harness {
    /// The queue as the database holds it, for the promise that a drag outlives the process.
    fn store_order(&self, thread_id: &str) -> Vec<String> {
        self.db
            .queue(thread_id)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect()
    }
}

/// A tool that takes a moment, so a test has a window to steer into a live run.
struct Slow;

impl fv_agent::Tool for Slow {
    fn spec(&self) -> fv_agent::ToolSpec {
        fv_agent::ToolSpec {
            name: "slow".into(),
            description: "test".into(),
            schema: serde_json::json!({"type": "object"}),
        }
    }
    fn call(
        &self,
        _: fv_agent::ToolCtx,
        _: serde_json::Value,
    ) -> futures_util::future::BoxFuture<'static, fv_agent::ToolOutput> {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            fv_agent::ToolOutput::ok("done")
        })
    }
}

async fn start(model: ScriptedModel) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(model);
    let mut tools = ToolRegistry::new();
    tools.register(Slow);
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
    let db = state.store.db.clone();
    let sock = dir.path().join("q.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Harness {
        _dir: dir,
        sock,
        model,
        db,
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

/// Let whatever is already on the wire land, so an `until` that follows waits for the notice its
/// own call causes rather than an earlier one of the same method.
async fn settle(notes: &mut Notes) {
    while tokio::time::timeout(Duration::from_millis(40), notes.recv())
        .await
        .is_ok()
    {}
}

fn queue_of(notes: &[ServerNotification]) -> Vec<QueueState> {
    notes
        .iter()
        .filter_map(|n| match n {
            ServerNotification::ThreadQueueChanged(e) => Some(e.body.clone()),
            _ => None,
        })
        .collect()
}

fn user_prompts(notes: &[ServerNotification]) -> Vec<String> {
    notes
        .iter()
        .filter_map(|n| match n {
            ServerNotification::ItemCompleted(e) => match &e.body.item {
                Item::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// A prompt queued while a reply is in flight goes out by itself once that reply ends, and the
/// client is shown the queue in between.
#[tokio::test]
async fn a_queued_prompt_is_sent_once_the_reply_in_flight_ends() {
    let h = start(ScriptedModel::new([
        Reply::new().text("first ").then_hang(),
        Reply::new().text("second").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;

    let item = c
        .call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "two".into(),
        })
        .await
        .unwrap();
    assert_eq!(item.text, "two");
    let announced = until(&mut notes, |n| n.method() == "thread/queue/changed").await;
    assert_eq!(queue_of(&announced)[0].items.len(), 1);
    assert_eq!(queue_of(&announced)[0].pause, None);

    // Stopping the reply pauses the queue: the user's own stop may well have been aimed at what
    // is queued behind it, so nothing runs until they say 继续.
    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let stopped = until(&mut notes, idle).await;
    assert!(
        user_prompts(&stopped).is_empty(),
        "{:?}",
        user_prompts(&stopped)
    );
    assert_eq!(
        queue_of(&stopped).last().and_then(|q| q.pause),
        Some(QueuePauseReason::Stopped)
    );
    c.call::<TurnQueueResume>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let rest = until(&mut notes, idle).await;
    let prompts = user_prompts(&rest);
    assert_eq!(prompts, ["two"], "{:?}", prompts);
    // The resumed prompt is a normal turn that finished, not the stopped one again.
    assert!(rest.iter().any(|n| matches!(
        n,
        ServerNotification::TurnCompleted(e) if e.body.status == TurnStatus::Completed
    )));
    // The queue is empty again, and the second prompt really was the model's input.
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert!(snapshot.queue.items.is_empty());
    assert_eq!(
        h.model
            .requests()
            .last()
            .unwrap()
            .conversation()
            .iter()
            .filter(|m| matches!(m, fv_core::Message::User { .. }))
            .count(),
        2
    );
}

/// 「立即」 stops the reply in front of it and sends that prompt next, not the head of the queue.
#[tokio::test]
async fn send_now_interrupts_the_run_and_sends_the_chosen_prompt_first() {
    let h = start(ScriptedModel::new([
        Reply::new().text("first ").then_hang(),
        Reply::new().text("chosen").done(),
        Reply::new().text("later").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;

    let ahead = c
        .call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "ahead".into(),
        })
        .await
        .unwrap();
    let chosen = c
        .call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "chosen".into(),
        })
        .await
        .unwrap();
    let _ = ahead;
    c.call::<TurnQueueSendNow>(QueueItemParams {
        thread_id: thread.clone(),
        item_id: chosen.id.clone(),
    })
    .await
    .unwrap();

    // The chosen prompt moves in front of the older queued prompt. Both then drain;
    // a snapshot taken after the chosen completion may already contain the next turn.
    let rest = until(&mut notes, idle).await;
    assert_eq!(user_prompts(&rest), ["chosen", "ahead"]);
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert!(snapshot.queue.items.is_empty());
    assert!(!snapshot.running);
}

/// A failed turn pauses the queue rather than feeding every later prompt to a broken run, and
/// nothing drains until the user resumes it.
#[tokio::test]
async fn a_failed_turn_pauses_the_queue_until_it_is_resumed() {
    let h = start(ScriptedModel::new([
        Reply::new().then_fail("upstream said no"),
        Reply::new().text("after resume").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    let failed = until(&mut notes, idle).await;
    assert!(failed.iter().any(|n| matches!(
        n,
        ServerNotification::TurnCompleted(e) if e.body.status == TurnStatus::Failed
    )));
    // The reason is stored, not guessed: the client prints a different sentence for a failure
    // than for its own stop.
    let failed_pause = queue_of(&failed).last().and_then(|q| q.pause);
    assert_eq!(failed_pause, Some(QueuePauseReason::Failed));

    // Queued onto an idle thread a paused queue still holds it: the prompt runs only after the
    // user says to resume.
    c.call::<TurnEnqueue>(TurnEnqueueParams {
        thread_id: thread.clone(),
        text: "held".into(),
    })
    .await
    .unwrap();
    let after_queue = until(&mut notes, |n| n.method() == "thread/queue/changed").await;
    let held = queue_of(&after_queue);
    assert_eq!(held.last().unwrap().items.len(), 1);
    assert_eq!(
        held.last().unwrap().pause,
        Some(QueuePauseReason::Failed),
        "the pause is shown beside it, with its reason"
    );

    c.call::<TurnQueueResume>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let resumed = until(&mut notes, idle).await;
    assert_eq!(user_prompts(&resumed), ["held"]);
}

/// A prompt removed from the queue is never sent.
#[tokio::test]
async fn a_removed_prompt_does_not_send() {
    let h = start(ScriptedModel::new([
        Reply::new().text("first ").then_hang(),
        Reply::new().text("unused").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    let item = c
        .call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "never".into(),
        })
        .await
        .unwrap();
    c.call::<TurnQueueRemove>(QueueItemParams {
        thread_id: thread.clone(),
        item_id: item.id,
    })
    .await
    .unwrap();
    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let rest = until(&mut notes, idle).await;
    assert!(user_prompts(&rest).is_empty());
    assert_eq!(h.model.requests().len(), 1);
}

/// The queue is on disk: a prompt that was waiting when the process ended is still waiting, and
/// a queue that had stopped stays stopped.
#[tokio::test]
async fn a_queued_prompt_survives_a_restart_and_a_pause_survives_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let thread;
    {
        let agent = AgentContext {
            context: Default::default(),
            hooks: None,
            model: Arc::new(NoModel),
            tools: Arc::new(ToolRegistry::new()),
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
        let sock = dir.path().join("p.sock");
        tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
        let (c, _n) = client(&Harness {
            _dir: tempfile::tempdir().unwrap(),
            sock: sock.clone(),
            model: Arc::new(ScriptedModel::new([])),
            db: state.store.db.clone(),
        })
        .await;
        thread = new_thread(&c).await;
        // An idle thread starts a queued prompt at once; pause it first so it stays queued, and
        // so the restart has both halves to restore.
        state
            .store
            .db
            .set_queue_pause(&thread, Some("failed"))
            .unwrap();
        c.call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "still here".into(),
        })
        .await
        .unwrap();
    }

    let agent = AgentContext {
        context: Default::default(),
        hooks: None,
        model: Arc::new(NoModel),
        tools: Arc::new(ToolRegistry::new()),
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
    let sock = dir.path().join("p2.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (c, _n) = client(&Harness {
        _dir: tempfile::tempdir().unwrap(),
        sock,
        model: Arc::new(ScriptedModel::new([])),
        db: state.store.db.clone(),
    })
    .await;
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        snapshot
            .queue
            .items
            .iter()
            .map(|i| i.text.as_str())
            .collect::<Vec<_>>(),
        ["still here"]
    );
    assert_eq!(
        snapshot.queue.pause,
        Some(QueuePauseReason::Failed),
        "the pause is stored, not inferred"
    );
}

/// A retry runs the same turn again from the same place, and the words it already had are what
/// the model is sent.
#[tokio::test]
async fn retry_reruns_the_turn_from_its_own_user_message() {
    let h = start(ScriptedModel::new([
        Reply::new().text("first answer").done(),
        Reply::new().text("second answer").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "original words".into(),
    })
    .await
    .unwrap();
    let first = until(&mut notes, idle).await;
    let retried_turn = first
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnCompleted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .unwrap();

    c.call::<TurnRewind>(TurnRewindParams {
        thread_id: thread.clone(),
        turn_id: retried_turn,
        text: None,
        rewind_files: false,
    })
    .await
    .unwrap();
    let second = until(&mut notes, idle).await;
    assert_eq!(user_prompts(&second), ["original words"]);
    // The retry's request holds the prompt once, not twice: the history was cut first.
    let requests = h.model.requests();
    let request = requests.last().unwrap();
    let prompts: Vec<&str> = request
        .conversation()
        .iter()
        .filter_map(|m| match m {
            fv_core::Message::User { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(prompts, ["original words"]);

    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.turns.len(), 1, "one turn, drawn once");
    assert!(matches!(
        snapshot.turns[0].items.last(),
        Some(Item::AgentMessage { text, .. }) if text == "second answer"
    ));
}

/// An edit replaces the words and drops the reply they produced: what is re-sent is the
/// corrected prompt, and the old answer is gone from the branch.
#[tokio::test]
async fn edit_rewrites_the_prompt_and_discards_the_reply_after_it() {
    let h = start(ScriptedModel::new([
        Reply::new().text("wrong answer").done(),
        Reply::new().text("right answer").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "typo".into(),
    })
    .await
    .unwrap();
    let first = until(&mut notes, idle).await;
    let turn = first
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnCompleted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .unwrap();
    c.call::<TurnRewind>(TurnRewindParams {
        thread_id: thread.clone(),
        turn_id: turn,
        text: Some("corrected".into()),
        rewind_files: false,
    })
    .await
    .unwrap();
    let second = until(&mut notes, idle).await;
    assert_eq!(user_prompts(&second), ["corrected"]);
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    let texts: Vec<String> = snapshot.turns[0]
        .items
        .iter()
        .filter_map(|i| match i {
            Item::UserMessage { text, .. } | Item::AgentMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["corrected", "right answer"]);

    // The transcript is append-only: the replaced answer is still in the file, and a fresh
    // process reading it lands on the same branch.
    let raw = std::fs::read_to_string(
        h._dir
            .path()
            .join("sessions")
            .join(format!("{thread}.jsonl")),
    )
    .unwrap();
    assert!(raw.contains("wrong answer"), "{raw}");
    assert!(raw.contains("\"type\":\"rewind\""));
}

/// A running reply cannot be rewound under itself: stopping it first is the user's call.
#[tokio::test]
async fn rewinding_a_running_thread_is_refused() {
    let h = start(ScriptedModel::new([Reply::new().text("busy ").then_hang()])).await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    let events = until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    let turn = events
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnStarted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .unwrap();
    let refused = c
        .call::<TurnRewind>(TurnRewindParams {
            thread_id: thread.clone(),
            turn_id: turn,
            text: None,
            rewind_files: false,
        })
        .await
        .is_err();
    assert!(refused);
}

/// A steer joins the run that is working, at its next model request, and the model sees it as
/// a user message — not as a second turn.
#[tokio::test]
async fn a_steer_reaches_the_live_run_as_a_user_message() {
    let h = start(ScriptedModel::new([
        // A command that takes a moment, so there is a window to steer into.
        Reply::new()
            .text("working ")
            .tool("c1", "slow", serde_json::json!({}))
            .done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "start".into(),
    })
    .await
    .unwrap();
    // Wait for the *tool call* to start: that is the window the steer has to land in (the text
    // block before it starts and ends within the same instant).
    let events = until(&mut notes, |n| {
        matches!(n, ServerNotification::ItemStarted(e) if matches!(e.body.item, Item::ToolCall { .. }))
    })
    .await;
    let turn = events
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnStarted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .unwrap();
    c.call::<TurnSteer>(TurnSteerParams {
        thread_id: thread.clone(),
        expected_turn_id: turn.clone(),
        text: "also rename it".into(),
    })
    .await
    .unwrap();
    let rest = until(&mut notes, idle).await;
    // One turn: the steer did not start a second one.
    let turns: Vec<&str> = rest
        .iter()
        .filter_map(|n| match n {
            ServerNotification::TurnStarted(e) => Some(e.body.turn_id.as_str()),
            _ => None,
        })
        .collect();
    assert!(turns.is_empty(), "{turns:?}");
    // The second model request carries what the user said, after the tool result.
    let requests = h.model.requests();
    let second = requests.last().unwrap();
    assert!(
        second
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::User { text } if text == "also rename it")),
        "{:?}",
        second.messages
    );
}

/// A steer asked of a thread with nothing running is refused with the code a client acts on,
/// so its words can become a prompt of their own instead of being retyped.
#[tokio::test]
async fn a_steer_on_an_idle_thread_is_refused_with_no_active_turn() {
    let h = start(ScriptedModel::new([
        Reply::new().text("answered").done(),
        Reply::new().text("after the fact").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    let first = until(&mut notes, idle).await;
    let turn = first
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnStarted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .unwrap();
    let refused = c
        .call::<TurnSteer>(TurnSteerParams {
            thread_id: thread.clone(),
            expected_turn_id: turn,
            text: "and then this".into(),
        })
        .await;
    match refused {
        Err(fv_client::ClientError::Rpc(e)) => {
            assert_eq!(e.code, fv_protocol::jsonrpc::code::NO_ACTIVE_TURN)
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    // Nothing ran: the words never reached the model on their own.
    assert_eq!(h.model.requests().len(), 1);
}

/// Steering is refused for a turn that is not the live one, and the answer names the run that
/// actually is — codex's `expectedTurnId` precondition.
#[tokio::test]
async fn steering_names_the_live_turn_when_the_client_has_the_wrong_one() {
    let h = start(ScriptedModel::new([Reply::new().text("busy ").then_hang()])).await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    let events = until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    let live = events
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnStarted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .unwrap();
    let answer = c
        .call::<TurnSteer>(TurnSteerParams {
            thread_id: thread.clone(),
            expected_turn_id: "some-old-turn".into(),
            text: "hello".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        answer.turn_id, live,
        "the answer hands back the live run id"
    );
}

#[tokio::test]
async fn each_chained_turn_owns_its_id_and_the_whole_queue_finishes() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("slow1", "slow", serde_json::json!({}))
            .done(),
        Reply::new().text("first done").done(),
        Reply::new()
            .text("second ")
            .wait(Duration::from_millis(200))
            .done(),
        Reply::new().text("third done").done(),
        Reply::new().text("continuation done").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    let first = c
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "one".into(),
        })
        .await
        .unwrap()
        .turn_id;
    until(&mut notes, |n| n.method() == "item/started").await;
    for prompt in ["two", "three"] {
        c.call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: prompt.into(),
        })
        .await
        .unwrap();
    }
    let started = until(
        &mut notes,
        |n| matches!(n,ServerNotification::TurnStarted(e) if e.body.turn_id!=first),
    )
    .await;
    let second = started
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnStarted(e) if e.body.turn_id != first => {
                Some(e.body.turn_id.clone())
            }
            _ => None,
        })
        .unwrap();
    let steered = c
        .call::<TurnSteer>(TurnSteerParams {
            thread_id: thread.clone(),
            expected_turn_id: second.clone(),
            text: "extra context".into(),
        })
        .await
        .unwrap();
    assert_eq!(steered.turn_id, second);
    let end = until(&mut notes, idle).await;
    assert!(end.iter().any(|n|matches!(n,ServerNotification::TurnStarted(e) if e.body.turn_id!=first && e.body.turn_id!=second)));
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    assert_eq!(snapshot.turns.len(), 3);
    assert!(
        !snapshot
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .any(|i| matches!(i, Item::Error { .. }))
    );
    assert!(snapshot.queue.items.is_empty());
    assert!(!snapshot.running);
}

/// The order a drag produces is the order the prompts are sent in, and it is the order the
/// database holds, so a restart resumes the arrangement rather than the order they were typed.
#[tokio::test]
async fn a_reordered_queue_is_sent_in_its_new_order_and_stored_that_way() {
    let h = start(ScriptedModel::new([
        Reply::new().text("first ").then_hang(),
        Reply::new().text("second").done(),
        Reply::new().text("third").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    let mut ids = Vec::new();
    for text in ["a", "b", "c"] {
        ids.push(
            c.call::<TurnEnqueue>(TurnEnqueueParams {
                thread_id: thread.clone(),
                text: text.into(),
            })
            .await
            .unwrap()
            .id,
        );
    }
    // c first, then a, then b — what dragging the last row to the top produces.
    settle(&mut notes).await;
    let order = vec![ids[2].clone(), ids[0].clone(), ids[1].clone()];
    c.call::<TurnQueueReorder>(QueueReorderParams {
        thread_id: thread.clone(),
        // Duplicate and stale ids must have the same first-occurrence semantics in memory
        // and on disk. Leave b unnamed to exercise preservation of the remaining queue.
        item_ids: vec![
            ids[2].clone(),
            ids[0].clone(),
            ids[2].clone(),
            "gone".into(),
        ],
    })
    .await
    .unwrap();
    let announced = until(&mut notes, |n| n.method() == "thread/queue/changed").await;
    let drawn: Vec<String> = queue_of(&announced)
        .last()
        .unwrap()
        .items
        .iter()
        .map(|item| item.id.clone())
        .collect();
    assert_eq!(drawn, order, "the client is told the new order");
    assert_eq!(
        h.store_order(&thread),
        vec![ids[2].clone(), ids[0].clone(), ids[1].clone()],
        "and so is the database"
    );

    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let stopped = until(&mut notes, idle).await;
    assert_eq!(
        queue_of(&stopped).last().and_then(|q| q.pause),
        Some(QueuePauseReason::Stopped)
    );
    c.call::<TurnQueueResume>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let mut sent = user_prompts(&until(&mut notes, idle).await);
    // One resume starts the head; the queue then continues on its own.
    let mut guard = 0;
    while sent.len() < 3 && guard < 4 {
        guard += 1;
        sent.extend(user_prompts(&until(&mut notes, idle).await));
    }
    assert_eq!(sent, ["c", "a", "b"], "{sent:?}");
}

/// Editing a waiting prompt changes what is sent, keeps its place, and leaves its neighbours
/// alone. A prompt already being sent is refused rather than rewritten under the model.
#[tokio::test]
async fn an_edited_prompt_keeps_its_place_and_sends_the_new_words() {
    let h = start(ScriptedModel::new([
        Reply::new().text("first ").then_hang(),
        Reply::new().text("second").done(),
    ]))
    .await;
    let (c, mut notes) = client(&h).await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "one".into(),
    })
    .await
    .unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    let first = c
        .call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "before".into(),
        })
        .await
        .unwrap();
    let second = c
        .call::<TurnEnqueue>(TurnEnqueueParams {
            thread_id: thread.clone(),
            text: "untouched".into(),
        })
        .await
        .unwrap();
    settle(&mut notes).await;
    c.call::<TurnQueueEdit>(QueueEditParams {
        thread_id: thread.clone(),
        item_id: first.id.clone(),
        text: "after".into(),
    })
    .await
    .unwrap();
    let announced = until(&mut notes, |n| n.method() == "thread/queue/changed").await;
    let queue = queue_of(&announced).last().unwrap().clone();
    assert_eq!(
        queue
            .items
            .iter()
            .map(|item| (item.id.as_str(), item.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (first.id.as_str(), "after"),
            (second.id.as_str(), "untouched")
        ]
    );

    // An empty rewrite is refused: a queued prompt with nothing in it is a turn with no question.
    let refused = c
        .call::<TurnQueueEdit>(QueueEditParams {
            thread_id: thread.clone(),
            item_id: first.id.clone(),
            text: "   ".into(),
        })
        .await;
    assert!(refused.is_err());

    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let stopped = until(&mut notes, idle).await;
    assert_eq!(
        queue_of(&stopped).last().and_then(|q| q.pause),
        Some(QueuePauseReason::Stopped)
    );
    c.call::<TurnQueueResume>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    // The queue drains on its own once resumed: the edited prompt first, its neighbour after it,
    // both in the places they already held.
    let mut sent = user_prompts(&until(&mut notes, idle).await);
    let mut guard = 0;
    while sent.len() < 2 && guard < 4 {
        guard += 1;
        sent.extend(user_prompts(&until(&mut notes, idle).await));
    }
    assert_eq!(sent, ["after", "untouched"], "{sent:?}");
}
