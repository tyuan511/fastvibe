# Notice

`stage_one_system.md`, `stage_one_input.md`, `consolidation.md` and `read_path.md` are adapted from the
memory prompt templates of OpenAI Codex (https://github.com/openai/codex), licensed under the Apache License,
Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

- `stage_one_system.md`, `stage_one_input.md`: `codex-rs/memories/write/templates/memories/` at commit
  `a9b0815167c27ab13719dd12d13b63e02b70d221`, unchanged.
- `consolidation.md`: the same directory and commit. Changed: the memory-extension placeholders were removed; the
  git-repository paragraph and two shell hints (`wc -l`, `rg --files`) were reworded for FastVibe, which keeps a
  baseline copy of the folder instead of a git repository and gives the agent no shell; "Codex" became "FastVibe".
- `read_path.md`: `codex-rs/core/templates/memories/read_path.md` at tag `rust-v0.120.0` (the last release that ships
  it as a standalone file). Changed: the description of the rollout transcript format, which is pi's session format here.

The templates are instructions to a model and are read at run time (`src/main/engine/memory-templates.ts`).
