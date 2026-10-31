//! The `ssh` on PATH here is an executable in a disposable directory. No network is used,
//! and PATH is changed only for an isolated test child, never the parallel test process.
use fv_daemon::ssh::SshHost;
use std::path::PathBuf;

#[test]
fn fake_ssh_probe_install_and_native_handshake() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("ssh");
    std::fs::write(&fake, r##"#!/bin/sh
printf '%s\n' "$@" >> "$SSH_FIXTURE_DIR/arguments"
for last do :; done
case "$last" in
  'uname -s; uname -m') printf 'Linux\naarch64\n' ;;
  *'--listen relay'*)
    IFS= read -r request
    printf '%s\n' '{"id":1,"result":{"serverVersion":"fixture","protocolVersion":1,"features":["fixtureFeature"],"dataDir":"/remote/data"}}'
    while IFS= read -r request; do :; done ;;
  *) exec /bin/sh -c "$last" ;;
esac
"##).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fixture_child", "--nocapture"])
        .env("SSH_FIXTURE_DIR", dir.path())
        .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let args = std::fs::read_to_string(dir.path().join("arguments")).unwrap();
    assert!(args.contains("BatchMode=yes\n"));
    assert!(args.contains("StrictHostKeyChecking=yes\n"));
    assert!(args.contains("--\nfixture-host\n"));
    assert!(args.contains("/remote/data 'quoted'") || args.contains("'\\''quoted'\\''"));
}

#[test]
fn real_server_projects_chat_and_terminal_survive_ssh_relay_disconnect() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let binary = std::env::var_os("FASTVIBE_SERVER_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/fastvibe-server")
        });
    assert!(
        binary.is_file(),
        "Build fastvibe-server first or set FASTVIBE_SERVER_BIN; this test never skips real relay validation"
    );
    let binary = std::fs::canonicalize(binary).unwrap();
    let fake = dir.path().join("ssh");
    std::fs::write(
        &fake,
        "#!/bin/sh\nfor last do :; done\nexec /bin/sh -c \"$last\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut server = std::process::Command::new(&binary)
        .args(["--listen", "unix", "--model", "echo", "--data-dir"])
        .arg(dir.path().join("data"))
        .env("SHELL", "/bin/sh")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::os::unix::net::UnixStream::connect(dir.path().join("data/server.sock")).is_err() {
        if server.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
            let _ = server.kill();
            panic!("fixture server failed to start");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fixture_real_child", "--nocapture"])
        .env("SSH_FIXTURE_DIR", dir.path())
        .env("SSH_FIXTURE_SERVER", &binary)
        .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    unsafe {
        libc::kill(server.id() as i32, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while server.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = server.kill();
    let _ = server.wait();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_real_child() {
    use fv_protocol::{methods::*, types::*};
    let Some(dir) = std::env::var_os("SSH_FIXTURE_DIR").map(PathBuf::from) else {
        return;
    };
    let binary = PathBuf::from(std::env::var_os("SSH_FIXTURE_SERVER").unwrap());
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async move {
            let host = SshHost {
                host: "fixture-only".into(),
                user: None,
                port: None,
                identity_file: None,
                server_binary: binary.display().to_string(),
                data_dir: dir.join("data").display().to_string(),
            };
            let mut first = host
                .connect_current(
                    "ssh-fixture",
                    env!("CARGO_PKG_VERSION"),
                    fv_protocol::DESKTOP_REQUIRED_FEATURES,
                )
                .await
                .unwrap();
            let folder = dir.join("project");
            std::fs::create_dir(&folder).unwrap();
            let project = first
                .client
                .call::<ProjectCreate>(ProjectCreateParams {
                    name: Some("Remote fixture".into()),
                    folders: vec![folder.display().to_string()],
                })
                .await
                .unwrap();
            let thread = first
                .client
                .call::<ThreadStart>(ThreadStartParams {
                    cwd: Some(project.path.clone()),
                    project: Some(project.path.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .thread;
            first
                .client
                .call::<TurnStart>(TurnStartParams {
                    thread_id: thread.id.clone(),
                    text: "SSH relay actual chat".into(),
                })
                .await
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let note = first.notifications.recv().await.expect("relay disconnected before turn completed");
                    if matches!(note, fv_protocol::ServerNotification::TurnCompleted(_)) {
                        break;
                    }
                }
            })
            .await
            .unwrap();
            let terminal = first
                .client
                .call::<TerminalStart>(TerminalStartParams {
                    cwd: project.path.clone(),
                    cols: Some(80),
                    rows: Some(24),
                })
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            first
                .client
                .call::<TerminalWrite>(TerminalWriteParams {
                    id: terminal.id.clone(),
                    data: "FV_SSH_MARK=kept; sleep 1; printf 'relay-%s\\n' \"$FV_SSH_MARK\"\n"
                        .into(),
                })
                .await
                .unwrap();
            drop(first);
            let second = host
                .connect_current(
                    "ssh-fixture",
                    env!("CARGO_PKG_VERSION"),
                    fv_protocol::DESKTOP_REQUIRED_FEATURES,
                )
                .await
                .unwrap();
            let projects = second.client.call::<ProjectList>(Empty {}).await.unwrap();
            assert!(projects.projects.iter().any(|p| p.path == project.path));
            let snapshot = second
                .client
                .call::<ThreadResume>(ThreadIdParams {
                    thread_id: thread.id.clone(),
                })
                .await
                .unwrap();
            assert_eq!(snapshot.thread.project.as_deref(), Some(project.path.as_str()));
            assert!(snapshot.turns.iter().flat_map(|turn| &turn.items).any(|item| matches!(item, Item::AgentMessage { text, .. } if text.contains("SSH relay actual chat"))));
            tokio::time::timeout(std::time::Duration::from_secs(8), async {
                loop {
                    let frame = second
                        .client
                        .call::<TerminalRead>(TerminalReadParams {
                            id: terminal.id.clone(),
                            offset: 0,
                            anchor: None,
                        })
                        .await
                        .unwrap();
                    if frame
                        .lines
                        .iter()
                        .any(|line| line.text.contains("relay-kept"))
                    {
                        break;
                    }
                    assert!(!frame.exited);
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                }
            })
            .await
            .unwrap();
            second
                .client
                .call::<TerminalWrite>(TerminalWriteParams {
                    id: terminal.id.clone(),
                    data: "printf 'reconnected-%s\\n' \"$FV_SSH_MARK\"\n".into(),
                })
                .await
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let frame = second
                        .client
                        .call::<TerminalRead>(TerminalReadParams {
                            id: terminal.id.clone(),
                            offset: 0,
                            anchor: None,
                        })
                        .await
                        .unwrap();
                    if frame
                        .lines
                        .iter()
                        .any(|line| line.text.contains("reconnected-kept"))
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                }
            })
            .await
            .unwrap();
            second
                .client
                .call::<TerminalKill>(TerminalIdParams { id: terminal.id })
                .await
                .unwrap();
        });
}

