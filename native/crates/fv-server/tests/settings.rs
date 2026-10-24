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
async fn projects_hold_several_folders_and_the_agent_is_told_about_them() {
    use fv_agent::testing::Reply;
    use fv_protocol::methods::{
        ProjectCreate, ProjectList, ProjectRemove, ProjectUpdate, ThreadList, ThreadStart,
        TurnStart,
    };
    use fv_protocol::types::{ProjectCreateParams, ProjectPathParams, ProjectUpdateParams};

    let data = tempfile::tempdir().unwrap();
    let (a, b, c) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let path = |d: &tempfile::TempDir| d.path().display().to_string();
    let model = Arc::new(ScriptedModel::new([Reply::new().text("ok").done()]));
    let agent = fv_server::agent_with_builtin_tools(model.clone());
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (client, mut notes) = connect(&sock).await;

    assert!(
        client
            .call::<ProjectList>(Empty {})
            .await
            .unwrap()
            .projects
            .is_empty()
    );

    // Not a folder, and no folders at all: refused.
    let missing = data.path().join("nope").display().to_string();
    assert!(
        client
            .call::<ProjectCreate>(ProjectCreateParams {
                name: None,
                folders: vec![missing]
            })
            .await
            .is_err()
    );
    assert!(
        client
            .call::<ProjectCreate>(ProjectCreateParams {
                name: None,
                folders: vec![]
            })
            .await
            .is_err()
    );

    // The first folder is the primary one; a name of its own is kept.
    let created = client
        .call::<ProjectCreate>(ProjectCreateParams {
            name: Some("Both".into()),
            folders: vec![path(&a), path(&b), path(&a)],
        })
        .await
        .unwrap();
    assert_eq!(created.path, path(&a));
    assert_eq!(created.name, "Both");
    assert_eq!(created.folders, vec![path(&b)], "a repeat is dropped");

    // A conversation in it is told about both folders.
    let thread = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(path(&a)),
            project: Some(path(&a)),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.id.clone(),
            text: "hi".into(),
        })
        .await
        .unwrap();
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
    let system = model.requests()[0].system.clone();
    assert!(system.contains("more than one folder"), "{system}");
    assert!(system.contains(&path(&b)), "{system}");

    // Making another folder the primary one moves the conversations with it.
    let moved = client
        .call::<ProjectUpdate>(ProjectUpdateParams {
            path: path(&a),
            name: None,
            folders: vec![path(&b), path(&a), path(&c)],
        })
        .await
        .unwrap();
    assert_eq!(moved.path, path(&b));
    assert_eq!(moved.folders, vec![path(&a), path(&c)]);
    let listed = client.call::<ProjectList>(Empty {}).await.unwrap().projects;
    assert_eq!(listed.len(), 1, "the project was replaced, not copied");
    let threads = client
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap()
        .threads;
    assert_eq!(threads[0].project.as_deref(), Some(path(&b).as_str()));
    assert_eq!(
        threads[0].cwd.as_deref(),
        Some(path(&a).as_str()),
        "a conversation keeps the cwd it started with"
    );

    // Taking it off the list; a conversation in a folder puts it back.
    let left = client
        .call::<ProjectRemove>(ProjectPathParams { path: path(&b) })
        .await
        .unwrap();
    assert!(left.projects.is_empty());
    client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(path(&c)),
            project: Some(path(&c)),
            ..Default::default()
        })
        .await
        .unwrap();
    let after = client.call::<ProjectList>(Empty {}).await.unwrap();
    assert_eq!(after.projects.len(), 1);
    assert_eq!(after.projects[0].path, path(&c));
}
