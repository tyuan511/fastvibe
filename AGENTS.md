# FastVibe

Electron desktop client for agent work, code, office, and multi-agent cowork. The default engine is the embedded **`@earendil-works/pi-coding-agent` SDK** running in the Electron main process. Native pi state (`~/.pi`) is never used as the data root; FastVibe keeps everything under its own userData directory.

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
    reasoning.json       thinking-block start/end times Main timed from the live stream
    usage-ledger.jsonl   append-only record of finalized turns, so 使用统计 survives deletion
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

### File icons

File/folder glyphs come from **Material Icon Theme** (`material-icon-theme`, the
most-installed VS Code file icon pack), shared by the chat's per-turn change chips
and the future project file tree.

- `src/main/engine/file-icons.ts` reads the package's `material-icons.json` and
  serves the SVGs under the private `fastvibe-icon://icons/<name>.svg` scheme
  (registered privileged before app ready, `protocol.handle` after). Names the
  manifest references but that don't ship as files fall back to `file.svg`.
- `workspace:file-icons` hands the renderer the lookup tables once
  (`src/renderer/src/lib/file-icons.ts`, cached module-wide); `components/file-icon.tsx`
  resolves a name to an icon. Add `fastvibe-icon:` to the CSP `img-src` when a new
  surface loads these icons.
- The right pane's **文件** tab (`components/layout/side-pane-files.tsx`) is the
  consumer: a lazily-loaded project tree (`workspace:read-dir`, hiding `.git` and
  `node_modules`). Narrow panes swap between the tree and a file preview; when
  the pane is wide enough (`@min-[32rem]/files`) the preview sits on the left
  and the tree stays on the right. Clicking a file anywhere in a conversation
  routes through `openPreview` → `openFilePreview`, so it opens in this same
  view rather than a separate tab.

### Code highlighting

Syntax highlighting is **shikiji** (`src/renderer/src/lib/highlight.ts`), used by
both the markdown code fences and the file preview.

- The highlighter is created lazily (`getHighlighterCore`, wasm engine); grammars
  are code-split and loaded on demand, so only languages actually shown are fetched.
- Colors come from `createCssVariablesTheme`, mapped in `index.css` onto the app's
  `--code-*` tokens — every theme highlights correctly with no per-theme setup.
- `useHighlightedCode(code, language)` is the React entry point: it debounces (so a
  streaming fence is not re-tokenized per token) and caches by `(language, code)`.
- The wasm engine needs `'wasm-unsafe-eval'` in the CSP `script-src` (`index.html`).

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

### Type scale & interface size

- **Use Tailwind's own `text-*` utilities** (`text-xs` / `text-sm` / `text-base` /
  `text-xl` / `text-2xl`), never arbitrary `text-[13px]` values. shadcn Nova's
  primitives are authored against that same scale, so product code that invents
  its own sizes drifts away from the components it composes. Conversation text is
  `text-sm`: the message body **and** everything a tool call renders (the summary
  row, output/parameter blocks, diffs, thinking, todo and question cards) so the
  transcript reads at one size. `text-xs` is for chrome — timestamps, chips,
  badges, menus, dense stats.
- Sizes are **rem-based** and the root font size is a setting: 通用 → 外观 →
  界面字号 writes `--ui-root-font-size` inline on `<html>`, and `html { font-size:
  var(--ui-root-font-size, 16px) }` turns that one number into an interface-wide
  scale (`applyUiFontSize` in `themes.ts`, called from `useThemeSync` and before
  mount in `main.tsx`). At the 16px default the `text-sm` body is 14px. Fixed px
  sizes do **not** follow it — prefer Tailwind spacing/`rem` (e.g. `h-3.5`, `w-70`)
  over `h-[14px]` for anything that must scale.
- Two exceptions need px by nature: xterm's `fontSize` (derived from the resolved
  root size in `side-pane-terminal.tsx`) and container-query breakpoints, which are
  written in `rem` (`min-[27.5rem]`) so they track the setting too.

## Routing

`react-router` with **`HashRouter`** (wrapped in `src/renderer/src/main.tsx`). The
production renderer is loaded over `file://` via `window.loadFile`, so path-based
history has nothing to fall back to — a reload on `/settings/providers` would 404.