#[test]
fn fixture_child() {
    let Some(dir) = std::env::var_os("SSH_FIXTURE_DIR").map(PathBuf::from) else {
        return;
    };
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async move {
            let host = SshHost {
                host: "fixture-host".into(),
                user: None,
                port: Some(2222),
                identity_file: None,
                server_binary: dir.join("installed server").display().to_string(),
                data_dir: "/remote/data 'quoted'".into(),
            };
            let target = host.probe().await.unwrap();
            assert_eq!(
                (target.os.as_str(), target.arch.as_str()),
                ("Linux", "aarch64")
            );
            let source = dir.join("native-server");
            std::fs::write(&source, b"#!/bin/sh\nprintf 'fastvibe-server fixture\\n'\n").unwrap();
            host.install(&source, "Linux", "aarch64").await.unwrap();
            assert_eq!(
                std::fs::read(&host.server_binary).unwrap(),
                std::fs::read(&source).unwrap()
            );
            let original = std::fs::read(&host.server_binary).unwrap();
            assert!(host.install(&source, "Darwin", "arm64").await.is_err());
            std::fs::write(&source, b"#!/bin/sh\nprintf 'unrelated binary\\n'\n").unwrap();
            assert!(host.install(&source, "Linux", "aarch64").await.is_err());
            assert_eq!(std::fs::read(&host.server_binary).unwrap(), original);
            assert!(std::fs::read_dir(&dir).unwrap().all(|e| {
                !e.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".install-")
            }));
            let connection = host
                .connect_current("fixture", "fixture", &["fixtureFeature"])
                .await
                .unwrap();
            assert!(!connection.version_mismatch);
            drop(connection);
            assert!(
                host.connect_current("fixture", "fixture", &["notImplemented"])
                    .await
                    .err()
                    .unwrap()
                    .contains("notImplemented")
            );
        });
}
