//! The sandbox, for real: commands are started behind Seatbelt and what they could and could not
//! do is read from the file system. Skipped where there is no Seatbelt.

use std::path::Path;
use std::process::{Command, Output};

use fv_sandbox::{Policy, SandboxMode, available, wrap};

fn run(policy: &Policy, script: &str, cwd: &Path) -> Output {
    let wrapped = wrap(policy, "/bin/sh", &["-c".into(), script.into()])
        .expect("a sandbox here")
        .expect("this policy is sandboxed");
    Command::new(wrapped.program)
        .args(wrapped.args)
        .current_dir(cwd)
        .output()
        .expect("sandbox-exec starts")
}

fn workspace(root: &Path, network: bool) -> Policy {
    Policy {
        mode: SandboxMode::WorkspaceWrite,
        writable_roots: vec![root.to_path_buf()],
        network,
    }
}

macro_rules! needs_seatbelt {
    () => {
        if !available() {
            eprintln!("no Seatbelt here: skipped");
            return;
        }
    };
}

#[test]
fn a_command_writes_inside_its_folder_and_nowhere_else() {
    needs_seatbelt!();
    let inside = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let policy = workspace(inside.path(), false);

    let ok = run(&policy, "echo hi > made.txt && cat made.txt", inside.path());
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(inside.path().join("made.txt")).unwrap(),
        "hi\n"
    );

    let target = outside.path().join("nope.txt");
    let denied = run(
        &policy,
        &format!("echo hi > {}", target.display()),
        inside.path(),
    );
    assert!(!denied.status.success(), "a write outside went through");
    assert!(!target.exists());
    let message = String::from_utf8_lossy(&denied.stderr).to_lowercase();
    assert!(message.contains("operation not permitted"), "{message}");
}

#[test]
fn reading_is_not_restricted() {
    needs_seatbelt!();
    let inside = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "found").unwrap();
    for mode in [SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite] {
        let policy = Policy {
            mode,
            writable_roots: vec![inside.path().to_path_buf()],
            network: false,
        };
        let out = run(
            &policy,
            &format!("cat {}", outside.path().join("secret.txt").display()),
            inside.path(),
        );
        assert!(
            out.status.success(),
            "{mode:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout), "found");
    }
}

#[test]
fn read_only_writes_nothing_not_even_in_the_working_folder() {
    needs_seatbelt!();
    let inside = tempfile::tempdir().unwrap();
    let policy = Policy {
        mode: SandboxMode::ReadOnly,
        writable_roots: vec![inside.path().to_path_buf()],
        network: false,
    };
    let out = run(&policy, "echo hi > made.txt", inside.path());
    assert!(!out.status.success());
    assert!(!inside.path().join("made.txt").exists());
}

#[test]
fn the_repositorys_own_directory_stays_read_only_inside_a_writable_folder() {
    needs_seatbelt!();
    let inside = tempfile::tempdir().unwrap();
    let git = inside.path().join(".git");
    std::fs::create_dir(&git).unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let policy = workspace(inside.path(), false);

    // Rewriting what is in it, adding to it and removing it are all refused…
    let edit = run(&policy, "echo x > .git/HEAD", inside.path());
    assert!(!edit.status.success());
    let add = run(&policy, "echo x > .git/new", inside.path());
    assert!(!add.status.success());
    let remove = run(&policy, "rm -rf .git", inside.path());
    assert!(!remove.status.success());
    assert_eq!(
        std::fs::read_to_string(git.join("HEAD")).unwrap(),
        "ref: refs/heads/main\n"
    );
    // …while the rest of the folder is not affected.
    assert!(
        run(&policy, "echo ok > fine.txt", inside.path())
            .status
            .success()
    );

    // A `.git` that does not exist yet cannot be made either.
    let fresh = tempfile::tempdir().unwrap();
    let policy = workspace(fresh.path(), false);
    let made = run(&policy, "mkdir .git", fresh.path());
    assert!(!made.status.success());
    assert!(!fresh.path().join(".git").exists());
}

#[test]
fn a_link_out_of_the_folder_does_not_carry_a_write_out() {
    needs_seatbelt!();
    let inside = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), inside.path().join("door")).unwrap();
    let policy = workspace(inside.path(), false);
    let out = run(&policy, "echo hi > door/escaped.txt", inside.path());
    assert!(!out.status.success());
    assert!(!outside.path().join("escaped.txt").exists());
}

#[test]
fn the_network_is_closed_unless_the_policy_opens_it() {
    needs_seatbelt!();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let inside = tempfile::tempdir().unwrap();
    let connect = format!("exec 3<>/dev/tcp/127.0.0.1/{port}");

    let closed = run(
        &workspace(inside.path(), false),
        &format!("/bin/bash -c '{connect}'"),
        inside.path(),
    );
    assert!(
        !closed.status.success(),
        "connected through a closed network"
    );

    let open = run(
        &workspace(inside.path(), true),
        &format!("/bin/bash -c '{connect}'"),
        inside.path(),
    );
    assert!(
        open.status.success(),
        "{}",
        String::from_utf8_lossy(&open.stderr)
    );
}

#[test]
fn full_access_is_not_wrapped_at_all() {
    let policy = Policy::full_access();
    assert_eq!(wrap(&policy, "/bin/sh", &[]).unwrap(), None);
}

#[test]
fn can_write_agrees_with_what_the_sandbox_does() {
    let inside = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(inside.path().join(".git")).unwrap();
    let policy = workspace(inside.path(), false);
    assert!(policy.can_write(&inside.path().join("a/b/c.txt")));
    assert!(policy.can_write(&inside.path().join("a/../d.txt")));
    assert!(!policy.can_write(&inside.path().join(".git/HEAD")));
    assert!(!policy.can_write(&inside.path().join(".git")));
    assert!(!policy.can_write(&inside.path().join("../escape.txt")));
    assert!(!policy.can_write(&outside.path().join("x")));
    assert!(
        !Policy {
            mode: SandboxMode::ReadOnly,
            ..policy.clone()
        }
        .can_write(&inside.path().join("x"))
    );
    assert!(Policy::full_access().can_write(Path::new("/etc/hosts")));
}
