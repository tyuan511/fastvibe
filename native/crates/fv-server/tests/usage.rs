use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::usage::{UsageParams, UsageRange, UsageStats};
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};

mod common;
type Notes = tokio::sync::mpsc::UnboundedReceiver<ServerNotification>;

async fn client(path: &Path) -> (Client, Notes) {
    let (client, notes) = Client::connect_unix(path).await.unwrap();
    let response = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "usage-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(response.features.iter().any(|f| f == "usageStats"));
    (client, notes)
}
async fn serve(dir: &Path, name: &str, model: Arc<ScriptedModel>) -> (Client, Notes) {
    let state =
        Arc::new(ServerState::new(dir.into(), fv_server::agent_with_builtin_tools(model)).unwrap());
    common::disable_reply_suggestions(&state);
    let socket = dir.join(name);
    tokio::spawn(UnixServer::bind(state, &socket).await.unwrap().run());
    client(&socket).await
}
async fn usage(client: &Client) -> UsageStats {
    client
        .call::<StatsUsage>(UsageParams {
            range: UsageRange::All,
            timezone: "Asia/Shanghai".into(),
        })
        .await
        .unwrap()
}
async fn say(c: &Client, notes: &mut Notes, id: &str) {
    c.call::<TurnStart>(TurnStartParams {
        thread_id: id.into(),
        text: "accounting input".into(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut completed = false;
        loop {
            match notes.recv().await.unwrap() {
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
    .unwrap();
}

#[tokio::test]
async fn real_requests_are_shared_not_duplicated_by_forks_and_retained_after_delete_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .text("private reply text")
            .input_tokens(10)
            .done(),
        Reply::new().text("new work").input_tokens(20).done(),
    ]));
    let (a, mut a_notes) = serve(dir.path(), "one.sock", model).await;
    let (b, mut b_notes) = client(&dir.path().join("one.sock")).await;
    assert_eq!(usage(&a).await.totals.metrics.requests, 0);
    let id = a
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    say(&a, &mut a_notes, &id).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                b_notes.recv().await,
                Some(ServerNotification::UsageChanged(_))
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    a.call::<ThreadUpdate>(ThreadUpdateParams {
        thread_id: id.clone(),
        title: Some("统计测试".into()),
        archived: None,
        pinned: None,
    })
    .await
    .unwrap();
    let first = usage(&b).await;
    assert_eq!(first.totals.metrics.requests, 1);
    assert_eq!(first.totals.metrics.input, 10);
    assert_eq!(first.conversations[0].title.as_deref(), Some("统计测试"));
    assert!(
        !serde_json::to_string(&first)
            .unwrap()
            .contains("private reply text")
    );
    let fork = a
        .call::<ThreadFork>(ThreadIdParams {
            thread_id: id.clone(),
        })
        .await
        .unwrap()
        .thread
        .id;
    assert_eq!(usage(&a).await.totals.metrics.requests, 1);
    say(&a, &mut a_notes, &fork).await;
    let both = usage(&b).await;
    assert_eq!(both.totals.metrics.requests, 2);
    assert_eq!(both.totals.metrics.input, 30);
    assert_eq!(both.sessions, 2);
    for id in [id, fork] {
        a.call::<ThreadDelete>(ThreadIdParams { thread_id: id })
            .await
            .unwrap();
    }
    let deleted = usage(&a).await;
    assert_eq!(deleted.totals, both.totals);
    assert!(
        deleted
            .conversations
            .iter()
            .all(|c| c.thread_id.is_none() && c.title.is_none())
    );
    let (restored, _) = serve(dir.path(), "two.sock", Arc::new(ScriptedModel::new([]))).await;
    assert_eq!(usage(&restored).await.totals, both.totals);
}

#[tokio::test]
async fn usage_queries_validate_timezones_and_are_explicitly_allowed_for_remote_clients() {
    let dir = tempfile::tempdir().unwrap();
    let (c, _) = serve(dir.path(), "s.sock", Arc::new(ScriptedModel::new([]))).await;
    assert!(
        c.call::<StatsUsage>(UsageParams {
            range: UsageRange::Month,
            timezone: "invented/zone".into()
        })
        .await
        .is_err()
    );
    let stats = c
        .call::<StatsUsage>(UsageParams {
            range: UsageRange::Week,
            timezone: "America/New_York".into(),
        })
        .await
        .unwrap();
    assert_eq!(stats.timezone, "America/New_York");
    assert_eq!(stats.totals.metrics.requests, 0);
    let request =
        serde_json::from_value(serde_json::json!({"id":1,"method":"stats/usage","params":{}}))
            .unwrap();
    assert!(fv_server::allows(ClientOrigin::Lan, &request));
    assert!(fv_server::allows(ClientOrigin::Official, &request));
}
