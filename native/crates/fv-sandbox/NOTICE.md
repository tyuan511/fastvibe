# Third-party code

The Seatbelt policy files `src/base.sbpl`, `src/network.sbpl` and `src/preferences.sbpl` are
copied unchanged from **OpenAI Codex** (<https://github.com/openai/codex>, `codex-rs/sandboxing/src`,
`seatbelt_base_policy.sbpl`, `seatbelt_network_policy.sbpl`, `seatbelt_preferences_policy.sbpl`,
Apache License 2.0). `src/seatbelt.rs` follows the structure of `seatbelt.rs` there: a policy of
those sections, the read and write rules built from roots that are passed to `sandbox-exec` as
`-D` parameters, `.git` kept read-only inside a writable root, and the command run behind `--`.
The sandbox modes and approval policies in `src/lib.rs` are codex's (`read-only`,
`workspace-write`, `danger-full-access`; `untrusted`, `on-failure`, `on-request`, `never`).

The Apache License 2.0 applies to those portions.
