//! Instructions and skills are resolved for a conversation's directory, never for whichever
//! conversation a GUI last selected. Reads happen off the async executor and are refreshed on
//! every turn, so edits to AGENTS.md or a skill take effect without restarting the daemon.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fv_protocol::types::*;
use fv_protocol::{ErrorObject, jsonrpc::code};
use serde::Deserialize;

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_INSTRUCTIONS_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIRECTORIES: usize = 4096;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn failed(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

fn read_text(path: &Path) -> Result<String, String> {
    let mut text = String::new();
    File::open(path)
        .and_then(|f| f.take(MAX_FILE_BYTES + 1).read_to_string(&mut text))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{} exceeds the 1 MiB limit", path.display()));
    }
    Ok(text)
}

/// The nearest repository, including a worktree's .git file. Outside git, start at the top
/// ancestor so nested instructions still follow the same outer-to-inner precedence.
fn ancestry(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for dir in cwd.ancestors() {
        dirs.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            break;
        }
    }
    dirs.reverse();
    dirs
}

#[derive(Deserialize)]
struct Metadata {
    name: String,
    description: String,
    #[serde(default, rename = "disable-model-invocation")]
    manual_only: bool,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn metadata(text: &str) -> Result<Metadata, String> {
    let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Err("SKILL.md needs YAML frontmatter".into());
    };
    let Some(yaml) = rest
        .split_once("\n---\n")
        .map(|(yaml, _)| yaml)
        .or_else(|| rest.strip_suffix("\n---"))
    else {
        return Err("SKILL.md has unclosed YAML frontmatter".into());
    };
    let mut meta: Metadata = serde_yaml::from_str(yaml).map_err(|e| e.to_string())?;
    meta.description = meta.description.trim().to_string();
    if !valid_name(&meta.name) {
        return Err(
            "skill names need lowercase letters, digits and single hyphens (1–64 bytes)".into(),
        );
    }
    if meta.description.is_empty() || meta.description.chars().count() > 1024 {
        return Err("skill descriptions need 1–1024 characters".into());
    }
    Ok(meta)
}

pub struct ContextLoader {
    home: Option<PathBuf>,
    managed: PathBuf,
    builtins: Vec<PathBuf>,
    mutation: Mutex<()>,
}

impl ContextLoader {
    pub fn new(data_dir: &Path) -> Self {
        let mut builtins = Vec::new();
        if let Ok(exe) = std::env::current_exe()
            && let Some(bin) = exe.parent()
        {
            builtins.push(bin.join("../Resources/skills"));
            builtins.push(bin.join("skills"));
        }
        builtins.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/skills"));
        builtins.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../resources/skills"));
        Self::with_roots(
            data_dir,
            std::env::var_os("HOME").map(PathBuf::from),
            builtins,
        )
    }

    /// Explicit roots also make tests independent of the process's HOME and installed skills.
    pub fn with_roots(data_dir: &Path, home: Option<PathBuf>, builtins: Vec<PathBuf>) -> Self {
        Self {
            home,
            managed: data_dir.join("skills"),
            builtins,
            mutation: Mutex::new(()),
        }
    }

    pub fn instructions(&self, cwd: Option<&Path>) -> (String, Vec<String>) {
        self.instructions_for_folders(cwd, &[])
    }

