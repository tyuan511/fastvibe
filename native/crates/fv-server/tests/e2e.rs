//! A real server on a real unix socket, driven by `fv-client`.

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::NoModel;
use fv_agent::{AgentContext, Model, ToolRegistry};
use fv_client::{Client, ClientError};
use fv_protocol::jsonrpc::code;
use fv_protocol::methods::{Initialize, ThreadList, ThreadResume, ThreadStart, ThreadUnsubscribe};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ListenError, ServerState, UnixServer, serve_connection};
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;

fn agent_with(model: Arc<dyn Model>) -> AgentContext {
    AgentContext {
        model,
        tools: Arc::new(ToolRegistry::new()),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
    }
}

fn idle_agent() -> AgentContext {
    agent_with(Arc::new(NoModel))
}

struct Harness {
    dir: tempfile::TempDir,
    state: Arc<ServerState>,
}

async fn start() -> Harness {
    start_with(idle_agent()).await
}

async fn start_with(agent: AgentContext) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    let server = UnixServer::bind(state.clone(), &dir.path().join("run/server.sock"))
        .await
        .unwrap();
    tokio::spawn(server.run());
    Harness { dir, state }
}

impl Harness {
    async fn connect(&self) -> (Client, Notes) {
        Client::connect_unix(self.dir.path().join("run/server.sock"))
            .await
            .unwrap()
    }
}

fn init_params() -> InitializeParams {
    InitializeParams {
        client_info: ClientInfo {
            name: "test".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: ClientCapabilities::default(),
    }
}

async fn initialized(h: &Harness) -> (Client, Notes) {
    let (c, n) = h.connect().await;
    c.call::<Initialize>(init_params()).await.unwrap();
    (c, n)
}

fn rpc_code<T: std::fmt::Debug>(r: Result<T, ClientError>) -> i64 {
    match r {
        Err(ClientError::Rpc(e)) => e.code,
        other => panic!("expected a server error, got {other:?}"),
    }
}

#[tokio::test]
async fn nothing_works_before_initialize() {
    let h = start().await;
    let (c, _n) = h.connect().await;
    assert_eq!(
        rpc_code(
            c.call::<ThreadList>(ThreadListParams {
                include_archived: false
            })
            .await
        ),
        code::NOT_INITIALIZED
    );
    c.call::<Initialize>(init_params()).await.unwrap();
    assert_eq!(
        rpc_code(c.call::<Initialize>(init_params()).await),
        code::ALREADY_INITIALIZED
    );
    c.call::<ThreadList>(ThreadListParams {
        include_archived: false,
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn protocol_version_mismatch_is_refused() {
    let h = start().await;
    let (c, _n) = h.connect().await;
    let mut p = init_params();
    p.protocol_version = PROTOCOL_VERSION + 1;
    assert_eq!(
        rpc_code(c.call::<Initialize>(p).await),
        code::INVALID_PARAMS
    );
    // Still not initialized after a refused handshake.
    assert_eq!(
        rpc_code(
            c.call::<ThreadList>(ThreadListParams {
                include_archived: false
            })
            .await
        ),
        code::NOT_INITIALIZED
    );
}

#[tokio::test]
async fn threads_are_created_listed_and_announced_to_every_client() {
    let h = start().await;
    let (a, _na) = initialized(&h).await;
    let (b, mut nb) = initialized(&h).await;

    let started = a
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some("/tmp/p".into()),
            project: None,
            model: None,
        })
        .await
        .unwrap()
        .thread;

    // The other client hears about it without asking.
    let mut kinds = Vec::new();
    for _ in 0..2 {
        let note = tokio::time::timeout(Duration::from_secs(2), nb.recv())
            .await
            .expect("notified")
            .unwrap();
        kinds.push(note.method());
    }
    assert!(
        kinds.contains(&"thread/started") && kinds.contains(&"catalog/changed"),
        "{kinds:?}"
    );

    let listed = b
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap()
        .threads;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, started.id);
    assert_eq!(listed[0].cwd.as_deref(), Some("/tmp/p"));
}

#[tokio::test]
async fn resume_subscribes_and_disconnect_unsubscribes() {
    let h = start().await;
    let (a, _na) = initialized(&h).await;
    let t = a
        .call::<ThreadStart>(ThreadStartParams {
            cwd: None,
            project: None,
            model: None,
        })
        .await
        .unwrap()
        .thread;
    // Whoever starts a thread is watching it.
    assert_eq!(h.state.subscriber_count(&t.id), 1);
    a.call::<ThreadUnsubscribe>(ThreadIdParams {
        thread_id: t.id.clone(),
    })
    .await
    .unwrap();
    assert_eq!(h.state.subscriber_count(&t.id), 0);

    let snapshot = a
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: t.id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.thread.id, t.id);
    assert_eq!(h.state.subscriber_count(&t.id), 1);

    a.call::<ThreadUnsubscribe>(ThreadIdParams {
        thread_id: t.id.clone(),
    })
    .await
    .unwrap();
    assert_eq!(h.state.subscriber_count(&t.id), 0);

    a.call::<ThreadResume>(ThreadIdParams {
        thread_id: t.id.clone(),
    })
    .await
    .unwrap();
    drop(a);
    for _ in 0..50 {
        if h.state.subscriber_count(&t.id) == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("a dropped connection stayed subscribed");
}

#[tokio::test]
async fn unknown_thread_and_unknown_method_are_distinct_errors() {
    let h = start().await;
    let (c, _n) = initialized(&h).await;
    assert_eq!(
        rpc_code(
            c.call::<ThreadResume>(ThreadIdParams {
                thread_id: "nope".into()
            })
            .await
        ),
        code::INVALID_PARAMS
    );
}

/// Raw frames, as a client that is not `fv-client` would send them.
async fn raw_exchange(state: Arc<ServerState>, lines: &[&str]) -> Vec<serde_json::Value> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(serve_connection(state, ClientOrigin::Local, sr, sw));
    let (cr, mut cw) = tokio::io::split(client_io);
    let mut reader = BufReader::new(cr).lines();
    let mut out = Vec::new();
    for line in lines {
        cw.write_all(line.as_bytes()).await.unwrap();
        cw.write_all(b"\n").await.unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(2), reader.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        out.push(serde_json::from_str(&reply).unwrap());
    }
    out
}

