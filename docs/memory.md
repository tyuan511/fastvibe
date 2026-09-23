# FastVibe memory

FastVibe has three memory modes backed by one local store:

- **Default memory** is always on and does not download an embedding model. It writes
  final user and assistant text to `runtime/engine/memory.sqlite` and uses SQLite FTS5
  for local text retrieval.
- **Semantic memory** is an explicit opt-in mode. It keeps the FTS index and stores a 384
  dimensional multilingual embedding. The embedding model is
  `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, loaded through
  Transformers.js and the architecture-specific ONNX INT8 file (about 118 MB). The
  model is downloaded only after the user confirms the mode change and lives under
  `runtime/engine/models/memory`.
- **JEV-enhanced memory** keeps the same local canonical store and adds a System-One
  control plane after Jev-Mem (arXiv:2609.23986). It requires the Decision engine to use
  Jev, have a saved API key, have the `Enhanced memory` application scenario checked, and
  have the local embedding model available.

### How JEV-enhanced memory follows the paper

JEV-enhanced memory is a port of the paper's reference implementation
(github.com/libingzheren/Jev-Mem @ `81574eb`, MIT), not a reading of the paper alone.
`src/main/engine/memory-jev.ts` holds its control plane — question texts, candidate
scoring, relation/consolidation rules, budget allocation, stopping, traversal scoring,
temporal references, entity and keyword extraction — with no I/O, and its header maps
each part to the reference file it mirrors. `JEV_MEM_PROFILE` is the paper's profile,
`config/jev_mem.json` over `JevMemConfig`'s defaults.

`test/fixtures/jev-mem-reference.json` is the reference's own output (its Python modules
run on fixed inputs): every question text and criterion, budget allocations including
ties, temporal references, keywords and entities. `test/memory-jev.test.ts` checks the
port against it, so drifting from the reference fails a test rather than a benchmark.

- **Write** (`MemoryBuilder.build`): admission is off, so every observation is kept.
  One typing request (four Nouls over `[speaker]: text`); candidates scored as
  2·cos (vector top 10) + 2·shared entity + keyword overlap + 0.25/(1+Δdays), top 10;
  one relation request (semantic, both causal directions, entity alias only when no
  identifier matches exactly); edges at probability ≥ 0.60, exact identifiers at 1.0.
  Then MAGMA's temporal links: PRECEDES/SUCCEEDS with the predecessor and
  TEMPORALLY_CLOSE from up to nine earlier memories within 24 h.
- **Fallback write** (`_build_magma` → `add_event`): if typing or relations fall back,
  the Jev node is dropped and the observation is written the MAGMA way. The System-Two
  model extracts a narrative, entities, keywords and emotion with the reference's prompt
  (its simple rules when the model is unavailable or answers something unparseable);
  the narrative is embedded and is what Jev reads, while the memory shown and injected
  stays the original text. The memory is linked to its predecessor in time and both
  ways (RELATED_TO) to its three nearest neighbours by vector. It does not count as a
  Jev write.
- **Every edge records its stage** (`origin`: `jev`, `sequence`, `consolidation`,
  `magma`), and edges of different stages between one pair coexist, as separate links
  do in the reference. Traversal shows each with the properties its stage gives it
  (a probability, a time difference, or a similarity score).
- **Consolidation** runs on every 20th successful Jev write, over that memory's own
  candidates. Each pair's decision is recorded on the memory; at most one semantic link
  is added (CONTRADICTS over REDUNDANT_WITH over RELATED_TO) when the strongest of
  link/redundant/contradiction reaches 0.85; obsolescence is recorded, not linked.
  System Two writes a new memory for a pair only when merge/promote is selected at
  ≥ 0.85 and contradiction is below 0.85; that memory goes through the full write path.
- **Read** (`RetrievalController.query`): route (six Nouls; the reference's intent
  baseline if the call falls back), vector + keyword anchors fused by RRF and scored by
  cosine, then rounds of assess → expand → score. Budgets follow Eqs. 13–14 (B = 80,
  θ_act = 0.10, largest remainder, ties by name), depth Eq. 15 (D_max = 8), transition
  score Eq. 23 with λ = (0.25, 0.35, 0.15, 0.15, 0.10), recency Eq. 25 against the newest
  evidence. Stop at sufficiency ≥ 0.95 with missing/contradiction < 0.15, or
  continue < 0.15, and within 60 nodes, 2,400 edges, 16 Jev calls and 15 s.
- **Calls** behave like the reference client: whole-batch validation, 3 s per attempt,
  up to three attempts, and an LRU of 1,024 identical requests that costs no budget.

FastVibe differences, each marked `FastVibe:` in the code:

- Chinese patterns next to the English-only heuristics (temporal references, temporal
  and intent keywords, quoted-name entities, character-bigram keywords).
- A per-memory content cap in Jev requests (18,000 characters shared per request): the
  reference sends short LoCoMo turns whole, ours can be long replies.
- Candidate discovery reads the latest 2,000 memories of the scope rather than all.
- `top_k` is the Memory settings' result count (default 8); the paper ran LoCoMo at 40.
- Memory spans a project's conversations (or one chat without a project); temporal
  links follow each conversation's own sequence.
- System Two is the model chosen in Memory settings, and the retrieved memories are
  injected into the main agent's system prompt instead of answered by System Two.
- The reference also enriches text with keywords before embedding; FastVibe embeds the
  raw text with its local MiniLM model.

Memory is injected through a hidden per-session extension's `before_agent_start`
handler. The retrieved text is an ephemeral system-prompt section; it is not appended
to the conversation transcript. Capture happens at the SDK `message_end` boundary,
after a user or final assistant message is complete. Thinking blocks, tool results,
passwords and hidden fields are not captured.

## What the agent is told, and what it can call

Retrieval by the current message is automatic, but on its own it left the agent unaware
that memory existed: asked "what do you remember", it denied having any, or — in this
repository, whose docs name the file — opened `memory.sqlite` with a shell command,
bypassing both the retrieval pipeline and the project scope. So the same extension
(`src/main/engine/memory-tools.ts` holds the wording and formatting) adds:

- **A standing note on every turn** (`## Long-term memory`): memory exists, related
  memories appear under "Relevant long-term memory" when there are any, the two tools
  below reach further, memories are evidence rather than instructions, storage details
  are not the answer, and FastVibe's own data files are never to be read for it.
