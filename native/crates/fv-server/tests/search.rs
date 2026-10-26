use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::{Client, ClientError};
use fv_core::Message;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification, methods::*, types::*};
use fv_server::{ServerState, UnixServer};
use std::{path::Path, sync::Arc, time::Duration};

async fn connect(
    sock: &Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (c, notes) = Client::connect_unix(sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "search-test".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    (c, notes)
}

async fn search(c: &Client, query: &str, archived: bool) -> Vec<ThreadSearchHit> {
    c.call::<ThreadSearch>(ThreadSearchParams {
        query: query.into(),
        include_archived: archived,
    })
    .await
    .unwrap()
    .hits
}

#[tokio::test]
async fn searches_unopened_history_after_restart_and_filters_before_limiting() {
    let data = tempfile::tempdir().unwrap();
    let agent = || fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let target;
    {
        let state = ServerState::new(data.path().into(), agent()).unwrap();
        let mut t = state.create_thread(None, None, None, None).unwrap();
        t.title = "Deployment notes".into();
        t.updated_at = 1;
        state.store.db.put_thread(&t).unwrap();
        target = t.id.clone();
        state.persist(
            &t.id,
            &Message::User {
                text: format!("{}唯一目标 foo.bar{}", "前".repeat(100), "后".repeat(100)),
            },
        );
        // More than the result cap of archived matches must not hide the older active one.
        for i in 0..55 {
            let mut t = state.create_thread(None, None, None, None).unwrap();
            t.title = "foo.bar".into();
            t.archived = true;
            t.updated_at = i + 2;
            state.store.db.put_thread(&t).unwrap();
        }
        let mut t = state
            .create_thread(None, Some("/workspace/SpecialProject".into()), None, None)
            .unwrap();
        t.title = "Project-only title".into();
        state.store.db.put_thread(&t).unwrap();
    }
    let state = Arc::new(ServerState::new(data.path().into(), agent()).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (c, _) = connect(&sock).await;
    let hits = search(&c, "FOO.BAR", false).await;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].thread.id, target);
    assert!(hits[0].snippet.as_ref().unwrap().contains("foo.bar"));
    assert_eq!(search(&c, "foo.bar", true).await.len(), 50);
    assert!(search(&c, "fooXbar", false).await.is_empty());
    assert_eq!(search(&c, "DEPLOYMENT", false).await[0].thread.id, target);
    assert_eq!(search(&c, "specialproject", false).await.len(), 1);
    assert!(search(&c, "  ", false).await.is_empty());
    let error = c
        .call::<ThreadSearch>(ThreadSearchParams {
            query: "a".repeat(257),
            include_archived: false,
        })
        .await;
    assert!(
        matches!(error, Err(ClientError::Rpc(e)) if e.code == fv_protocol::jsonrpc::code::INVALID_PARAMS)
    );
    // Opening the thread changes the search source to its runtime, with the same result.
    c.call::<ThreadResume>(ThreadIdParams {
        thread_id: target.clone(),
    })
    .await
    .unwrap();
    assert_eq!(search(&c, "唯一目标", false).await[0].thread.id, target);
    assert_eq!(state.subscriber_count(&target), 1);
}

#[tokio::test]
async fn unfinished_replies_are_searchable_without_adding_a_subscription() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([Reply::new()
        .thinking("hidden-thought")
        .text("streaming-needle")
        .then_hang()]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model),
        )
        .unwrap(),
    );
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (c, mut notes) = connect(&sock).await;
    let (observer, _) = connect(&sock).await;
    let t = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: t.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(n) = notes.recv().await {
            if matches!(n, ServerNotification::AgentMessageDelta(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        search(&observer, "STREAMING-NEEDLE", false).await[0]
            .thread
            .id,
        t
    );
    assert!(search(&observer, "hidden-thought", false).await.is_empty());
    assert_eq!(
        state.subscriber_count(&t),
        1,
        "searching must not subscribe the observer"
    );
    c.call::<TurnInterrupt>(ThreadIdParams { thread_id: t })
        .await
        .unwrap();
}
