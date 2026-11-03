# FastVibe memory

One switch (设置 → 长期记忆), off by default, and one choice: which model does the work. Off means off: nothing is read, written or
injected, and the files already on disk stay until the user clears them. On, FastVibe runs
**Codex's memory pipeline** (`codex-rs/memories`): two background phases that turn finished
conversations into Markdown files, and a read path that costs one prompt section. The four
prompts are Codex's own, vendored under `resources/memories/` (Apache-2.0, see its
`NOTICE.md` for the commit each came from and the few lines changed).

There used to be three modes (default, semantic, JEV-enhanced) over a SQLite index with
embeddings and a relation graph. All of that is gone: `memory.sqlite`, the 118 MB embedding
model and the graph view. `removeLegacyMemory` deletes the leftovers at startup, and a
`memory.json` from that era reads as "off" (only a file carrying `version: 2` can switch the
new memory on).

## The files

`runtime/engine/memories/` is the folder the agent reads, and what 打开文件夹 reveals:

```
memory_summary.md     first line `v1`; a compact map, supplied as hidden context on change
MEMORY.md             the handbook, by task group, citing recap files; read with grep
raw_memories.md       input to consolidation: `## Thread <id>` per selected conversation
rollout_summaries/    one recap per conversation: <created UTC>-<hash4>-<slug>.md
skills/               optional, written by the consolidation agent
```

Bookkeeping lives outside the folder, where the agent has no reason to look: the shared
`fastvibe.db` stores stage-1 outputs, optional retention metadata and retry state in
`memory_outputs`, `memory_empty`, `memory_failures` and `memory_meta`.
The old `runtime/engine/memory-state.json` is migrated once and renamed aside.
`runtime/engine/memories-baseline/` is a copy of the folder as the last successful
consolidation left it.

## Stage 1 — extraction (`memory.ts`, `memory-plan.ts`, `memory-transcript.ts`)

A pass runs 45 seconds after launch, every 15 minutes, when the switch goes on, and from
设置 → 立即整理. It prunes, then reads at most 2 conversations (`max_rollouts_per_startup`).

- **Which conversations** (Codex's defaults): a side chat belongs to its parent and a running
  chat is not finished. A conversation is read once its **transcript file** has been quiet for
  6 hours (the file's mtime, not the catalog's `updatedAt`, which moves on a rename) and is at
  most 10 days old. One already read at its current mtime is skipped, so a chat that is
  continued is read again and one that is not is never read twice.
- **What the model sees**: Codex's `stage_one_system.md` as the system prompt and
  `stage_one_input.md` (rollout path, cwd, contents) as the user message. The contents are one
  branch rendered as text — user messages, replies, tool calls, tool results (clipped at 8,000
  characters; a row at 10,000, as Codex's tiered input does) — never thinking blocks or hidden
  messages. The budget is 70% of the model's window (Codex's `CONTEXT_WINDOW_PERCENT`), the
  middle dropped past it. Secrets are replaced with `[REDACTED_SECRET]` on the way in and again
  on the way out.
- **What it returns**: JSON `{ raw_memory, rollout_summary, rollout_slug }`. No note or no recap
  means "nothing worth saving": the conversation is recorded as empty and not asked again until
  it changes. A conversation with no real exchange is never sent.
- **Failure**: retried after an hour, three times, then left until the transcript changes. The
  message shows in the settings row.
- **Pruning**: expired sources and the memory of deleted conversations are dropped. Retention
  maintenance runs even without new conversations. An expired or capacity-evicted source keeps
  its transcript fingerprint in `memory_empty`, so unchanged history cannot recreate it.
- **The model** is the one chosen in 设置 → 长期记忆 (`config.model`, used for both stages, where Codex
  has separate `extract_model` and `consolidation_model`). Unset, or no longer authenticated, it is the
  light model, then the default model, the active chat's model, or anything authenticated
  (`#backgroundModel` in `process-manager.ts`).

## Stage 2 — consolidation (`memory-workspace.ts`, `pi/memory-agent.ts`)

The top 256 distilled conversations are selected by the shared retention score, then their
last effective usage clock, then stable source identity. `raw_memories.md` and
`rollout_summaries/` are brought in line with that selection exactly. Source notes and the raw
collection are host-owned inputs: consolidation cannot change or recreate them.

Ordinary memory and Vivi use the same `engine/memory-retention.ts` policy:

- Unweighted retention is `R = 2^(-age / halfLife)`, with age measured from the later of
  generation and last effective use. Expiry is strictly `R < 1/16`; the boundary itself stays.
- The initial half-life is 7.5 days. Effective uses at least 24 hours apart double it, up to
  90 days: expiry after 30 / 60 / 120 / 240 / 360 unused days. Expired sources cannot be revived
  by a late citation or read. Same-day repeat feedback changes neither the usage clock nor counts.
- Ranking alone multiplies `R` by a bounded logarithmic reinforcement weight. Old cumulative
  usage counts never become reinforcements or affect selection. Optional new metadata is
  backward compatible; invalid numeric fields use finite fallbacks.
- Both collections have the same 256-source limit. Explicitly saved instructions and user
  preferences follow the same decay and capacity rules, with no permanent exemption.
- The common `MEMORY_RETENTION_POLICY` is appended to both consolidation prompts. Removal
  clears only claims and routing/index entries supported exclusively by removed sources;
  claims supported by surviving sources remain with updated citations. Old context must not
  recreate removed sources. Literal dangling references in the handbook, summary and optional
  ordinary-memory skills reject consolidation; surviving raw notes may legitimately describe
  historical filenames. Semantic cleanup still depends on the consolidation model.

