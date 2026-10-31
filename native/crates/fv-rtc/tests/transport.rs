//! Real ICE + DTLS fingerprint + SCTP tests. Forced relay uses only throwaway,
//! in-process TURN credentials and asserts a relay candidate actually exists.
use fv_protocol::official::{RTC_CHANNEL, RTC_PROTOCOL};
use fv_rtc::peer::{AnswerPeer, Signal, TransportConfig, channel_stream};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use webrtc::{
    api::{APIBuilder, setting_engine::SettingEngine},
    data_channel::data_channel_init::RTCDataChannelInit,
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    peer_connection::{
        configuration::RTCConfiguration, policy::ice_transport_policy::RTCIceTransportPolicy,
        sdp::session_description::RTCSessionDescription,
    },
};

async fn exercise(relay: bool, answer_pings: bool) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tokio::time::timeout(Duration::from_secs(35), async {
        let (turn, servers) = if relay {
            use turn::{auth::{LongTermAuthHandler, generate_long_term_credentials}, relay::relay_static::RelayAddressGeneratorStatic, server::{Server, config::{ConnConfig, ServerConfig}}};
            let socket = Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap());
            let address = socket.local_addr().unwrap();
            let server = Server::new(ServerConfig {
                conn_configs: vec![ConnConfig { conn: socket, relay_addr_generator: Box::new(RelayAddressGeneratorStatic { relay_address: "127.0.0.1".parse().unwrap(), address: "127.0.0.1".into(), net: Arc::new(webrtc_util::vnet::net::Net::new(None)) }) }],
                realm: "native-test".into(), auth_handler: Arc::new(LongTermAuthHandler::new("ephemeral-test-only".into())), channel_bind_timeout: Duration::from_secs(30), alloc_close_notify: None,
            }).await.unwrap();
            let (username, credential) = generate_long_term_credentials("ephemeral-test-only", Duration::from_secs(90)).unwrap();
            (Some(server), vec![RTCIceServer { urls: vec![format!("turn:{address}?transport=udp")], username, credential }])
        } else { (None, vec![]) };
        let mut setting = SettingEngine::default();
        setting.set_include_loopback_candidate(true);
        let offerer = Arc::new(APIBuilder::new().with_setting_engine(setting).build().new_peer_connection(RTCConfiguration {
            ice_servers: servers, ice_transport_policy: if relay { RTCIceTransportPolicy::Relay } else { RTCIceTransportPolicy::All }, ..Default::default()
        }).await.unwrap());
        let (to_answer, mut candidates) = mpsc::channel(64);
        offerer.on_ice_candidate(Box::new(move |c| { let tx = to_answer.clone(); Box::pin(async move { if let Some(c) = c { tx.send(c.to_json().unwrap()).await.unwrap(); } }) }));
        let (to_offer, mut replies) = mpsc::channel(64);
        let config = TransportConfig { include_loopback: true, heartbeat_interval: Duration::from_millis(400), heartbeat_timeout: Duration::from_millis(200), ..Default::default() };
        let mut answerer = AnswerPeer::new(vec![], to_offer, config.clone()).await.unwrap();
        let mut answer_open = answerer.take_opened();
        let channel = offerer.create_data_channel(RTC_CHANNEL, Some(RTCDataChannelInit { protocol: Some(RTC_PROTOCOL.into()), ordered: Some(true), ..Default::default() })).await.unwrap();
        let mut phone = if answer_pings { Some(channel_stream(offerer.clone(), channel.clone(), config, CancellationToken::new())) } else { None };
        let offer = offerer.create_offer(None).await.unwrap();
        offerer.set_local_description(offer.clone()).await.unwrap();
        let answer = answerer.apply(Signal::Offer { sdp: offer.sdp, protocol: RTC_PROTOCOL.into() }).await.unwrap().unwrap();
        let Signal::Answer { sdp, .. } = answer else { panic!() };
        offerer.set_remote_description(RTCSessionDescription::answer(sdp).unwrap()).await.unwrap();
        let mut saw_relay = false;
        let server = loop {
            tokio::select! {
                server = &mut answer_open => break server.unwrap(),
                Some(candidate) = candidates.recv() => {
                    saw_relay |= candidate.candidate.contains(" typ relay");
                    if relay { assert!(candidate.candidate.contains(" typ relay")); }
                    answerer.apply(Signal::Candidate { candidate: candidate.candidate, mid: candidate.sdp_mid.unwrap_or_else(|| "0".into()) }).await.unwrap();
                }
                Some(Signal::Candidate { candidate, mid }) = replies.recv() => {
                    offerer.add_ice_candidate(RTCIceCandidateInit { candidate, sdp_mid: Some(mid), ..Default::default() }).await.unwrap();
                }
            }
        };
        if relay { assert!(saw_relay, "forced TURN must actually allocate and signal a relay"); }
        let mut server = server;
        if let Some(ref mut phone) = phone {
            let request = b"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"},\"protocolVersion\":1}}\n";
            phone.write_all(request).await.unwrap();
            let mut got = vec![0; request.len()]; server.read_exact(&mut got).await.unwrap(); assert_eq!(got, request);
            let large = format!("{{\"result\":\"{}\"}}\n", "x".repeat(512 * 1024));
            let expected = large.clone();
            let send = tokio::spawn(async move { server.write_all(large.as_bytes()).await.unwrap(); server });
            let mut got = vec![0; expected.len()]; phone.read_exact(&mut got).await.unwrap(); assert_eq!(got, expected.as_bytes());
            let server = send.await.unwrap();
            tokio::time::sleep(Duration::from_millis(1000)).await;
            assert!(!answerer.cancellation().is_cancelled(), "active peers answer heartbeat pings");
            drop(server);
        } else {
            let mut byte = [0];
            assert_eq!(server.read(&mut byte).await.unwrap(), 0, "silent peer must be closed by heartbeat");
        }
        answerer.close().await;
        offerer.close().await.unwrap();
        if let Some(turn) = turn { turn.close().await.unwrap(); }
    }).await.expect("real RTC handshake or transfer timed out");
}
#[tokio::test]
async fn direct_native_stream_roundtrip_and_heartbeat() {
    exercise(false, true).await;
}
#[tokio::test]
async fn forced_local_turn_native_stream_roundtrip() {
    exercise(true, true).await;
}
#[tokio::test]
async fn heartbeat_closes_silent_peer() {
    exercise(false, false).await;
}

