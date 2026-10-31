//! The workspace the file tree and the preview read: listing a directory, reading a file into a
//! preview, writing a text file back, and the tree's create / rename / delete.
//!
//! Everything here is the Electron app's `engine/workspace-fs.ts` and `engine/file-preview.ts`,
//! kept to the same rules — that build is the reference implementation, so a difference here is
//! a bug, not a design choice:
//!
//! - **`.git` and `node_modules` never appear** in a listing, however much the agent uses them.
//! - **Only real files and directories are listed.** A symlink is skipped: the tree previews what
//!   is on the path it shows, and following a link would write somewhere else.
//! - **Directories first, then files, alphabetical** — the order every file tree in this app uses.
//! - **A preview that cannot be drawn says why, in words a person reads.** `ENOENT` is never the
//!   sentence a user sees; the reason is one of `missing` / `permission` / `not-a-file` /
//!   `unknown`, and the host's own words travel separately as `detail`.
//! - **A write is atomic and refuses what it cannot do honestly**: no symlink, no binary, no file
//!   over the cap, and a file that was CRLF keeps CRLF (one save would otherwise rewrite every
//!   line).

use std::path::{Path, PathBuf};

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::*;
use sha2::{Digest, Sha256};

/// The heaviest directories the tree never shows, even though the agent can touch them.
const HIDDEN: [&str; 2] = [".git", "node_modules"];
/// Largest file the pane will load or write back. Past this it stays a size-only preview.
pub const MAX_TEXT_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// The preview will not read a bigger file into memory at all.
const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;
/// Rows a delimited file is cut to, so a 200 MB export cannot freeze the pane.
const MAX_CSV_ROWS: usize = 5000;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, message)
}

/// One directory listing: directories first, then files, each alphabetical.
pub fn read_dir(path: &str) -> Result<ReadDirResponse, ErrorObject> {
    let dir = Path::new(path);
    let entries = std::fs::read_dir(dir).map_err(|e| {
        let reason = failure_reason(&e);
        invalid(format!("{}: {}", human_reason(reason), dir.display()))
    })?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Symlinks, sockets and the like are skipped: the tree only previews real files.
        let kind = if file_type.is_dir() {
            EntryKind::Directory
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        out.push(DirEntry {
            name,
            path: entry.path().display().to_string(),
            kind,
        });
    }
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(ReadDirResponse { entries: out })
}

/// Why a path could not be read, as the pane names it.
fn failure_reason(error: &std::io::Error) -> PreviewFailure {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => PreviewFailure::Missing,
        ErrorKind::PermissionDenied => PreviewFailure::Permission,
        ErrorKind::IsADirectory => PreviewFailure::NotAFile,
        // The errno, for the kinds Rust folds into `Other`: `ENOTDIR`/`EISDIR` are how a path
        // through a file, or a directory read as a file, arrive.
        _ => match error.raw_os_error() {
            Some(20) => PreviewFailure::Missing,
            Some(21) => PreviewFailure::NotAFile,
            Some(13) => PreviewFailure::Permission,
            _ => PreviewFailure::Unknown,
        },
    }
}

/// The sentence a reader gets, which never contains the errno.
fn human_reason(reason: PreviewFailure) -> &'static str {
    match reason {
        PreviewFailure::Missing => "文件不存在",
        PreviewFailure::Permission => "没有读取权限",
        PreviewFailure::NotAFile => "这是一个文件夹",
        PreviewFailure::Unknown => "无法打开这个文件",
    }
}

/// A preview that could not be produced: the conclusion, the host's own words, and the way out.
fn preview_failure(path: &Path, error: &std::io::Error) -> FilePreview {
    let reason = failure_reason(error);
    FilePreview::Error {
        path: path.display().to_string(),
        name: file_name(path),
        message: human_reason(reason).to_string(),
        reason,
        detail: Some(format!("{}: {}", error.kind_label(), error)),
        // A file that is gone cannot be revealed, so the way out points at the directory it
        // should be in; a directory that is not a file is its own way out.
        directory: match reason {
            PreviewFailure::NotAFile => Some(path.display().to_string()),
            _ => path.parent().map(|p| p.display().to_string()),
        },
    }
}

trait KindLabel {
    fn kind_label(&self) -> &'static str;
}

