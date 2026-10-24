//! File glyphs from the vscode-icons set the Electron app vendors (`resources/file-icons`),
//! resolved by the same rules as `src/shared/file-icons.ts`: an exact file name first, then
//! the longest matching extension, then (for a name with no dot) the whole name as an
//! extension, else the default glyph. A light theme prefers the set's light artwork.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

const MANIFEST: &str = include_str!("../../../../resources/file-icons/manifest.json");

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Variant {
    #[serde(default)]
    file_extensions: HashMap<String, String>,
    #[serde(default)]
    file_names: HashMap<String, String>,
    file: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    file_extensions: HashMap<String, String>,
    file_names: HashMap<String, String>,
    file: String,
    #[serde(default)]
    light: Variant,
}

struct Index {
    /// Longest first, so `d.ts` wins over `ts`.
    extensions: Vec<(String, String)>,
    extension_map: HashMap<String, String>,
    file_names: HashMap<String, String>,
    file: String,
}

fn build(m: &Manifest, light: bool) -> Index {
    let mut extension_map = m.file_extensions.clone();
    let mut file_names = m.file_names.clone();
    let mut file = m.file.clone();
    if light {
        extension_map.extend(m.light.file_extensions.clone());
        file_names.extend(m.light.file_names.clone());
        if let Some(f) = &m.light.file {
            file = f.clone();
        }
    }
    let mut extensions: Vec<(String, String)> = extension_map
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    extensions.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.0.cmp(&b.0)));
    Index {
        extensions,
        extension_map,
        file_names,
        file,
    }
}

fn indexes() -> &'static (Index, Index) {
    static INDEXES: OnceLock<(Index, Index)> = OnceLock::new();
    INDEXES.get_or_init(|| {
        let m: Manifest = serde_json::from_str(MANIFEST).expect("file icon manifest");
        (build(&m, false), build(&m, true))
    })
}

/// The icon name for a file name (not a path).
pub fn resolve(name: &str, light: bool) -> &'static str {
    let (dark, lightx) = indexes();
    let index = if light { lightx } else { dark };
    let lower = name.to_lowercase();
    if let Some(icon) = index.file_names.get(&lower) {
        return icon;
    }
    for (ext, icon) in &index.extensions {
        if lower.len() > ext.len()
            && lower.ends_with(ext.as_str())
            && lower.as_bytes()[lower.len() - ext.len() - 1] == b'.'
        {
            return icon;
        }
    }
    if !lower.contains('.')
        && let Some(icon) = index.extension_map.get(&lower)
    {
        return icon;
    }
    &index.file
}

/// The asset path of a file's glyph.
pub fn path(name: &str, light: bool) -> String {
    format!("file-icons/{}.svg", resolve(name, light))
}
