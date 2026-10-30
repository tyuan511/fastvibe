//! App settings over the protocol: defaults, partial updates, and everyone being told.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::methods::{DiagnosticsGet, Initialize, SettingsGet, SettingsReset, SettingsSet};
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
async fn browser_settings_validate_templates_and_persist() {
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (client, _) = connect(&sock).await;
    let error = client
        .call::<SettingsSet>(AppSettingsPatch {
            browser_search_engine: Some("https://search.example/".into()),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("{query}"));
    let error = client.call::<SettingsSet>(AppSettingsPatch {browser_engine:Some("arbitrary-command".into()),..Default::default()}).await.unwrap_err();
    assert!(error.to_string().contains("browserEngine"));
    let saved = client
        .call::<SettingsSet>(AppSettingsPatch {
            browser_homepage: Some("https://example.com/docs".into()),
            browser_search_engine: Some("https://search.example/?q={query}".into()),
            browser_download_dir: Some("/tmp/fastvibe-downloads".into()),
            browser_use_system: Some(true),
            browser_engine: Some("chrome".into()),
            keep_awake: Some(true),
            proxy_url: Some("http://127.0.0.1:8888".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(saved.browser_homepage, "https://example.com/docs");
    assert_eq!(
        saved.browser_search_engine,
        "https://search.example/?q={query}"
    );
    assert_eq!(saved.browser_download_dir, "/tmp/fastvibe-downloads");
    assert!(saved.browser_use_system);
    assert_eq!(saved.browser_engine,"chrome");
    assert!(saved.keep_awake);
    assert_eq!(saved.proxy_url, "http://127.0.0.1:8888");
    assert_eq!(client.call::<SettingsGet>(Empty {}).await.unwrap(), saved);
}

#[tokio::test]
async fn reset_preferences_restores_defaults() {
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (client, _) = connect(&sock).await;
    client
        .call::<SettingsSet>(AppSettingsPatch {
            browser_homepage: Some("https://example.com".into()),
            custom_system_prompt: Some("keep this until reset".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let reset = client.call::<SettingsReset>(Empty {}).await.unwrap();
    assert_eq!(reset, AppSettings::default());
    assert_eq!(client.call::<SettingsGet>(Empty {}).await.unwrap(), reset);
}

#[tokio::test]
async fn diagnostics_are_bounded_and_do_not_include_credentials_or_paths() {
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (client, _) = connect(&sock).await;
    let diagnostics = client.call::<DiagnosticsGet>(Empty {}).await.unwrap();
    assert_eq!(diagnostics.app_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(diagnostics.platform, std::env::consts::OS);
    let json = serde_json::to_string(&diagnostics).unwrap();
    assert!(!json.contains(data.path().to_str().unwrap()));
    assert!(!json.contains("api_key"));
}

#[tokio::test]
async fn auto_archive_moves_only_old_unpinned_idle_threads() {
    use fv_protocol::methods::{ThreadList, ThreadStart};
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (client, _) = connect(&sock).await;
    client
        .call::<SettingsSet>(AppSettingsPatch {
            auto_archive_after_days: Some(Some(30)),
            ..Default::default()
        })
        .await
        .unwrap();
    let old = client
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread;
    let pinned = client
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread;
    let mut old_record = state.thread(&old.id).unwrap().unwrap();
    old_record.updated_at = chrono::Utc::now().timestamp_millis() - 31 * 86_400_000;
    state.store.db.put_thread(&old_record).unwrap();
    let mut pinned_record = state.thread(&pinned.id).unwrap().unwrap();
    pinned_record.updated_at = old_record.updated_at;
    pinned_record.pinned = true;
    state.store.db.put_thread(&pinned_record).unwrap();
    state.archive_stale_threads();
    let visible = client
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap();
    assert!(visible.threads.iter().all(|thread| thread.id != old.id));
    assert!(visible.threads.iter().any(|thread| thread.id == pinned.id));
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
    let context = model.requests()[0]
        .project_context()
        .unwrap_or_default()
        .to_string();
    assert!(context.contains("more than one folder"), "{context}");
    assert!(context.contains(&path(&b)), "{context}");

    // Sidebar state follows a changed primary folder, too.
    client
        .call::<SettingsSet>(AppSettingsPatch {
            sidebar: Some(SidebarSettingsPatch {
                closed_projects: Some(vec![path(&a)]),
                project_order: Some(vec![path(&a)]),
                order: Some([(format!("project:{}", path(&a)), vec![thread.id.clone()])].into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
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
    let sidebar = client.call::<SettingsGet>(Empty {}).await.unwrap().sidebar;
    assert_eq!(sidebar.closed_projects, [path(&b)]);
    assert_eq!(sidebar.project_order, [path(&b)]);
    assert_eq!(
        sidebar.order[&format!("project:{}", path(&b))],
        std::slice::from_ref(&thread.id)
    );
    assert!(!sidebar.order.contains_key(&format!("project:{}", path(&a))));
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

#[tokio::test]
async fn sidebar_settings_merge_sections_broadcast_and_survive_restart() {
    let data = tempfile::tempdir().unwrap();
    let agent = || fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent()).unwrap());
    let server = UnixServer::bind(state.clone(), &data.path().join("s.sock"))
        .await
        .unwrap();
    tokio::spawn(server.run());
    let (a, _) = connect(&data.path().join("s.sock")).await;
    let (b, mut notes) = connect(&data.path().join("s.sock")).await;
    a.call::<SettingsSet>(AppSettingsPatch {
        sidebar: Some(SidebarSettingsPatch {
            width: Some(380.0),
            collapsed: Some(true),
            closed_projects: Some(vec!["/work".into()]),
            project_order: Some(vec!["/b".into(), "/a".into()]),
            order: Some([("pinned".into(), vec!["p2".into(), "p1".into()])].into()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await
    .unwrap();
    let heard = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ServerNotification::SettingsChanged(s)) = notes.recv().await {
                break s;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(heard.sidebar.width, 380.0);
    let updated = b
        .call::<SettingsSet>(AppSettingsPatch {
            sidebar: Some(SidebarSettingsPatch {
                order: Some([("chats".into(), vec!["c2".into(), "c1".into()])].into()),
                sort: Some(SidebarSort::Title),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(updated.sidebar.order["pinned"], ["p2", "p1"]);
    assert!(updated.sidebar.collapsed);
    assert_eq!(updated.sidebar.width, 380.0);
    // Reopen storage through a fresh server state, not the client's optimistic state.
    let reopened = ServerState::new(data.path().to_path_buf(), agent()).unwrap();
    let stored = reopened
        .store
        .db
        .get_setting("app.settings")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<AppSettings>(&stored).unwrap(),
        updated
    );
    let clamped = a
        .call::<SettingsSet>(AppSettingsPatch {
            sidebar: Some(SidebarSettingsPatch {
                width: Some(9999.0),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(clamped.sidebar.width, 480.0);
}

#[tokio::test]
async fn a_fork_has_independent_history_images_and_subscription() {
    use fv_core::{ImagePart, ImageSource, Message};
    use fv_protocol::methods::{ThreadDelete, ThreadFork, ThreadResume};
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let original = state.create_thread(None, None, None, None).unwrap();
    let image = state
        .store
        .images
        .externalize(
            &original.id,
            &Message::ToolImages {
                call_id: "image-call".into(),
                name: "view_image".into(),
                images: vec![ImagePart {
                    mime: "image/png".into(),
                    source: ImageSource::Base64 {
                        // A real 1×1 PNG: saving decodes and shrinks the picture.
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".into(),
                    },
                }],
            },
        )
        .unwrap();
    state
        .store
        .transcripts
        .append_timed(
            &original.id,
            &[
                Message::User {
                    text: "original prompt".into(),
                },
                image,
            ],
            &[111, 222],
        )
        .unwrap();
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (c, _) = connect(&sock).await;
    let fork = c
        .call::<ThreadFork>(ThreadIdParams {
            thread_id: original.id.clone(),
        })
        .await
        .unwrap()
        .thread;
    assert_ne!(fork.id, original.id);
    assert!(!fork.archived && !fork.pinned && !fork.unread);
    assert_eq!(state.subscriber_count(&fork.id), 1);
    let copied = state.store.transcripts.read(&fork.id).unwrap();
    assert_eq!(copied.timestamps, [111, 222]);
    assert_eq!(
        copied.messages[0],
        Message::User {
            text: "original prompt".into()
        }
    );
    let Message::ToolImages { images, .. } = &copied.messages[1] else {
        panic!("picture")
    };
    let ImageSource::File { path } = &images[0].source else {
        panic!("externalized")
    };
    assert!(path.contains(&fork.id));
    c.call::<ThreadDelete>(ThreadIdParams {
        thread_id: original.id,
    })
    .await
    .unwrap();
    assert!(
        std::fs::read(path).unwrap().starts_with(b"\x89PNG"),
        "the fork's copy outlives the original"
    );
    assert!(
        !c.call::<ThreadResume>(ThreadIdParams {
            thread_id: fork.id.clone()
        })
        .await
        .unwrap()
        .turns
        .is_empty()
    );
    let rt = state.runtime(&fork.id);
    rt.begin(&state, "busy").await.unwrap();
    assert!(
        c.call::<ThreadFork>(ThreadIdParams {
            thread_id: fork.id.clone()
        })
        .await
        .is_err(),
        "a partial tool batch is never copied"
    );
    rt.end(&state).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_sidebar_patches_do_not_erase_each_other() {
    let data = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let mut clients = Vec::new();
    for _ in 0..12 {
        clients.push(connect(&sock).await.0);
    }
    let jobs: Vec<_> = clients
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            tokio::spawn(async move {
                c.call::<SettingsSet>(AppSettingsPatch {
                    sidebar: Some(SidebarSettingsPatch {
                        order: Some([(format!("project:{i}"), vec![format!("chat:{i}")])].into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .await
                .unwrap();
            })
        })
        .collect();
    for job in jobs {
        job.await.unwrap();
    }
    let (c, _) = connect(&sock).await;
    let prefs = c.call::<SettingsGet>(Empty {}).await.unwrap().sidebar;
    assert_eq!(prefs.order.len(), 12);
}
