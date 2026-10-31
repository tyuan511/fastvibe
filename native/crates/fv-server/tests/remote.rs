use fv_agent::testing::NoModel;
use fv_client::Client;
use fv_protocol::{methods::*, remote::*, types::*};
use fv_server::{ServerState, remote::Remote};
use std::sync::Arc;
use std::time::Duration;

fn init() -> InitializeParams {
    InitializeParams {
        client_info: ClientInfo {
            name: "test".into(),
            version: "0".into(),
        },
        protocol_version: 1,
        capabilities: Default::default(),
    }
}
fn state(dir: &tempfile::TempDir) -> Arc<ServerState> {
    Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
        )
        .unwrap(),
    )
}
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn lan_auth_policy_chunks_and_revocation_are_real_socket_operations() {
    let dir = tempfile::tempdir().unwrap();
    let state = state(&dir);
    let remote = Remote::for_state(&state).unwrap();
    let port = free_port();
    assert!(!remote.status().listening);
    remote
        .configure(RemoteConfigureParams {
            enabled: true,
            port,
            name: None,
        })
        .await
        .unwrap();
    assert!(!remote.status().listening, "no password, no listener");
    remote.set_password("test password".into()).await.unwrap();
    assert!(remote.status().listening);
    let url = format!("ws://127.0.0.1:{port}/ws");
    assert!(Client::connect_websocket(&url, "bogus").await.is_err());
    let token = Client::login(
        &format!("http://127.0.0.1:{port}"),
        "test password",
        "phone",
    )
    .await
    .unwrap();
    let (client, mut notes) = Client::connect_websocket(&url, &token).await.unwrap();
    client.call::<Initialize>(init()).await.unwrap();
    assert!(
        client.call::<RemoteStatusGet>(Empty {}).await.is_err(),
        "remote cannot manage credentials"
    );
    let thread = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(dir.path().display().to_string()),
            project: None,
            model: None,
            thinking: None,
        })
        .await
        .unwrap()
        .thread;
    std::fs::write(dir.path().join("output.bin"), [0u8, 1, 2, 255]).unwrap();
    let chunk = client
        .call::<WorkspaceReadFile>(ReadFileParams {
            thread_id: thread.id.clone(),
            path: "output.bin".into(),
            offset: 1,
            length: 2,
        })
        .await
        .unwrap();
    assert_eq!(chunk.data, "AQI=");
    assert_eq!(chunk.offset, 1);
    assert_eq!(chunk.size, 4);
    assert!(!chunk.eof);
    assert!(
        client
            .call::<WorkspaceReadFile>(ReadFileParams {
                thread_id: thread.id.clone(),
                path: "output.bin".into(),
                offset: 0,
                length: 512 * 1024 + 1
            })
            .await
            .is_err()
    );
    let device = remote.status().devices[0].id.clone();
    remote.revoke(&device).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while notes.recv().await.is_some() {}
    })
    .await
    .unwrap();
    for _ in 0..100 {
        if state.subscriber_count(&thread.id) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(state.subscriber_count(&thread.id), 0);
    assert!(Client::connect_websocket(&url, &token).await.is_err());
    remote.set_password(String::new()).await.unwrap();
    assert!(!remote.status().listening);
    fv_server::remote::shutdown(&state);
}

#[tokio::test]
async fn dual_stack_listener_accepts_both_families() {
    let listener = fv_server::remote::bind_dual_stack(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    let ipv4 = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    let _ = listener.accept().await.unwrap();
    drop(ipv4);
    if listener.local_addr().unwrap().is_ipv6() {
        let _ipv6 = tokio::net::TcpStream::connect((std::net::Ipv6Addr::LOCALHOST, port))
            .await
            .unwrap();
        let _ = listener.accept().await.unwrap();
    }
}
