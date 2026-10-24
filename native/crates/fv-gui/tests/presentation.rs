//! How turns are laid out, and the small formats the transcript uses.

use fv_gui::presentation::{FileChange, format_duration, layout, patch_changes};
use fv_protocol::types::Item;
use serde_json::json;

fn say(t: &str) -> Item {
    Item::AgentMessage {
        id: t.into(),
        text: t.into(),
    }
}

fn tool(id: &str, done: bool) -> Item {
    Item::ToolCall {
        id: id.into(),
        name: "exec_command".into(),
        arguments: json!({"cmd": "ls"}),
        output: done.then(|| "ok".into()),
        is_error: false,
    }
}

fn user() -> Item {
    Item::UserMessage {
        id: "u".into(),
        text: "hi".into(),
    }
}

#[test]
fn a_settled_turn_folds_everything_up_to_its_last_tool_call() {
    let items = vec![user(), say("first"), tool("a", true), say("answer")];
    let l = layout(&items, false);
    assert!(l.folded);
    assert_eq!(
        l.process.len(),
        2,
        "the text before the last call is process too"
    );
    assert_eq!(l.answer, vec![&items[3]]);
}

#[test]
fn nothing_folds_while_running_after_a_failure_or_without_an_answer() {
    let running = vec![user(), tool("a", true), say("answer")];
    assert!(!layout(&running, true).folded);

    let stopped_on_a_call = vec![user(), say("x"), tool("a", true)];
    assert!(!layout(&stopped_on_a_call, false).folded);

    let failed = vec![
        user(),
        tool("a", true),
        say("answer"),
        Item::Error {
            id: "e".into(),
            message: "boom".into(),
        },
    ];
    assert!(!layout(&failed, false).folded);

    let no_process = vec![user(), say("answer")];
    let l = layout(&no_process, false);
    assert!(!l.folded);
    assert_eq!(l.answer.len(), 1);
}

#[test]
fn a_patch_is_counted_per_file_and_a_new_file_has_no_removals() {
    let patch = "*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Update File: src/b.rs\n@@ fn x\n-old\n+new\n context\n*** Update File: c.rs\n*** Move to: d.rs\n@@\n-gone\n*** End Patch\n";
    assert_eq!(
        patch_changes(patch),
        vec![
            FileChange {
                path: "a.txt".into(),
                added: 2,
                removed: 0
            },
            FileChange {
                path: "src/b.rs".into(),
                added: 1,
                removed: 1
            },
            FileChange {
                path: "d.rs".into(),
                added: 0,
                removed: 1
            },
        ]
    );
}

#[test]
fn durations_read_like_the_electron_app() {
    assert_eq!(format_duration(0), "0 秒");
    assert_eq!(format_duration(18_000), "18 秒");
    assert_eq!(format_duration(120_000), "2 分钟");
    assert_eq!(format_duration(221_000), "3 分钟 41 秒");
    assert_eq!(format_duration(3_723_000), "1 小时 2 分钟 3 秒");
}

#[test]
fn file_icons_follow_the_manifest_rules() {
    use fv_gui::file_icons::resolve;
    assert_eq!(resolve("App.tsx", false), "file_type_reactts");
    assert_eq!(resolve("Dockerfile", false), "file_type_docker");
    assert_eq!(resolve("no-such-kind.zzz", false), "default_file");
    // `d.ts` is a longer extension than `ts`, and wins.
    assert_ne!(resolve("x.d.ts", false), resolve("x.ts", false));
}