- `#/` — the workspace shell (sidebar + thread + composer). Always mounted.
- `#/c/<id>` — a conversation. Switching chats, new chats, and the sidebar's
  back/forward buttons walk this as real HashRouter history (mouse side buttons too).
- `#/settings/<section>` — a settings pane, rendered **over** the shell so app state
  survives. Sections come from `SETTINGS_SECTIONS` in `settings-dialog.tsx`
  (currently `general | shortcuts | archived | usage | providers | mcp | skills | extensions | about`);
  `App.tsx` derives the valid set from that export, so adding a pane needs no routing change.
  Section switches `replace`; opening settings pushes, so back returns to the chat.
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

**FastVibe defaults to the OpenAI Responses API** (`openai-responses`), and the
protocol is user-selectable — both on the provider (API 格式, which sets the default
for all its models) and per model (协议, in 模型详情). A model with no `api` of its own
inherits its provider's (that is what `models.json` omits), which is why a gateway can
serve a `/responses` model next to a `/chat/completions` one without being split into
two providers. `compat` is therefore emitted per model, derived from the api that
model will actually stream with.

`providers.json` carries a `version`. **v2 made the builtin protocol selectable**; in
v1 the code pinned it, so a v1 entry's `api` is the old default rather than a choice
and `normalizeFastVibe` migrates it (`PROVIDERS_VERSION`). The builtin's name and
baseUrl stay code-owned either way.

**Editing a provider never restarts the engine.** `PiProcessManager.reloadProviders()`
mutates the live `AuthStorage` (set/remove keys), rewrites `models.json`, then calls
`ModelRegistry.refresh()` on the *same* instance every session already holds, and
re-points each idle session at the refreshed `Model` object (`agent.state.model`,
quietly — a settings edit is not a user model switch and must not append a
`model_change` entry). A run that is still streaming keeps the config it started
under and is rebound on `agent_end`. Only a cold engine (`needsAuth`/`idle`) takes
the `start()` path. Do not reintroduce `stop()` + `start()` here: it disposed every
AgentSession, so a change in Settings → 供应商 aborted the reply in flight.

**Model parameters have a single source: the bundled models.dev snapshot.** There is
no hand-maintained catalog — context window, max output, input modalities, reasoning
efforts and list prices all come from models.dev (`loadModelsDev()` →
`enrichModel()`). Unknown ids keep conservative defaults (128K / 8K / text-only)
rather than being rejected. The provider's model list is a compact roster (name, a chip
if the protocol is pinned, the context size); clicking a row opens 模型详情, which
shows those parameters and lets the user tune name, protocol, context, max output,
推理 / 输入模态 and **思考强度**. A tuned model is marked `edited` so 同步模型
refreshes its metadata without reverting the edits.

