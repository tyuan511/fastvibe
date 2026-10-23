use std::path::{Path, PathBuf};

/// A path as a tool received it: absolute is used as it is, relative is taken from the turn's
/// working directory. FastVibe has no sandbox, so nothing is confined to that directory.
pub fn resolve(cwd: Option<&Path>, path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("the path is empty".into());
    }
    let p = PathBuf::from(path);
    if p.is_absolute() {
        return Ok(p);
    }
    match cwd {
        Some(cwd) => Ok(cwd.join(p)),
        None => Err(format!(
            "`{path}` is relative and this conversation has no working directory; use an absolute path"
        )),
    }
}
