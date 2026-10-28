//! Embeds the app's assets (fonts, icons) and the file icons the Electron app vendors, as a
//! table the asset source reads from.

use std::fmt::Write as _;
use std::path::Path;

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
    entries.sort_by_key(|e| e.path());
    for e in entries {
        let p = e.path();
        if p.is_dir() {
            walk(&p, root, out);
        } else {
            out.push(
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

fn main() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    // The copy in `locales/` is baked into the binary by the `i18n!` macro at compile time, and
    // nothing on cargo's side knows those files were read: editing a string and rebuilding left
    // the *previous* table in the executable, so the change only appeared once some `.rs` file
    // happened to change too. Naming them here is what makes 改文案 → 重新构建 actually work.
    let locales = crate_dir.join("locales");
    println!("cargo:rerun-if-changed={}", locales.display());
    if let Ok(entries) = std::fs::read_dir(&locales) {
        let mut files: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        files.sort();
        for path in files {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    // One copy of the file icons serves both apps.
    let roots = [
        (crate_dir.join("assets"), ""),
        (
            crate_dir.join("../../../resources/file-icons/icons"),
            "file-icons/",
        ),
    ];
    let mut code = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (root, prefix) in &roots {
        println!("cargo:rerun-if-changed={}", root.display());
        let mut files = Vec::new();
        walk(root, root, &mut files);
        for f in &files {
            let full = root.join(f).display().to_string();
            writeln!(code, "    (\"{prefix}{f}\", include_bytes!({full:?})),").unwrap();
        }
    }
    code.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("assets.rs");
    std::fs::write(out, code).unwrap();
}
