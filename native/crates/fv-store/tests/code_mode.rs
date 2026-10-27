use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_protocol::types::{Item, TurnStatus};
use fv_store::Store;
use serde_json::json;
fn call(id: &str) -> Message {
    Message::Assistant(AssistantMessage {
        content: vec![ContentBlock::ToolCall {
            id: id.into(),
            name: "code_mode".into(),
            arguments: json!({"code":"text('summary')"}),
        }],
        stop: StopReason::ToolUse,
        usage: Default::default(),
        model: None,
        duration_ms: None,
    })
}
fn trace(id: &str, output: Option<&str>) -> Item {
    Item::ToolCall {
        id: id.into(),
        name: "exec_command".into(),
        arguments: json!({"cmd":"printf original"}),
        output: output.map(str::to_string),
        is_error: false,
    }
}
#[test]
fn nested_activity_is_ui_only_upserts_and_rewinds_and_forks_with_its_provider_call() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let log = &store.transcripts;
    log.start_turn("root", "first").unwrap();
    log.append(
        "root",
        &[
            Message::User {
                text: "work".into(),
            },
            call("outer-one"),
        ],
    )
    .unwrap();
    log.tool_activity("root", "first", "outer-one", trace("nested-one", None))
        .unwrap();
    log.tool_activity(
        "root",
        "first",
        "outer-one",
        trace("nested-one", Some("completed nested output")),
    )
    .unwrap();
    log.append(
        "root",
        &[Message::ToolResult {
            call_id: "outer-one".into(),
            name: "code_mode".into(),
            content: "summary".into(),
            is_error: false,
        }],
    )
    .unwrap();
    log.finish_turn("root", "first", TurnStatus::Completed, None)
        .unwrap();
    log.start_turn("root", "second").unwrap();
    log.append(
        "root",
        &[
            Message::User {
                text: "delegate".into(),
            },
            call("outer-two"),
        ],
    )
    .unwrap();
    log.tool_activity("root", "second", "outer-two", trace("nested-two", None))
        .unwrap();
    let loaded = log.read("root").unwrap();
    assert_eq!(loaded.messages.len(), 5);
    let turns = loaded.turns();
    assert_eq!(
        turns[0]
            .items
            .iter()
            .filter(|i| matches!(i,Item::ToolCall{id,..}if id=="nested-one"))
            .count(),
        1
    );
    assert!(turns[1].items.iter().any(
        |i| matches!(i,Item::ToolCall{id,is_error:true,output:Some(_),..}if id=="nested-two")
    ));
    assert!(
        log.search("root", "completed nested output")
            .unwrap()
            .is_some()
    );
    let fork = loaded.before_tool_call("second", "outer-two", 5).unwrap();
    log.copy_loaded("child", &fork, &fork.messages).unwrap();
    let child = log.read("child").unwrap();
    assert_eq!(child.skipped, 0);
    assert!(
        child.turns()[0]
            .items
            .iter()
            .any(|i| matches!(i,Item::ToolCall{id,..}if id=="nested-one"))
    );
    assert!(
        !child
            .turns()
            .iter()
            .flat_map(|t| &t.items)
            .any(|i| matches!(i,Item::ToolCall{id,..}if id=="nested-two"))
    );
    log.rewind_before("root", 3, Some("second")).unwrap();
    assert_eq!(log.read("root").unwrap().turns().len(), 1);
    log.rewind_before("root", 0, Some("first")).unwrap();
    assert!(log.read("root").unwrap().turns().is_empty());
}
