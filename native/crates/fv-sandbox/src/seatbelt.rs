//! macOS Seatbelt, the way codex uses it: a policy text of fixed sections plus rules built from
//! the writable roots, the roots passed to `sandbox-exec` as `-D` parameters (so no path is ever
//! spliced into the policy text), and the command run behind `--`.

use std::path::Path;

use crate::policy::{PROTECTED_NAMES, Policy, SandboxMode, resolve};

const BASE: &str = include_str!("base.sbpl");
const NETWORK: &str = include_str!("network.sbpl");
const PREFERENCES: &str = include_str!("preferences.sbpl");

/// Only the system's own `sandbox-exec`: one found on `PATH` could be anyone's.
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// A command ready to start: the program and its arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wrapped {
    pub program: String,
    pub args: Vec<String>,
}

/// Whether this system can enforce a sandbox.
pub fn available() -> bool {
    cfg!(target_os = "macos") && Path::new(SANDBOX_EXEC).exists()
}

/// `program args…` behind the policy. `None` when no sandbox applies (`danger-full-access`);
/// an error when one is wanted and this system cannot provide it.
pub fn wrap(policy: &Policy, program: &str, args: &[String]) -> Result<Option<Wrapped>, String> {
    if policy.mode == SandboxMode::DangerFullAccess {
        return Ok(None);
    }
    if !available() {
        return Err(
            "this system has no sandbox (macOS Seatbelt is the one supported); \
             choose 完全访问 in the settings to run commands without one"
                .into(),
        );
    }
    let (text, params) = policy_text(policy);
    let mut out: Vec<String> = vec!["-p".into(), text];
    for (key, value) in params {
        out.push(format!("-D{key}={value}"));
    }
    out.push("--".into());
    out.push(program.into());
    out.extend(args.iter().cloned());
    Ok(Some(Wrapped {
        program: SANDBOX_EXEC.into(),
        args: out,
    }))
}

/// The policy text and the `-D` parameters it refers to.
fn policy_text(policy: &Policy) -> (String, Vec<(String, String)>) {
    let mut sections = vec![BASE.to_string(), "(allow file-read*)".to_string()];
    let mut params: Vec<(String, String)> = Vec::new();

    if policy.mode == SandboxMode::WorkspaceWrite && !policy.writable_roots.is_empty() {
        let mut components = Vec::new();
        let mut roots: Vec<String> = Vec::new();
        for root in &policy.writable_roots {
            let root = resolve(root).display().to_string();
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        for (i, root) in roots.iter().enumerate() {
            let key = format!("WRITABLE_ROOT_{i}");
            params.push((key.clone(), root.clone()));
            // Writable, except the bookkeeping directories inside it: both the directory itself
            // (so it cannot be created or replaced) and everything beneath.
            let mut parts = vec![format!("(subpath (param \"{key}\"))")];
            for name in PROTECTED_NAMES {
                let excluded = format!("{key}_{}", name.trim_start_matches('.').to_uppercase());
                params.push((excluded.clone(), format!("{root}/{name}")));
                parts.push(format!("(require-not (literal (param \"{excluded}\")))"));
                parts.push(format!("(require-not (subpath (param \"{excluded}\")))"));
            }
            components.push(format!("(require-all {} )", parts.join(" ")));
        }
        sections.push(format!("(allow file-write*\n{}\n)", components.join(" ")));
        // The root itself must stay where it is: a command may not unlink the folder the next
        // policy is built from.
        for i in 0..roots.len() {
            sections.push(format!(
                "(deny file-write-unlink (require-all (literal (param \"WRITABLE_ROOT_{i}\")) (vnode-type DIRECTORY)))"
            ));
        }
    }

    if policy.mode == SandboxMode::WorkspaceWrite && policy.network {
        // Codex's full-network form: outbound and inbound, the platform services the network
        // stack looks up, and the one system libcurl needs for TLS.
        sections.push("(allow network-outbound)\n(allow network-inbound)".to_string());
        sections.push(NETWORK.to_string());
        sections.push(
            "(allow mach-lookup (global-name \"com.apple.TrustEvaluationAgent\"))".to_string(),
        );
    }
    sections.push(PREFERENCES.to_string());
    sections.push("(deny mach-lookup (xpc-service-name-prefix \"\"))".to_string());
    (sections.join("\n"), params)
}
