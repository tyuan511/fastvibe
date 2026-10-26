#![cfg(unix)]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::{ApprovalPolicy, Permissions, Policy, SandboxMode, ToolCtx, ToolRegistry};
use fv_tools::ExecSessions;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn registry(pool: &Arc<ExecSessions>) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    pool.register(&mut registry);
    registry
}
fn ctx(root: Option<&Path>, cancel: CancellationToken) -> ToolCtx {
    ToolCtx::new(cancel, root.map(Path::to_path_buf))
}
async fn call(
    registry: &ToolRegistry,
    name: &str,
    context: ToolCtx,
    args: Value,
) -> fv_agent::ToolOutput {
    registry.get(name).unwrap().call(context, args).await
}
async fn start(
    registry: &ToolRegistry,
    root: Option<&Path>,
    cmd: &str,
    tty: bool,
    cancel: CancellationToken,
) -> fv_agent::ToolOutput {
    call(
        registry,
        "exec_command",
        ctx(root, cancel),
        json!({"cmd":cmd,"shell":"/bin/sh","login":false,"tty":tty,"yield_time_ms":250}),
    )
    .await
}
fn id(out: &fv_agent::ToolOutput) -> u64 {
    assert!(!out.is_error, "{}", out.content);
    out.content
        .split("session ID ")
        .nth(1)
        .unwrap_or_else(|| panic!("{}", out.content))
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}
async fn input(registry: &ToolRegistry, id: u64, chars: &str) -> fv_agent::ToolOutput {
    call(
        registry,
        "write_stdin",
        ctx(None, CancellationToken::new()),
        json!({"session_id":id,"chars":chars,"yield_time_ms":250}),
    )
    .await
}
fn pid(path: &Path) -> i32 {
    std::fs::read_to_string(path)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}