impl KindLabel for std::io::Error {
    /// The errno's own name, for the small print — never the sentence a user reads.
    fn kind_label(&self) -> &'static str {
        match self.raw_os_error() {
            Some(2) => "ENOENT",
            Some(13) => "EACCES",
            Some(20) => "ENOTDIR",
            Some(21) => "EISDIR",
            Some(1) => "EPERM",
            _ => "error",
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .map(|e| format!(".{e}"))
        .unwrap_or_default()
}

/// Read a file into whatever the pane draws for it.
///
/// The order of the checks is the Electron app's, and each step exists for a reason:
/// images / video / PDF are named but never read (the pane loads them from a URL, so a 200 MB
/// movie never becomes a base64 frame); an Office document is a *page* to render, not text to
/// extract; and only what is left is read as text.
pub fn preview(path: &str) -> FilePreview {
    let file = Path::new(path);
    let stat = match std::fs::metadata(file) {
        Ok(stat) => stat,
        Err(e) => return preview_failure(file, &e),
    };
    if !stat.is_file() {
        let e = std::io::Error::from_raw_os_error(21);
        return preview_failure(file, &e);
    }
    let name = file_name(file);
    let ext = extension(file);
    let size = stat.len();

    if let Some(mime) = media_mime(&ext) {
        let kind = match mime.split('/').next().unwrap_or("") {
            "image" => FilePreviewKind::Image,
            "video" => FilePreviewKind::Video,
            _ if ext == ".pdf" => FilePreviewKind::Pdf,
            _ => FilePreviewKind::Binary,
        };
        return FilePreview::Media {
            kind,
            path: path.to_string(),
            name,
            mime_type: mime.to_string(),
            size,
        };
    }
    if let Some(format) = office_format(&ext) {
        return FilePreview::Office {
            path: path.to_string(),
            name,
            format,
            size,
        };
    }
    if unsupported_office(&ext) {
        return FilePreview::Unsupported {
            path: path.to_string(),
            name,
            format: ext.trim_start_matches('.').to_uppercase(),
        };
    }
    if size > MAX_PREVIEW_BYTES {
        return FilePreview::Binary {
            path: path.to_string(),
            name,
            size,
        };
    }
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(e) => return preview_failure(file, &e),
    };
    // A file with NUL bytes is not text, whatever its extension says: drawing it would be a
    // screen of replacement characters.
    if bytes.contains(&0) {
        return FilePreview::Binary {
            path: path.to_string(),
            name,
            size,
        };
    }
    let text = match String::from_utf8(bytes.clone()) {
        Ok(text) => text,
        Err(_) => {
            return FilePreview::Binary {
                path: path.to_string(),
                name,
                size,
            };
        }
    };
    let file_revision = revision(&bytes);
    match ext.as_str() {
        ".md" | ".markdown" => FilePreview::Text {
            kind: FilePreviewKind::Markdown,
            path: path.to_string(),
            name,
            language: None,
            text,
            revision: Some(file_revision.clone()),
        },
        ".html" | ".htm" => FilePreview::Text {
            kind: FilePreviewKind::Html,
            path: path.to_string(),
            name,
            language: None,
            text,
            revision: Some(file_revision.clone()),
        },
        ".csv" | ".tsv" => {
            let rows = parse_delimited(&text, ext == ".tsv");
            let total = rows.len();
            let truncated = total > MAX_CSV_ROWS;
            FilePreview::Table {
                path: path.to_string(),
                name,
                rows: rows.into_iter().take(MAX_CSV_ROWS).collect(),
                truncated,
                total_rows: total as u64,
            }
        }
        ".diff" | ".patch" => FilePreview::Text {
            kind: FilePreviewKind::Diff,
            path: path.to_string(),
            name,
            language: None,
            text,
            revision: Some(file_revision.clone()),
        },
        _ => FilePreview::Text {
            kind: FilePreviewKind::Code,
            language: Some(code_language(&name, &ext)),
            path: path.to_string(),
            name,
            text,
            revision: Some(file_revision),
        },
    }
}

/// The media types the pane draws from a URL rather than from memory.
fn media_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".avif" => "image/avif",
        ".bmp" => "image/bmp",
        ".ico" => "image/x-icon",
        ".svg" => "image/svg+xml",
        ".mp4" => "video/mp4",
        ".m4v" => "video/mp4",
        ".mov" => "video/quicktime",
        ".webm" => "video/webm",
        ".pdf" => "application/pdf",
        _ => return None,
    })
}

