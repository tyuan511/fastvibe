# FastVibe GPUI

FastVibe is being rebuilt as a native GPUI desktop client. The new desktop shell
and its reusable runtime live in the Rust workspace under `crates/`.

## Workspace

- `crates/fastvibe-app` — GPUI desktop application and UI shell.
- `crates/fastvibe-core` — projects, sessions, transcripts, harnesses, and model
  selection logic shared by the desktop app.

## Development

```bash
cargo dev
cargo check -p fastvibe-app
cargo test -p fastvibe-core
```

The optional accelerated GPUI backend can be checked with:

```bash
cargo check -p fastvibe-app --features gpui-fast
```

The application stores its local development database under
`$FASTVIBE_DATA_DIR/fastvibe.db`, or under `~/.fastvibe-app/fastvibe.db` when
that variable is not set.
