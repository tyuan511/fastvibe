# FastVibe patch to alacritty_terminal 0.26.0

Source: the crates.io 0.26.0 release (https://crates.io/crates/alacritty_terminal/0.26.0), upstream repository https://github.com/alacritty/alacritty . Apache-2.0; upstream source headers and LICENSE-APACHE are retained. The registry Cargo.toml and original manifest are retained, except the reference-test target is omitted because its 46 MiB fixture corpus is not vendored. Upstream inline unit tests remain available.

The runtime change is in src/grid/mod.rs: expose a monotonic count of rows appended to scrollback and a history identity that changes on explicit history clearing or construction of a new grid. Both fields are excluded from upstream grid serialization. The counter increases only when the full history rotates, so scrolling a subregion cannot move a remote client's anchored history. It continues past the 5,000-line ring limit. Client viewports use these coordinates independently; the library's display offset remains untouched. Screen resize invalidation is handled by fv-server.

When updating the dependency, reapply these accessors and verify the terminal history, partial-scroll, eviction, copy and reset tests in fv-server, plus the upstream inline grid tests.

For upstream inline tests, seed its ignored standalone Cargo.lock from native/Cargo.lock, then run `cargo test --manifest-path native/vendor/alacritty_terminal/Cargo.toml --lib --target-dir native/target` from the repository root. The standalone workspace lets Cargo include the upstream dev-dependencies without adding third-party test targets to the application workspace.
