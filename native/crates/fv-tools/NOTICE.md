# Third-party code

Parts of this crate are adapted from **OpenAI Codex** (<https://github.com/openai/codex>,
`codex-rs`, Apache License 2.0), at tag `rust-v0.46.0` unless noted:

| Here | From | Changes |
| --- | --- | --- |
| `src/apply_patch/parser.rs` | `apply-patch/src/parser.rs` | `ApplyPatchArgs` is defined in `apply_patch/mod.rs`; the unused `Hunk::resolve_path` is removed; otherwise unchanged, tests included |
| `src/apply_patch/seek_sequence.rs` | `apply-patch/src/seek_sequence.rs` | none |
| `src/apply_patch/instructions.md` | `apply-patch/apply_patch_tool_instructions.md` | used as the base of the tool description |
| `src/apply_patch/plan.rs` | `apply-patch/src/lib.rs` (`derive_new_contents_from_chunks`, `compute_replacements`, `apply_replacements`) | patches are planned against an in-memory view of every file first and written only if all of them apply |
| `src/truncate.rs` | `core/src/truncate.rs` (`truncate_middle`) | none |
| `src/exec_command.rs` | `core/src/tools/handlers/shell_spec.rs` (`exec_command`) and `core/src/exec.rs` | argument names kept; commands run to completion (no resumable sessions yet) |

The Apache License 2.0 applies to those portions. The upstream copyright notices are retained in the files.
