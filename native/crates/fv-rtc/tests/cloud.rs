//! Local HTTP/WebSocket contract fixture. No production account, network or credentials.
use axum::{
    Json, Router,
    extract::{
        State,
        ws::{Message, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::IntoResponse,
    routing::{get, post, put},
};
use fv_rtc::{
    account::{Issuer, PendingLogin},
    official::{OfficialConfig, OfficialConnection},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Default)]
struct Fixture {
    exchanges: Mutex<Vec<Value>>,
    registrations: Mutex<Vec<Value>>,
    hellos: Mutex<Vec<Value>>,
    ice_requests: std::sync::atomic::AtomicUsize,
}
const TOKEN: &str = "fvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn user() -> Value {
    json!({"id":"test-account","login":"fixture","avatar_url":"","email":null})
}
fn authorized(headers: &HeaderMap) {
    assert_eq!(
        headers.get("authorization").unwrap(),
        &format!("Bearer {TOKEN}")
    );
}
async fn token(State(state): State<Arc<Fixture>>, Json(body): Json<Value>) -> Json<Value> {
    assert_eq!(body["grant_type"], "authorization_code");
    assert_eq!(body["client_id"], "fastvibe-desktop");
    assert!(body["code_verifier"].as_str().unwrap().len() >= 43);
    state.exchanges.lock().unwrap().push(body);
    Json(json!({"access_token": TOKEN, "token_type":"Bearer", "expires_in":3600,"user":user()}))
}
async fn register(
    State(state): State<Arc<Fixture>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    authorized(&headers);
    state.registrations.lock().unwrap().push(body);
    Json(json!({"device":{"id":"device-test"}}))
}
async fn signal(
    State(state): State<Arc<Fixture>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    authorized(&headers);
    ws.on_upgrade(move |mut socket| async move {
        let Some(Ok(Message::Text(text))) = socket.recv().await else {
            panic!("hello missing")
        };
        let hello: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(hello["role"], "device");
        assert_eq!(hello["device_id"], "device-test");
        let first_connection = {
            let mut hellos = state.hellos.lock().unwrap();
            hellos.push(hello);
            hellos.len() == 1
        };
        socket
            .send(Message::Text(
                json!({"type":"hello","role":"device"}).to_string().into(),
            ))
            .await
            .unwrap();
        // A transient signaling loss must not mint a second ICE directory/cache.
        if first_connection {
            socket.send(Message::Close(None)).await.unwrap();
            return;
        }
        while let Some(Ok(message)) = socket.recv().await {
            if let Message::Ping(bytes) = message {
                socket.send(Message::Pong(bytes)).await.unwrap();
            }
        }
    })
}

#[tokio::test]
async fn pkce_callback_exchange_identity_registration_signaling_shutdown() {
    let fixture = Arc::new(Fixture::default());
    let app = Router::new()
        .route("/api/oauth/token", post(token))
        .route("/api/devices/me", put(register))
        .route("/api/rtc/signal", get(signal))
        .route(
            "/api/rtc/ice",
            get(|State(state): State<Arc<Fixture>>| async move {
                state
                    .ice_requests
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Json(json!({"ice_servers":[],"expires_at":"2000-01-01T00:00:00Z"}))
            }),
        )
        .route(
            "/api/me",
            get(|headers: HeaderMap| async move {
                authorized(&headers);
                Json(user())
            }),
        )
        .with_state(fixture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = Issuer::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let login = PendingLogin::begin(issuer, "Native test", "macos")
        .await
        .unwrap();
    let query: std::collections::HashMap<_, _> = login
        .authorize_url()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let redirect = url::Url::parse(&query["redirect_uri"]).unwrap();
    let target = format!("/callback?code=test-one-time-code&state={}", query["state"]);
    let completing = tokio::spawn(login.complete());
    let mut callback = tokio::net::TcpStream::connect(("127.0.0.1", redirect.port().unwrap()))
        .await
        .unwrap();
    callback
        .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut body = Vec::new();
    callback.read_to_end(&mut body).await.unwrap();
    assert!(String::from_utf8(body).unwrap().contains("Signed in"));
    let mut account = completing.await.unwrap().unwrap();
    account.refresh().await.unwrap();
    let config = OfficialConfig::new(
        "native_fixture_install".into(),
        "Fixture desktop".into(),
        "macos".into(),
    );
    let mut official = OfficialConnection::start(account, config).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                official.state.borrow().status,
                fv_protocol::official::OfficialStatus::Online
            ) && fixture.hellos.lock().unwrap().len() == 2
            {
                break;
            }
            official.state.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.exchanges.lock().unwrap().len(), 1);
    assert_eq!(
        fixture.registrations.lock().unwrap()[0]["install_id"],
        "native_fixture_install"
    );
    assert_eq!(fixture.hellos.lock().unwrap().len(), 2);
    assert_eq!(
        fixture
            .ice_requests
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert!(
        official.accepted.try_recv().is_err(),
        "a signaling socket alone is never an authenticated peer"
    );
    tokio::time::timeout(Duration::from_secs(2), official.shutdown())
        .await
        .unwrap();
    server.abort();
}
