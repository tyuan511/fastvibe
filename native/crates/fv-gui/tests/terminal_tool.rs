//! Terminal data presentation, without launching a window or driving the interface.
use fv_gui::presentation::{describe, terminal_command, terminal_output, unwrap_shell_command};
use serde_json::json;

#[test]
fn command_arguments_follow_electrons_precedence_and_skip_blank_fields() {
    let args = json!({"command": " echo first ", "cmd": "second", "script": "third"});
    assert_eq!(terminal_command("bash", &args), "echo first");
    for field in ["command", "cmd", "script", "parsed_cmd"] {
        let mut args = json!({"command": "  "});
        args[field] = json!(" echo 中文\nprintf done ");
        assert_eq!(
            terminal_command("exec_command", &args),
            "echo 中文\nprintf done"
        );
        assert_eq!(
            describe("exec_command", &args, false, true).subject,
            "echo 中文\nprintf done"
        );
    }
    assert_eq!(terminal_command("shell", &json!(" echo raw ")), "echo raw");
    assert_eq!(
        terminal_command("write_stdin", &json!({"session_id": 42})),
        "write_stdin"
    );
    assert_eq!(terminal_command("bash", &json!({"cmd": 2})), "bash");
}

#[test]
fn shell_display_wrappers_match_electron_without_parsing_the_inner_script() {
    for (input, expected) in [
        (" /bin/zsh -lc ' echo hello ' ", "echo hello"),
        ("bash -lc \"printf a\\nb\"", "printf a\\nb"),
        ("SH\t-lc\n'echo 中文'", "echo 中文"),
        ("/BIN/ZSH -lc 'echo caps'", "echo caps"),
        ("/bin/bash -lc echo hello", "echo hello"),
        ("sh -lc ''", ""),
        ("sh -lc 'echo a\necho b'", "echo a\necho b"),
        (" echo plain ", "echo plain"),
        ("zsh -c 'echo untouched'", "zsh -c 'echo untouched'"),
        (
            "/usr/bin/bash -lc 'echo untouched'",
            "/usr/bin/bash -lc 'echo untouched'",
        ),
        (
            "env bash -lc 'echo untouched'",
            "env bash -lc 'echo untouched'",
        ),
        ("bash -lcecho", "bash -lcecho"),
        ("bash -lc ", "bash -lc"),
        ("bash -lc 'unmatched", "'unmatched"),
    ] {
        assert_eq!(unwrap_shell_command(input), expected, "{input}");
    }
}

#[test]
fn output_keeps_whitespace_inside_the_result_and_uses_electrons_limit() {
    assert_eq!(
        terminal_output(" \n  line one\n\n  line two  \n"),
        "line one\n\n  line two"
    );
    assert_eq!(terminal_output(" \n\t"), "");
    assert_eq!(terminal_output(&"中".repeat(4000)), "中".repeat(4000));
    assert_eq!(
        terminal_output(&"中".repeat(4001)),
        format!("{}\n…", "中".repeat(4000))
    );
    assert_eq!(terminal_output(&"😀".repeat(2000)), "😀".repeat(2000));
    assert_eq!(
        terminal_output(&format!("{}😀x", "a".repeat(3999))),
        format!("{}\n…", "a".repeat(3999))
    );
    let many_lines = "x\n".repeat(401);
    assert_eq!(
        terminal_output(&many_lines).lines().count(),
        401,
        "no unrelated 400-line cutoff"
    );
}
