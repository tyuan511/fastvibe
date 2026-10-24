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

fn named(id: &str, name: &str, args: serde_json::Value) -> Item {
    Item::ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args,
        output: Some("ok".into()),
        is_error: false,
    }
}

#[test]
fn settled_calls_between_prose_fold_into_one_run() {
    use fv_gui::presentation::{Part, fold_runs};
    let items = [
        say("a"),
        tool("1", true),
        tool("2", true),
        say("b"),
        tool("3", true),
    ];
    let refs: Vec<&Item> = items.iter().collect();
    let parts = fold_runs(&refs, false);
    assert_eq!(parts.len(), 4);
    assert!(matches!(&parts[1], Part::Run(r) if r.len() == 2));
    assert!(
        matches!(&parts[3], Part::Item(_)),
        "a lone call stays a row"
    );
}

#[test]
fn a_running_call_stands_alone_and_splits_the_batch() {
    use fv_gui::presentation::{Part, fold_runs};
    let items = [
        tool("1", true),
        tool("2", true),
        tool("3", false),
        tool("4", true),
    ];
    let refs: Vec<&Item> = items.iter().collect();
    let parts = fold_runs(&refs, true);
    assert!(matches!(&parts[0], Part::Run(r) if r.len() == 2));
    assert!(matches!(&parts[1], Part::Item(_)));
    assert!(matches!(&parts[2], Part::Item(_)));
}

#[test]
fn questions_and_plans_break_a_run() {
    use fv_gui::presentation::{Part, fold_runs};
    let items = [
        tool("1", true),
        named("q", "request_user_input", json!({})),
        tool("2", true),
    ];
    let refs: Vec<&Item> = items.iter().collect();
    assert!(
        fold_runs(&refs, false)
            .iter()
            .all(|p| matches!(p, Part::Item(_)))
    );
}

#[test]
fn the_summary_names_one_file_and_counts_many() {
    use fv_gui::presentation::{Piece, run_summary};
    let items = [
        tool("1", true),
        tool("2", true),
        named("3", "view_image", json!({"path": "/a/b/pic.png"})),
    ];
    let refs: Vec<&Item> = items.iter().collect();
    let line: String = run_summary(&refs)
        .into_iter()
        .map(|p| match p {
            Piece::Text(t) | Piece::Name(t) => t,
        })
        .collect();
    assert_eq!(line, "已运行 2 个命令，读取 pic.png");
}