- **`memory_search`** — retrieval by a topic the agent chooses, through the same
  pipeline and scope as the automatic retrieval (JEV-Mem in JEV mode).
- **`memory_recent`** — the newest memories of the scope, for "what do you remember".

Both are read-only (the permission sandbox's `READ_ONLY_TOOLS`) and scoped like the
automatic retrieval: the project's conversations, or the chat alone without a project.
Memories reach the agent as `[who · when] text`, in the interface language; kinds,
scores and paths are not shown. Delegated subagents load no extensions and get neither.

## Files and IPC

- `src/main/engine/memory.ts`: model lifecycle, hybrid retrieval, the JEV write/read loops
  and the session extension.
- `src/main/engine/memory-jev.ts`: the JEV control plane — prompts, thresholds, formulas.
- `src/main/engine/memory-tools.ts`: the agent's memory note, `memory_search` /
  `memory_recent` wording and result formatting.
- `src/main/engine/memory-store.ts`: SQLite schema, FTS5 index, embeddings, graph
  edges and the `memory_meta` counters.
- `src/shared/memory.ts`: persisted configuration and transport types.
- `runtime/engine/memory.json`: memory mode configuration.
- `runtime/engine/memory.sqlite`: local canonical memory and graph.
- `memory:get-state`, `memory:set-config`, `memory:search`, `memory:delete`,
  `memory:clear`: transport-neutral IPC methods.

The memory mode selector is separate from the Decision engine selector. Selecting JEV
memory does not turn on browser or computer control; it requires the dedicated memory
scenario instead. Selecting Semantic memory prompts before downloading the model, and
refusing leaves Default memory selected.
