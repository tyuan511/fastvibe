// `derive_new_contents`, `compute_replacements` and `apply_replacements` are adapted from
// OpenAI Codex (codex-rs/apply-patch/src/lib.rs, rust-v0.46.0), Apache-2.0. See NOTICE.md.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::parser::{Hunk, UpdateFileChunk};
use super::seek_sequence::seek_sequence;
use crate::paths::resolve;

enum Op {
    Write(PathBuf, String),
    Remove(PathBuf),
}

/// A patch checked against the files it touches and ready to be written.
pub(super) struct Plan {
    ops: Vec<Op>,
    added: Vec<String>,
    modified: Vec<String>,
    deleted: Vec<String>,
}

/// What each file would hold after the hunks so far, so that later hunks see earlier ones
/// (a file added and then updated in the same patch, a file moved and then edited).
struct View {
    files: HashMap<PathBuf, Option<String>>,
}

impl View {
    fn read(&self, path: &Path) -> std::io::Result<String> {
        match self.files.get(path) {
            Some(Some(contents)) => Ok(contents.clone()),
            Some(None) => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "deleted earlier in this patch",
            )),
            None => std::fs::read_to_string(path),
        }
    }

    fn exists(&self, path: &Path) -> bool {
        match self.files.get(path) {
            Some(state) => state.is_some(),
            None => path.is_file(),
        }
    }
}

pub(super) fn plan(hunks: &[Hunk], cwd: Option<&Path>) -> Result<Plan, String> {
    if hunks.is_empty() {
        return Err("No files were modified.".into());
    }
    let abs = |p: &Path| resolve(cwd, &p.to_string_lossy());
    let mut view = View {
        files: HashMap::new(),
    };
    let mut plan = Plan {
        ops: Vec::new(),
        added: Vec::new(),
        modified: Vec::new(),
        deleted: Vec::new(),
    };

    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let target = abs(path)?;
                if target.is_dir() {
                    return Err(format!(
                        "Failed to write file {}: it is a directory",
                        path.display()
                    ));
                }
                view.files.insert(target.clone(), Some(contents.clone()));
                plan.ops.push(Op::Write(target, contents.clone()));
                plan.added.push(path.display().to_string());
            }
            Hunk::DeleteFile { path } => {
                let target = abs(path)?;
                if !view.exists(&target) {
                    return Err(format!(
                        "Failed to delete file {}: it does not exist",
                        path.display()
                    ));
                }
                view.files.insert(target.clone(), None);
                plan.ops.push(Op::Remove(target));
                plan.deleted.push(path.display().to_string());
            }
            Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            } => {
                let source = abs(path)?;
                let original = view.read(&source).map_err(|e| {
                    format!("Failed to read file to update {}: {e}", path.display())
                })?;
                let updated = derive_new_contents(&original, path, chunks)?;
                match move_path {
                    Some(dest) => {
                        let dest_abs = abs(dest)?;
                        view.files.insert(dest_abs.clone(), Some(updated.clone()));
                        plan.ops.push(Op::Write(dest_abs.clone(), updated));
                        if dest_abs != source {
                            view.files.insert(source.clone(), None);
                            plan.ops.push(Op::Remove(source));
                        }
                        plan.modified.push(dest.display().to_string());
                    }
                    None => {
                        view.files.insert(source.clone(), Some(updated.clone()));
                        plan.ops.push(Op::Write(source, updated));
                        plan.modified.push(path.display().to_string());
                    }
                }
            }
        }
    }
    Ok(plan)
}

impl Plan {
    /// Every file the patch would write or remove, as absolute paths.
    pub(super) fn paths(&self) -> Vec<PathBuf> {
        self.ops
            .iter()
            .map(|op| match op {
                Op::Write(path, _) | Op::Remove(path) => path.clone(),
            })
            .collect()
    }

