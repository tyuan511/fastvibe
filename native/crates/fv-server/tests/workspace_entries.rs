//! File tree operations through the same protocol used by desktop and remote clients.
use fv_agent::testing::NoModel;
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

struct Harness {
    _dir: tempfile::TempDir,
    root: String,
    socket: std::path::PathBuf,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().join("data"),
                fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
            )
            .unwrap(),
        );
        let socket = dir.path().join("s.sock");
        let server = tokio::spawn(UnixServer::bind(state, &socket).await.unwrap().run());
        Self {
            _dir: dir,
            root: root.display().to_string(),
            socket,
            server,
        }
    }
    async fn client(&self) -> (Client, UnboundedReceiver<ServerNotification>) {
        let (client, notes) = Client::connect_unix(&self.socket).await.unwrap();
        let hello = client
            .call::<Initialize>(InitializeParams {
                client_info: ClientInfo {
                    name: "files-test".into(),
                    version: "0".into(),
                },
                protocol_version: PROTOCOL_VERSION,
                capabilities: Default::default(),
            })
            .await
            .unwrap();
        assert!(hello.features.iter().any(|f| f == "workspaceEntries"));
        (client, notes)
    }
}
async fn changed(notes: &mut UnboundedReceiver<ServerNotification>) -> WorkspaceEntryChange {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(note) = notes.recv().await {
            if let ServerNotification::WorkspaceEntryChanged(change) = note {
                return change;
            }
        }
        panic!("no workspace notification");
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn every_client_gets_changes_and_failed_operations_do_not_overwrite_or_publish_success() {
    let h = Harness::new().await;
    let (a, mut an) = h.client().await;
    let (b, mut bn) = h.client().await;
    let file = a
        .call::<WorkspaceCreateEntry>(CreateEntryParams {
            cwd: h.root.clone(),
            path: ".".into(),
            name: "旧名.md".into(),
            kind: EntryKind::File,
        })
        .await
        .unwrap();
    assert_eq!(changed(&mut an).await, changed(&mut bn).await);
    a.call::<WorkspaceWriteFile>(WriteFileParams {
        cwd: None,
        path: file.path.clone(),
        text: "retained bytes".into(),
    })
    .await
    .unwrap();
    let renamed = b
        .call::<WorkspaceRenameEntry>(RenameEntryParams {
            cwd: h.root.clone(),
            path: file.path,
            name: "新名.md".into(),
        })
        .await
        .unwrap();
    let change = changed(&mut an).await;
    assert_eq!(change.kind, EntryChangeKind::Renamed);
    assert_eq!(change.entry.as_ref(), Some(&renamed));
    assert_eq!(change, changed(&mut bn).await);
    assert_eq!(
        std::fs::read_to_string(&renamed.path).unwrap(),
        "retained bytes"
    );
    assert!(
        a.call::<WorkspaceCreateEntry>(CreateEntryParams {
            cwd: h.root.clone(),
            path: ".".into(),
            name: "新名.md".into(),
            kind: EntryKind::File
        })
        .await
        .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), changed(&mut bn))
            .await
            .is_err()
    );
    a.call::<WorkspaceDeleteEntry>(DeleteEntryParams {
        cwd: h.root.clone(),
        path: renamed.path.clone(),
        permanent: true,
    })
    .await
    .unwrap();
    assert_eq!(changed(&mut an).await.kind, EntryChangeKind::Deleted);
    assert_eq!(changed(&mut bn).await.path, renamed.path);
    assert!(!std::path::Path::new(&renamed.path).exists());
}

#[tokio::test]
async fn dependent_mutations_on_one_connection_keep_their_arrival_order() {
    let h = Harness::new().await;
    let (client, _notes) = h.client().await;
    for i in 0..4 {
        let parent = format!("folder-{i}");
        let child = format!("{parent}/inside.txt");
        let moved = format!("renamed-{i}");
        let (created, child_created, renamed) = tokio::join!(biased;
            client.call::<WorkspaceCreateEntry>(CreateEntryParams { cwd: h.root.clone(), path: ".".into(), name: parent.clone(), kind: EntryKind::Directory }),
            client.call::<WorkspaceCreateEntry>(CreateEntryParams { cwd: h.root.clone(), path: parent.clone(), name: "inside.txt".into(), kind: EntryKind::File }),
            client.call::<WorkspaceRenameEntry>(RenameEntryParams { cwd: h.root.clone(), path: parent, name: moved.clone() }),
        );
        created.unwrap();
        child_created.unwrap();
        renamed.unwrap();
        assert!(!std::path::Path::new(&h.root).join(child).exists());
        assert!(
            std::path::Path::new(&h.root)
                .join(moved)
                .join("inside.txt")
                .is_file()
        );
    }
}

#[tokio::test]
async fn authenticated_remote_origins_have_the_same_bounded_file_operations() {
    for origin in [ClientOrigin::Ssh, ClientOrigin::Lan, ClientOrigin::Official] {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().join("data"),
                fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
            )
            .unwrap(),
        );
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let (io, server_io) = tokio::io::duplex(65536);
        let (r, w) = tokio::io::split(server_io);
        let server = tokio::spawn(fv_server::serve_connection(state, origin, r, w));
        let (r, w) = tokio::io::split(io);
        let (client, _) = Client::from_io(r, w);
        client
            .call::<Initialize>(InitializeParams {
                client_info: ClientInfo {
                    name: "remote".into(),
                    version: "0".into(),
                },
                protocol_version: PROTOCOL_VERSION,
                capabilities: Default::default(),
            })
            .await
            .unwrap();
        let entry = client
            .call::<WorkspaceCreateEntry>(CreateEntryParams {
                cwd: root.display().to_string(),
                path: ".".into(),
                name: "file".into(),
                kind: EntryKind::File,
            })
            .await
            .unwrap();
        assert!(std::path::Path::new(&entry.path).is_file());
        assert!(
            client
                .call::<WorkspaceDeleteEntry>(DeleteEntryParams {
                    cwd: root.display().to_string(),
                    path: "../data".into(),
                    permanent: true
                })
                .await
                .is_err()
        );
        server.abort();
    }
}