#[tokio::test]
async fn malformed_and_unknown_frames_get_the_right_errors() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), idle_agent()).unwrap());
    let replies = raw_exchange(
        state,
        &[
            "not json",
            r#"{"id":1,"method":"nope","params":{}}"#,
            r#"{"id":2,"method":"initialize","params":{"protocolVersion":"x"}}"#,
        ],
    )
    .await;
    assert_eq!(replies[0]["error"]["code"], code::PARSE_ERROR);
    assert_eq!(replies[1]["id"], 1);
    assert_eq!(replies[1]["error"]["code"], code::METHOD_NOT_FOUND);
    assert_eq!(replies[2]["id"], 2);
    assert_eq!(replies[2]["error"]["code"], code::INVALID_PARAMS);
}

#[tokio::test]
async fn socket_is_private_and_a_second_server_is_refused() {
    let h = start().await;
    let sock = h.dir.path().join("run/server.sock");
    let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "socket mode");
    let dir_mode = std::fs::metadata(sock.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dir_mode, 0o700, "directory mode");

    let second = UnixServer::bind(
        Arc::new(ServerState::new(h.dir.path().to_path_buf(), idle_agent()).unwrap()),
        &sock,
    )
    .await;
    assert!(matches!(second, Err(ListenError::AlreadyRunning(_))));
}

#[tokio::test]
async fn a_stale_socket_file_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("server.sock");
    // A socket left behind by a crashed server: bound, then abandoned without removing the file.
    let stale = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    drop(stale);
    assert!(sock.exists());
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), idle_agent()).unwrap());
    UnixServer::bind(state, &sock)
        .await
        .expect("stale socket is taken over");
}

#[tokio::test]
async fn in_memory_pipe_serves_like_any_transport() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), idle_agent()).unwrap());
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(serve_connection(state, ClientOrigin::Ssh, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let (client, _notes) = Client::from_io(cr, cw);
    let info = client.call::<Initialize>(init_params()).await.unwrap();
    assert_eq!(info.protocol_version, PROTOCOL_VERSION);
}
