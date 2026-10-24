//! App settings over the protocol: defaults, partial updates, and everyone being told.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::methods::{Initialize, SettingsGet, SettingsSet};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};

async fn connect(
    sock: &std::path::Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (c, notes) = Client::connect_unix(sock).await.unwrap();
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
    (c, notes)
}

#[tokio::test]
async fn settings_start_at_their_defaults_change_by_field_and_reach_every_client() {
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());

    let (a, _) = connect(&sock).await;
    let (b, mut b_notes) = connect(&sock).await;

    assert_eq!(
        a.call::<SettingsGet>(Empty {}).await.unwrap(),
        AppSettings::default()
    );

    let changed = a
        .call::<SettingsSet>(AppSettingsPatch {
            theme_mode: Some(ThemeMode::Dark),
            dark_theme: Some("tokyo-night".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(changed.theme_mode, ThemeMode::Dark);
    assert_eq!(changed.dark_theme, "tokyo-night");
    // What the patch did not name stays.
    assert_eq!(changed.light_theme, "github-light");
    assert!(!changed.glass);

    // The other client hears about it, and reads the same thing.
    let heard = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ServerNotification::SettingsChanged(s)) = b_notes.recv().await {
                return s;
            }
        }
    })
    .await
    .expect("settings/changed");
    assert_eq!(heard, changed);
    assert_eq!(b.call::<SettingsGet>(Empty {}).await.unwrap(), changed);
}

#[tokio::test]
async fn a_thread_can_be_renamed_archived_pinned_and_deleted_for_good() {
    use fv_agent::testing::Reply;
    use fv_protocol::methods::{ThreadDelete, ThreadList, ThreadStart, ThreadUpdate, TurnStart};

    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([Reply::new().text("hello").done()]));
    let agent = fv_server::agent_with_builtin_tools(model);
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (c, mut notes) = connect(&sock).await;

    let id = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: id.clone(),
        text: "hi".into(),
    })
    .await
    .unwrap();
    // Wait for the turn so there is a transcript on disk.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(ServerNotification::ThreadStatusChanged(e)) = notes.recv().await
                && !e.body.running
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let transcript = data.path().join("sessions").join(format!("{id}.jsonl"));
    assert!(transcript.exists(), "the turn wrote a transcript");

    let updated = c
        .call::<ThreadUpdate>(ThreadUpdateParams {
            thread_id: id.clone(),
            title: Some("  New name  ".into()),
            archived: None,
            pinned: Some(true),
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(updated.title, "New name");
    assert!(updated.pinned && !updated.archived);

    c.call::<ThreadUpdate>(ThreadUpdateParams {
        thread_id: id.clone(),
        title: None,
        archived: Some(true),
        pinned: None,
    })
    .await
    .unwrap();
    let live = c
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap();
    assert!(
        live.threads.is_empty(),
        "an archived thread leaves the list"
    );
    let all = c
        .call::<ThreadList>(ThreadListParams {
            include_archived: true,
        })
        .await
        .unwrap();
    assert_eq!(all.threads.len(), 1);
    assert!(all.threads[0].pinned, "the pin survives archiving");

    c.call::<ThreadDelete>(ThreadIdParams {
        thread_id: id.clone(),
    })
    .await
    .unwrap();
    assert!(!transcript.exists(), "the transcript goes with the thread");
    let none = c
        .call::<ThreadList>(ThreadListParams {
            include_archived: true,
        })
        .await
        .unwrap();
    assert!(none.threads.is_empty());
    // Deleting what is already gone is not an error.
    c.call::<ThreadDelete>(ThreadIdParams { thread_id: id })
        .await
        .unwrap();
}

#[tokio::test]
async fn projects_are_folders_that_exist_and_a_chat_in_one_adds_it() {
    use fv_protocol::methods::{ProjectAdd, ProjectList, ProjectRemove, ThreadStart};
    use fv_protocol::types::ProjectPathParams;

    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (c, _) = connect(&sock).await;

    assert!(
        c.call::<ProjectList>(Empty {})
            .await
            .unwrap()
            .projects
            .is_empty()
    );

    // Not a folder: refused.
    let missing = data.path().join("nope").display().to_string();
    assert!(
        c.call::<ProjectAdd>(ProjectPathParams { path: missing })
            .await
            .is_err()
    );

    let path = work.path().display().to_string();
    let added = c
        .call::<ProjectAdd>(ProjectPathParams { path: path.clone() })
        .await
        .unwrap();
    assert_eq!(added.path, path);
    assert_eq!(
        added.name,
        work.path().file_name().unwrap().to_string_lossy()
    );
    // Adding it twice is the same as once.
    c.call::<ProjectAdd>(ProjectPathParams { path: path.clone() })
        .await
        .unwrap();
    assert_eq!(
        c.call::<ProjectList>(Empty {})
            .await
            .unwrap()
            .projects
            .len(),
        1
    );

    // Taking it off the list; a chat started in a folder puts it back.
    let left = c
        .call::<ProjectRemove>(ProjectPathParams { path: path.clone() })
        .await
        .unwrap();
    assert!(left.projects.is_empty());
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: Some(path.clone()),
        project: Some(path.clone()),
        ..Default::default()
    })
    .await
    .unwrap();
    let after = c.call::<ProjectList>(Empty {}).await.unwrap();
    assert_eq!(after.projects.len(), 1);
    assert_eq!(after.projects[0].path, path);
}
