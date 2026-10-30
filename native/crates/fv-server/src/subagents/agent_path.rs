//! Canonical agent paths, after codex's `protocol/src/agent_path.rs`.
//!
//! Every spawned agent carries a path (`/root/<name>/…`) derived from its spawner's own path
//! and the spawn-time `task_name`. A tool target is resolved as an agent id first, then as a
//! path: absolute (starting with `/root`) or relative to the caller's own path — so a parent
//! names its own children directly while a sibling needs the canonical form. `..` and `.` are
//! reserved; names are lowercase letters, digits and underscores.

pub const ROOT: &str = "/root";

pub fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("agent_name must not be empty".to_string());
    }
    if name == "root" {
        return Err("agent_name `root` is reserved".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("agent_name `{name}` is reserved"));
    }
    if name.len() > 64 {
        return Err("agent_name must be at most 64 characters".to_string());
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Err(
            "agent_name must use only lowercase letters, digits, and underscores".to_string(),
        );
    }
    Ok(())
}

fn valid_segments(reference: &str) -> Result<(), String> {
    for segment in reference.split('/') {
        // The root segment is spelled `root`, which the name rules otherwise reserve.
        if segment == "root" {
            continue;
        }
        valid_name(segment)?;
    }
    Ok(())
}

/// The caller's own path: its stored task name, or `/root` for the root thread.
pub fn caller_path(task_name: Option<&str>) -> String {
    task_name.map(str::to_string).unwrap_or_else(|| ROOT.into())
}

/// `spawner_path/name`, after codex's `AgentPath::join`.
pub fn join(spawner: &str, name: &str) -> Result<String, String> {
    valid_name(name)?;
    Ok(format!("{spawner}/{name}"))
}

/// Resolve a target reference against the caller's path: absolute when it starts with `/`,
/// relative otherwise. The result is a canonical path, not yet matched against any agent.
pub fn resolve(caller: &str, reference: &str) -> Result<String, String> {
    if reference.is_empty() {
        return Err("agent path must not be empty".to_string());
    }
    if reference == ROOT {
        return Ok(ROOT.to_string());
    }
    if reference.starts_with('/') {
        if !reference.starts_with(&format!("{ROOT}/")) {
            return Err(format!("absolute agent paths must start with `{ROOT}`"));
        }
        if reference.ends_with('/') {
            return Err("absolute agent path must not end with `/`".to_string());
        }
        valid_segments(reference.strip_prefix('/').unwrap_or(""))?;
        return Ok(reference.to_string());
    }
    if reference.ends_with('/') {
        return Err("relative agent path must not end with `/`".to_string());
    }
    valid_segments(reference)?;
    Ok(format!("{caller}/{reference}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_codex_rules() {
        assert!(valid_name("worker_1").is_ok());
        for bad in ["", "root", ".", "..", "Bad", "a-b", "a/b", "名"] {
            assert!(valid_name(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn relative_references_join_the_caller_path() {
        assert_eq!(resolve("/root", "worker").unwrap(), "/root/worker");
        assert_eq!(
            resolve("/root/researcher", "worker").unwrap(),
            "/root/researcher/worker"
        );
        // `..` and `.` are reserved names, so references only ever go down the tree.
        assert!(resolve("/root", "../sibling").is_err());
        assert!(resolve("/root", ".").is_err());
        assert!(resolve("/root", "").is_err());
    }

    #[test]
    fn absolute_references_must_start_at_root() {
        assert_eq!(
            resolve("/root/x", "/root/other/y").unwrap(),
            "/root/other/y"
        );
        assert_eq!(resolve("/root/x", "/root").unwrap(), "/root");
        assert!(resolve("/root/x", "/not-root/y").is_err());
        assert!(resolve("/root/x", "/root/bad-name/").is_err());
        assert!(resolve("/root/x", "/root/Bad").is_err());
    }

    #[test]
    fn join_validates_the_new_segment() {
        assert_eq!(join("/root", "w").unwrap(), "/root/w");
        assert!(join("/root", "W").is_err());
        assert!(join("/root", "root").is_err());
    }
}