Vivi's files and ledger remain separate from ordinary memory. Vivi obtains usage feedback
from requested source-note reads and excerpts that explicitly cite a source; ordinary memory
obtains it from reply citations. Search hits and automatic summary injection reinforce neither.

Codex keeps the folder in a git repository and gives the agent `phase2_workspace_diff.md`, the
diff from the last baseline; no changes means no agent. FastVibe cannot count on a `git`
binary, so it compares the folder with the baseline copy and writes the same file in the same
git style (a status list, then `diff --git` hunks, capped at 4 MiB). **A folder identical to
its baseline, with a valid `MEMORY.md` and summary, is not consolidated.** Anything else
— new recaps, a recap that was deleted, a conversation that moved on, or a user's own edit to
`MEMORY.md` — is in the diff, and the prompt calls every change in it authoritative.

The agent is a **throwaway in-memory session** with the memory folder as its workspace, given
Codex's `consolidation.md` plus the shared retention policy as its one user message, at medium reasoning (`pi/memory-agent.ts`).
Its tools are `read / edit / write / grep / find / ls`: no shell or extensions.
Ordinary memory retains its existing file-tool access; Vivi's isolated consolidation copy
uses a workspace-only file-tool boundary. No extensions means no memory read for
the thing that writes memory; ten-minute cap.

Afterwards the folder must hold a `MEMORY.md` that is a file and a `memory_summary.md` whose
first line is exactly `v1`, fits the shared 20,000-character budget, and contain no symlink (they are removed, as Codex does).
The prompt reserves at least half the summary for the routing index. An oversized result gets one
size-repair request in the same consolidation session, under the original time/cancellation budget. Otherwise
the pass reports an error, the baseline is **not** advanced, and ordinary memory restores the
complete file tree captured before that attempt. The next pass reconstructs the changed source
inputs against the same successful baseline and retries the same removal diff. A cancelled
attempt also restores that tree. This is recovery around in-place file edits, not a crash-safe
multi-file publication transaction; Vivi uses its separate locked journal publication.
Only a valid result becomes the new baseline.

## Read path

`memory.extension()` is a hidden extension of every conversation's session. On
`before_agent_start`, when memory is on and `memory_summary.md` exists, it keeps Codex's
`read_path.md` rules in the system prompt: the folder layout, when to use memory, a quick pass
of at most four to six lookups, "never update memories", and how to treat stale facts. The
summary itself is a hidden persisted context message with a 20,000-character budget (not a
token count). Summaries within budget are kept in full. Legacy oversized summaries share the
budget between profile, preferences, tips and the routing index, with extra weight for the index;
projects and days share its space instead of being dropped after a prefix cutoff. Complete
paragraphs/topics are kept where possible; a topic too large for its share becomes its complete
title plus a pointer to search `MEMORY.md`. An abridgement notice gives the full summary path
and permits range reads. A hash of the whole summary makes omitted-tail changes visible too.
A changed summary appends a new snapshot, preserving earlier request bytes; an unchanged one
adds nothing. Only the latest snapshot describes the current memory map.
The compaction-aware projection decides whether one already exists, so reloads and forks
deduplicate correctly and compaction can trigger reinjection. Turning memory off or losing
the summary filters all memory snapshots from subsequent requests; raw session history stays
append-only. There are no memory tools: the agent uses `read` and `grep`.

**Citations are the usage signal.** The prompt asks the agent to end a reply that used memory
with an `<oai-mem-citation>` block naming file ranges and the conversation ids (`rollout_ids`)
whose recaps it used. `noteReply` (called on every finished assistant message) reinforces an
unexpired source only when at least 24 hours have elapsed since generation or its last effective
reinforcement. Only a successful reinforcement increments `usageCount` and updates `lastUsage`,
`lastReinforcedAt` and `reinforcementCount`. All metadata survives a restart. The block
is for the pipeline: `stripMemoryCitation` (`shared/memory-citation.ts`) removes it, partial or
whole, from what the reader sees — in Main when a transcript is mapped, and in the renderer's
markdown view while a reply streams. (A phone, which draws a streamed reply itself, shows the
block until the reply is next loaded.)

## IPC

`memory:get-state`, `memory:set-config` (`{ enabled }`), `memory:run`, `memory:clear`, and the
push `memory:changed` (every change, to every client — the handlers do not broadcast for
themselves). All four are allowed remotely like the rest of settings. Delegated subagents load
no extensions, so they have no memory.

## Where this differs from Codex, on purpose or not yet

- **State** uses the shared database and in-process flags, without Codex's leases and global
  worker lock. Retention decay and bounded reinforcement are shared with Vivi rather than
  Codex's cumulative-use ordering and fixed unused window.
- **Triggers**: Codex starts a pass when a root session starts. FastVibe runs one on a timer, so
  it takes at most 2 conversations per pass but passes come every 15 minutes.
- **Stage-1 input** is rendered text, not Codex's serialized response items, and a tool result
  and a row are clipped as in Codex's tiered (v2) input rather than not at all.
- **No shell** for the consolidation agent (above), so Codex's `wc -l` / `rg` hints in the prompt
  were reworded; the diff is produced here rather than by git.
- **Not done**: per-chat control (`/memories`), keeping chats that used MCP or web search out of
  generation, the rate-limit guard, a separate model per stage, memory
  extensions (`extensions/`), and stage 1's strict output schema (the answer is parsed leniently).
- **Skills**: the agent may write `skills/<name>/SKILL.md` in the memory folder and the read
  prompt tells later agents to open them from `MEMORY.md`, but FastVibe does not register them
  as skills in the skill list.
- **Scope**: one store for the whole machine, like Codex's; the handbook records which cwd each
  entry applies to.
