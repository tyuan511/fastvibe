# GPUI workspace instructions

FastVibe is currently a Rust GPUI desktop application. The active product code is
under `crates/fastvibe-app` and `crates/fastvibe-core`.

## Boundaries

- `crates/fastvibe-app` owns the desktop window, GPUI components, layout, and
  user interaction.
- `crates/fastvibe-core` owns projects, sessions, persistence, harness adapters,
  model catalogs, and transcript state.
- Keep UI code independent from storage details except through the core
  repository API.
- Keep user data in the repository's database; do not add ad hoc JSON or global
  mutable state for application behavior.

## UI

- Use GPUI and GPUI Kit components already available in the workspace.
- Use semantic theme tokens from the active GPUI Kit theme instead of hardcoded
  palette colors.
- Keep the macOS title bar owned by `TitleBar::window_options()` and
  `TitleBar::new()` so traffic lights and window dragging remain native.
- Keep sidebar project rows and session rows keyboard/mouse accessible and use
  stable element IDs for repeated items.
- Do not add browser, Electron, Flutter, or NSH code back to this workspace.

## Verification

Run checks relevant to the change:

```bash
cargo fmt --all -- --check
cargo dev --help
cargo check -p fastvibe-app
cargo test -p fastvibe-core
```

For accelerated GPUI changes, also run:

```bash
cargo check -p fastvibe-app --features gpui-fast
```

Do not use computer-use or UI automation tests. UI behavior is verified
manually by the user; code changes should be covered by Rust unit tests and
basic compile checks where appropriate.
