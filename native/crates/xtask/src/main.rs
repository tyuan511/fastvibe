//! Project tasks, run as `cargo <alias>`.
//!
//!   cargo dev [-- app args]   build both, update an idle changed server, start the app
//!
//! Runnable from the repository root as well as from `native/`: every cargo call below names
//! this workspace's manifest, so the invocation's directory decides nothing.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use fv_daemon::Daemon;
use sha2::{Digest, Sha256};

/// The native workspace root, taken from this crate's own manifest directory (a compile-time
/// constant) rather than from the invocation's cwd. `cargo dev` is aliased both in
/// `native/.cargo/config.toml` and in the repository root's, and a bare `cargo build` resolves
/// its workspace by walking up from cwd — which finds no `Cargo.toml` at all when the command
/// was typed at the root.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("xtask lives at <workspace>/crates/xtask")
        .to_path_buf()
}

/// A cargo command for this workspace, already pointed at its manifest and started in the
/// workspace root. `--manifest-path` is a per-subcommand option, so it has to follow the
/// subcommand name; `current_dir` only keeps the launched app's cwd the same wherever `cargo
/// dev` was typed from (nothing in the app reads it).
fn cargo(subcommand: &str) -> Command {
    let mut command = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    command
        .arg(subcommand)
        .arg("--manifest-path")
        .arg(workspace_root().join("Cargo.toml"))
        .current_dir(workspace_root());
    command
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("dev") => dev(args.collect()),
        other => {
            eprintln!("usage: cargo dev [app args]   (got {other:?})");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Restart {
    Unchanged,
    Now,
    Busy,
}

/// Decide from the running executable's own report, never from timestamps or package versions.
/// An old server that cannot report a fingerprint/activity is deliberately left alone: killing
/// a conversation just because two builds speak different protocol versions is worse than a
/// one-line warning explaining how to replace it once idle.
fn restart_needed(current: Option<&str>, running: Option<bool>, built: &str) -> Restart {
    match current {
        Some(current) if current == built => Restart::Unchanged,
        _ if running == Some(false) => Restart::Now,
        _ => Restart::Busy,
    }
}

fn fingerprint(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn requested_data_dir(app_args: &[String]) -> Result<Option<PathBuf>, &'static str> {
    let mut data_dir = std::env::var_os("FASTVIBE_DATA_DIR").map(Into::into);
    let mut args = app_args.iter();
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            let Some(path) = args.next() else {
                return Err("--data-dir needs a path");
            };
            data_dir = Some(path.into());
        }
    }
    Ok(data_dir)
}

/// A blocking handshake is fine here: no server runtime or GUI exists on this thread yet.
fn prepare_server(daemon: &Daemon, built: &str) -> Result<(), String> {
    if !daemon.socket().exists() {
        return Ok(());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let connection =
        match runtime.block_on(daemon.connect("fastvibe-dev", env!("CARGO_PKG_VERSION"))) {
            Ok(connection) => connection,
            // A crashed server's stale socket needs no shutdown. If it is merely starting, the
            // GUI's normal connection path will retry/report it without us killing anything.
            Err(_) => return Ok(()),
        };
    match restart_needed(
        connection.build_fingerprint.as_deref(),
        connection.has_running_turns,
        built,
    ) {
        Restart::Unchanged => Ok(()),
        Restart::Busy => {
            eprintln!(
                "FastVibe server update available; keeping the running server to avoid interrupting a conversation. Stop the old server or rerun cargo dev when idle to update."
            );
            Ok(())
        }
        Restart::Now => {
            drop(connection);
            daemon
                .stop_and_wait()
                .map(|_| ())
                .map_err(|error| format!("could not restart the development server: {error}"))
        }
    }
}

fn dev(app_args: Vec<String>) -> ExitCode {
    // The app looks for the server next to itself, so both must be built first.
    let built = cargo("build")
        .args(["-p", "fv-server", "-p", "fv-gui"])
        .status();
    if !matches!(built, Ok(s) if s.success()) {
        return ExitCode::FAILURE;
    }

    let data_dir = match requested_data_dir(&app_args) {
        Ok(dir) => dir.unwrap_or_else(fv_daemon::default_data_dir),
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let server_bin = match fv_daemon::find_server_binary() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let built_fingerprint = match fingerprint(&server_bin) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("could not fingerprint {}: {error}", server_bin.display());
            return ExitCode::FAILURE;
        }
    };
    let daemon = fv_daemon::Daemon::new(data_dir, server_bin);
    if let Err(error) = prepare_server(&daemon, &built_fingerprint) {
        eprintln!("{error}");
        return ExitCode::FAILURE;
    }

    let status = cargo("run")
        .args(["-q", "-p", "fv-gui", "--bin", "fastvibe", "--"])
        .args(app_args)
        .status();
    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unchanged_build_never_restarts() {
        assert_eq!(
            restart_needed(Some("same"), Some(false), "same"),
            Restart::Unchanged
        );
        assert_eq!(
            restart_needed(Some("same"), Some(true), "same"),
            Restart::Unchanged
        );
        assert_eq!(
            restart_needed(Some("same"), None, "same"),
            Restart::Unchanged
        );
    }

    #[test]
    fn a_changed_build_restarts_only_when_idle() {
        assert_eq!(
            restart_needed(Some("old"), Some(false), "new"),
            Restart::Now
        );
        assert_eq!(
            restart_needed(Some("old"), Some(true), "new"),
            Restart::Busy
        );
        assert_eq!(restart_needed(Some("old"), None, "new"), Restart::Busy);
        assert_eq!(restart_needed(None, Some(false), "new"), Restart::Now);
        assert_eq!(restart_needed(None, Some(true), "new"), Restart::Busy);
        assert_eq!(restart_needed(None, None, "new"), Restart::Busy);
    }

    /// The workspace is located from the crate, so a `cargo dev` typed anywhere in the
    /// repository builds the same thing. A wrong number of `..` would silently resolve to a
    /// directory with no manifest, and cargo would report that instead of launching the app.
    #[test]
    fn the_workspace_root_holds_this_crate_and_its_manifest() {
        let root = workspace_root();
        assert!(
            root.join("Cargo.toml").is_file(),
            "no workspace manifest under {}",
            root.display()
        );
        assert!(
            root.join("crates")
                .join("xtask")
                .join("Cargo.toml")
                .is_file(),
            "xtask is not a member of {}",
            root.display()
        );
        assert!(root.is_absolute(), "{} is not absolute", root.display());
    }

    #[test]
    fn data_dir_arguments_and_environment_use_the_same_precedence() {
        let base = std::env::var_os("FASTVIBE_DATA_DIR").map(PathBuf::from);
        let args = vec![
            "--theme".into(),
            "--data-dir".into(),
            "/tmp/dev-data".into(),
        ];
        assert_eq!(requested_data_dir(&args), Ok(Some("/tmp/dev-data".into())));
        assert_eq!(requested_data_dir(&["--theme".into()]), Ok(base));
        assert_eq!(
            requested_data_dir(&["--data-dir".into()]),
            Err("--data-dir needs a path")
        );
    }
}
