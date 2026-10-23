use std::path::Path;

use fv_agent::{Tool, ToolCtx, ToolOutput};
use fv_tools::ApplyPatchTool;
use serde_json::json;
use tokio_util::sync::CancellationToken;

async fn apply(cwd: Option<&Path>, patch: &str) -> ToolOutput {
    ApplyPatchTool
        .call(
            ToolCtx {
                cancel: CancellationToken::new(),
                cwd: cwd.map(Path::to_path_buf),
            },
            json!({ "input": patch }),
        )
        .await
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[tokio::test]
async fn add_update_move_and_delete_in_one_patch() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    std::fs::write(d.join("app.py"), "def greet():\n    print(\"Hi\")\n").unwrap();
    std::fs::write(d.join("obsolete.txt"), "bye\n").unwrap();

    let out = apply(
        Some(d),
        "*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: app.py\n*** Move to: src/main.py\n@@ def greet():\n-    print(\"Hi\")\n+    print(\"Hello, world!\")\n*** Delete File: obsolete.txt\n*** End Patch\n",
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(
        out.content,
        "Success. Updated the following files:\nA hello.txt\nM src/main.py\nD obsolete.txt\n"
    );
    assert_eq!(read(&d.join("hello.txt")), "Hello world\n");
    assert_eq!(
        read(&d.join("src/main.py")),
        "def greet():\n    print(\"Hello, world!\")\n"
    );
    assert!(!d.join("app.py").exists() && !d.join("obsolete.txt").exists());
}

#[tokio::test]
async fn later_hunks_see_earlier_ones() {
    let dir = tempfile::tempdir().unwrap();
    let out = apply(
        Some(dir.path()),
        "*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Update File: a.txt\n@@\n one\n+between\n two\n*** End Patch\n",
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(read(&dir.path().join("a.txt")), "one\nbetween\ntwo\n");
}

#[tokio::test]
async fn a_patch_that_does_not_apply_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    std::fs::write(d.join("a.txt"), "keep\n").unwrap();
    std::fs::write(d.join("b.txt"), "other\n").unwrap();

    // The first hunk is fine, the second cannot find its lines.
    let out = apply(
        Some(d),
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-keep\n+changed\n*** Update File: b.txt\n@@\n-missing line\n+x\n*** Add File: c.txt\n+new\n*** End Patch\n",
    )
    .await;
    assert!(out.is_error);
    assert!(
        out.content
            .contains("Failed to find expected lines in b.txt"),
        "{}",
        out.content
    );
    assert_eq!(
        read(&d.join("a.txt")),
        "keep\n",
        "the hunk that did apply was written anyway"
    );
    assert!(!d.join("c.txt").exists());
}

#[tokio::test]
async fn paths_are_relative_to_the_working_directory_or_absolute() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let abs = other.path().join("abs.txt");
    let patch = format!(
        "*** Begin Patch\n*** Add File: rel.txt\n+r\n*** Add File: {}\n+a\n*** End Patch\n",
        abs.display()
    );
    let out = apply(Some(dir.path()), &patch).await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(read(&dir.path().join("rel.txt")), "r\n");
    assert_eq!(read(&abs), "a\n");

    // A relative path with nowhere to be relative to is refused, not guessed.
    let out = apply(
        None,
        "*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch\n",
    )
    .await;
    assert!(
        out.is_error && out.content.contains("no working directory"),
        "{}",
        out.content
    );
}

#[tokio::test]
async fn context_markers_and_end_of_file_pick_the_right_place() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    std::fs::write(
        d.join("m.rs"),
        "fn a() {\n    x();\n}\n\nfn b() {\n    x();\n}\n",
    )
    .unwrap();
    // `x();` occurs twice; the @@ line says which function.
    let out = apply(Some(d), "*** Begin Patch\n*** Update File: m.rs\n@@ fn b() {\n-    x();\n+    y();\n*** End Patch\n").await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(
        read(&d.join("m.rs")),
        "fn a() {\n    x();\n}\n\nfn b() {\n    y();\n}\n"
    );

    std::fs::write(d.join("t.txt"), "a\nb\na\nb\n").unwrap();
    let out = apply(
        Some(d),
        "*** Begin Patch\n*** Update File: t.txt\n@@\n a\n-b\n+B\n*** End of File\n*** End Patch\n",
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(
        read(&d.join("t.txt")),
        "a\nb\na\nB\n",
        "an end-of-file chunk matches at the end"
    );
}

#[tokio::test]
async fn missing_files_and_bad_patches_say_what_is_wrong() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let out = apply(
        Some(d),
        "*** Begin Patch\n*** Update File: nope.txt\n@@\n-a\n+b\n*** End Patch\n",
    )
    .await;
    assert!(
        out.is_error
            && out
                .content
                .contains("Failed to read file to update nope.txt"),
        "{}",
        out.content
    );
    let out = apply(
        Some(d),
        "*** Begin Patch\n*** Delete File: nope.txt\n*** End Patch\n",
    )
    .await;
    assert!(
        out.is_error && out.content.contains("does not exist"),
        "{}",
        out.content
    );
    let out = apply(Some(d), "just some text").await;
    assert!(
        out.is_error && out.content.contains("*** Begin Patch"),
        "{}",
        out.content
    );
    let out = apply(Some(d), "*** Begin Patch\n*** End Patch\n").await;
    assert!(
        out.is_error && out.content.contains("No files were modified"),
        "{}",
        out.content
    );
}

#[tokio::test]
async fn a_heredoc_wrapper_and_a_bare_string_argument_are_tolerated() {
    let dir = tempfile::tempdir().unwrap();
    let out = apply(
        Some(dir.path()),
        "<<'EOF'\n*** Begin Patch\n*** Add File: h.txt\n+hi\n*** End Patch\nEOF\n",
    )
    .await;
    assert!(!out.is_error, "{}", out.content);

    let ctx = ToolCtx {
        cancel: CancellationToken::new(),
        cwd: Some(dir.path().to_path_buf()),
    };
    let out = ApplyPatchTool
        .call(
            ctx,
            json!("*** Begin Patch\n*** Add File: bare.txt\n+x\n*** End Patch\n"),
        )
        .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(dir.path().join("bare.txt").exists());
}

#[test]
fn the_tool_is_described_as_a_tool_not_a_shell_command() {
    use fv_agent::Tool;
    let spec = ApplyPatchTool.spec();
    assert_eq!(spec.name, "apply_patch");
    assert!(
        spec.description.contains("apply_patch` tool"),
        "{}",
        spec.description
    );
    assert!(
        !spec.description.contains("shell {"),
        "the shell example was not replaced"
    );
    assert!(spec.description.contains("\"input\""));
    assert_eq!(spec.schema["required"], json!(["input"]));
}