    /// Write everything. The only failures left are the disk's own (full, read-only).
    pub(super) fn apply(self) -> Result<String, String> {
        for op in &self.ops {
            match op {
                Op::Write(path, contents) => {
                    if let Some(parent) = path.parent()
                        && !parent.as_os_str().is_empty()
                    {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            format!(
                                "Failed to create parent directories for {}: {e}",
                                path.display()
                            )
                        })?;
                    }
                    std::fs::write(path, contents)
                        .map_err(|e| format!("Failed to write file {}: {e}", path.display()))?;
                }
                Op::Remove(path) => {
                    std::fs::remove_file(path)
                        .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
                }
            }
        }
        let mut out = String::from("Success. Updated the following files:\n");
        for p in &self.added {
            out.push_str(&format!("A {p}\n"));
        }
        for p in &self.modified {
            out.push_str(&format!("M {p}\n"));
        }
        for p in &self.deleted {
            out.push_str(&format!("D {p}\n"));
        }
        Ok(out)
    }
}

/// The file's new contents after applying the chunks.
fn derive_new_contents(
    original: &str,
    path: &Path,
    chunks: &[UpdateFileChunk],
) -> Result<String, String> {
    let mut lines: Vec<String> = original.split('\n').map(String::from).collect();
    // Drop the empty element after the final newline so line counts match `diff`'s.
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let replacements = compute_replacements(&lines, path, chunks)?;
    let mut new_lines = apply_replacements(lines, &replacements);
    if !new_lines.last().is_some_and(String::is_empty) {
        new_lines.push(String::new());
    }
    Ok(new_lines.join("\n"))
}

/// `(start_index, old_len, new_lines)` for each chunk.
fn compute_replacements(
    original_lines: &[String],
    path: &Path,
    chunks: &[UpdateFileChunk],
) -> Result<Vec<(usize, usize, Vec<String>)>, String> {
    let mut replacements = Vec::new();
    let mut line_index = 0usize;

    for chunk in chunks {
        // A context line (`@@ fn main`) narrows where the chunk may start.
        if let Some(ctx_line) = &chunk.change_context {
            match seek_sequence(
                original_lines,
                std::slice::from_ref(ctx_line),
                line_index,
                false,
            ) {
                Some(idx) => line_index = idx + 1,
                None => {
                    return Err(format!(
                        "Failed to find context '{}' in {}",
                        ctx_line,
                        path.display()
                    ));
                }
            }
        }

        if chunk.old_lines.is_empty() {
            // Pure addition: at the end, before the final empty line if there is one.
            let at = if original_lines.last().is_some_and(String::is_empty) {
                original_lines.len() - 1
            } else {
                original_lines.len()
            };
            replacements.push((at, 0, chunk.new_lines.clone()));
            continue;
        }

        // The last element of `old_lines` is often an empty string standing for the final
        // newline, which `original_lines` does not have; retry without it when the first
        // search fails.
        let mut pattern: &[String] = &chunk.old_lines;
        let mut found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        let mut new_slice: &[String] = &chunk.new_lines;

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
            found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        }

        match found {
            Some(start) => {
                replacements.push((start, pattern.len(), new_slice.to_vec()));
                line_index = start + pattern.len();
            }
            None => {
                return Err(format!(
                    "Failed to find expected lines in {}:\n{}",
                    path.display(),
                    chunk.old_lines.join("\n")
                ));
            }
        }
    }

    replacements.sort_by_key(|r| r.0);
    Ok(replacements)
}

fn apply_replacements(
    mut lines: Vec<String>,
    replacements: &[(usize, usize, Vec<String>)],
) -> Vec<String> {
    // Back to front, so an earlier replacement does not move the position of a later one.
    for (start, old_len, new_segment) in replacements.iter().rev() {
        for _ in 0..*old_len {
            if *start < lines.len() {
                lines.remove(*start);
            }
        }
        for (offset, line) in new_segment.iter().enumerate() {
            lines.insert(start + offset, line.clone());
        }
    }
    lines
}
