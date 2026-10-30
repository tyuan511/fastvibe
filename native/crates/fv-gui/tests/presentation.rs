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
        patch_changes(patch)
            .into_iter()
            .map(|mut file| {
                file.diff.clear();
                file
            })
            .collect::<Vec<_>>(),
        vec![
            FileChange {
                path: "a.txt".into(),
                added: 2,
                removed: 0,
                diff: String::new()
            },
            FileChange {
                path: "src/b.rs".into(),
                added: 1,
                removed: 1,
                diff: String::new()
            },
            FileChange {
                path: "d.rs".into(),
                added: 0,
                removed: 1,
                diff: String::new()
            },
        ]
    );
}

#[test]
fn durations_read_like_the_electron_app() {
    assert_eq!(format_duration(0, false), "0 秒");
    assert_eq!(format_duration(18_000, false), "18 秒");
    assert_eq!(format_duration(120_000, false), "2 分钟");
    assert_eq!(format_duration(221_000, false), "3 分钟 41 秒");
    assert_eq!(format_duration(3_723_000, false), "1 小时 2 分钟 3 秒");
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
fn native_tool_targets_keep_their_meaning_in_headers() {
    use fv_gui::presentation::{Family, describe, family_of, tool_path};
    let args = json!({"action": "open", "url": "https://example.com"});
    let view = describe("browser", &args, true, true);
    assert_eq!(view.family, Family::Browser);
    assert_eq!(view.label, "Using browser");
    assert_eq!(view.subject, "open");
    assert_eq!(view.context, "https://example.com");
    assert_eq!(family_of("computer"), Family::Computer);
    assert_eq!(family_of("list_agents"), Family::Agent);
    assert_eq!(family_of("request_user_input_async"), Family::Question);
    for name in [
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
    ] {
        assert_eq!(family_of(name), Family::Mcp);
    }
    let args = json!({"target": "child-thread-id"});
    assert_eq!(tool_path("send_input", &args), None);
    assert_eq!(
        describe("send_input", &args, false, true).context,
        "child-thread-id"
    );
    for name in ["read_file", "edit", "write"] {
        let args = json!({"file_path": "/project/src/main.rs"});
        let view = describe(name, &args, false, true);
        assert_eq!(view.subject, "main.rs", "{name}");
        assert_eq!(view.context, "/project/src", "{name}");
        assert_eq!(
            tool_path(name, &args).as_deref(),
            Some("/project/src/main.rs")
        );
    }
}

#[test]
fn tool_family_icons_exist_in_the_native_bundle() {
    use fv_gui::presentation::{Family, family_icon};
    for family in [
        Family::Read,
        Family::Edit,
        Family::Terminal,
        Family::Search,
        Family::Web,
        Family::Browser,
        Family::Computer,
        Family::Skill,
        Family::Agent,
        Family::Todo,
        Family::Question,
        Family::Mcp,
        Family::Present,
        Family::Other,
    ] {
        let name = family_icon(family, false);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets/icons")
            .join(format!("{name}.svg"));
        assert!(path.is_file(), "missing icon for {family:?}: {name}");
    }
}

#[test]
fn hosted_search_headers_show_the_actual_query_or_page() {
    use fv_gui::presentation::describe;
    for (action, expected) in [
        (json!({"query": "native tools"}), "native tools"),
        (
            json!({"queries": ["native tools", "GPUI"]}),
            "native tools, GPUI",
        ),
        (json!({"url": "https://example.com"}), "https://example.com"),
    ] {
        let args = json!({"hosted": true, "action": action});
        assert_eq!(describe("web_search", &args, true, true).subject, expected);
    }
}

#[test]
fn async_questions_and_agent_lists_stay_outside_tool_batches() {
    use fv_gui::presentation::{Part, fold_runs};
    for name in ["request_user_input_async", "list_agents"] {
        let items = [
            tool("1", true),
            named("special", name, json!({})),
            tool("2", true),
        ];
        let refs: Vec<&Item> = items.iter().collect();
        assert!(
            fold_runs(&refs, false, false)
                .iter()
                .all(|p| matches!(p, Part::Item(_))),
            "{name}"
        );
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
    let parts = fold_runs(&refs, false, false);
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
    let parts = fold_runs(&refs, true, false);
    assert!(matches!(&parts[0], Part::Run(r) if r.len() == 2));
    assert!(matches!(&parts[1], Part::Item(_)));
    assert!(matches!(&parts[2], Part::Item(_)));
}

#[test]
fn collapse_thinking_folds_finished_thoughts_into_a_batch_with_calls_only() {
    use fv_gui::presentation::{Part, Piece, fold_runs, run_summary};
    let think = |id: &str| Item::Reasoning {
        id: id.into(),
        text: "hmm".into(),
    };
    let items = [tool("1", true), think("t"), tool("2", true), say("b")];
    let refs: Vec<&Item> = items.iter().collect();
    // Off: the thought splits the batch as prose does.
    assert_eq!(fold_runs(&refs, false, false).len(), 4);
    let parts = fold_runs(&refs, false, true);
    let Part::Run(run) = &parts[0] else {
        panic!("expected one folded run, got {parts:?}");
    };
    assert_eq!(run.len(), 3);
    let line: String = run_summary(run, false)
        .into_iter()
        .map(|p| match p {
            Piece::Path(path) => fv_gui::presentation::split_path(&path).0.to_string(),
            Piece::Text(t) | Piece::Name(t) => t,
        })
        .collect();
    assert_eq!(line, "已运行 2 个命令，思考 1 次");
    // Two thoughts with no call keep their own rows, and one still being written stands alone.
    let lone = [think("a"), think("b")];
    let refs: Vec<&Item> = lone.iter().collect();
    assert!(
        fold_runs(&refs, false, true)
            .iter()
            .all(|p| matches!(p, Part::Item(_)))
    );
    let live = [tool("1", true), tool("2", true), think("t")];
    let refs: Vec<&Item> = live.iter().collect();
    let parts = fold_runs(&refs, true, true);
    assert!(matches!(&parts[0], Part::Run(r) if r.len() == 2));
    assert!(matches!(&parts[1], Part::Item(Item::Reasoning { .. })));
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
        fold_runs(&refs, false, false)
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
    let line: String = run_summary(&refs, false)
        .into_iter()
        .map(|p| match p {
            Piece::Path(path) => fv_gui::presentation::split_path(&path).0.to_string(),
            Piece::Text(t) | Piece::Name(t) => t,
        })
        .collect();
    assert_eq!(line, "已运行 2 个命令，读取 pic.png");
}

#[test]
fn the_same_summary_reads_in_english_with_a_lowercase_later_clause() {
    use fv_gui::presentation::{Piece, run_summary};
    let items = [
        tool("1", true),
        tool("2", true),
        named("3", "view_image", json!({"path": "/a/b/pic.png"})),
    ];
    let refs: Vec<&Item> = items.iter().collect();
    let line: String = run_summary(&refs, true)
        .into_iter()
        .map(|p| match p {
            Piece::Path(path) => fv_gui::presentation::split_path(&path).0.to_string(),
            Piece::Text(t) | Piece::Name(t) => t,
        })
        .collect();
    assert_eq!(line, "Ran 2 commands, read pic.png");
    // One command is singular, and several files are counted rather than named.
    let one = [tool("1", true)];
    let refs: Vec<&Item> = one.iter().collect();
    let line: String = run_summary(&refs, true)
        .into_iter()
        .map(|p| match p {
            Piece::Path(path) => fv_gui::presentation::split_path(&path).0.to_string(),
            Piece::Text(t) | Piece::Name(t) => t,
        })
        .collect();
    assert_eq!(line, "Ran 1 command");
}

#[test]
fn durations_and_tool_labels_follow_the_language() {
    use fv_gui::presentation::describe;
    assert_eq!(format_duration(221_000, true), "3m 41s");
    assert_eq!(format_duration(3_723_000, true), "1h 2m 3s");
    let cmd = json!({"cmd": "pnpm build"});
    assert_eq!(describe("exec_command", &cmd, false, false).label, "终端");
    assert_eq!(
        describe("exec_command", &cmd, false, true).label,
        "Terminal"
    );
    assert_eq!(describe("exec_command", &cmd, true, true).label, "Running");
    assert_eq!(
        describe("exec_command", &cmd, true, false).label,
        "正在执行"
    );
}

#[test]
fn every_tool_family_has_a_label_in_both_languages() {
    // The label keys are built at run time, so the source scan in `locale_file_tests` cannot see
    // them; a missing one would show its key on screen.
    let samples = [
        ("exec_command", json!({"cmd": "ls"})),
        ("apply_patch", json!({"input": ""})),
        ("view_image", json!({"path": "/a/b.png"})),
        ("grep_files", json!({"pattern": "x"})),
        ("web_search", json!({"query": "x"})),
        ("browser", json!({"action": "snapshot"})),
        ("computer", json!({"action": "screenshot"})),
        ("list_agents", json!({})),
        ("request_user_input_async", json!({})),
        ("update_plan", json!({})),
        ("request_user_input", json!({})),
        ("spawn_agent", json!({})),
        ("present", json!({})),
        ("mcp_server_tool", json!({})),
        ("something_else", json!({})),
        ("code_mode", json!({})),
        ("wait", json!({})),
        ("wait", json!({"terminate": true})),
    ];
    for (name, args) in &samples {
        for running in [false, true] {
            for english in [false, true] {
                let label = fv_gui::presentation::describe(name, args, running, english).label;
                assert!(
                    !label.is_empty() && !label.starts_with("presentation."),
                    "{name} running={running} english={english}: {label}"
                );
            }
        }
    }
}

#[test]
fn summary_paths_keep_the_directory_and_rename_target() {
    use fv_gui::presentation::{Piece, run_summary, tool_path};
    let args = json!({"input": "*** Begin Patch\n*** Update File: src/old.rs\n*** Move to: lib/new.rs\n@@\n-old\n+new\n*** End Patch"});
    let item = named("patch", "apply_patch", args.clone());
    assert_eq!(
        tool_path("apply_patch", &args).as_deref(),
        Some("lib/new.rs")
    );
    assert!(run_summary(&[&item], false).contains(&Piece::Path("lib/new.rs".into())));
    let many = json!({"input": "*** Begin Patch\n*** Add File: a\n+a\n*** Add File: b\n+b\n*** End Patch"});
    assert_eq!(tool_path("apply_patch", &many), None);
}

#[test]
fn patch_previews_keep_each_files_own_content() {
    let patch = "*** Begin Patch\n*** Update File: a.rs\n@@ fn a\n--- old\n+++ new\n*** Add File: b.rs\n+second\n*** End Patch\n";
    let files = patch_changes(patch);
    assert_eq!(
        files[0].diff,
        "*** Update File: a.rs\n@@ fn a\n--- old\n+++ new\n"
    );
    assert_eq!(files[1].diff, "*** Add File: b.rs\n+second\n");
}
