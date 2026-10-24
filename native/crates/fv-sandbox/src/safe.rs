//! Which commands may run without asking under `untrusted`, and whether a failed command was
//! stopped by the sandbox.

/// Commands that only read. Under `untrusted` these run unasked; everything else asks.
///
/// Deliberately small, and a command is only safe on its own: anything that chains, pipes,
/// redirects or substitutes is not (a harmless first word can hide a harmful second one).
pub fn is_known_safe(command: &str) -> bool {
    const SAFE: &[&str] = &[
        "cat", "cd", "echo", "false", "grep", "head", "ls", "nl", "pwd", "tail", "true", "wc",
        "which", "whoami", "stat", "file", "date", "uname", "basename", "dirname", "tree",
    ];
    let command = command.trim();
    if command.is_empty()
        || command.chars().any(|c| {
            matches!(
                c,
                ';' | '&' | '|' | '>' | '<' | '`' | '$' | '(' | ')' | '\n' | '\\'
            )
        })
    {
        return false;
    }
    let mut words = command.split_whitespace();
    let first = words.next().unwrap_or("");
    if first == "git" {
        // Only the read-only subcommands, and none of the options that run something.
        let rest: Vec<&str> = words.collect();
        return matches!(
            rest.first().copied(),
            Some("status" | "log" | "diff" | "show" | "branch" | "rev-parse" | "ls-files")
        ) && !rest.iter().any(|w| {
            w.starts_with("--output") || w.starts_with("--ext-diff") || *w == "-c" || *w == "--exec"
        });
    }
    // `find` and `rg` can run commands through their options.
    SAFE.contains(&first)
}

/// Whether a command that failed was probably stopped by the sandbox rather than failing by
/// itself: it exited with an error and said so in words the sandbox's refusals use.
pub fn looks_denied(exit_code: Option<i32>, output: &str) -> bool {
    if exit_code == Some(0) {
        return false;
    }
    const MARKERS: &[&str] = &[
        "operation not permitted",
        "read-only file system",
        "permission denied",
        "sandbox",
    ];
    let lower = output.to_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_read_is_known_safe() {
        assert!(is_known_safe("ls -la src"));
        assert!(is_known_safe("git status"));
        assert!(is_known_safe("git log --oneline -n 5"));
        assert!(!is_known_safe("rm -rf build"));
        assert!(!is_known_safe("ls; rm -rf /"));
        assert!(!is_known_safe("cat a > b"));
        assert!(!is_known_safe("echo $(whoami)"));
        assert!(!is_known_safe("git commit -m x"));
        assert!(!is_known_safe("git -c core.pager=sh log"));
        assert!(!is_known_safe("find . -exec rm {} ;"));
        assert!(!is_known_safe(""));
    }

    #[test]
    fn a_refusal_is_told_from_a_failure_of_the_commands_own() {
        assert!(looks_denied(Some(1), "touch: x: Operation not permitted"));
        assert!(looks_denied(
            Some(1),
            "mkdir: /etc/x: Read-only file system"
        ));
        assert!(!looks_denied(Some(0), "Operation not permitted"));
        assert!(!looks_denied(Some(2), "no such file or directory"));
    }
}
