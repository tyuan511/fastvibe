//! The built-in tools through a whole turn: model → tool call → real files → result → model.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::{Initialize, ThreadStart, TurnStart};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::json;

async fn until_idle(
    notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        let idle = matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
        seen.push(n);
        if idle {
            return seen;
        }
    }
}

#[tokio::test]
async fn a_turn_can_write_read_and_run_in_the_threads_directory() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let patch =
        "*** Begin Patch\n*** Add File: notes/hello.txt\n+hello from the model\n*** End Patch\n";
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("c1", "apply_patch", json!({"input": patch}))
            .done(),
        Reply::new()
            .tool(
                "c2",
                "exec_command",
                json!({"cmd": "cat notes/hello.txt", "login": false}),
            )
            .done(),
        Reply::new()
            .tool(
                "c3",
                "exec_command",
                json!({"cmd": "wc -c < notes/hello.txt", "login": false}),
            )
            .done(),
        Reply::new().text("All done.").done(),
    ]));
    let agent = fv_server::agent_with_builtin_tools(model.clone());
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());

    let (c, mut notes) = Client::connect_unix(&sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "t".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(work.path().display().to_string()),
            project: None,
            model: None,
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread,
        text: "make a note".into(),
    })
    .await
    .unwrap();
    let events = until_idle(&mut notes).await;

    // The file is really there, in the thread's directory.
    assert_eq!(
        std::fs::read_to_string(work.path().join("notes/hello.txt")).unwrap(),
        "hello from the model\n"
    );

    // Each call finished with its output, as items a client can draw.
    let outputs: Vec<(String, String, bool)> = events
        .iter()
        .filter_map(|n| match n {
            ServerNotification::ItemCompleted(e) => match &e.body.item {
                Item::ToolCall {
                    name,
                    output: Some(o),
                    is_error,
                    ..
                } => Some((name.clone(), o.clone(), *is_error)),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(outputs.len(), 3, "{outputs:?}");
    assert_eq!(outputs[0].0, "apply_patch");
    assert!(
        outputs[0].1.contains("A notes/hello.txt") && !outputs[0].2,
        "{outputs:?}"
    );
    assert_eq!(outputs[1].0, "exec_command");
    assert!(
        outputs[1].1.contains("hello from the model") && !outputs[1].2,
        "{outputs:?}"
    );
    assert_eq!(outputs[2].0, "exec_command");
    assert!(
        outputs[2].1.contains("Process exited with code 0") && outputs[2].1.contains("21"),
        "{outputs:?}"
    );

    // The model was told what it can use and where it is working.
    let first = &model.requests()[0];
    let names: Vec<&str> = first.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "apply_patch",
            "close_agent",
            "code_mode",
            "exec_command",
            "list_agents",
            "request_user_input",
            "resume_agent",
            "send_input",
            "spawn_agent",
            "update_plan",
            "view_image",
            "wait",
            "wait_agent",
            "write_stdin"
        ]
    );
    assert!(
        first.system.contains(&work.path().display().to_string()),
        "{}",
        first.system
    );
}
