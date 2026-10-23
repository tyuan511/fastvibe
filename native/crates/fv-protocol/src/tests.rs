use serde_json::json;

use crate::methods::{CLIENT_METHODS, Initialize, ThreadList};
use crate::*;

#[test]
fn request_roundtrips_with_method_tag() {
    let wire = json!({
        "method": "initialize",
        "id": 1,
        "params": {
            "clientInfo": {"name": "fv-gui", "version": "0.1.0"},
            "protocolVersion": 1
        }
    });
    let req: ClientRequest = serde_json::from_value(wire).unwrap();
    assert_eq!(req.method(), Initialize::METHOD);
    assert_eq!(req.id(), &RequestId::Number(1));
    let back = serde_json::to_value(&req).unwrap();
    assert_eq!(back["method"], "initialize");
    assert_eq!(back["params"]["clientInfo"]["name"], "fv-gui");
}

#[test]
fn unknown_method_is_rejected() {
    let wire = json!({"method": "nope", "id": 1, "params": {}});
    assert!(serde_json::from_value::<ClientRequest>(wire).is_err());
}

#[test]
fn notification_has_no_id() {
    let n = ServerNotification::CatalogChanged(types::CatalogChanged {});
    let v = serde_json::to_value(&n).unwrap();
    assert_eq!(v, json!({"method": "catalog/changed", "params": {}}));
}

#[test]
fn thread_events_flatten_their_body() {
    let n = ServerNotification::AgentMessageDelta(types::ThreadEvent {
        thread_id: "t1".into(),
        seq: 7,
        body: types::Delta {
            turn_id: "u1".into(),
            item_id: "i1".into(),
            delta: "hi".into(),
        },
    });
    let v = serde_json::to_value(&n).unwrap();
    assert_eq!(
        v["params"],
        json!({"threadId":"t1","seq":7,"turnId":"u1","itemId":"i1","delta":"hi"})
    );
}

#[test]
fn method_names_are_unique_and_typed_markers_agree() {
    let mut names = CLIENT_METHODS.to_vec();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), CLIENT_METHODS.len());
    assert_eq!(ThreadList::METHOD, "thread/list");
}

#[test]
fn frames_are_told_apart_by_shape() {
    let req: Message =
        serde_json::from_value(json!({"id": 3, "method": "thread/list", "params": {}})).unwrap();
    assert!(matches!(req, Message::Request { .. }));
    let note: Message = serde_json::from_value(json!({"method": "initialized"})).unwrap();
    assert!(matches!(note, Message::Notification { .. }));
    let ok: Message = serde_json::from_value(json!({"id": "a", "result": {}})).unwrap();
    assert!(matches!(ok, Message::Response { .. }));
    let err: Message =
        serde_json::from_value(json!({"id": 1, "error": {"code": -32601, "message": "x"}}))
            .unwrap();
    assert!(matches!(err, Message::Error { .. }));
}

/// The committed schema is what the Flutter client generates its types from, so a change to
/// the protocol must show up as a diff in `native/schema/`.
/// Regenerate with `UPDATE_SCHEMA=1 cargo test -p fv-protocol schema`.
#[test]
fn schema_matches_committed_snapshot() {
    let schema = serde_json::json!({
        "clientRequest": schemars::schema_for!(ClientRequest),
        "clientNotification": schemars::schema_for!(ClientNotification),
        "serverNotification": schemars::schema_for!(ServerNotification),
        "message": schemars::schema_for!(Message),
    });
    let text = serde_json::to_string_pretty(&schema).unwrap() + "\n";
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../schema/protocol.json");
    if std::env::var_os("UPDATE_SCHEMA").is_some() {
        std::fs::write(path, &text).unwrap();
    }
    let committed = std::fs::read_to_string(path).expect("run with UPDATE_SCHEMA=1 to create it");
    // Compared as values, not text: whether object keys keep their insertion order depends on
    // which crates in the build turn on serde_json's `preserve_order`, which must not matter.
    let committed: serde_json::Value =
        serde_json::from_str(&committed).expect("committed schema is JSON");
    assert_eq!(
        committed, schema,
        "protocol changed: rerun with UPDATE_SCHEMA=1 and commit native/schema/"
    );
}
