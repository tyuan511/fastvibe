//! Local interop fixture for a real Flutter/libwebrtc runner. No account credentials.
//! cargo run -p fv-rtc --example flutter_peer -- 17779
//! WebSocket /signal speaks Signal JSON; /ice returns an ephemeral forced-relay config.
//! The accepted native stream answers initialize using fv-protocol's Message type.
use axum::{
    Json, Router,
    extract::{
        State,
        ws::{Message, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use fv_protocol::{Message as RpcMessage, RequestId, official::RTC_PROTOCOL};
use fv_rtc::peer::{AnswerPeer, Signal, TransportConfig};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
#[derive(Clone)]
struct Fixture {
    ice: serde_json::Value,
}
async fn signal(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(|mut socket| async move {
        let (signals, mut output) = mpsc::channel(64);
        let mut answer = AnswerPeer::new(vec![], signals, TransportConfig { include_loopback: true, ..Default::default() }).await.unwrap();
        let mut opened = answer.take_opened();
        let mut handed = false;
        loop {
            tokio::select! {
                Some(signal) = output.recv() => { if socket.send(Message::Text(serde_json::to_string(&signal).unwrap().into())).await.is_err() { break; } }
                Some(Ok(Message::Text(text))) = socket.recv() => {
                    let Ok(signal) = serde_json::from_str::<Signal>(&text) else { break; };
                    match answer.apply(signal).await {
                        Ok(Some(signal)) => { if socket.send(Message::Text(serde_json::to_string(&signal).unwrap().into())).await.is_err() { break; } },
                        Ok(None) => {}, Err(_) => break,
                    }
                }
                stream = &mut opened, if !handed => {
                    let Ok(stream) = stream else { break; };
                    handed = true;
                    tokio::spawn(async move {
                        let (read, mut write) = tokio::io::split(stream);
                        let mut lines = BufReader::new(read).lines();
                        let Some(line) = lines.next_line().await.unwrap() else { return; };
                        let request: RpcMessage = serde_json::from_str(&line).unwrap();
                        let RpcMessage::Request { id, method, .. } = request else { panic!("expected native request") };
                        assert_eq!(method, "initialize");
                        assert_eq!(id, RequestId::Number(1));
                        let response = RpcMessage::Response { id, result: json!({"protocolVersion":1,"serverVersion":"rtc-fixture","features":[],"dataDir":"fixture","large":"x".repeat(128*1024)}) };
                        let mut bytes = serde_json::to_vec(&response).unwrap(); bytes.push(b'\n');
                        write.write_all(&bytes).await.unwrap();
                        println!("native fv-protocol initialize response sent over {RTC_PROTOCOL}");
                        while lines.next_line().await.unwrap().is_some() {}
                    });
                }
                _ = tokio::time::sleep(Duration::from_secs(40)) => break,
            }
        }
        answer.close().await;
    })
}
#[tokio::main]
async fn main() {
    use turn::{
        auth::{LongTermAuthHandler, generate_long_term_credentials},
        relay::relay_static::RelayAddressGeneratorStatic,
        server::{
            Server,
            config::{ConnConfig, ServerConfig},
        },
    };
    let port = std::env::args().nth(1).unwrap_or_else(|| "17779".into());
    let udp = Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let turn_address = udp.local_addr().unwrap();
    let turn = Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn: udp,
            relay_addr_generator: Box::new(RelayAddressGeneratorStatic {
                relay_address: "127.0.0.1".parse().unwrap(),
                address: "127.0.0.1".into(),
                net: Arc::new(webrtc_util::vnet::net::Net::new(None)),
            }),
        }],
        realm: "native-flutter-interop".into(),
        auth_handler: Arc::new(LongTermAuthHandler::new("ephemeral-only".into())),
        channel_bind_timeout: Duration::from_secs(30),
        alloc_close_notify: None,
    })
    .await
    .unwrap();
    let (username, credential) =
        generate_long_term_credentials("ephemeral-only", Duration::from_secs(300)).unwrap();
    let state = Fixture {
        ice: json!({"iceServers":[{"urls":[format!("turn:{turn_address}?transport=udp")],"username":username,"credential":credential}],"iceTransportPolicy":"relay"}),
    };
    let app = Router::new()
        .route("/signal", get(signal))
        .route(
            "/ice",
            get(|State(state): State<Fixture>| async move { Json(state.ice) }),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    println!(
        "Flutter native RTC fixture listening on {}",
        listener.local_addr().unwrap()
    );
    axum::serve(listener, app).await.unwrap();
    turn.close().await.unwrap();
}
