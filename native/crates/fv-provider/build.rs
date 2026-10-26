//! Embeds the models.dev snapshot the app ships with, so one binary is enough for the
//! desktop and for an SSH host alike.
//!
//! The snapshot is generated, not committed (`pnpm sync:models` writes it, the release
//! refreshes it), so a tree without one embeds nothing and the catalog starts empty —
//! exactly what the Electron app does when its `resources/models-dev` is missing.

use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // One copy of the catalog serves both apps, as with the file icons.
    let snapshot = manifest.join("../../../resources/models-dev/index.json");
    let body = if snapshot.is_file() {
        println!("cargo:rerun-if-changed={}", snapshot.display());
        format!(
            "pub static MODELS_DEV_BUNDLED: &[u8] = include_bytes!({});\n",
            display_quoted(&snapshot)
        )
    } else {
        // Watch the directory instead: the file appearing is what has to be noticed, and a
        // rule for a path that does not exist would rerun this on every build.
        println!(
            "cargo:rerun-if-changed={}",
            snapshot.parent().unwrap().display()
        );
        "pub static MODELS_DEV_BUNDLED: &[u8] = &[];\n".to_string()
    };
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("models_dev_bundled.rs");
    std::fs::write(out, body).unwrap();
}

/// `include_bytes!` wants a Rust string literal, and Windows path separators have to survive it.
fn display_quoted(path: &Path) -> String {
    format!("{:?}", path.display().to_string())
}
