# Third-party code

Parts of this crate are adapted from **OpenAI Codex** (<https://github.com/openai/codex>,
`codex-rs`, Apache License 2.0), at tag `rust-v0.46.0` unless noted:

| Here | From | Changes |
| --- | --- | --- |
| `src/apply_patch/parser.rs` | `apply-patch/src/parser.rs` | `ApplyPatchArgs` is defined in `apply_patch/mod.rs`; the unused `Hunk::resolve_path` is removed; otherwise unchanged, tests included |
| `src/apply_patch/seek_sequence.rs` | `apply-patch/src/seek_sequence.rs` | none |
| `src/apply_patch/instructions.md` | `apply-patch/apply_patch_tool_instructions.md` | used as the base of the tool description |
| `src/apply_patch/plan.rs` | `apply-patch/src/lib.rs` (`derive_new_contents_from_chunks`, `compute_replacements`, `apply_replacements`) | patches are planned against an in-memory view of every file first and written only if all of them apply |
| `src/truncate.rs` | `core/src/truncate.rs` (`truncate_middle`) | preserve the suffix when the only newline in the suffix budget is the final byte; otherwise a long final line would disappear |
| `src/update_plan.rs` | `core/src/tools/handlers/plan.rs`, `plan_spec.rs` | name, arguments and description kept; the plan reaches clients from the call's arguments |
| `src/request_user_input.rs` | `core/src/tools/handlers/request_user_input.rs`, `request_user_input_spec.rs` | name, arguments, description and result format kept; no collaboration modes; the client always adds an "Other" answer |
| `src/view_image.rs` | `core/src/tools/handlers/view_image.rs`, `view_image_spec.rs` | name, argument, description and refusal messages kept; a large picture is scaled down before it is sent (it is carried again by every later request) |
| `src/tool_search.rs`, `src/bm25.rs` | `core/src/tools/handlers/tool_search.rs`, `tool_search_spec.rs` | name, arguments and the BM25 idea kept; codex relies on the Responses API's own deferred loading, here deferred tools are left out of requests until found, so it works with any provider |
| `src/exec_command.rs` | `core/src/tools/handlers/shell_spec.rs` (`exec_command`) and `core/src/exec.rs` | argument names kept, plus codex's `sandbox_permissions` / `justification`; sandbox and approval handling lives in `fv-sandbox` / `fv-agent` |
| `src/exec_sessions/*`, `src/write_stdin.rs` | Unified-exec behavior in `main`: `core/src/unified_exec/mod.rs`, `core/src/unified_exec/write_stdin.rs`, `core/src/tools/handlers/unified_exec.rs` (consulted 2026-10-26) | independently implemented process pool and PTY I/O; retain yield defaults, completion-only explicit timeouts, 64 live processes, 1 MiB output, conversation-scoped IDs and incremental output. FastVibe keeps pipe stdin open for later input, interprets standalone Ctrl-C / Ctrl-D for pipes too, retains its 50,000-token maximum and existing sandbox approvals, and prevents idle server replacement while a command runs. Windows PTY support remains part of the Windows delivery work |

Code-mode interface references: OpenAI Codex commit
`60adfa8513f77c27826f0c5b770e7a7d4eca538e`, consulted 2026-10-26:
`code-mode-protocol/src/description.rs`, `runtime.rs` and
`core/src/tools/code_mode/{execute_spec,wait_spec,delegate}.rs` (Apache-2.0).
`src/code_mode/` independently implements isolated async JavaScript, nested native
calls, explicit printed output, conversation-local JSON values, incremental yielding,
waiting and cancellation. It embeds rquickjs/QuickJS (MIT) on bounded worker threads
rather than requiring the upstream external V8 host. `code_mode` uses a JSON `code`
field on every provider protocol, with `wait` retaining the cell/yield/terminate fields.
Native sandbox/approval and role grants remain authoritative; native command sessions
already returned by a nested call retain their turn ownership. Unfinished cells stop
at the end of the native turn; only explicit JSON values survive between its cells/turns.
Audio helpers await native audio-content support; existing image output is supported.

The Apache License 2.0 applies to those portions. The upstream copyright notices are retained in the files.