#[tokio::test]
async fn legacy_offer_and_unbounded_early_candidates_are_rejected() {
    let (signals, _) = mpsc::channel(64);
    let mut answer = AnswerPeer::new(vec![], signals, TransportConfig::default())
        .await
        .unwrap();
    assert!(
        serde_json::from_value::<Signal>(serde_json::json!({"type":"offer","sdp":"legacy"}))
            .is_err()
    );
    assert!(
        answer
            .apply(Signal::Offer {
                sdp: "legacy".into(),
                protocol: "app-protocol-v1".into()
            })
            .await
            .is_err()
    );
    assert!(
        answer
            .apply(Signal::Offer {
                sdp: "x".repeat(16 * 1024),
                protocol: RTC_PROTOCOL.into()
            })
            .await
            .is_err()
    );
    for _ in 0..64 {
        answer
            .apply(Signal::Candidate {
                candidate: "candidate:1 1 UDP 1 127.0.0.1 1234 typ host".into(),
                mid: "0".into(),
            })
            .await
            .unwrap();
    }
    assert!(
        answer
            .apply(Signal::Candidate {
                candidate: "candidate:1 1 UDP 1 127.0.0.1 1234 typ host".into(),
                mid: "0".into()
            })
            .await
            .is_err()
    );
    answer.close().await;
}
