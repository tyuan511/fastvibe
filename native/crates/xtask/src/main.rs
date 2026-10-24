//! Project tasks, run as `cargo <alias>`.
//!
//!   cargo dev [-- app args]   build both, restart the development server, start the app

use std::process::{Command, ExitCode};

fn cargo() -> Command {
    Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
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

fn dev(app_args: Vec<String>) -> ExitCode {
    // The app looks for the server next to itself, so both must be built first.
    let built = cargo()
        .args(["build", "-p", "fv-server", "-p", "fv-gui"])
        .status();
    if !matches!(built, Ok(s) if s.success()) {
        return ExitCode::FAILURE;
    }

    // A resident server deliberately survives closing the GUI. Development is different: an
    // old process would answer newly added protocol methods with -32601. Only stop the server
    // belonging to the data directory this launch will use; FASTVIBE_DATA_DIR has the same
    // precedence in Daemon::default_data_dir.
    let mut data_dir = std::env::var_os("FASTVIBE_DATA_DIR").map(Into::into);
    let mut app_args = app_args.into_iter();
    while let Some(arg) = app_args.next() {
        if arg == "--data-dir" {
            let Some(path) = app_args.next() else {
                eprintln!("--data-dir needs a path");
                return ExitCode::FAILURE;
            };
            data_dir = Some(path.into());
        }
    }
    let data_dir = data_dir.unwrap_or_else(fv_daemon::default_data_dir);
    let server_bin = match fv_daemon::find_server_binary() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let daemon = fv_daemon::Daemon::new(data_dir, server_bin);
    if let Err(error) = daemon.stop_and_wait() {
        eprintln!("could not restart the development server: {error}");
        return ExitCode::FAILURE;
    }

    let status = cargo()
        .args(["run", "-q", "-p", "fv-gui", "--bin", "fastvibe", "--"])
        .args(app_args)
        .status();
    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}
