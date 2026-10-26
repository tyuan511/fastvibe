//! A restored GUI tab refers to the server's PTY, never to a replayed output log.
use fv_agent::testing::NoModel;
use fv_client::Client;
use fv_protocol::{PROTOCOL_VERSION, methods::*, types::*};
use fv_server::ServerState;
use std::{sync::Arc, time::Duration};

async fn connect(state: Arc<ServerState>) -> (Client, tokio::task::JoinHandle<()>) {
    let expected_busy = state.has_running_turns();
    let (io, peer) = tokio::net::UnixStream::pair().unwrap();
    let (r, w) = peer.into_split();
    let server = tokio::spawn(fv_server::serve_connection(
        state,
        ClientOrigin::Local,
        r,
        w,
    ));
    let (r, w) = io.into_split();
    let (client, _) = Client::from_io(r, w);
    let hello = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "terminal-recovery".into(),
                version: "test".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert_eq!(hello.has_running_turns, Some(expected_busy));
    assert!(
        hello
            .features
            .iter()
            .any(|feature| feature == "terminalInteraction")
    );
    (client, server)
}

#[tokio::test]
async fn terminal_history_and_copy_are_independent_for_two_clients() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(
            dir.path().join("data"),
            fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
        )
        .unwrap(),
    );
    let (first, first_server) = connect(state.clone()).await;
    let session = first
        .call::<TerminalStart>(TerminalStartParams {
            cwd: dir.path().display().to_string(),
            cols: Some(80),
            rows: Some(8),
        })
        .await
        .unwrap();
    // Match the existing real-PTY fixtures: let the user's login profile finish before input.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let numbers = (0..40).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
    first.call::<TerminalWrite>(TerminalWriteParams { id: session.id.clone(), data: format!("printf '\\033[3J\\033[2J\\033[H'; for i in {numbers}; do printf 'hist-%s\\n' \"$i\"; done\n") }).await.unwrap();
    output(&first, &session.id, "hist-39").await;
    let (second, second_server) = connect(state.clone()).await;
    let history = first
        .call::<TerminalRead>(TerminalReadParams {
            id: session.id.clone(),
            offset: 20,
            anchor: None,
        })
        .await
        .unwrap();
    assert_eq!(history.offset, 20);
    assert!(history.cursor_hidden);
    let selected = history.lines[0].text.trim_end().to_string();
    assert!(selected.starts_with("hist-"), "{selected}");
    let point = TerminalPoint {
        line: history.anchor.serial as i64 - history.offset as i64,
        column: 0,
    };
    let copy = TerminalCopyParams {
        id: session.id.clone(),
        epoch: history.anchor.epoch,
        start: point,
        end: TerminalPoint {
            column: history.cols,
            ..point
        },
    };
    assert_eq!(
        first.call::<TerminalCopy>(copy.clone()).await.unwrap().text,
        selected
    );

    second
        .call::<TerminalWrite>(TerminalWriteParams {
            id: session.id.clone(),
            data: "printf 'tail-%s\\n' 'after-history'\n".into(),
        })
        .await
        .unwrap();
    let live = output(&second, &session.id, "tail-after-history").await;
    assert_eq!(live.offset, 0);
    let anchored = first
        .call::<TerminalRead>(TerminalReadParams {
            id: session.id.clone(),
            offset: history.offset,
            anchor: Some(history.anchor),
        })
        .await
        .unwrap();
    assert!(anchored.offset > history.offset);
    assert_eq!(anchored.lines[0], history.lines[0]);
    assert_eq!(
        first.call::<TerminalCopy>(copy.clone()).await.unwrap().text,
        selected
    );
    assert!(
        anchored
            .lines
            .iter()
            .all(|row| row.widths.len() == row.text.chars().count())
    );
    first
        .call::<TerminalResize>(TerminalResizeParams {
            id: session.id.clone(),
            cols: 100,
            rows: 8,
        })
        .await
        .unwrap();
    assert!(
        first.call::<TerminalCopy>(copy).await.is_err(),
        "a resized screen cannot reuse stale selection coordinates"
    );
    first
        .call::<TerminalKill>(TerminalIdParams { id: session.id })
        .await
        .unwrap();
    drop(first);
    drop(second);
    tokio::time::timeout(Duration::from_secs(5), first_server)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), second_server)
        .await
        .unwrap()
        .unwrap();
}

async fn output(client: &Client, id: &str, expected: &str) -> TerminalFrame {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = client
                .call::<TerminalRead>(TerminalReadParams {
                    id: id.into(),
                    offset: 0,
                    anchor: None,
                })
                .await
                .unwrap();
            if frame.lines.iter().any(|line| line.text.contains(expected)) {
                return frame;
            }
            assert!(!frame.exited, "terminal exited before producing {expected}");
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("PTY output")
}

#[tokio::test]
async fn gui_disconnect_keeps_the_same_pty_and_server_restart_rejects_its_old_id() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let state = Arc::new(
        ServerState::new(
            data.clone(),
            fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
        )
        .unwrap(),
    );
    let (client, server) = connect(state.clone()).await;
    let session = client
        .call::<TerminalStart>(TerminalStartParams {
            cwd: dir.path().display().to_string(),
            cols: Some(100),
            rows: Some(24),
        })
        .await
        .unwrap();
    // The result is not present verbatim in the command echo.
    client
        .call::<TerminalWrite>(TerminalWriteParams {
            id: session.id.clone(),
            data: "FV_RECONNECT_MARK=after-reconnect; printf 'restored-%s\\n' 'terminal-ok'\n"
                .into(),
        })
        .await
        .unwrap();
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();

    let (client, server) = connect(state.clone()).await;
    let frame = output(&client, &session.id, "restored-terminal-ok").await;
    assert_eq!(frame.id, session.id);
    assert_eq!((frame.cols, frame.rows), (100, 24));
    assert_eq!(frame.cwd, session.cwd);
    client
        .call::<TerminalWrite>(TerminalWriteParams {
            id: session.id.clone(),
            data: "printf 'interactive-%s\\n' \"$FV_RECONNECT_MARK\"\n".into(),
        })
        .await
        .unwrap();
    output(&client, &session.id, "interactive-after-reconnect").await;
    client
        .call::<TerminalKill>(TerminalIdParams {
            id: session.id.clone(),
        })
        .await
        .unwrap();
    assert!(
        client
            .call::<TerminalRead>(TerminalReadParams {
                id: session.id.clone(),
                offset: 0,
                anchor: None
            })
            .await
            .is_err()
    );
    assert!(
        !state.has_running_turns(),
        "killed PTYs no longer block a server upgrade"
    );
    let lost_session = client
        .call::<TerminalStart>(TerminalStartParams {
            cwd: session.cwd.clone(),
            cols: Some(80),
            rows: Some(24),
        })
        .await
        .unwrap();
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert!(
        state.has_running_turns(),
        "the live shell outlives its GUI connection"
    );
    drop(state);

    let restarted = Arc::new(
        ServerState::new(data, fv_server::agent_with_builtin_tools(Arc::new(NoModel))).unwrap(),
    );
    let (client, server) = connect(restarted).await;
    assert!(
        client
            .call::<TerminalRead>(TerminalReadParams {
                id: lost_session.id,
                offset: 0,
                anchor: None
            })
            .await
            .is_err()
    );
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}