    fn instructions_for_folders(
        &self,
        cwd: Option<&Path>,
        other_folders: &[String],
    ) -> (String, Vec<String>) {
        let mut paths = Vec::new();
        let mut directories = BTreeSet::new();
        if let Some(home) = &self.home {
            if let Ok(dir) = fs::canonicalize(home.join(".agents")) {
                directories.insert(dir);
            }
            paths.push((
                vec![
                    home.join(".agents/AGENTS.override.md"),
                    home.join(".agents/AGENTS.md"),
                ],
                "all conversations".to_string(),
            ));
        }
        for cwd in cwd
            .into_iter()
            .chain(other_folders.iter().map(Path::new))
            .filter_map(|p| fs::canonicalize(p).ok())
        {
            for dir in ancestry(&cwd) {
                if !directories.insert(dir.clone()) {
                    continue;
                }
                paths.push((
                    vec![dir.join("AGENTS.override.md"), dir.join("AGENTS.md")],
                    format!("{} and descendants", dir.display()),
                ));
            }
        }
        let mut seen = BTreeSet::new();
        let mut result = String::new();
        let mut diagnostics = Vec::new();
        for (candidates, scope) in paths {
            for path in candidates {
                let canonical = match fs::canonicalize(&path) {
                    Ok(p) => p,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        diagnostics.push(format!("{}: {e}", path.display()));
                        continue;
                    }
                };
                if !seen.insert(canonical) {
                    continue;
                }
                match read_text(&path) {
                    Ok(body) if !body.trim().is_empty() => {
                        let entry = format!(
                            "\n\nProject instructions from {} (scope: {scope}):\n{body}",
                            path.display()
                        );
                        if result.len() + entry.len() > MAX_INSTRUCTIONS_BYTES {
                            diagnostics.push(format!(
                                "{}: total instruction limit exceeded",
                                path.display()
                            ));
                        } else {
                            result.push_str(&entry);
                        }
                        break;
                    }
                    Ok(_) => (),
                    Err(e) => diagnostics.push(e),
                }
            }
        }
        if !result.is_empty() {
            result.insert_str(0, "\n\nApply instructions from broader to narrower scope; deeper files override broader files. Instructions scoped to one folder do not apply to sibling folders. The user's direct instructions take precedence.\n");
        }
        (result, diagnostics)
    }

    pub fn list(&self, cwd: Option<&Path>) -> SkillListResponse {
        self.list_for_folders(cwd, &[])
    }

    pub fn list_for_folders(
        &self,
        cwd: Option<&Path>,
        other_folders: &[String],
    ) -> SkillListResponse {
        let mut roots = Vec::new();
        // Nearest project wins, then managed, global and bundled. The builtin always loses
        // to a user-authored skill with the same name, as in the Electron app.
        for cwd in cwd
            .into_iter()
            .chain(other_folders.iter().map(Path::new))
            .filter_map(|p| fs::canonicalize(p).ok())
        {
            for dir in ancestry(&cwd).into_iter().rev() {
                roots.push((dir.join(".agents/skills"), SkillScope::Project));
            }
        }
        roots.push((self.managed.clone(), SkillScope::Managed));
        if let Some(home) = &self.home {
            roots.push((home.join(".agents/skills"), SkillScope::Global));
        }
        roots.extend(
            self.builtins
                .iter()
                .map(|p| (p.clone(), SkillScope::Builtin)),
        );
        let mut skills = BTreeMap::new();
        let mut diagnostics = Vec::new();
        let mut seen = BTreeSet::new();
        for (root, scope) in roots {
            self.scan(&root, scope, 0, &mut seen, &mut skills, &mut diagnostics);
        }
        SkillListResponse {
            skills: skills.into_values().collect(),
            diagnostics,
        }
    }

    fn scan(
        &self,
        dir: &Path,
        scope: SkillScope,
        depth: usize,
        seen: &mut BTreeSet<PathBuf>,
        skills: &mut BTreeMap<String, SkillInfo>,
        diagnostics: &mut Vec<String>,
    ) {
        let canonical = match fs::canonicalize(dir) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                diagnostics.push(format!("{}: {e}", dir.display()));
                return;
            }
        };
        if depth > 12 || seen.len() >= MAX_DIRECTORIES {
            diagnostics.push(format!("{}: skill discovery limit exceeded", dir.display()));
            return;
        }
        if !seen.insert(canonical.clone()) {
            return;
        }
        if canonical.join(".incomplete").exists() {
            diagnostics.push(format!("{}: incomplete skill import", dir.display()));
            return;
        }
        let file = canonical.join("SKILL.md");
        if file.exists() {
            match read_text(&file).and_then(|text| metadata(&text)) {
                Ok(meta) => {
                    let removable = scope == SkillScope::Managed
                        && fs::canonicalize(&self.managed)
                            .is_ok_and(|root| canonical.parent() == Some(root.as_path()))
                        && fs::symlink_metadata(dir).is_ok_and(|m| !m.file_type().is_symlink());
                    let info = SkillInfo {
                        name: meta.name.clone(),
                        description: meta.description,
                        path: file.display().to_string(),
                        scope,
                        removable,
                        manual_only: meta.manual_only,
                    };
                    if let Some(first) = skills.get(&meta.name) {
                        diagnostics.push(format!("{} shadows {}", first.path, info.path));
                    } else {
                        skills.insert(meta.name, info);
                    }
                }
                Err(e) => diagnostics.push(format!("{}: {e}", file.display())),
            }
            return;
        }
        let entries = match fs::read_dir(&canonical) {
            Ok(entries) => entries,
            Err(e) => {
                diagnostics.push(format!("{}: {e}", dir.display()));
                return;
            }
        };
        let mut children = Vec::new();
        for entry in entries {
            match entry {
                Ok(entry) => {
                    let name = entry.file_name();
                    if !name.to_string_lossy().starts_with('.') && entry.path().is_dir() {
                        children.push(entry.path());
                    }
                }
                Err(e) => diagnostics.push(format!("{}: {e}", dir.display())),
            }
        }
        children.sort();
        for child in children {
            self.scan(&child, scope, depth + 1, seen, skills, diagnostics);
        }
    }

    pub fn read(&self, cwd: Option<&Path>, name: &str) -> Result<SkillReadResponse, ErrorObject> {
        self.read_for_folders(cwd, &[], name)
    }

    pub fn read_for_folders(
        &self,
        cwd: Option<&Path>,
        other_folders: &[String],
        name: &str,
    ) -> Result<SkillReadResponse, ErrorObject> {
        let skill = self
            .list_for_folders(cwd, other_folders)
            .skills
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| invalid(format!("技能不存在：{name}")))?;
        let content = read_text(Path::new(&skill.path)).map_err(failed)?;
        Ok(SkillReadResponse { skill, content })
    }

    pub fn create(&self, params: SkillCreateParams) -> Result<(), ErrorObject> {
        let _guard = self.mutation.lock().unwrap();
        if !valid_name(&params.name) {
            return Err(invalid("名称需为 1–64 个小写字母、数字和单连字符"));
        }
        let description = params.description.trim();
        let text = format!(
            "---\nname: {}\ndescription: {}\n---\n\n{}\n",
            params.name,
            serde_json::to_string(description).map_err(failed)?,
            params.body.trim()
        );
        metadata(&text).map_err(invalid)?;
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid("技能内容不能超过 1 MiB"));
        }
        fs::create_dir_all(&self.managed).map_err(failed)?;
        let dest = self.managed.join(&params.name);
        fs::create_dir(&dest).map_err(|e| invalid(format!("无法创建技能（可能已存在）：{e}")))?;
        let saved = write_skill(&dest, &text);
        if let Err(e) = saved {
            let _ = fs::remove_dir_all(&dest);
            return Err(failed(e));
        }
        Ok(())
    }

    pub fn remove(&self, cwd: Option<&Path>, name: &str) -> Result<(), ErrorObject> {
        self.remove_for_folders(cwd, &[], name)
    }

    pub fn remove_for_folders(
        &self,
        cwd: Option<&Path>,
        other_folders: &[String],
        name: &str,
    ) -> Result<(), ErrorObject> {
        let _guard = self.mutation.lock().unwrap();
        let found = self.read_for_folders(cwd, other_folders, name)?;
        if !found.skill.removable {
            return Err(invalid("只能删除 FastVibe 中添加的技能"));
        }
        let dir = Path::new(&found.skill.path)
            .parent()
            .ok_or_else(|| invalid("技能路径无效"))?;
        // Validate the directory itself too: the frontmatter name may differ from its dirname.
        let managed = fs::canonicalize(&self.managed).map_err(failed)?;
        if dir.parent() != Some(managed.as_path()) {
            return Err(invalid("技能不在私有目录中"));
        }
        fs::remove_dir_all(dir).map_err(failed)
    }

    /// Import a skill or a collection, including supporting resources. All destinations are
    /// reserved before copying; an existing skill is never overwritten, and a failed batch
    /// removes only directories this operation created.
    pub fn import(&self, source: &Path) -> Result<(), ErrorObject> {
        let _guard = self.mutation.lock().unwrap();
        if !source.is_absolute() {
            return Err(invalid("请选择技能文件夹的绝对路径"));
        }
        let source = fs::canonicalize(source).map_err(failed)?;
        let source = if source.is_file() && source.file_name().is_some_and(|n| n == "SKILL.md") {
            source
                .parent()
                .ok_or_else(|| invalid("技能路径无效"))?
                .to_path_buf()
        } else {
            source
        };
        fs::create_dir_all(&self.managed).map_err(failed)?;
        let managed = fs::canonicalize(&self.managed).map_err(failed)?;
        if source.starts_with(&managed) || managed.starts_with(&source) {
            return Err(invalid("不能从技能存储目录或其父目录导入"));
        }
        let (mut skills, mut diagnostics, mut seen) =
            (BTreeMap::new(), Vec::new(), BTreeSet::new());
        self.scan(
            &source,
            SkillScope::Global,
            0,
            &mut seen,
            &mut skills,
            &mut diagnostics,
        );
        if !diagnostics.is_empty() {
            return Err(invalid(diagnostics.join("\n")));
        }
        if skills.is_empty() {
            return Err(invalid("所选文件夹没有有效的 SKILL.md"));
        }
        let mut plans = Vec::new();
        for skill in skills.into_values() {
            let file = Path::new(&skill.path);
            let base = file.parent().ok_or_else(|| invalid("技能路径无效"))?;
            if !base.starts_with(&source)
                || fs::symlink_metadata(file)
                    .map_err(failed)?
                    .file_type()
                    .is_symlink()
            {
                return Err(invalid("导入的技能必须是所选文件夹中的实际文件"));
            }
            let text = read_text(file).map_err(invalid)?;
            metadata(&text).map_err(invalid)?;
            plans.push((base.to_path_buf(), managed.join(&skill.name), text));
        }
        let mut created = Vec::new();
        let result = (|| -> std::io::Result<()> {
            for (_, dest, _) in &plans {
                fs::create_dir(dest)?;
                created.push(dest.clone());
                fs::write(dest.join(".incomplete"), "")?;
            }
            let mut budget = (0usize, 0u64);
            for (source, dest, text) in &plans {
                copy_resources(source, dest, 0, &mut budget)?;
                write_skill(dest, text)?;
            }
            for dest in &created {
                fs::remove_file(dest.join(".incomplete"))?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            for dest in created {
                let _ = fs::remove_dir_all(dest);
            }
            return Err(failed(format!("无法导入技能（请检查名称是否已存在）：{e}")));
        }
        Ok(())
    }

    pub fn prompt(&self, cwd: Option<&Path>, user_text: Option<&str>) -> String {
        self.prompt_for_folders(cwd, &[], user_text)
    }

    pub fn prompt_for_folders(
        &self,
        cwd: Option<&Path>,
        other_folders: &[String],
        user_text: Option<&str>,
    ) -> String {
        let (mut text, mut diagnostics) = self.instructions_for_folders(cwd, other_folders);
        let catalog = self.list_for_folders(cwd, other_folders);
        diagnostics.extend(catalog.diagnostics);
        if !catalog.skills.is_empty() {
            text.push_str("\n\nAvailable skills (name, description, absolute SKILL.md path):\n");
            for skill in &catalog.skills {
                if !skill.manual_only {
                    text.push_str(&serde_json::to_string(skill).expect("skill serializes"));
                    text.push('\n');
                }
            }
            text.push_str("When a skill is named or clearly fits the request, read its SKILL.md with exec_command and follow its instructions. Resolve its relative resources against that file's directory. Do not apply skills based on keywords alone. The user's explicit instructions take precedence over skill guidance.\n");
        }
        if let Some(name) = user_text
            .and_then(|s| s.trim_start().strip_prefix("/skill:"))
            .and_then(|s| s.split_whitespace().next())
        {
            match self.read_for_folders(cwd, other_folders, name) {
                Ok(skill) => text.push_str(&format!(
                    "\n\nThe user explicitly selected skill {} at {}:\n{}",
                    skill.skill.name, skill.skill.path, skill.content
                )),
                Err(e) => diagnostics.push(e.message),
            }
        }
        if !diagnostics.is_empty() {
            text.push_str("\n\nContext discovery diagnostics (do not claim unread instructions were loaded):\n");
            for message in diagnostics {
                text.push_str(&format!("- {message}\n"));
            }
        }
        text
    }
}

fn write_skill(dest: &Path, text: &str) -> std::io::Result<()> {
    let temporary = dest.join(".SKILL.md.tmp");
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    fs::rename(temporary, dest.join("SKILL.md"))
}

fn copy_resources(
    source: &Path,
    dest: &Path,
    depth: usize,
    budget: &mut (usize, u64),
) -> std::io::Result<()> {
    if depth > 32 {
        return Err(std::io::Error::other("技能目录层级过深"));
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git"
            || (depth == 0
                && (name == "SKILL.md" || name == ".incomplete" || name == ".SKILL.md.tmp"))
        {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(std::io::Error::other("请将技能中的符号链接替换为实际文件"));
        }
        budget.0 += 1;
        if budget.0 > 10000 {
            return Err(std::io::Error::other("技能包含过多文件"));
        }
        let path = dest.join(name);
        if kind.is_dir() {
            fs::create_dir(&path)?;
            copy_resources(&entry.path(), &path, depth + 1, budget)?;
        } else if kind.is_file() {
            budget.1 += entry.metadata()?.len();
            if budget.1 > 100 * 1024 * 1024 {
                return Err(std::io::Error::other("技能资源超过 100 MiB"));
            }
            fs::copy(entry.path(), path)?;
        } else {
            return Err(std::io::Error::other("技能中存在不支持的特殊文件"));
        }
    }
    Ok(())
}
