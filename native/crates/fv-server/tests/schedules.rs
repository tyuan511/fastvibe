//! Real native RPC transport: schedules keep running without a subscribed window.
use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::{
    PROTOCOL_VERSION, ServerRequest,
    methods::*,
    schedules::{
        MissedPolicy, ScheduleDefinition, ScheduleHistoryParams, ScheduleIdParams, ScheduleRule,
        ScheduleRunStatus, ScheduleUpsertParams,
    },
    types::*,
};
use fv_server::{ServerState, UnixServer};
use serde_json::json;
use std::{sync::Arc, time::Duration};
async fn init(client: &Client) {
    let r = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "schedule-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(r.features.iter().any(|f| f == "schedules"));
}
#[tokio::test]
async fn disconnected_schedule_waits_for_input_then_reconnects_to_the_same_run_and_artifact() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let model=Arc::new(ScriptedModel::new([
        Reply::new().tool("question","request_user_input",json!({"questions":[{"id":"scope","header":"Scope","question":"Proceed?","options":[{"label":"Proceed","description":"Write output."},{"label":"Stop","description":"Stop."}]}]})).done(),
        Reply::new().tool("patch","apply_patch",json!({"input":"*** Begin Patch\n*** Add File: output.txt\n+from scheduled task\n*** End Patch"})).done(),Reply::new().text("Scheduled output saved").done()]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    let socket = data.path().join("schedule.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, notes) = Client::connect_unix(&socket).await.unwrap();
    init(&client).await;
    let project = client
        .call::<ProjectCreate>(ProjectCreateParams {
            name: Some("Scheduled project".into()),
            folders: vec![work.path().display().to_string()],
        })
        .await
        .unwrap();
    let task = client
        .call::<ScheduleUpsert>(ScheduleUpsertParams {
            task_id: None,
            expected_version: None,
            definition: ScheduleDefinition {
                name: "Scheduled artifact".into(),
                prompt: "Ask once, then write the artifact".into(),
                project: Some(project.path.clone()),
                model: None,
                thinking: None,
                rule: ScheduleRule::Daily {
                    time: "09:00".into(),
                    time_zone: "UTC".into(),
                },
                max_run_seconds: 30,
                missed_policy: MissedPolicy::RunLatest,
            },
            enabled: true,
        })
        .await
        .unwrap();
    let queued = client
        .call::<ScheduleRunNow>(ScheduleIdParams {
            task_id: task.id.clone(),
        })
        .await
        .unwrap();
    drop(notes);
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), async {
        while state
            .pending_prompts(
                state
                    .store
                    .db
                    .list_threads(true)
                    .unwrap()
                    .first()
                    .map(|t| t.id.as_str())
                    .unwrap_or(""),
            )
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (other, _notes) = Client::connect_unix(&socket).await.unwrap();
    init(&other).await;
    let snapshot = other.call::<ScheduleList>(Empty {}).await.unwrap();
    let run = snapshot.active.unwrap();
    assert_eq!(run.id, queued.id);
    assert!(run.waiting_for_input);
    let root = run.thread_id.unwrap();
    let mut requests = other.take_requests().unwrap();
    let running = other
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: root.clone(),
        })
        .await
        .unwrap();
    assert_eq!(running.thread.project, Some(project.path));
    assert!(running.running);
    let request = tokio::time::timeout(Duration::from_secs(3), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let ServerRequest::UserInput { id, .. } = request else {
        panic!("expected input")
    };
    other
        .respond(id, json!({"answers":{"scope":{"answers":["Proceed"]}}}))
        .await
        .unwrap();
    let history = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let h = other
                .call::<ScheduleHistory>(ScheduleHistoryParams {
                    task_id: task.id.clone(),
                    offset: 0,
                    limit: Some(10),
                })
                .await
                .unwrap();
            if h.runs[0].status.terminal() {
                return h;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(history.total, 1);
    assert_eq!(history.runs[0].status, ScheduleRunStatus::Completed);
    assert_eq!(history.runs[0].result, "Scheduled output saved");
    assert!(!history.runs[0].waiting_for_input);
    assert_eq!(
        std::fs::read_to_string(work.path().join("output.txt")).unwrap(),
        "from scheduled task\n"
    );
    let output = other
        .call::<ThreadResume>(ThreadIdParams { thread_id: root })
        .await
        .unwrap();
    assert_eq!(output.turns.len(), 1);
    assert!(
        output.turns[0]
            .items
            .iter()
            .any(|i| matches!(i,Item::AgentMessage{text,..}if text=="Scheduled output saved"))
    );
    assert_eq!(model.requests().len(), 3);
    state.shutdown_schedules().await;
    server.abort();
}
