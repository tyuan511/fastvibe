use serde_json::json;

use crate::methods::{CLIENT_METHODS, Initialize, ThreadList};
use crate::*;

#[test]
fn personalization_defaults_empty_and_roundtrips_verbatim_with_clearable_patches() {
    use types::{AppSettings, AppSettingsPatch};
    let mut settings: AppSettings = serde_json::from_value(json!({
        "themeMode":"system", "lightTheme":"github-light", "darkTheme":"github-dark", "glass":false
    }))
    .unwrap();
    assert_eq!(settings.custom_system_prompt, "");
    let text = "  请先说明计划。\nKeep API names as written.\n";
    let patch: AppSettingsPatch = serde_json::from_value(json!({
        "customSystemPrompt": text, "expectedCustomSystemPrompt":""
    }))
    .unwrap();
    assert_eq!(patch.expected_custom_system_prompt.as_deref(), Some(""));
    settings.apply(patch);
    assert_eq!(
        serde_json::to_value(&settings).unwrap()["customSystemPrompt"],
        text
    );
    settings.apply(serde_json::from_value(json!({"glass": true})).unwrap());
    assert_eq!(settings.custom_system_prompt, text);
    settings.apply(serde_json::from_value(json!({"customSystemPrompt":""})).unwrap());
    assert!(settings.custom_system_prompt.is_empty() && settings.glass);
}

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
fn imported_thread_source_is_optional_for_old_records() {
    let mut thread: types::Thread = serde_json::from_value(json!({
        "id": "t1",
        "title": "old",
        "cwd": null,
        "project": null,
        "createdAt": 1,
        "updatedAt": 1,
        "archived": false,
        "unread": false,
        "model": null,
        "thinking": null,
        "pinned": false,
        "worktree": null
    }))
    .unwrap();
    assert!(thread.source.is_none());
    thread.source = Some("codex".into());
    assert_eq!(serde_json::to_value(thread).unwrap()["source"], "codex");
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
        "serverRequest": schemars::schema_for!(ServerRequest),
        "userInputResponse": schemars::schema_for!(types::UserInputResponse),
        "message": schemars::schema_for!(Message),
        "providerTestResult": schemars::schema_for!(crate::provider_test::ProviderTestResult),
        "modelDetail": schemars::schema_for!(crate::models::ModelDetail),
        "subagentList": schemars::schema_for!(crate::subagents::SubagentListResponse),
        "subagentConfig": schemars::schema_for!(crate::subagents::SubagentConfig),
        "subagentRoles": schemars::schema_for!(crate::subagents::SubagentRolesResponse),
        "schedules": schemars::schema_for!(crate::schedules::ScheduleSnapshot),
        "scheduleHistory": schemars::schema_for!(crate::schedules::ScheduleHistory),
        "officeRender": schemars::schema_for!(crate::office::OfficeRenderResponse),
        "officeWatch": schemars::schema_for!(crate::office::OfficeWatchState),
        "officeSelection": schemars::schema_for!(crate::office::OfficeSelection),
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

#[test]
fn automatic_compaction_defaults_on_for_old_settings_and_accepts_an_explicit_off_patch() {
    let mut legacy = serde_json::to_value(types::AppSettings::default()).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("autoCompactionEnabled");
    let mut settings: types::AppSettings = serde_json::from_value(legacy).unwrap();
    assert!(settings.auto_compaction_enabled);
    settings
        .apply(serde_json::from_value(serde_json::json!({"autoCompactionEnabled":false})).unwrap());
    assert!(!settings.auto_compaction_enabled);
    assert_eq!(settings.light_theme, "github-light");
    assert_eq!(
        serde_json::to_value(settings).unwrap()["autoCompactionEnabled"],
        false
    );
}

#[test]
fn a_question_request_has_its_wire_shape() {
    let req = ServerRequest::UserInput {
        id: RequestId::String("r1".into()),
        params: types::UserInputRequest {
            thread_id: "t".into(),
            turn_id: "u".into(),
            call_id: "c".into(),
            questions: vec![types::Question {
                id: "scope".into(),
                header: "Scope".into(),
                question: "How far?".into(),
                options: vec![types::QuestionOption {
                    label: "Small".into(),
                    description: "Just this".into(),
                }],
                is_other: true,
            }],
        },
    };
    let v = serde_json::to_value(&req).unwrap();
    assert_eq!(v["method"], "item/question/request");
    assert_eq!(v["id"], "r1");
    assert_eq!(v["params"]["questions"][0]["isOther"], true);
    assert_eq!(serde_json::from_value::<ServerRequest>(v).unwrap(), req);

    let answer: types::UserInputResponse =
        serde_json::from_value(json!({"answers": {"scope": {"answers": ["Small"]}}})).unwrap();
    assert_eq!(answer.answers["scope"].answers, ["Small"]);
}

#[test]
fn plan_updates_use_snake_case_statuses() {
    let n = ServerNotification::TurnPlanUpdated(types::ThreadEvent {
        thread_id: "t".into(),
        seq: 3,
        body: types::PlanUpdated {
            turn_id: "u".into(),
            explanation: None,
            plan: vec![types::PlanStep {
                step: "do it".into(),
                status: types::PlanStatus::InProgress,
            }],
        },
    });
    let v = serde_json::to_value(&n).unwrap();
    assert_eq!(v["method"], "turn/plan/updated");
    assert_eq!(v["params"]["plan"][0]["status"], "in_progress");
}

#[test]
fn a_provider_never_carries_its_key() {
    let p = types::ProviderInfo {
        id: "relay".into(),
        name: "Relay".into(),
        protocol: types::ApiProtocol::Chat,
        base_url: "https://x/v1".into(),
        has_key: true,
        enabled: true,
        models: vec![],
    };
    let v = serde_json::to_value(&p).unwrap();
    assert_eq!(v["hasKey"], true);
    assert!(
        v.get("apiKey").is_none(),
        "a key field exists on what is sent to clients"
    );

    // On the way in the key is optional (absent keeps the stored one).
    let upsert: types::ProviderUpsertParams = serde_json::from_value(
        json!({"name": "R", "protocol": "responses", "baseUrl": "https://x"}),
    )
    .unwrap();
    assert_eq!(upsert.api_key, None);
    assert!(upsert.enabled && upsert.models.is_empty());
}

#[test]
fn model_info_defaults_to_seeing_images() {
    let m: types::ModelInfo = serde_json::from_value(json!({"id": "m", "name": null})).unwrap();
    assert!(m.supports_images && m.protocol.is_none());
}

#[test]
fn sidebar_preferences_accept_old_settings_and_merge_only_the_named_sections() {
    use crate::types::{AppSettings, SidebarSettings, SidebarSettingsPatch};
    let settings: AppSettings = serde_json::from_str(r#"{"themeMode":"system","lightTheme":"github-light","darkTheme":"github-dark","glass":false}"#).unwrap();
    assert_eq!(settings.sidebar, SidebarSettings::default());
    let mut sidebar = settings.sidebar;
    sidebar.apply(SidebarSettingsPatch {
        width: Some(1.0),
        order: Some([("pinned".into(), vec!["a".into()])].into()),
        ..Default::default()
    });
    assert_eq!(sidebar.width, 200.0);
    sidebar.apply(SidebarSettingsPatch {
        width: Some(f32::NAN),
        order: Some([("chats".into(), vec!["b".into()])].into()),
        ..Default::default()
    });
    assert_eq!(sidebar.width, 200.0);
    assert_eq!(sidebar.order["pinned"], ["a"]);
    assert_eq!(sidebar.order["chats"], ["b"]);
}

#[test]
fn code_mode_defaults_on_for_old_settings_and_can_be_explicitly_disabled() {
    let mut value = serde_json::to_value(types::AppSettings::default()).unwrap();
    value.as_object_mut().unwrap().remove("codeModeEnabled");
    let mut settings: types::AppSettings = serde_json::from_value(value).unwrap();
    assert!(settings.code_mode_enabled);
    settings.apply(serde_json::from_value(serde_json::json!({"codeModeEnabled":false})).unwrap());
    let saved = serde_json::to_value(&settings).unwrap();
    assert_eq!(saved["codeModeEnabled"], false);
    assert!(
        !serde_json::from_value::<types::AppSettings>(saved)
            .unwrap()
            .code_mode_enabled
    );
}