/// The three formats OfficeCLI renders. No bytes are read for them.
fn office_format(ext: &str) -> Option<OfficeFormat> {
    Some(match ext {
        ".docx" => OfficeFormat::Docx,
        ".xlsx" => OfficeFormat::Xlsx,
        ".pptx" => OfficeFormat::Pptx,
        _ => return None,
    })
}

/// Legacy binary Office, ODF and the macro-enabled variants: named, not guessed at.
fn unsupported_office(ext: &str) -> bool {
    matches!(
        ext,
        ".doc" | ".xls" | ".ppt" | ".odt" | ".ods" | ".odp" | ".docm" | ".xlsm" | ".pptm"
    )
}

/// Split a delimited file the way a spreadsheet reader would, honouring quotes.
fn parse_delimited(text: &str, tab: bool) -> Vec<Vec<String>> {
    let separator = if tab { '\t' } else { ',' };
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                // A doubled quote inside a quoted field is one quote.
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            c if c == separator => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// The language name the editor asks its highlighter for.
///
/// Only what a reader would not guess from the extension belongs here — `ts` needs saying,
/// `zig` does not. The renderer resolves the rest from the extension on its own.
fn code_language(name: &str, ext: &str) -> String {
    match name {
        "Makefile" | "GNUmakefile" => return "make".into(),
        "Dockerfile" | "Containerfile" => return "docker".into(),
        "CMakeLists.txt" => return "cmake".into(),
        "Gemfile" | "Rakefile" => return "ruby".into(),
        "Jenkinsfile" => return "groovy".into(),
        "Justfile" => return "just".into(),
        _ => {}
    }
    match ext {
        ".ts" | ".mts" | ".cts" => "typescript",
        ".js" | ".mjs" | ".cjs" => "javascript",
        ".py" => "python",
        ".rb" => "ruby",
        ".rs" => "rust",
        ".kt" | ".kts" => "kotlin",
        ".h" => "c",
        ".cc" | ".cxx" => "cpp",
        ".hpp" => "cpp",
        ".cs" => "csharp",
        ".yml" => "yaml",
        ".sh" | ".bash" | ".zsh" => "shellscript",
        // No extension at all travels as its own name, which is also what a dotfile is.
        _ => ext.trim_start_matches('.'),
    }
    .to_string()
}

/// Replace a text file the file pane has open.
///
/// The bytes land in a temp file in the same directory and are renamed over the original, so a
/// crash cannot leave a half-written source. A symlink is refused: the tree only lists real
/// files, and following a link would write somewhere other than the path on screen.
pub fn write_file(path: &str, text: &str, baseline: Option<&str>) -> Result<String, ErrorObject> {
    if path.is_empty() || path.contains('\0') {
        return Err(invalid("路径无效"));
    }
    let file = Path::new(path);
    let metadata = match std::fs::symlink_metadata(file) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(invalid("文件不存在")),
        Err(e) => return Err(failed(e.to_string())),
    };
    if metadata.file_type().is_symlink() {
        return Err(invalid("不能写入符号链接"));
    }
    if !metadata.is_file() {
        return Err(invalid("只能修改普通文件"));
    }
    let size = metadata.len();
    if size > MAX_TEXT_FILE_BYTES {
        return Err(invalid("文件过大，无法编辑"));
    }
    let original = std::fs::read(file).map_err(|e| failed(e.to_string()))?;
    let current_revision = revision(&original);
    if let Some(expected) = baseline
        && expected != current_revision
    {
        return Err(invalid(format!(
            "文件已被修改，请重新读取后再保存（当前版本：{current_revision}）"
        )));
    }
    if original.contains(&0) || std::str::from_utf8(&original).is_err() {
        return Err(invalid("不能覆盖二进制文件"));
    }
    // The editor only holds `\n`, so a file that was CRLF gets that ending back — otherwise one
    // save would rewrite every line of the file.
    let crlf = String::from_utf8_lossy(&original).contains("\r\n");
    let output = if crlf && !text.contains("\r\n") {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    if output.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(invalid("文件过大，无法编辑"));
    }
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    let temporary = dir.join(format!(".fastvibe-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        {
            use std::io::Write as _;
            let mut handle = std::fs::File::create(&temporary)?;
            handle.write_all(output.as_bytes())?;
            handle.sync_all()?;
        }
        // The original's permissions, so a script stays executable.
        std::fs::set_permissions(&temporary, metadata.permissions())?;
        std::fs::rename(&temporary, file)
    })();
    if let Err(e) = result {
        // The original is untouched; a leftover temp is the lesser failure.
        let _ = std::fs::remove_file(&temporary);
        return Err(failed(e.to_string()));
    }
    Ok(revision(output.as_bytes()))
}

