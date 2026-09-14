# FastVibe

Electron desktop client for agent work, code, office, and multi-agent cowork. The default engine is the embedded **`@mariozechner/pi-coding-agent` SDK** running in the Electron main process. Native pi state (`~/.pi`) is never used as the data root; FastVibe keeps everything under its own userData directory.

## Architecture

```
src/main/          Electron main: window, IPC, and embedded agent lifecycle
  engine/          Isolated runtime paths, provider configuration, and shared model/file helpers
  pi/              Embedded pi-coding-agent host, MCP bridge, and multi-session lifecycle
src/preload/       contextBridge API (`window.fastvibe`)
src/renderer/      React UI (Vite renderer)
  src/components/ui/   shadcn-generated primitives only
  src/components/      product composition (chat, layout)
src/shared/        IPC channels and types used by main + renderer
```

Runtime data lives under the app userData directory:

```
~/Library/Application Support/FastVibe/
  settings.json          UI prefs (theme, chat behaviour) — not localStorage
  conversations.json
  providers.json
  mcp.json
  runtime/engine/
    agent/sessions       session transcripts, passed to the SDK's SessionManager
    wt                   git worktrees for isolated conversations
    scratch              workspace for conversations not bound to a project
```

Paths are handed to `createAgentSession` programmatically (`agentDir`, `sessionManager`,
`settingsManager`) rather than through environment variables. Agent IPC channels use the
`engine:` prefix (`src/shared/ipc.ts`), exposed to the renderer as `window.fastvibe.engine`.

Provider credentials are kept in FastVibe's isolated runtime and injected into the SDK's in-memory auth storage. Do not export these variables into the user's login shell or the in-app terminal.

## UI: shadcn Nova

- Style: **`base-nova`** (latest Nova on Base UI). Configured in `components.json`.
- Package manager is **pnpm**. Install and update primitives **only** via:

  ```bash
  pnpm shadcn add <component> -y
  ```

- Do **not** hand-write files under `src/renderer/src/components/ui/`. If a primitive already exists in shadcn (Button, Input, Textarea, Badge, Message, Bubble, Empty, Item, Alert, …), add it with the CLI and compose it.
- Product screens (chat thread, workspace chrome, tool cards) live outside `components/ui/` and **compose** shadcn primitives. Custom markup is allowed only when shadcn has no matching primitive.
- Wrap the tree with `TooltipProvider`.
- `vite.config.ts` exists so the shadcn CLI can detect Vite. The Electron app builds through `electron.vite.config.ts`.

## Theming

The app ships light **and** dark themes; never assume light.

- `src/renderer/src/lib/themes.ts` is the single source of truth. It holds twenty
  first-party themes (ten light, ten dark) modelled on the most-installed VS
  Code themes — GitHub, One Dark Pro, Dracula, Tokyo Night, Catppuccin, Nord,
  Night Owl, Gruvbox, Monokai, Rosé Pine, Ayu, Everforest, Solarized, Quiet Light.
  Each theme is a compact `ThemeSeed`; `buildTokens` derives the full
  shadcn / Base UI token set from it (`--background`, `--primary`, `--sidebar-*`,
  `--warning/--success/--info`, `--code-*`, …).
- `applyTheme` writes every token as an **inline** custom property on `<html>` and
  toggles the `dark` class. Inline properties outrank the `.dark` fallback block in
  `index.css`; the `dark` class keeps Tailwind `dark:` variants working. `App.tsx`
  calls `useThemeSync()` to apply the store live and to follow the OS while
  `themeMode` is `"system"`.
- Light and dark are chosen independently: `settings.lightTheme` / `settings.darkTheme`,
  with `settings.themeMode` (`light | dark | system`) picking the active one. The
  pickers live in Settings → 通用 → 外观 (`components/settings/theme-select.tsx`).
- **Never hardcode palette colours** in product code. Use semantic utilities
  (`bg-background`, `text-muted-foreground`, `border-border`, `text-warning`, …) so
  every theme works. `bg-white` is only acceptable for surfaces that are meant to be
  paper (rendered HTML/PDF previews).
- To add a theme, append a `ThemeSeed` to `SEEDS` in `themes.ts` and list its id in
  `LIGHT_THEME_IDS` / `DARK_THEME_IDS`. No CSS changes required.

## Routing

`react-router` with **`HashRouter`** (wrapped in `src/renderer/src/main.tsx`). The
production renderer is loaded over `file://` via `window.loadFile`, so path-based
history has nothing to fall back to — a reload on `/settings/providers` would 404.

- `#/` — the workspace shell (sidebar + thread + composer). Always mounted.
- `#/settings/<section>` — a settings pane, rendered **over** the shell so app state
  survives. Sections come from `SETTINGS_SECTIONS` in `settings-dialog.tsx`
  (currently `general | chat | usage | providers | mcp | skills | about`); `App.tsx` derives
  the valid set from that export, so adding a pane needs no routing change.
- Unknown or missing sections normalise to `#/settings/general` via a redirect effect
  in `App.tsx`.
- To deep-link into a pane, `navigate("/settings/providers")`. The composer's
  「添加模型 / 管理模型」 entry uses this to reach provider configuration.

## Providers

FastVibe (`https://fastvibe.dev/v1`) is **one provider among others**, not a forced
onboarding gate. There is no connect wall: an unconfigured engine reports
`needsAuth`, the chat surface stays usable, and the composer's model menu links to
Settings → 供应商. Users can equally add any OpenAI-compatible provider there.

A provider ships **no models** until the user connects it: configuring a provider
fetches its `/models` list and the user picks which to keep. A provider without an
API key is excluded from `models.json` entirely, so no models surface anywhere.

**Model parameters have a single source: the bundled models.dev snapshot.** There is
no hand-maintained catalog and no per-model editing UI — context window, max output,
input modalities and reasoning efforts all come from models.dev (`loadModelsDev()` →
`enrichModel()`). Unknown ids keep conservative defaults (128K / 8K / text-only)
rather than being rejected. Only `models.json` is written; the `models.yml` /
`config.yml` pair from the old RPC engine is gone because the SDK never read them.

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
- `src/main/engine/models-dev.ts` reads only the bundled snapshot. No network access at
  runtime. `normalizeModelKey` must stay identical to `normalize` in the sync script.
- Resolution order: `process.resourcesPath/models-dev/index.json` then
  `resources/models-dev/index.json`. Packaging must copy the directory via
  `extraResources`. If the snapshot is missing, models fall back to defaults
  (128K context / 8192 output / text-only) and the settings About page shows it as missing.
- Run `pnpm sync:models -- --force` before a release to refresh the snapshot.

## Product constraints

- Code / Office / Cowork are first-class; pi-coding-agent is the default backend.
- Office and extra ACP agents come later; keep Host adapters (RPC/ACP) decoupled from the renderer.
- Built-in model provider is **fastvibe** (`https://fastvibe.dev/v1`). The user pastes an API key; FastVibe fetches `/models`, writes isolated `models.json`, then starts the embedded engine. Do not mention the backend runtime in the UI.
