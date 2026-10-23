use std::path::Path;
use std::time::{Duration, Instant};

use fv_agent::{Tool, ToolCtx, ToolOutput};
use fv_tools::ExecCommandTool;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

async fn exec(cwd: Option<&Path>, args: Value) -> ToolOutput {
    ExecCommandTool
        .call(
            ToolCtx::new(CancellationToken::new(), cwd.map(Path::to_path_buf)),
            args,
        )
        .await
}

fn output_of(out: &ToolOutput) -> &str {
    out.content
        .split_once("Output:\n")
        .map(|(_, o)| o)
        .unwrap_or("")
}

#[tokio::test]
async fn a_command_reports_its_output_exit_code_and_time() {
    let out = exec(None, json!({"cmd": "echo hello", "login": false})).await;
    assert!(!out.is_error, "{}", out.content);
    assert!(out.content.starts_with("Wall time: "), "{}", out.content);
    assert!(out.content.contains("Process exited with code 0"));
    assert_eq!(output_of(&out).trim(), "hello");
}

#[tokio::test]
async fn a_failing_command_is_an_error_with_its_code_and_both_streams_in_order() {
    let out = exec(
        None,
        json!({"cmd": "echo out; sleep 0.1; echo err 1>&2; exit 3", "login": false}),
    )
    .await;
    assert!(out.is_error);
    assert!(
        out.content.contains("Process exited with code 3"),
        "{}",
        out.content
    );
    let text = output_of(&out);
    assert!(
        text.find("out").unwrap() < text.find("err").unwrap(),
        "{text:?}"
    );
}

#[tokio::test]
async fn the_working_directory_is_the_conversations_unless_told_otherwise() {
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    let here = exec(Some(dir.path()), json!({"cmd": "pwd", "login": false})).await;
    assert_eq!(
        std::fs::canonicalize(output_of(&here).trim()).unwrap(),
        std::fs::canonicalize(dir.path()).unwrap()
    );
    let there = exec(
        Some(dir.path()),
        json!({"cmd": "pwd", "workdir": "sub", "login": false}),
    )
    .await;
    assert_eq!(
        std::fs::canonicalize(output_of(&there).trim()).unwrap(),
        std::fs::canonicalize(&sub).unwrap()
    );
}

#[tokio::test]
async fn a_command_past_its_timeout_is_killed_with_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("child.pid");
    let started = Instant::now();
    let out = exec(
        Some(dir.path()),
        json!({"cmd": format!("sleep 60 & echo $! > {}; wait", pidfile.display()), "timeout_ms": 400, "login": false}),
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the timeout did not stop it"
    );
    assert!(
        out.is_error && out.content.contains("timed out"),
        "{}",
        out.content
    );
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "the background child survived the kill"
    );
}

#[tokio::test]
async fn dropping_the_call_kills_the_command() {
    // This is what happens when the user stops a turn: the tool's future is dropped.
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let call = exec(
        Some(dir.path()),
        json!({"cmd": format!("echo $$ > {}; sleep 60", pidfile.display()), "login": false}),
    );
    let _ = tokio::time::timeout(Duration::from_millis(500), call).await;
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "the command kept running after the call was dropped"
    );
}

#[tokio::test]
async fn a_flood_of_output_is_cut_in_the_middle_to_the_token_budget() {
    let out = exec(
        None,
        json!({"cmd": "seq 1 200000", "max_output_tokens": 200, "login": false}),
    )
    .await;
    assert!(!out.is_error);
    let text = output_of(&out);
    assert!(text.len() < 1200, "{} bytes", text.len());
    assert!(
        text.starts_with("1\n") && text.trim_end().ends_with("200000"),
        "{text:?}"
    );
    assert!(text.contains("tokens truncated"));
}

#[tokio::test]
async fn a_background_process_holding_the_pipe_does_not_hang_the_call() {
    let started = Instant::now();
    let out = exec(
        None,
        json!({"cmd": "(sleep 30 &) ; echo done", "login": false}),
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "waited for the background process"
    );
    assert!(!out.is_error);
    assert_eq!(output_of(&out).trim(), "done");
}

#[tokio::test]
async fn bad_arguments_and_missing_shells_are_reported() {
    assert!(exec(None, json!({"cmd": "  "})).await.is_error);
    let out = exec(None, json!({"cmd": "echo", "shell": "/no/such/shell"})).await;
    assert!(
        out.is_error && out.content.contains("failed to start"),
        "{}",
        out.content
    );
    let out = exec(None, json!({"command": "echo"})).await;
    assert!(out.is_error && out.content.contains("failed to parse arguments"));
}
