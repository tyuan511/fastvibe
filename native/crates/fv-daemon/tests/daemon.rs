use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use fv_daemon::{Daemon, DaemonError};
use fv_protocol::methods::ThreadList;
use fv_protocol::types::ThreadListParams;

/// The server binary, built once for all the tests here.
fn server_bin() -> PathBuf {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            let status = std::process::Command::new(env!("CARGO"))
                .args(["build", "-q", "-p", "fv-server", "--bin", "fastvibe-server"])
                .current_dir(&root)
                .status()
                .expect("run cargo");
            assert!(status.success(), "could not build the server");
            root.join("target/debug/fastvibe-server")
                .canonicalize()
                .expect("built server")
        })
        .clone()
}

fn pid_of(dir: &std::path::Path) -> i32 {
    std::fs::read_to_string(dir.join("server.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_gone(pid: i32) {
    for _ in 0..100 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("server {pid} did not stop");
}

#[tokio::test]
async fn it_starts_a_server_and_connects_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(dir.path().to_path_buf(), server_bin());
    let conn = daemon.connect("test", "0").await.unwrap();
    // The handshake is done: the server answers real calls.
    let threads = conn
        .client
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap();
    assert!(threads.threads.is_empty());
    assert!(conn.version_mismatch, "test version 0 is not the server's");
    let pid = pid_of(dir.path());
    daemon.stop().unwrap();
    wait_gone(pid).await;
}

#[tokio::test]
async fn a_development_restart_waits_for_the_old_server_to_leave() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(dir.path().to_path_buf(), server_bin());
    daemon.ensure_running().await.unwrap();
    let old_pid = pid_of(dir.path());

    assert!(daemon.stop_and_wait().unwrap());
    wait_gone(old_pid).await;
    assert!(!daemon.ensure_running().await.is_err());
    let new_pid = pid_of(dir.path());
    assert_ne!(new_pid, old_pid);
    assert!(alive(new_pid));
    daemon.stop().unwrap();
    wait_gone(new_pid).await;
}

#[tokio::test]
async fn a_second_app_finds_the_server_the_first_started() {
    let dir = tempfile::tempdir().unwrap();
    let first = Daemon::new(dir.path().to_path_buf(), server_bin());
    first.ensure_running().await.unwrap();
    let pid = pid_of(dir.path());

    let second = Daemon::new(dir.path().to_path_buf(), server_bin());
    second.ensure_running().await.unwrap();
    assert_eq!(pid_of(dir.path()), pid, "a second server was started");
    first.stop().unwrap();
    wait_gone(pid).await;
}

#[tokio::test]
async fn apps_opening_at_once_start_one_server() {
    let dir = tempfile::tempdir().unwrap();
    let make = || Daemon::new(dir.path().to_path_buf(), server_bin());
    let (a, b, c) = (make(), make(), make());
    let (ra, rb, rc) = tokio::join!(a.ensure_running(), b.ensure_running(), c.ensure_running());
    ra.unwrap();
    rb.unwrap();
    rc.unwrap();
    let pid = pid_of(dir.path());
    // Exactly the process whose pid was recorded is the one answering: nothing else was started
    // (a second server would have refused the socket and exited, leaving this one).
    assert!(alive(pid));
    make().stop().unwrap();
    wait_gone(pid).await;
}

#[tokio::test]
async fn a_socket_left_by_a_crashed_server_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(dir.path().to_path_buf(), server_bin());
    daemon.ensure_running().await.unwrap();
    let pid = pid_of(dir.path());
    // Killed hard: it cannot remove its own socket file.
    unsafe { libc::kill(pid, libc::SIGKILL) };
    wait_gone(pid).await;
    assert!(
        dir.path().join("server.sock").exists(),
        "the test needs a stale socket"
    );

    let conn = daemon.connect("test", "0").await.unwrap();
    conn.client
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap();
    let new_pid = pid_of(dir.path());
    assert_ne!(new_pid, pid);
    daemon.stop().unwrap();
    wait_gone(new_pid).await;
}

#[tokio::test]
async fn a_server_that_cannot_start_says_why() {
    let dir = tempfile::tempdir().unwrap();
    // A "server" that prints a reason and exits.
    let fake = dir.path().join("fake-server");
    std::fs::write(
        &fake,
        "#!/bin/sh\necho 'cannot open the database' >&2\nexit 3\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let daemon = Daemon::new(dir.path().join("data"), fake);
    match daemon.ensure_running().await {
        Err(DaemonError::DidNotStart { log }) => {
            assert!(log.contains("cannot open the database"), "{log}")
        }
        other => panic!("{other:?}"),
    }

    let missing = Daemon::new(dir.path().join("data2"), dir.path().join("nope"));
    assert!(matches!(
        missing.ensure_running().await,
        Err(DaemonError::NoServerBinary(_))
    ));
}

#[test]
fn the_server_binary_is_found_where_it_is_told() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("fastvibe-server");
    std::fs::write(&bin, "").unwrap();
    // Environment variables are process-wide, so this is the only test here that sets one.
    unsafe { std::env::set_var("FASTVIBE_SERVER_BIN", &bin) };
    assert_eq!(fv_daemon::find_server_binary().unwrap(), bin);
    unsafe { std::env::set_var("FASTVIBE_SERVER_BIN", dir.path().join("missing")) };
    assert!(fv_daemon::find_server_binary().is_err());
    unsafe { std::env::remove_var("FASTVIBE_SERVER_BIN") };
}
