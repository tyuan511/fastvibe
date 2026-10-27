#![cfg(unix)]
//! Process and RPC acceptance, no desktop/computer use. The pinned CLI smoke is
//! explicit so a clean source checkout can run unit tests before fetching resources.
use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::{PROTOCOL_VERSION, methods::*, office::*, types::*};
use fv_server::{ServerState, UnixServer, office::Manager};
use std::{path::Path, sync::Arc, time::Duration};
fn fake_install(dir: &Path, body: &str) -> fv_env::OfficeInstall {
    use std::os::unix::fs::PermissionsExt;
    let binary = dir.join("officecli");
    std::fs::write(&binary, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    fv_env::OfficeInstall {
        binary,
        version: "fake-pinned".into(),
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn renders_are_deduplicated_cancel_per_owner_and_cache_tracks_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.docx");
    std::fs::write(&source, "first").unwrap();
    let install = fake_install(
        dir.path(),
        "printf '.\\n' >> \"$(dirname \"$0\")/calls\"\nsleep 0.3\nprintf '<html>native office</html>' > \"$5\"",
    );
    let manager = Manager::with_install(dir.path().join("data"), Some(install));
    let (a, b) = (manager.clone(), manager.clone());
    let (p1, p2) = (source.clone(), source.clone());
    let one = tokio::spawn(async move { a.render_for(1, "one", &p1).await });
    let two = tokio::spawn(async move { b.render_for(2, "two", &p2).await });
    until(|| dir.path().join("calls").exists()).await;
    manager.watch_stop(1, "one");
    assert!(one.await.unwrap().is_err());
    let result = two.await.unwrap().unwrap();
    assert!(
        std::fs::read_to_string(&result.path)
            .unwrap()
            .contains("native office")
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        manager.render_for(2, "cache", &source).await.unwrap().path,
        result.path
    );
    std::fs::write(&source, "a changed document").unwrap();
    assert_ne!(
        manager
            .render_for(2, "changed", &source)
            .await
            .unwrap()
            .path,
        result.path
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("calls"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    manager.watch_stop(3, "early");
    assert!(manager.render_for(3, "early", &source).await.is_err());
    assert!(manager.watch_start(3, "early", &source).await.is_err());
    manager.shutdown().await;
}
#[tokio::test]
async fn cancelling_the_last_waiter_kills_the_renderer_and_no_partial_cache_is_published() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.pptx");
    std::fs::write(&source, "stub").unwrap();
    let install = fake_install(
        dir.path(),
        "printf '%s' \"$$\" > \"$(dirname \"$0\")/pid\"\nprintf partial > \"$5\"\nsleep 30",
    );
    let manager = Manager::with_install(dir.path().join("data"), Some(install));
    let (worker, path) = (manager.clone(), source.clone());
    let job = tokio::spawn(async move { worker.render_for(1, "cancel", &path).await });
    until(|| {
        dir.path().join("pid").exists()
            && std::fs::read_dir(dir.path().join("data/office-preview"))
                .is_ok_and(|mut rows| rows.next().is_some())
    })
    .await;
    let pid = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    manager.watch_stop(1, "cancel");
    assert!(job.await.unwrap().is_err());
    until(|| unsafe { libc::kill(pid, 0) != 0 }).await;
    manager.shutdown().await;
    assert!(
        std::fs::read_dir(dir.path().join("data/office-preview"))
            .unwrap()
            .next()
            .is_none()
    );
}
#[tokio::test]
async fn office_renders_leave_stop_responsive_and_disconnect_cancels_owned_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.docx");
    std::fs::write(&source, "stub").unwrap();
    let install = fake_install(
        dir.path(),
        "printf '%s' \"$$\" > \"$(dirname \"$0\")/pid\"\nsleep 30\nprintf page > \"$5\"",
    );
    let mut state = ServerState::new(
        dir.path().join("state"),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    state.office = Manager::with_install(dir.path().join("state"), Some(install));
    let state = Arc::new(state);
    let socket = dir.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, _) = Client::connect_unix(&socket).await.unwrap();
    let client = Arc::new(client);
    let init = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "office-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(init.features.iter().any(|f| f == "officePreview"));
    let c = client.clone();
    let path = source.to_string_lossy().to_string();
    let job = tokio::spawn(async move {
        c.call::<OfficeRender>(OfficeWatchParams {
            path,
            cwd: None,
            lease_id: "rpc-render".into(),
        })
        .await
    });
    until(|| dir.path().join("pid").exists()).await;
    let pid = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        client.call::<OfficeWatchStop>(OfficeLeaseParams {
            lease_id: "rpc-render".into(),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(job.await.unwrap().is_err());
    until(|| unsafe { libc::kill(pid, 0) != 0 }).await;
    // A closed lease cannot be resurrected by a late start, including a denied remote call.
    let request = fv_protocol::ClientRequest::OfficeWatchStart {
        id: fv_protocol::RequestId::Number(1),
        params: OfficeWatchParams {
            path: source.to_string_lossy().into(),
            cwd: None,
            lease_id: "remote".into(),
        },
    };
    assert!(!fv_server::allows(ClientOrigin::Official, &request));
    assert!(!fv_server::allows(ClientOrigin::Ssh, &request));
    std::fs::remove_file(dir.path().join("pid")).unwrap();
    let c = client.clone();
    let path = source.to_string_lossy().to_string();
    let pending = tokio::spawn(async move {
        c.call::<OfficeRender>(OfficeWatchParams {
            path,
            cwd: None,
            lease_id: "disconnect".into(),
        })
        .await
    });
    until(|| dir.path().join("pid").exists()).await;
    let second = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    pending.abort();
    let _ = pending.await;
    drop(client);
    until(|| unsafe { libc::kill(second, 0) != 0 }).await;
    state.office.shutdown().await;
    state.shutdown_schedules().await;
    server.abort();
}
#[tokio::test]
#[ignore = "requires the checksum-verified OfficeCLI resource: node scripts/fetch-officecli.mjs"]
async fn pinned_officecli_renders_all_formats_shares_live_leases_and_tracks_external_saves() {
    let install = fv_env::office_install()
        .expect("fetch the pinned OfficeCLI resource first")
        .clone();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(data.join("officecli-state")).unwrap();
    let manager = Manager::with_install(data.clone(), Some(install.clone()));
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for extension in ["docx", "xlsx", "pptx"] {
        let file = dir.path().join(format!("sample.{extension}"));
        let mut env = fv_env::snapshot();
        install.apply(&mut env, &data);
        let created = tokio::process::Command::new(&install.binary)
            .args(["create", file.to_str().unwrap(), "--json"])
            .envs(&env)
            .output()
            .await
            .unwrap();
        assert!(
            created.status.success(),
            "{}",
            String::from_utf8_lossy(&created.stderr)
        );
        let rendered = manager.render(&file).await.unwrap();
        assert!(rendered.size > 100);
        assert!(
            std::fs::read_to_string(rendered.path)
                .unwrap()
                .contains("<html")
        );
        let first = manager.watch_start(1, extension, &file).await.unwrap();
        let other = manager.watch_start(2, extension, &file).await.unwrap();
        assert_eq!(first.url, other.url);
        let url = first.url.unwrap();
        assert!(client.get(&url).send().await.unwrap().status().is_success());
        manager.watch_stop(1, extension);
        assert!(manager.watch_state(1, extension).is_err());
        assert_eq!(
            manager.watch_state(2, extension).unwrap().phase,
            OfficeWatchPhase::Ready
        );
        let copy = dir.path().join(format!("replace.{extension}"));
        std::fs::copy(&file, &copy).unwrap();
        if extension == "docx" {
            let edited = tokio::process::Command::new(&install.binary)
                .args([
                    "add",
                    copy.to_str().unwrap(),
                    "/body",
                    "--type",
                    "paragraph",
                    "--prop",
                    "text=ExternalReplacementMarker",
                    "--json",
                ])
                .envs(&env)
                .output()
                .await
                .unwrap();
            assert!(
                edited.status.success(),
                "{}",
                String::from_utf8_lossy(&edited.stderr)
            );
        }
        std::fs::rename(&copy, &file).unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(
            manager.watch_state(2, extension).unwrap().phase,
            OfficeWatchPhase::Ready
        );
        if extension == "docx" {
            tokio::time::timeout(Duration::from_secs(12), async {
                loop {
                    let page = client.get(&url).send().await.unwrap().text().await.unwrap();
                    if page.contains("ExternalReplacementMarker") {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("the watch page did not follow an external atomic replacement");
        }
        if extension != "xlsx" {
            assert!(
                manager
                    .selection(2, extension)
                    .await
                    .unwrap_err()
                    .contains("选中")
            );
        }
        manager.watch_stop(2, extension);
        tokio::time::timeout(Duration::from_secs(7), async {
            while client.get(&url).send().await.is_ok() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("unreferenced watch survived its release delay");
    }
    manager.shutdown().await;
}

#[tokio::test]
async fn closing_a_preview_still_works_when_every_background_request_slot_is_full() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("busy.docx");
    std::fs::write(&source, "stub").unwrap();
    let install = fake_install(
        dir.path(),
        "printf '%s' \"$$\" > \"$(dirname \"$0\")/pid\"\nsleep 30\nprintf page > \"$5\"",
    );
    let mut state = ServerState::new(
        dir.path().join("state"),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    state.office = Manager::with_install(dir.path().join("state"), Some(install));
    let state = Arc::new(state);
    let socket = dir.path().join("control.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    write.write_all(format!("{}\n",serde_json::json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"control-test","version":"0"},"protocolVersion":PROTOCOL_VERSION}})).as_bytes()).await.unwrap();
    loop {
        let frame: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        if frame["id"] == 1 {
            break;
        }
    }
    let mut requests = String::new();
    for index in 0..17 {
        requests.push_str(&format!("{}\n",serde_json::json!({"method":"office/render","id":index+2,"params":{"path":source,"leaseId":format!("busy-{index}")}})));
    }
    write.write_all(requests.as_bytes()).await.unwrap();
    let overloaded = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            if frame["id"] == 18 {
                return frame;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        overloaded["error"]["code"],
        fv_protocol::jsonrpc::code::OVERLOADED
    );
    write
        .write_all(
            b"{\"method\":\"office/watchStop\",\"id\":19,\"params\":{\"leaseId\":\"busy-0\"}}\n",
        )
        .await
        .unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let frame: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            if frame["id"] == 19 {
                return frame;
            }
        }
    })
    .await
    .unwrap();
    assert!(stopped.get("result").is_some(), "{stopped}");
    until(|| dir.path().join("pid").exists()).await;
    let pid = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    drop(write);
    drop(lines);
    until(|| unsafe { libc::kill(pid, 0) != 0 }).await;
    state.office.shutdown().await;
    state.shutdown_schedules().await;
    server.abort();
}