**Thinking levels are the engine's, not models.dev's.** `THINKING_LEVELS`
(`@shared/types`) mirrors pi-ai's set:
`off | minimal | low | medium | high | xhigh | max`. models.dev's effort values map
onto it one-to-one (`models-dev.ts`), recording the provider value in `effortMap`
(pi's `thinkingLevelMap`) wherever the names differ.
**`off` is never offered.** The engine's set contains it, but asking an upstream to
*disable* thinking is rejected by models that reason by default, so no menu in the app
offers it (`THINKING_EFFORT_LEVELS` is what gets stored, tuned and listed) and
`settings.thinkingLevel: "off"` from an older build is dropped on load — 跟随模型默认
is the "leave the parameter alone" choice. `THINKING_LABELS.off` stays so the composer
can still name a session the engine reports as off (a non-reasoning model, a restored
transcript).
`renderModelsJson` then writes a `thinkingLevelMap` for any model the user tuned:
unchecked levels become `null` (the engine clamps instead of sending a rejected
parameter), `xhigh` and `max` always carry a mapping because pi only offers either
when mapped, and unchecking 推理 clears the list and writes `reasoning: false`.

Only `models.json` is written; the `models.yml` / `config.yml` pair from the old RPC
engine is gone because the SDK never read them.

## Plugins & extensions

FastVibe hosts pi extensions (the SDK's plugin system) and bridges their
terminal-only surface onto the GUI. Five **built-in** extensions ship with the app
(`resources/extensions/plan.ts`, `goal.ts`, `todo.ts`, `permission-sandbox.ts`, `session-title.ts`); anything else
the user installs at runtime via 设置 → 插件, which writes to the isolated `agentDir`
(`ExtensionManager` → SDK `DefaultPackageManager`), never `~/.pi`.

- **Built-ins** — `plan.ts` and `goal.ts` are FastVibe's own replacements for the
  `@narumitw/pi-plan-mode` / `pi-goal-x` packages (deliberately not bundled as
  dependencies). Only `/plan` and `/goal` are registered. `todo.ts` is always on
  (no slash command): the model replaces the whole list each call.
  `session-title.ts` is also always on: the first user prompt is summarised into
  a short title via a fire-and-forget `modelRegistry.complete` call, then
  `pi.setSessionName`. Manual sidebar renames set `titleManual` so they are not
  overwritten. Parallel runs and side chats name the session up front and are skipped.
  - **Plan** narrows the active tools to the read-only set (`read/grep/find/ls`)
    and, on each plan turn, appends a planning instruction on `before_agent_start`.
    Entering the mode lazily registers and enables a `question` tool (removed again
    on exit) so the agent can clarify ambiguous requirements before planning. It
    takes an array of questions and asks them in one panel (`questions` UI, see
    Dialogs) with ←/→ paging and a progress stepper; on hosts without that UI it
    degrades to one `ctx.ui.select` / `ctx.ui.input` panel per question (`问题 i/n`).
    It returns a structured `questions` payload the transcript renders as a Q&A card
    (`question-answers.tsx`, tool family `question`).
    When the turn ends the extension asks `ctx.ui.confirm` — confirming restores the
    tools and sends the plan back as the execution prompt, declining collects
    feedback via `ctx.ui.input` and regenerates. It publishes the `plan-mode` status,
    which the renderer shows as a badge beside the composer's permission control
    (`ExtensionStatusBadges`); the badge's close button dispatches `/plan` to exit.
  - **Goal** runs a long-term execution loop: every turn is instructed to compare
    progress against the objective and take on that round's tasks, and `agent_end`
    sends a continuation until the model ends with a lone `GOAL_COMPLETE` line
    (stripped on `message_end`) or the round cap pauses it. Its state travels as a
    JSON `goal` status that the renderer turns into the control panel above the
    composer (`GoalPanel`: view / pause / resume / clear). A bare `/goal` (picked
    from the palette without an objective) only arms the mode: it publishes a
    `goal-armed` status that the composer shows as a badge next to plan mode's, and
    the objective is taken from the user's next message in `before_agent_start`.
  - **Todo** is Claude Code's TodoWrite as a pi tool (`todo`). The model submits
    the complete list every time (`pending` / `in_progress` / `completed` /
    `cancelled`; at most one `in_progress`). State is stored in tool-result
    `details` and reconstructed on `session_start` / `session_tree`, so a branch
    sees the list from that point in history. Unfinished items are injected on
    `before_agent_start` so they survive compaction. The transcript already
    renders a tool named `todo` as a checklist card; `TodoPanel` above the
    composer reads `latestTodos` from the thread and hides once every item is
    done or cancelled. The sandbox treats `todo` as read-only, so `ask` mode
    does not confirm it.
- **Permission sandbox** — `permission-sandbox.ts` is the enforcement half of the
  composer's three modes (`ask` 请求批准 / `smart` 帮我批准 / `full` 完全访问权限).
  It hooks `tool_call`, classifies each call (network rules, out-of-workspace
  writes, sensitive paths, destructive shell patterns) and asks through
  `ctx.ui.confirm`, which the host renders as the inline `PermissionPanel` (a
  numbered listbox that takes over the composer slot — not a modal). `full` never asks.
  The mode reaches it through the `FASTVIBE_PERMISSION_MODE` env var, which
  `applyPermissionMode` (`engine/app-settings.ts`) syncs from `settings.json` at
  startup and on every settings write; the extension re-reads it per tool call, so a
  mode change lands in a running session. It is a standalone jiti module, so it
  reads no FastVibe internals — keep new rules in the file itself.
- **Loading** — `src/main/pi/extension-manager.ts` resolves the built-in entry
  points (from `resources/extensions` in dev, `resourcesPath/extensions` packaged;
  `electron-builder.yml` copies them via `extraResources`) and `#createSession`
  passes them through a per-session `DefaultResourceLoader`
  (`additionalExtensionPaths`). `pnpm-workspace.yaml` pins `@earendil-works/pi-tui`
  to the SDK's version so host and plugins share one instance. Packaged builds set
  `JITI_FS_CACHE=false` because jiti cannot write its cache inside the asar.
- **Mode** — `bindExtensions` binds `mode: "rpc"` (not the default `"print"`).
  TUI-first plugins gate on `ctx.mode`, and `"print"` makes them refuse to run;
  `rpc` also makes them fall back to string widgets / select-editor dialogs.
- **Dialogs** — `select/confirm/input/editor` flow through `extension_ui_request`
  / `respondPermission`, and FastVibe adds a non-SDK `questions` method to the UI
  context (`#extensionUi` → `FastVibeExtensionUIContext`) for single-panel
  multi-question prompts; `questions` answers ride `respondPermission.answers`.
  `confirm` (approve a tool), `select` (pick an option), `input` (free-form answer)
  and `questions` (multi-question, paged) render as the inline `PermissionPanel` in the composer
  slot — the agent's questions and the sandbox's approvals share one panel; only
  `editor` (multi-line prefill) keeps the modal `PermissionDialog`.
- **Fire-and-forget UI** — `notify`, `setStatus`, `setWidget` (string lines) and
  `set_editor_text` reach the renderer store and render as toasts, a status row, a
  panel above the composer, and composer prefill (`ExtensionWidgets`,
  `ExtensionNotices`).
- **TUI components → GUI** — `src/main/pi/tui-bridge.ts` renders pi-tui components
  produced by plugins: component-factory widgets (`setWidget(factory)`, re-rendered
  every second with change detection) and `registerMessageRenderer` output. ANSI SGR
  is parsed back into structured runs; known pi theme color names are folded back to
  names and mapped to the app's semantic tokens in `components/chat/tui-lines.tsx`.
  Hidden custom messages (`display: false`) are dropped.
- **Session replacement** — extension `ctx.newSession` / `ctx.switchSession` are
  implemented on the conversation catalog; `#extensionNewSession` seeds the manager
  via the plugin's `setup`, creates a new conversation, activates it and emits
  `conversation_opened`, then runs `withSession` against the replacement.

### TODO: remaining TUI→GUI gaps

Deliberately deferred. Plugin authors are expected to degrade via `ctx.mode` /
`ctx.hasUI`, and the built-in plugins do not need these, but a fully general
"install any plugin and it just works" host still needs them:

1. **`registerShortcut`** — keyboard shortcuts are ignored. Needs the registered
   shortcuts exposed over IPC plus a renderer key dispatcher that invokes the
   handler (e.g. a plugin's dashboard toggle or audit shortcut).
2. **`registerEntryRenderer`** — display-only custom entries (`pi.appendEntry`) are
   not merged into the transcript. The thread is built from `session.messages`, which
   excludes non-context entries; showing them needs an ordered walk of
   `sessionManager.getEntries()` interleaved with the context messages.
3. **`ctx.ui.custom()`** — full-screen interactive components still return
   `undefined`. Bridging needs an ANSI screen plus key forwarding; xterm/node-pty are
   already dependencies.
4. **`registerMarkdownTransformer`, `setEditorComponent`, `addAutocompleteProvider`,
   theme selection** — no-ops.

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
  `[id, name, context, output, inputMask, efforts|null, cost|null]` tuples and `x` maps
  every normalized alias to an index, so runtime lookup is one `Map` hit (O(1)).
  `v: 2` added `cost`, `v: 3` the price ladder, `v: 4` dropped the feature bitmask the
  UI no longer records. Older snapshots still decode — a v1 tuple just ends after
  `efforts`, and the decoder reads the price slot by version so a stale bundled index
  loses detail instead of misreading a retired field as prices.
- `cost` is `[input, output, cacheRead, cacheWrite, tiers?]` per million tokens, `null`
  when the catalog has no non-zero price; `tiers` is the long-context ladder,
  `[[over, input, output, cacheRead, cacheWrite], …]` ascending, and absent for the
  majority of models that charge one flat rate. `context_over_200k` is the older
  single-threshold spelling and is only consulted when a model has no `tiers`. A tier
  row that omits a field (`cache_write` on most Anthropic models) keeps the entry price
  for that field rather than reading as free.
- `scoreOf` weights capability double and uses the ladder as a last tie-break, so a
  reseller that copied the base rate cannot displace the vendor entry that also knows
  the ladder — the ladder only exists on the entry that can price a long request.
  Where two entries still differ on price, models.dev lists the same model under many
  resellers and the winner is whichever scores highest, so a base price is a
  best-effort guess rather than a statement about the user's gateway.
- Prices are not display-only. `cost` is written to `models.json`, where pi's
  `calculateCost` multiplies it by the turn's tokens; the ladder cannot be expressed
  there (pi prices a run with one rate), so `src/main/engine/pricing.ts` picks the tier
  from the request's prompt size whenever FastVibe reports money itself — the live
  composer stat and 统计 — and `models.json` keeps the entry rate.
- Prices are never user-editable, so `hydrateModels` back-fills `cost`/`costTiers` from
  the bundled catalog for any model that has none. Without that, a `providers.json`
  written before pricing existed leaves `models.json` with no price and every turn is
  billed at $0.
- `src/main/engine/models-dev.ts` reads only the bundled snapshot. No network access at
  runtime. `normalizeModelKey` must stay identical to `normalize` in the sync script.
- Resolution order: `process.resourcesPath/models-dev/index.json` then
  `resources/models-dev/index.json`. Packaging must copy the directory via
  `extraResources`. If the snapshot is missing, models fall back to defaults
  (128K context / 8192 output / text-only) and the settings About page shows it as missing.
- Run `pnpm sync:models -- --force` before a release to refresh the snapshot.

## Usage statistics (使用统计)

Settings → 使用统计 (`components/settings/usage-settings.tsx`) is fed by
`collectUsageStats` (`src/main/engine/usage-stats.ts`) over the `stats:usage` channel.

- **Two sources, one union.** The pane is rebuilt from the engine's session
  transcripts, *plus* `usage-ledger.jsonl`. Deleting a conversation unlinks its
  transcript (`PiProcessManager.deleteConversation`), which used to silently rewrite
  history; the ledger is what keeps it. A live transcript is the primary source and the
  ledger only adds turns whose file is gone; the two are deduplicated by
  `sessionId` + entry id (`turnKey`). Branching is safe because FastVibe branches in
  place (`navigateTree`) and never calls the SDK's `createBranchedSession`, so a session
  id — and therefore the key — is stable.
- **The ledger stores raw usage, never a price.** `UsageLedger` (`usage-ledger.ts`)
  appends one line per finalized assistant turn (tokens, model, engine-reported cost,
  timestamp, tool-call count) as the turn lands, and `capture()` folds a whole
  transcript in before it is unlinked (pre-ledger history included). `usage-stats.ts`
  re-prices every turn at read time against the *current* price table, so a provider
  edit re-prices the ledger and the transcripts alike; storing a price would freeze it.
- **The ledger is a supplement, not the source of truth.** Tokens and cost are always
  recomputed from raw fields, and `parseSessionTurns` is memoised on `mtimeMs` + `size`.
  If the ledger is missing or corrupt, statistics simply fall back to the transcripts —
  they are never *less* correct than before, only less complete after a deletion.
- Appends are synchronous (one line per turn) so a capture that precedes an `unlink` is
  durable before the file disappears; `flush()` is a no-op kept for the shutdown path.

## Product constraints

- Code / Office / Cowork are first-class; pi-coding-agent is the default backend.
- Office and extra ACP agents come later; keep Host adapters (RPC/ACP) decoupled from the renderer.
- Built-in model provider is **fastvibe** (`https://fastvibe.dev/v1`). The user pastes an API key; FastVibe fetches `/models`, writes isolated `models.json`, then starts the embedded engine. Do not mention the backend runtime in the UI.
