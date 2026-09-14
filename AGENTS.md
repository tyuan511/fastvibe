# FastVibe

Electron desktop client for agent work, code, office, and multi-agent cowork. The default engine is the embedded **`@mariozechner/pi-coding-agent` SDK** running in the Electron main process. Native `~/.pi`/`~/.omp` state is never used as the data root.

## Architecture

```
src/main/          Electron main: window, IPC, and embedded agent lifecycle
  omp/             Isolated runtime paths, provider configuration, and shared model/file helpers
  pi/              Embedded pi-coding-agent host, MCP bridge, and multi-session lifecycle
src/preload/       contextBridge API (`window.fastvibe`)
src/renderer/      React UI (Vite renderer)
  src/components/ui/   shadcn-generated primitives only
  src/components/      product composition (chat, layout)
src/shared/        IPC channels and types used by main + renderer
```

Runtime data lives under the app userData directory:

```
~/Library/Application Support/FastVibe/runtime/omp/
  agent/sessions     PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR
  wt                 OMP_WORKTREE_DIR
```

Provider credentials are kept in FastVibe's isolated runtime and injected into the SDK's in-memory auth storage. Do not export these variables into the user's login shell or the in-app terminal.

## UI: shadcn Nova

- Style: **`base-nova`** (latest Nova on Base UI). Configured in `components.json`.
- Package manager is **pnpm**. Install and update primitives **only** via:

  ```bash
  pnpm shadcn add <component> -y
  ```

- Do **not** hand-write files under `src/renderer/src/components/ui/`. If a primitive already exists in shadcn (Button, Input, Textarea, Badge, Message, Bubble, Empty, Item, Alert, …), add it with the CLI and compose it.
- Product screens (chat thread, workspace chrome, tool cards) live outside `components/ui/` and **compose** shadcn primitives. Custom markup is allowed only when shadcn has no matching primitive.
- Wrap the tree with `TooltipProvider`. Keep `html` in light mode (no `dark` class).
- `vite.config.ts` exists so the shadcn CLI can detect Vite. The Electron app builds through `electron.vite.config.ts`.

## Commands

```bash
pnpm sync:models  # rebuild the bundled models.dev index from upstream
pnpm dev          # sync models.dev if needed, then electron-vite
pnpm typecheck
pnpm shadcn add <component> -y
```

## Model metadata (models.dev)

- `scripts/sync-models-dev.mjs` downloads `https://models.dev/api.json` and emits a
  lookup-optimised snapshot to `resources/models-dev/index.json` (gitignored, generated).
  The upstream catalog is ~4.5 MB; the snapshot is ~0.4 MB.
- The snapshot is `{ v, t, s, c, m, x }`: `m` is unique models as
  `[id, name, context, output, inputMask, efforts|null]` tuples and `x` maps every
  normalized alias to an index, so runtime lookup is one `Map` hit (O(1)).
- `src/main/omp/models-dev.ts` reads only the bundled snapshot. No network access at
  runtime. `normalizeModelKey` must stay identical to `normalize` in the sync script.
- Resolution order: `process.resourcesPath/models-dev/index.json` then
  `resources/models-dev/index.json`. Packaging must copy the directory via
  `extraResources`. If the snapshot is missing, models fall back to defaults
  (128K context / 8192 output / text-only) and the settings About page shows it as missing.
- Run `pnpm sync:models -- --force` before a release to refresh the snapshot.

## Product constraints

- Code / Office / Cowork are first-class; pi-coding-agent is the default backend.
- Office and extra ACP agents come later; keep Host adapters (RPC/ACP) decoupled from the renderer.
- Built-in model provider is **fastvibe** (`https://fastvibe.dev/v1`). The user pastes an API key; FastVibe fetches `/models`, writes isolated `models.json` plus compatibility YAML, then starts the embedded engine. Do not mention the backend runtime in the UI.
