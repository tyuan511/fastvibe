//! A picture a tool returned: kept as a file, not in the transcript, and still there after a restart.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_core::{ImageSource, Message};
use fv_protocol::methods::{Initialize, ThreadStart, TurnStart};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use image::{ImageBuffer, Rgb};
use serde_json::json;

async fn run(
    dir: &Path,
    name: &str,
    model: ScriptedModel,
) -> (Arc<ScriptedModel>, std::path::PathBuf) {
    let model = Arc::new(model);
    let agent = fv_server::agent_with_builtin_tools(model.clone());
    let state = Arc::new(ServerState::new(dir.to_path_buf(), agent).unwrap());
    let sock = dir.join(format!("{name}.sock"));
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    (model, sock)
}

async fn connect(
    sock: &Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (c, n) = Client::connect_unix(sock).await.unwrap();
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
    (c, n)
}

async fn idle(notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>) {
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        if matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running) {
            return;
        }
    }
}

#[tokio::test]
async fn a_viewed_picture_is_a_file_on_disk_and_survives_a_restart() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    ImageBuffer::from_pixel(8, 6, Rgb([10u8, 200, 30]))
        .save(work.path().join("shot.png"))
        .unwrap();
    let png = std::fs::read(work.path().join("shot.png")).unwrap();

    let thread = {
        let (model, sock) = run(
            data.path(),
            "a",
            ScriptedModel::new([
                Reply::new()
                    .tool("v1", "view_image", json!({"path": "shot.png"}))
                    .done(),
                Reply::new().text("It is green.").done(),
            ]),
        )
        .await;
        let (c, mut notes) = connect(&sock).await;
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
            thread_id: thread.clone(),
            text: "what colour?".into(),
        })
        .await
        .unwrap();
        idle(&mut notes).await;

        // The model was shown the picture right after the tool's result.
        let second = &model.requests()[1];
        assert!(
            matches!(&second.messages[2], Message::ToolResult { call_id, .. } if call_id == "v1")
        );
        let Message::ToolImages { images, .. } = &second.messages[3] else {
            panic!("{:?}", second.messages)
        };
        assert!(matches!(&images[0].source, ImageSource::Base64 { .. }));
        thread
    };

    // The transcript holds a path, not the picture.
    let transcript =
        std::fs::read_to_string(data.path().join("sessions").join(format!("{thread}.jsonl")))
            .unwrap();
    assert!(
        !transcript.contains("base64") && !transcript.contains("iVBOR"),
        "pixels in the transcript"
    );
    assert!(transcript.contains("tool-images"), "{transcript}");
    let stored: Vec<_> = std::fs::read_dir(data.path().join("tool-images").join(&thread))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(
        std::fs::read(stored[0].path()).unwrap(),
        png,
        "the file is the picture that was sent"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(stored[0].path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    // After a restart the history has the path, and the next request can still send it.
    let (model, sock) = run(
        data.path(),
        "b",
        ScriptedModel::new([Reply::new().text("Still green.").done()]),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "and now?".into(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    let first = &model.requests()[0];
    let Some(Message::ToolImages { images, .. }) = first
        .messages
        .iter()
        .find(|m| matches!(m, Message::ToolImages { .. }))
    else {
        panic!("the picture was lost: {:?}", first.messages)
    };
    let ImageSource::File { path } = &images[0].source else {
        panic!("not a file")
    };
    assert_eq!(std::fs::read(path).unwrap(), png);
}

#[tokio::test]
async fn a_picture_that_is_not_one_is_an_error_and_stores_nothing() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("fake.png"), "not an image").unwrap();
    let (_, sock) = run(
        data.path(),
        "a",
        ScriptedModel::new([
            Reply::new()
                .tool("v1", "view_image", json!({"path": "fake.png"}))
                .done(),
            Reply::new().text("It is not a picture.").done(),
        ]),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
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
        thread_id: thread.clone(),
        text: "look".into(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    let folder = data.path().join("tool-images").join(&thread);
    assert!(!folder.exists() || std::fs::read_dir(folder).unwrap().next().is_none());
}
