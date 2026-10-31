//! Project tasks, run as `cargo <alias>`.
//!
//!   cargo dev [-- app args]   build both and start the app
//!
//! Runnable from the repository root as well as from `native/`: every cargo call below names
//! this workspace's manifest, so the invocation's directory decides nothing.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use fv_daemon::Daemon;

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
        Some("dist-mac-local") => dist_mac_local(args.collect()),
        other => {
            eprintln!("usage: cargo dev [app args] | cargo dist:mac:local (got {other:?})");
            ExitCode::FAILURE
        }
    }
}

/// Build the same native layout as CI, for the host Mac, without signing or publishing.
fn dist_mac_local(args: Vec<String>) -> ExitCode {
    if args == ["--help"] || args == ["-h"] {
        println!(
            "usage: cargo dist:mac:local\nBuild an unsigned native macOS release bundle for this Mac."
        );
        return ExitCode::SUCCESS;
    }
    if !args.is_empty() {
        eprintln!("usage: cargo dist:mac:local");
        return ExitCode::FAILURE;
    }
    if !cfg!(target_os = "macos") {
        eprintln!("cargo dist:mac:local must run on macOS");
        return ExitCode::FAILURE;
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        arch => {
            eprintln!("unsupported macOS architecture: {arch}");
            return ExitCode::FAILURE;
        }
    };
    let root = workspace_root()
        .parent()
        .expect("native workspace has a parent")
        .to_path_buf();
    let output = format!("release/native/mac-{arch}");
    let steps: Vec<Vec<String>> = vec![
        vec![
            "scripts/fetch-officecli.mjs".into(),
            format!("--platforms=mac-{arch}"),
        ],
        vec![
            "scripts/stage-native-app.mjs".into(),
            "--platform".into(),
            "mac".into(),
            "--arch".into(),
            arch.into(),
            "--profile".into(),
            "release".into(),
            "--bundle".into(),
            "--output".into(),
            output.clone(),
        ],
        vec![
            "scripts/check-native-bundle.mjs".into(),
            "--bundle".into(),
            output.clone(),
        ],
    ];
    for step in steps {
        match Command::new("node").args(&step).current_dir(&root).status() {
            Ok(status) if status.success() => {}
            Ok(status) => {
                eprintln!("{} failed: {status}", step[0]);
                return ExitCode::FAILURE;
            }
            Err(error) => {
                eprintln!("could not run {}: {error}", step[0]);
                return ExitCode::FAILURE;
            }
        }
    }
    println!(
        "Native macOS release bundle: {}",
        root.join(output).display()
    );
    ExitCode::SUCCESS
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
fn prepare_server(daemon: &Daemon) -> Result<(), String> {
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
    if connection.has_running_turns != Some(false) {
        eprintln!(
            "Keeping the running FastVibe server to avoid interrupting work. Rerun cargo dev when idle to use the newly built server."
        );
        return Ok(());
    }
    drop(connection);
    daemon
        .stop_and_wait()
        .map(|_| ())
        .map_err(|error| format!("could not restart the development server: {error}"))
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
    let daemon = fv_daemon::Daemon::new(data_dir, server_bin);
    if let Err(error) = prepare_server(&daemon) {
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