async fn dead(pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pipe_sessions_accept_input_return_only_new_output_and_are_conversation_scoped() {
    let a = Arc::new(ExecSessions::default());
    let b = Arc::new(ExecSessions::default());
    let first = registry(&a);
    let second = registry(&b);
    let out = start(&first, None, "printf READY; read -r first; printf 'one:%s\\n' \"$first\"; read -r second; printf 'two:%s\\n' \"$second\"", false, CancellationToken::new()).await;
    let session = id(&out);
    assert!(out.content.contains("READY"));
    assert!(input(&second, session, "stolen\n").await.is_error);
    let next = input(&first, session, "第一\n").await;
    assert!(!next.is_error, "{}", next.content);
    assert!(next.content.contains("one:第一"));
    assert!(!next.content.contains("READY"));
    let last = input(&first, session, "done\n").await;
    assert!(!last.is_error, "{}", last.content);
    assert!(last.content.contains("Process exited with code 0"));
    assert!(last.content.contains("two:done") && !last.content.contains("one:第一"));
    assert!(input(&first, session, "").await.is_error);
}

#[tokio::test]
async fn a_real_pty_reports_terminal_dimensions_and_preserves_unicode_input() {
    let pool = Arc::new(ExecSessions::default());
    let registry = registry(&pool);
    let out = start(&registry, None, "python3 -u -c 'import os; print(\"TTY\",os.isatty(0),os.get_terminal_size().columns,flush=True); line=input(); print(\"REPLY:\"+line,flush=True)'", true, CancellationToken::new()).await;
    let session = id(&out);
    assert!(out.content.contains("TTY True 80"), "{}", out.content);
    let reply = input(&registry, session, "你好\n").await;
    assert!(!reply.is_error, "{}", reply.content);
    assert!(reply.content.contains("REPLY:你好"));
}

#[tokio::test]
async fn eof_and_interrupt_work_for_pipe_sessions_as_well_as_terminal_control() {
    let pool = Arc::new(ExecSessions::default());
    let registry = registry(&pool);
    let out = start(
        &registry,
        None,
        "read -r line; printf 'got:%s\\n' \"$line\"; cat",
        false,
        CancellationToken::new(),
    )
    .await;
    let session = id(&out);
    assert!(
        input(&registry, session, "hello\n")
            .await
            .content
            .contains("got:hello")
    );
    let end = input(&registry, session, "\u{4}").await;
    assert!(
        !end.is_error && end.content.contains("Process exited with code 0"),
        "{}",
        end.content
    );
    let out = start(&registry, None, "sleep 60", false, CancellationToken::new()).await;
    let end = input(&registry, id(&out), "\u{3}").await;
    assert!(
        end.is_error && !end.content.contains("Process running"),
        "{}",
        end.content
    );
}

#[tokio::test]
async fn stopping_after_yield_kills_pipe_and_pty_processes_and_their_children() {
    for tty in [false, true] {
        let pool = Arc::new(ExecSessions::default());
        let registry = registry(&pool);
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let out = start(
            &registry,
            Some(dir.path()),
            "echo $$ > parent; sleep 60 & echo $! > child; wait",
            tty,
            cancel.clone(),
        )
        .await;
        id(&out);
        let parent = pid(&dir.path().join("parent"));
        let child = pid(&dir.path().join("child"));
        cancel.cancel();
        dead(parent).await;
        dead(child).await;
    }
}

#[tokio::test]
async fn an_interaction_moves_cancellation_to_the_new_turn_without_duplicate_output() {
    let pool = Arc::new(ExecSessions::default());
    let registry = registry(&pool);
    let dir = tempfile::tempdir().unwrap();
    let first = CancellationToken::new();
    let out = start(
        &registry,
        Some(dir.path()),
        "echo $$ > parent; while IFS= read -r line; do printf 'tick:%s\\n' \"$line\"; done",
        false,
        first.clone(),
    )
    .await;
    let session = id(&out);
    let next = CancellationToken::new();
    let out = call(
        &registry,
        "write_stdin",
        ctx(None, next.clone()),
        json!({"session_id":session,"chars":"next\n","yield_time_ms":250}),
    )
    .await;
    assert!(out.content.contains("tick:next"));
    first.cancel();
    tokio::time::sleep(Duration::from_millis(30)).await;
    let parent = pid(&dir.path().join("parent"));
    assert_eq!(unsafe { libc::kill(parent, 0) }, 0);
    next.cancel();
    dead(parent).await;
}

#[tokio::test]
async fn closing_or_dropping_the_pool_kills_yielded_processes_and_refuses_new_work() {
    let dir = tempfile::tempdir().unwrap();
    let pool = Arc::new(ExecSessions::default());
    let tools = registry(&pool);
    let out = start(
        &tools,
        Some(dir.path()),
        "echo $$ > parent; sleep 60",
        false,
        CancellationToken::new(),
    )
    .await;
    let session = id(&out);
    let parent = pid(&dir.path().join("parent"));
    pool.close();
    dead(parent).await;
    assert!(input(&tools, session, "").await.is_error);
    assert!(
        start(
            &tools,
            None,
            "touch should-not-run",
            false,
            CancellationToken::new()
        )
        .await
        .is_error
    );
    let dir = tempfile::tempdir().unwrap();
    let parent = {
        let pool = Arc::new(ExecSessions::default());
        let tools = registry(&pool);
        let out = start(
            &tools,
            Some(dir.path()),
            "echo $$ > parent; sleep 60",
            true,
            CancellationToken::new(),
        )
        .await;
        id(&out);
        pid(&dir.path().join("parent"))
    };
    dead(parent).await;
}

#[tokio::test]
async fn a_policy_restriction_blocks_input_to_an_old_full_access_process_but_allows_stopping_it() {
    let pool = Arc::new(ExecSessions::default());
    let tools = registry(&pool);
    let dir = tempfile::tempdir().unwrap();
    let mut full = ctx(Some(dir.path()), CancellationToken::new());
    full.permissions = Some(Arc::new(Permissions {
        policy: Policy::full_access(),
        approval: ApprovalPolicy::OnRequest,
        approver: None,
    }));
    let out = call(&tools, "exec_command", full, json!({"cmd":"read -r line; printf '%s' \"$line\" > forbidden","shell":"/bin/sh","login":false,"yield_time_ms":250})).await;
    let session = id(&out);
    let restricted = || {
        let mut context = ctx(Some(dir.path()), CancellationToken::new());
        context.permissions = Some(Arc::new(Permissions {
            policy: Policy {
                mode: SandboxMode::ReadOnly,
                writable_roots: vec![],
                network: false,
            },
            approval: ApprovalPolicy::Never,
            approver: None,
        }));
        context
    };
    let denied = call(
        &tools,
        "write_stdin",
        restricted(),
        json!({"session_id":session,"chars":"no\n"}),
    )
    .await;
    assert!(denied.is_error && denied.content.contains("broader permissions"));
    assert!(!dir.path().join("forbidden").exists());
    let stopped = call(
        &tools,
        "write_stdin",
        restricted(),
        json!({"session_id":session,"chars":"\u{3}"}),
    )
    .await;
    assert!(!stopped.content.contains("Process running"));
}

#[tokio::test]
async fn split_utf8_and_flooded_output_stay_bounded_and_keep_the_beginning_and_end() {
    let pool = Arc::new(ExecSessions::default());
    let tools = registry(&pool);
    let out = call(&tools, "exec_command", ctx(None, CancellationToken::new()), json!({
        "cmd":"python3 -u -c 'import os,time; data=\"中\".encode(); os.write(1,data[:1]); time.sleep(.02); os.write(2,b\"err\\n\"); time.sleep(.02); os.write(1,data[1:]+b\"\\n\"); os.write(1,b\"x\"*(2*1024*1024)); print(\"结尾\",flush=True)'",
        "shell":"/bin/sh","login":false,"max_output_tokens":128
    })).await;
    assert!(!out.is_error, "{}", out.content);
    assert!(
        out.content.contains("中") && out.content.contains("结尾"),
        "{}",
        out.content
    );
    assert!(!out.content.contains('\u{fffd}'));
    assert!(out.content.len() < 1000);
    assert!(out.content.contains("tokens truncated"));
}

#[tokio::test]
async fn explicit_deadlines_are_completion_only_and_kill_children_in_both_modes() {
    for tty in [false, true] {
        let pool = Arc::new(ExecSessions::default());
        let tools = registry(&pool);
        let dir = tempfile::tempdir().unwrap();
        let out = call(&tools, "exec_command", ctx(Some(dir.path()), CancellationToken::new()), json!({
            "cmd":"echo $$ > parent; sleep 60 & echo $! > child; wait", "shell":"/bin/sh","login":false,
            "tty":tty,"timeout_ms":150,"yield_time_ms":250
        })).await;
        assert!(
            out.is_error && out.content.contains("timed out"),
            "{}",
            out.content
        );
        assert!(!out.content.contains("session ID"));
        dead(pid(&dir.path().join("parent"))).await;
        dead(pid(&dir.path().join("child"))).await;
    }
}

#[tokio::test]
async fn dropping_the_initial_call_kills_a_pty_even_without_canceling_its_turn_token() {
    let pool = Arc::new(ExecSessions::default());
    let tools = registry(&pool);
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let pending = call(
        &tools,
        "exec_command",
        ctx(Some(dir.path()), cancel.clone()),
        json!({
            "cmd":"echo $$ > parent; sleep 60", "shell":"/bin/sh","login":false,"tty":true,"yield_time_ms":30000
        }),
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(400), pending)
            .await
            .is_err()
    );
    assert!(!cancel.is_cancelled());
    dead(pid(&dir.path().join("parent"))).await;
}

#[tokio::test]
async fn a_full_input_queue_can_be_canceled_without_a_stranded_io_thread() {
    for tty in [false, true] {
        let pool = Arc::new(ExecSessions::default());
        let tools = registry(&pool);
        let dir = tempfile::tempdir().unwrap();
        let command = if tty {
            "stty -echo; echo $$ > parent; sleep 60"
        } else {
            "echo $$ > parent; sleep 60"
        };
        let out = start(
            &tools,
            Some(dir.path()),
            command,
            tty,
            CancellationToken::new(),
        )
        .await;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            stop.cancel();
        });
        let out = tokio::time::timeout(
            Duration::from_secs(3),
            call(
                &tools,
                "write_stdin",
                ctx(None, cancel),
                json!({"session_id":id(&out),"chars":"x".repeat(2*1024*1024)}),
            ),
        )
        .await
        .unwrap();
        assert!(out.is_error);
        dead(pid(&dir.path().join("parent"))).await;
    }
}
