//! Project tasks, run as `cargo <alias>`.
//!
//!   cargo dev [-- app args]   build the server and the app, then start the app

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
    let status = cargo()
        .args(["run", "-q", "-p", "fv-gui", "--bin", "fastvibe", "--"])
        .args(app_args)
        .status();
    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}