/// Resolve a path a client sent against a conversation's working directory.
///
/// A client may only send what it could have got from a listing: a relative path is resolved
/// against `cwd`, and an absolute one is taken as given. Nothing here is a sandbox — the same
/// trust the agent's own tools have.
pub fn resolve(cwd: Option<&str>, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match cwd {
        Some(dir) => Path::new(dir).join(path),
        None => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn a_listing_hides_the_heavy_directories_and_puts_folders_first() {
        let dir = temp_dir();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("zebra.txt"), "z").unwrap();
        std::fs::write(dir.path().join("alpha.txt"), "a").unwrap();

        let listed = read_dir(&dir.path().display().to_string()).unwrap();
        assert_eq!(
            listed
                .entries
                .iter()
                .map(|e| (e.name.as_str(), e.kind))
                .collect::<Vec<_>>(),
            [
                ("src", EntryKind::Directory),
                ("alpha.txt", EntryKind::File),
                ("zebra.txt", EntryKind::File),
            ]
        );
    }

    #[test]
    fn a_symlink_is_not_listed_and_cannot_be_written_through() {
        let dir = temp_dir();
        let target = dir.path().join("real.txt");
        std::fs::write(&target, "real\n").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let listed = read_dir(&dir.path().display().to_string()).unwrap();
        assert!(
            !listed.entries.iter().any(|e| e.name == "link.txt"),
            "the tree previews what is on the path it shows"
        );
        assert!(write_file(&link.display().to_string(), "changed\n", None).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "real\n");
    }

    #[test]
    fn a_missing_file_says_so_without_an_errno_in_the_sentence() {
        let preview = preview("/definitely/not/here/report.md");
        let FilePreview::Error {
            message,
            reason,
            detail,
            directory,
            ..
        } = preview
        else {
            panic!("expected a failure");
        };
        assert_eq!(reason, PreviewFailure::Missing);
        assert_eq!(message, "文件不存在");
        assert!(!message.contains("ENOENT"), "{message}");
        assert!(
            detail.unwrap().contains("ENOENT"),
            "the small print keeps it"
        );
        // The way out points at the directory it should be in, never at the missing file.
        assert_eq!(directory.as_deref(), Some("/definitely/not/here"));
    }

    #[test]
    fn a_directory_is_not_a_file_and_says_which() {
        let dir = temp_dir();
        let FilePreview::Error {
            reason, message, ..
        } = preview(&dir.path().display().to_string())
        else {
            panic!("expected a failure");
        };
        assert_eq!(reason, PreviewFailure::NotAFile);
        assert_eq!(message, "这是一个文件夹");
    }

    #[test]
    fn a_binary_file_is_named_not_drawn() {
        let dir = temp_dir();
        let file = dir.path().join("blob.bin");
        std::fs::write(&file, b"\x00\x01\x02").unwrap();
        let FilePreview::Binary { size, .. } = preview(&file.display().to_string()) else {
            panic!("expected binary");
        };
        assert_eq!(size, 3);
    }

    #[test]
    fn media_and_office_are_named_without_being_read() {
        let dir = temp_dir();
        let png = dir.path().join("shot.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        let FilePreview::Media {
            kind, mime_type, ..
        } = preview(&png.display().to_string())
        else {
            panic!("expected media");
        };
        assert_eq!(kind, FilePreviewKind::Image);
        assert_eq!(mime_type, "image/png");

        let docx = dir.path().join("deck.docx");
        std::fs::write(&docx, b"PK\x03\x04").unwrap();
        let FilePreview::Office { format, .. } = preview(&docx.display().to_string()) else {
            panic!("expected office");
        };
        assert_eq!(format, OfficeFormat::Docx);

        let doc = dir.path().join("old.doc");
        std::fs::write(&doc, b"\xd0\xcf\x11\xe0").unwrap();
        let FilePreview::Unsupported { format, .. } = preview(&doc.display().to_string()) else {
            panic!("expected unsupported");
        };
        assert_eq!(format, "DOC");
    }

    #[test]
    fn a_large_crlf_diff_keeps_all_bytes_and_revision() {
        let dir = temp_dir();
        let file = dir.path().join("large.diff");
        let expected = (0..4501)
            .map(|i| format!("@@ hunk {i} @@\r\n+line {i}\r\n"))
            .collect::<String>();
        std::fs::write(&file, expected.as_bytes()).unwrap();
        let FilePreview::Text {
            kind,
            text,
            revision: actual_revision,
            ..
        } = preview(&file.display().to_string())
        else {
            panic!("expected diff text");
        };
        assert_eq!(kind, FilePreviewKind::Diff);
        assert_eq!(text, expected);
        assert_eq!(
            actual_revision.as_deref(),
            Some(revision(expected.as_bytes()).as_str())
        );
    }

    #[test]
    fn invalid_utf8_is_binary_and_cannot_be_written_lossily() {
        let dir = temp_dir();
        let file = dir.path().join("broken.rs");
        let bytes = b"valid\n\xff\n";
        std::fs::write(&file, bytes).unwrap();
        assert!(matches!(
            preview(&file.display().to_string()),
            FilePreview::Binary { .. }
        ));
        assert!(write_file(&file.display().to_string(), "replacement", None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }

    #[test]
    fn a_baseline_conflict_preserves_external_bytes() {
        let dir = temp_dir();
        let file = dir.path().join("note.md");
        std::fs::write(&file, b"original\n").unwrap();
        let expected = revision(b"original\n");
        std::fs::write(&file, b"external\n").unwrap();
        let error =
            write_file(&file.display().to_string(), "draft\n", Some(&expected)).unwrap_err();
        assert!(error.message.contains("文件已被修改"));
        assert_eq!(std::fs::read(&file).unwrap(), b"external\n");
    }

    #[test]
    fn a_successful_write_returns_the_new_revision() {
        let dir = temp_dir();
        let file = dir.path().join("note.md");
        std::fs::write(&file, b"original\n").unwrap();
        let baseline = revision(b"original\n");
        let next = write_file(&file.display().to_string(), "new\n", Some(&baseline)).unwrap();
        assert_eq!(next, revision(b"new\n"));
        assert_eq!(std::fs::read(&file).unwrap(), b"new\n");
    }

    #[test]
    fn code_markdown_and_delimited_files_get_their_own_kind() {
        let dir = temp_dir();
        let ts = dir.path().join("app.ts");
        std::fs::write(&ts, "const a = 1;\n").unwrap();
        let FilePreview::Text {
            kind,
            language,
            text,
            ..
        } = preview(&ts.display().to_string())
        else {
            panic!("expected text");
        };
        assert_eq!(kind, FilePreviewKind::Code);
        assert_eq!(language.as_deref(), Some("typescript"));
        assert_eq!(text, "const a = 1;\n");

        let md = dir.path().join("README.md");
        std::fs::write(&md, "# hi\n").unwrap();
        assert!(matches!(
            preview(&md.display().to_string()),
            FilePreview::Text {
                kind: FilePreviewKind::Markdown,
                ..
            }
        ));

        let csv = dir.path().join("t.csv");
        std::fs::write(&csv, "a,b\n\"x,1\",2\n").unwrap();
        let FilePreview::Table { rows, .. } = preview(&csv.display().to_string()) else {
            panic!("expected a table");
        };
        assert_eq!(rows, [["a", "b"], ["x,1", "2"]]);
    }

    #[test]
    fn a_write_keeps_crlf_and_refuses_binaries() {
        let dir = temp_dir();
        let file = dir.path().join("script.sh");
        std::fs::write(&file, "line one\r\nline two\r\n").unwrap();
        write_file(&file.display().to_string(), "new one\nnew two\n", None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "new one\r\nnew two\r\n",
            "one save must not rewrite every line ending"
        );

        let binary = dir.path().join("blob.bin");
        std::fs::write(&binary, b"\x00\x01").unwrap();
        assert!(write_file(&binary.display().to_string(), "text", None).is_err());
    }

    #[test]
    fn a_relative_path_is_resolved_against_the_conversation() {
        assert_eq!(
            resolve(Some("/work/project"), "src/app.ts"),
            PathBuf::from("/work/project/src/app.ts")
        );
        assert_eq!(
            resolve(Some("/work/project"), "/etc/hosts"),
            PathBuf::from("/etc/hosts")
        );
    }
}
