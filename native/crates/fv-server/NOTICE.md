# Third-party references

The collaboration tool interface in `src/subagents.rs` follows OpenAI Codex
(<https://github.com/openai/codex>, Apache License 2.0), consulted from local upstream
commit `60adfa8513f77c27826f0c5b770e7a7d4eca538e` on 2026-10-26
(`core/src/tools/handlers/multi_agents*.rs` and `multi_agents_spec.rs`).

FastVibe independently implements the child-session runtime with its own thread engine,
SQLite ownership records, JSONL transcripts and JSON-RPC controls. It follows the
MultiAgentV2 surface (spawn_agent with task_name, followup_task, send_message,
interrupt_agent, the mailbox-style target-less wait_agent, and list_agents with a
path-prefix filter), including canonical /root/... agent paths resolved relative to the
caller and the `Message Type: FINAL_ANSWER` completion-message format. Client-side
close/resume stay as JSON-RPC controls rather than model tools. Inputs support text
tasks, custom `provider/model` labels, `fork_turns` and saved `agent_type` roles. Forks copy durable parent context and independent image files while
retaining original accounting identities; roles add immutable per-child instruction/model/tool
snapshots, filesystem read-only constraints and ancestor tool-grant ceilings. Status/results use native
FastVibe types and bounded previews; the child thread retains the full output.
