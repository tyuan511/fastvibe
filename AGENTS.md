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
  (currently `general | shortcuts | archived | usage | providers | mcp | skills | extensions | import | about`);
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

**The model and thinking chips work on the empty hero too.** There is no conversation
for the engine to bind the choice to until the first prompt, so `setModel` /
`setThinkingLevel` hold it on the manager (`#pendingModel` / `#pendingThinking`) and
return a draft `EngineSessionState` — `getState()` reports the same instead of failing
with 「no active conversation」, and `#applyPreferredModel` adopts the pick into the next
session created (before the pinned 「默认模型」, which it still falls back to). A pick made
while no conversation exists is dropped as soon as one is activated.

**Nothing on the first-run path is an error.** A fresh install has no conversation and
possibly no provider, and that is a state the composer has to work *in* rather than
fail in: the model chip reads 「添加模型」 while nothing is configured, and a send with
no model refuses the prompt — keeping the draft — and points at 设置 → 供应商, instead of
creating a conversation the engine would then refuse to run. Once a provider is
connected a send needs no extra step: the new session resolves its own model
(`findInitialModel`), and every session-scoped choice that could be made before a
conversation existed (the model/thinking chips, 自动压缩 read in `#createSession`) is
adopted by the session that appears.

**A switch is drawn in the transcript as a divider only where the new model actually
runs** — a quiet rule reading 「模型已切换至 provider/model」, naming the model the reply
came from rather than the pair it moved between. Picking a model is not using one: the
SDK writes a `model_change` entry the instant the pick is made, so drawing from the
entry alone put a divider on the screen for a switch that no reply had run on yet (or
one reverted before the next prompt). The divider is therefore tied to the reply:

- It is a **`{ kind: "model" }` MessagePart, not a row**. Consecutive engine messages
  of one reply are merged into a single row, so a switch made while a reply was
  streaming belongs *between that reply's parts* — a row of its own would split the
  merged run into two blocks (and two footers).
- `#announceModelUse` (`src/main/pi/process-manager.ts`) emits `model_changed` from the
  assistant `message_start` whose `provider`/`model` differs from the last assistant
  message already in the transcript, so the part is spliced in live as the new model
  starts answering, at the part index the engine's current message began at —
  `apply-engine-event.ts` tracks it as `partBoundary` (`stores/session.ts`). Picking A,
  then B, then A again before sending announces nothing, and `#useModel` itself no
  longer emits anything (nor does the renderer re-read the transcript after a pick).
- `#insertModelSwitches` derives the dividers from the **replies**, not from the
  `model_change` entries: it walks `sessionManager.getBranch()` and inserts one at the
  start of every assistant message whose `provider`/`model` differs from the previous
  assistant message's — the same slot the live event uses, so a reload and the stream
  agree. The entry alone cannot say this: it is anchored to the last completed message,
  which during a run sits *before* the reply still streaming, so a switch made mid-run
  would appear one round-trip early. A pick that no reply followed draws nothing, and
  so does `A→B→A` before sending — no reply ever ran on B. Re-picking the model already
  selected returns early, and a provider edit's forced fallback model goes through the
  same path (it *is* a switch the user did not ask for, announced when the next reply
  runs on it).
- A leading divider stays **outside** 折叠运行过程's fold (`foldHead` in
  `components/chat/message-list.tsx`): which model answered is not process, and hiding
  it inside 「用时 …」 buries the one fact the divider exists to state. A divider spliced
  mid-run does still fold with the rest of the run it sits in.

Only `models.json` is written; the `models.yml` / `config.yml` pair from the old RPC
engine is gone because the SDK never read them.

## Plugins & extensions

FastVibe hosts pi extensions (the SDK's plugin system) and bridges their
terminal-only surface onto the GUI. Eight **built-in** extensions ship with the app
(`resources/extensions/plan.ts`, `goal.ts`, `todo.ts`, `permission-sandbox.ts`, `session-title.ts`,
`browser-use.ts`, `web-search.ts`, `subagent/index.ts`); anything else
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
    composer reads `latestTodos` from the thread. It is folded by default — one
    header line carrying the position in the list and the single in-progress item
    (else the next pending one), with the whole checklist (`TodoRow compact`, one
    line per item, capped and scrollable) behind a `Collapsible`.
    - **Only while the chat is working.** The panel is hidden unless
      `useConversationWorking()` (`stores/session.ts`) says this conversation is
      busy, and equally once every item is done or cancelled. An unfinished list is
      not news after the run that was working through it stopped; it would sit above
      the composer with a busy mark, claiming work that is not happening. The plan is
      still in the transcript's todo card, one collapsed row away.
    - **Busy marks follow the run.** The header's leading glyph and the leading glyph
      of the item `in_progress` are `RunningMark` (`components/running-mark.tsx`) —
      the same sweeping-arc mark the sidebar puts on a running conversation, shared so
      "a run is in flight" reads identically — but only while that conversation is
      working. Idle, a stalled item falls back to the plain circle (`StatusIcon`), in
      the panel and in the transcript card alike (the card reads the same flag through
      `TodoChecklist`): a stopped chat must not keep spinning.
    - **The `n/N` badge counts position, not completions.** `todoPosition` / `activeTodo`
      (`lib/todos.ts`) name *which* step the agent is on — `1/N` from the first moment,
      rather than sitting at `0/N` until that step closes. The completed count stays
      reachable as the badge's `title`. The tool card's row (`tool-presentation.tsx`)
      uses the same helpers, so the transcript and the panel cannot drift apart. The sandbox treats `todo` as read-only, so `ask` mode
    does not confirm it.
- **Permission sandbox** — `permission-sandbox.ts` is the enforcement half of the
  composer's three modes (`ask` 请求批准 / `smart` 帮我批准 / `full` 完全访问).
  It hooks `tool_call`, classifies each call (network rules, out-of-workspace
  writes, sensitive paths, destructive shell patterns) and asks through
  `ctx.ui.confirm`, which the host renders as the inline `PermissionPanel` (a
  numbered listbox that takes over the composer slot — not a modal). `full` never asks.
  The mode reaches it through the `FASTVIBE_PERMISSION_MODE` env var, which
  `applyPermissionMode` (`engine/app-settings.ts`) syncs from `settings.json` at
  startup and on every settings write; the extension re-reads it per tool call, so a
  mode change lands in a running session. It is a standalone jiti module, so it
  reads no FastVibe internals — keep new rules in the file itself.
  Two settings keys feed it: `defaultPermissionMode` (设置 → 通用 → 默认权限模式, default
  `smart` 帮我批准) is what a launch starts on, while `permissionMode` is the live mode the
  composer's chip switches. Main resolves the two at startup —
  `applyStartupPermissionMode` (`engine/app-settings.ts`) re-seeds the live value from the
  default, writes it back to `settings.json` and exports it — so one session escalated to
  `full` cannot outlive the app, and the sandbox env cannot disagree with the chip. An
  absent or malformed value anywhere means `smart`, never `full`.
- **Subagent** — `subagent/index.ts` registers a `subagent` tool that delegates a
  self-contained task to a role defined by a markdown file under
  `resources/extensions/subagent/agents/*.md`: `scout`, `planner`, `worker`,
  `reviewer` (user roles under `getAgentDir()/agents` are merged in). Because the
  SDK omits custom tools from the system prompt unless they declare it, the tool sets
  `promptSnippet` + `promptGuidelines` and lists the discovered roles in its
  `description` — that is what makes the main agent aware it can delegate. Modes are
  single / parallel (≤8) / chain (`{previous}`), and each spawned run gets an id of
  `${toolCallId}:${index}`.
  - **In-process runner, no child process.** The app embeds the SDK and excludes
    `pi-coding-agent/dist/bundle` from the archive, and a second process would not
    have the in-memory provider credentials either. So delegation runs on the
    host's own engine: Main injects `runSubagent` on the extension UI context
    (`FastVibeExtensionUIContext`, next to the `questions` bridge) and the tool
    requires it — there is **no `spawn("pi")` fallback** (`runSingleAgent` fails
    fast when the bridge is absent). `#runSubagent` creates a throwaway
    `createAgentSession` (`SessionManager.inMemory`), with `noExtensions: true`
    plus the permission sandbox as its only extension, appends the role's system
    prompt through the resource loader, restricts tools to the agent's list, and
    binds the parent conversation's UI context so a delegated `bash`/`edit` still
    confirms through the same composer panel.
  - **Model selection.** A delegated run uses the model its parent chat is on: it is
    a tool call inside that conversation, and a run on a different gateway than the
    one the user just proved works fails on its own — five parallel `reviewer` runs
    on a rate-limited second provider came back `429` for every one of them, so
    every subagent pane was empty. The parent's model reaches Main as
    `request.fallbackModel`; next comes a role file's explicit `model:` line (the
    built-in roles deliberately carry none), and the user's 「默认模型」
    (设置 → 供应商, `readDefaultModel` → `settings.defaultModel`) is the last resort,
    so a fresh install with no parent model still runs. Whichever spec wins,
    `#resolveSubagentModel` only accepts it when `ModelRegistry.hasConfiguredAuth`
    says this install can authenticate it — the catalog (`getAll()`) holds every
    reseller's models, so a pinned `claude-sonnet-4-5` on a gateway with no
    Anthropic key would otherwise win and fail with “No API key found”. Bare ids
    resolve against `getAvailable()` **and** are re-checked for auth.
  - **Renderer.** The sub-session's engine events are re-emitted as
    `subagent_event` / `subagent_lifecycle` (see `#trackSubagentEvent`), which the
    renderer folds into `session.subagents` + `subagentStreams`; `App.tsx` applies
    them regardless of which conversation is focused, so a backgrounded run keeps
    updating. **One run, one right-pane tab**: `registerSubagent` mints
    `subagent:<toolCallId>:<index>` on lifecycle, tagged with the owning
    `conversationId`, and `SidePane` only lists tabs belonging to the chat on
    screen — parallel/chain runs and runs from different chats never share a view.
    A `subagent` tool card does not dump its parameters — it lists the spawned
    runs (role · brief · status, the whole row opening that run's tab; no
    「查看对话」 button). The collapsed row summarises the fan-out rather than
    listing every run — at most two distinct roles plus a count (`scout ×5`,
    `scout, planner 等 4 个`) — and expanding it reveals each run. A run's tab is
    `SidePaneSubagent`: the same `MessageList` as the main thread (follow-the-bottom
    included), no composer and no abort — a delegated run is not a conversation the
    user can steer. The delegated brief is the opening user message, pinned on the
    tab as `subagentBrief`: the pane reads it from there, not from `subagents`,
    because that list is replaced by every `getSubagents` snapshot and a brief
    derived from it blanked the transcript mid-run. The cached transcript is read
    only once the run is over, and the empty state is chosen by the pane rather than
    by `MessageList`, so the scroller is never swapped for it mid-flight. The tab is
    titled `role · 运行中/已完成/失败`.
- **Browser use** — `browser-use.ts` is the tool surface for FastVibe's own side-pane
  `<webview>`; it holds no browser code. Every call crosses `browser:request` /`browser:response`
  (`src/main/pi/browser-bridge.ts`, one pending map keyed by request id, 30s default budget) into
  `handleBrowserRequest` (`components/layout/side-pane-browser.tsx`), which owns the webview
  registry and injects the page scripts. The payload is **one shared `BrowserRequest`**
  (`@shared/types`) — the extension, the bridge and the renderer must not re-declare it.
  - **Injected scripts are the fragile part.** Electron reports a script that never compiles as
    `GUEST_VIEW_MANAGER_CALL: Script failed to execute`, naming neither the script nor the cause —
    a single missing brace made every `browser_snapshot` fail. So page scripts are wrapped
    (`inject`) to return `{ok, value|error}` as data, and `pnpm check:scripts`
    (`scripts/check-injected-scripts.mjs`, wired into `typecheck` and `prebuild`) parses each one
    with its `${...}` interpolations neutralised. Add a page script → it must stay parseable.
  - **Elements are addressed explicitly.** A snapshot stamps each interactive element with a
    `data-fv-ref` (`e0`, `e1`, …) and reports both that `ref` and a CSS `selector` (`#id`, else a
    short `nth-of-type` path), so `browser_click` / `browser_type` target the element instead of
    guessing from text; a miss returns the labels that *were* on offer.
  - **Reuse, not sprawl.** `browser_open` navigates the tab already on screen (one Chromium guest
    per call made later calls slow and timeout-prone); `newTab: true` is the escape hatch. A
    click/keypress is awaited through its possible navigation, and a dead guest is retired —
    dropped from the registry and its pane tab closed. **A dead tab is never a tool error.**
    The browser is a shared side-pane resource the user can close or crash at any moment, so
    retiring one is an internal detail: the request that found it mints a replacement, resumes
    the page that tab was last on (tracked as `Entry.url`, updated by every navigation,
    load, history move and the pane's own address bar) and runs its action there, replying with
    a `note` — `browser_open` does the same in place, so the model is never asked to call it
    again. Only a tab whose replacement cannot be created (a webview that will not come up at
    all) is reported as an error. `tabId` is optional everywhere: an
    omitted id means the current tab, and a stale id with exactly one tab open is adopted with a
    `note`.
  - **A guest is never re-parented.** Chromium tears the guest down when its `<webview>`
    element is moved in the DOM — every call after that fails with `Invalid guestInstanceId`,
    and re-assigning `src` does not bring it back. So every guest's host lives in one layer
    (`getLayer`) that is attached to `document.body` once and only *positioned*: stretched
    over the tab's viewport while that tab is on screen, parked off-screen otherwise
    (`showGuest` / `parkGuest`, never `appendChild`). The park/edit-run design this replaced
    moved the host out of the park when the pane mounted it, so the guest died on open,
    `usable()` retired the fresh tab, and retiring the last tab collapsed the pane — the
    闪一下 the side pane did when a tool opened the browser. The layer follows the pane's
    collapse spring through its clipping ancestor's rect and leaves the pane's splitter
    clickable (`SPLITTER_GUTTER`); a parked or momentarily zero-sized guest stays found
    (`guestAlive` probes `getURL`), which is what keeps browser-use in a background chat
    working.
- **Web search** — `web-search.ts` registers a client `web_search` tool only while the
  session model speaks `openai-responses`. Execute opens a *side* `{baseUrl}/responses`
  request with the hosted `{ type: "web_search" }` tool (auth from `modelRegistry`); it is
  **not** injected into the main conversation, because pi-ai cannot parse `web_search_call`.
  Completions / Messages models drop it from the active set. The sandbox treats it as
  network (`ask` confirms, `smart` does not). Do not vendor `pi-web-search`.
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
pnpm sync:models    # rebuild the bundled models.dev index from upstream
pnpm dev            # sync models.dev if needed, then electron-vite
pnpm typecheck      # injected browser scripts, then both tsconfigs
pnpm check:scripts  # only the browser page scripts (a compile error there is a
                    # `Script failed to execute` at tool-call time, not a build error)
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

## 从其他 Agent 导入（设置 → 导入）

设置 → 导入 lists the sibling coding agents on this machine — **pi coding agent, Claude Code,
Codex, opencode** — one row each (brand mark, name, an 导入 button). Picking a row opens a
multi-select picker of that agent's sessions; nothing is imported until the user confirms.
`docs/import-from-other-agents.md` is the format dossier behind every adapter.

- **An absent agent gets no row.** `scanImportSources` skips any source whose data root does
  not exist, so a machine without pi or opencode installed shows only the two rows that can
  actually do something — a row whose only possible message is 「未找到数据目录」 is noise. A
  source that *is* installed but holds no sessions still gets a row (it says 没有找到会话):
  that is a state the user would otherwise go hunting for in the file system. If every source
  is absent the pane says so once instead of listing four disabled rows.

- **One adapter per source, one writer for all of them** (`src/main/engine/import/`):
  `sources/*.ts` translate a foreign store into the intermediate form in `types.ts` and stop;
  `writer.ts` is the only place that knows the pi v3 transcript contract, and
  `runner.ts` drives scan → read → write → register. Adding an agent means one adapter file
  plus a line in `adapters.ts` — nothing else in the app learns how many sources exist.
- **The writer is where the contract lives, and it is not negotiable.** The first line must
  be the `session` header with `version: 3` (otherwise the SDK rejects the file, or a
  migration pass rewrites every entry id); entries form a linear `parentId` chain in file
  order, because the reader takes the *last* entry as the leaf; and a tool result is written
  **immediately after** the assistant that made the call. That last one is not cosmetic: the
  first converter appended results at the end of the file, the SDK still built a context with
  no errors, and the failure only appeared when the user continued the chat and the provider
  rejected a `tool_use` with no `tool_result`. A call with no recorded output gets a
  synthesised error result for the same reason. Foreign thinking blocks are written **without**
  their signature — replaying another provider's signature is rejected, and an unsigned
  thinking block is what makes pi fall back to plain text.
- **Import copies, never links.** A deleted conversation unlinks its `sessionFile`, so a chat
  pointing at `~/.claude` would destroy the user's real data. Every foreign root is opened
  read-only (Codex/opencode SQLite via `node:sqlite` `{ readOnly: true }`; the opencode DB is
  copied aside only when a live WAL refuses the read) and each session is converted into
  FastVibe's own `runtime/engine/agent/sessions`.
- **Candidates are only as expensive as they must be.** The picker must open instantly, so
  `importCandidates` skips what it cannot get cheaply: Codex leaves `messageCount` undefined
  rather than counting 1000+ rollouts (that alone cost 4.5s), and opencode reports a message
  count instead of summing `LENGTH(data)` over 81k part blobs (2.6s). Codex is enumerated from
  `state_*.sqlite:threads`, opencode from its own DB, the other two by directory listing.
- **Per-session outcomes, never all-or-nothing.** These stores are full of pruned rollouts and
  half-written files, so a failure is collected and shown as a reason next to that row. The
  report also lists what a conversion dropped (injected context, subagent sidechains,
  compaction markers — never written as real `compaction` entries, which would hide earlier
  messages from both the model and the thread).
- **Archived sessions are folded, not dropped.** `threads.archived` (Codex, plus the
  `archived_sessions/` directory on the walk fallback) and `session.time_archived` (opencode)
  travel through the adapter as `archived` and reach the picker as one boolean — on the
  author's corpus 62 of 88 Codex threads are archived, so listing them beside live work buries
  it. The picker hides them behind a 显示已归档 switch and badges the rows; the source row
  carries `archivedCount` so the count is visible while they are hidden. The select-all
  checkbox carries the count in its own label (`全选（已选/可见）`, not a separate 已选
  readout) and is scoped to the rows on screen; folding the archived away also drops them
  from the selection, so that number always matches what would actually be imported. pi and
  Claude Code have no such notion and their switch stays disabled.
- **The catalog write is flushed before success is reported.** `ConversationCatalog` coalesces
  writes on a 40 ms debounce, so `importSessions` calls `flush()` once at the end — after the
  pane says 已导入, the chats survive a crash.
- **`importedFrom: { source, sourceId }`** on the `Conversation` is the re-import key: the
  picker marks sessions already taken, and the same session imported twice is visible as such
  rather than silently duplicated. Imported chats are registered **not activated**
  (`activate: false`) so a twelve-session import does not walk the user through twelve tabs,
  and `titleManual` protects the name that came from the other agent.
- **Icons** are the four brands from LobeHub (`components/agent-brand-icon.tsx`), inlined as
  `currentColor` paths rather than `<img>` so they follow the active theme.

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

## 会话是否在运行（`conversation_running`）

Two different things can be in flight in one conversation, and the sidebar's 运行中 mark
means either: an agent **run** and a **compaction**.

- A run is `agent_start` → **`agent_settled`**, not `agent_end`. The SDK emits `agent_end`
  before it does everything else it still owes the same run: retrying a failed request
  (after an exponential backoff), auto-compacting, or continuing with messages an
  `agent_end` handler queued (`ctx.sendMessage` from a goal/plan handler). Each of those
  then starts another `agent_start` *inside that same run*, and only `agent_settled` —
  emitted once, at the end of `_runAgentPrompt`'s post-run loop — means it is over (it is
  the same condition as the SDK's `session.isIdle`). Ending the flag at `agent_end` made
  the mark, the footer and the stop button go idle for the whole backoff/compaction
  window. `PiProcessManager` sets `#running` on those two events and nothing else;
  `apply-engine-event.ts` keeps the renderer's `streaming` on the same pair.
- **A resume is a run too.** `continueTurn` (the composer's 继续) drives the resumed turn
  through the SDK's own run wrapper — `_runAgentPrompt([])`, private because 0.85.1 has no
  public entry point for continuing an interrupted turn — and not the bare
  `agent.continue()` loop, because the wrapper is exactly where `agent_settled` and the
  post-run policy live. Calling the raw loop left a resumed run with nothing to clear the
  flag *and* with an `agent_end` claiming `willRetry` for a retry nothing would perform, so a
  502 mid-resume stuck the chat on 停止 (sidebar 运行中, keep-awake held, sends queued instead
  of sent) with no 继续 control, until some unrelated run settled it.
- The composer's resume control reads `runInterrupted` (`stores/session.ts`): a terminal
  `agent_end` (`error` / `aborted`), or an `auto_retry_end` reporting failure with no such
  verdict on record — a retry chain the user stopped while it waited out the backoff, which
  the SDK ends after already dropping the failed attempt from agent state, so no errored
  message and no `agent_end` ever describe it. Both pause the follow-up queue; `agent_start`,
  `turn_start` and a fresh prompt clear the marker again.
- A compaction keeps its own flag `#compacting`, for when it is not part of a run at all:
  `/compact`, and the threshold check a fresh prompt runs before it is sent. It is the only
  thing that can say such a chat is busy, and it is used to re-serve the 正在压缩上下文 card.
  It is deliberately *not* folded into `#running`, because `#isLive()` uses that to decide
  whether a steer is drained mid-turn or a fresh turn is started — a standalone compaction
  must not pass for a live run there. `PiProcessManager` broadcasts the union of the two as
  `conversation_running`.
- `EngineSessionState.running` is the run alone; `isCompacting` is the other half, and the
  renderer unions them (`working()` in `stores/session.ts`) wherever it writes the sidebar
  map.
- **One busy state for every mark.** The per-conversation map (`running[id]`, written from
  `conversation_running` and from the events' own verdict) is what *every* 「this chat is
  working」 display reads: the sidebar's `RunningMark`, the composer's stop button and
  extension badges, `GoalPanel`'s disabled state, and the todo panel/card
  (`useConversationWorking()`; the side pane reads `running[tab.conversationId]`). Nothing
  keeps a second copy — the store has no `compacting` field any more — and `Escape`-to-stop
  uses the same gate as the button it clicks. A delegated run's tab is the same idea one
  level down: `Main` marks it 已完成 on the sub-session's `agent_settled`.
- The renderer's `streaming` is deliberately *not* that mark: it means 「a run is in flight
  for the chat on screen」, and is read only where that is the question — the transcript's
  caret / working row / per-message footer, and whether a send is queued (steer or
  follow-up) rather than starting a turn (the 加入队列 / 发送 label, the placeholder, the
  queue drain). `streaming ⇒ working` always: a run is a subset of working, and a
  `conversation_running: false` for the chat on screen clears `streaming` in the same batch,
  so the two can never be seen to contradict each other.
- **The transcript's working row is gated on the reply's tail, not on whether it has text.**
  `WorkingStatus` (`components/chat/message-list.tsx`) renders 「正在工作 / 继续工作」 while `streaming`
  and *nothing live is at the end of the reply* — where 「live」 means a trailing text part (its caret
  blinks), a trailing thinking block (it shimmers 正在思考), or any tool still `running` (its spinner).
  The old gate was `!hasText`, which showed the row only in a reply that had not written a word yet:
  a run that had already produced prose then went quiet for the whole tool→model boundary, because
  the tool cards had settled and the next token had not arrived — a transcript of finished rows that
  read as a hang. The point is that a live element is *last*, so a reply whose text is followed by a
  running tool still shows only the spinner.
- **Main owns the renderer's mark.** `conversation_running` is sent on every change (for
  background chats too), and only Main may lower it. A transcript read must not: `setMessages`
  leaves the run flags alone, because `reloadActiveMessages()` fires at every `agent_end` /
  `compaction_end` and its full-transcript reply can land long after the engine moved on —
  clearing them there showed a working chat as idle in the middle of its next request.
  Optimistic writes stay local (`addUserMessage`, `setStreaming`) and are undone by
  `setSession` / `dropEmptyAssistant`.
- Every state reply carries `conversationId`, and `App.tsx` drops a `getState`/`getMessages`
  answer whose conversation is no longer on screen — a late reply must not light up (or
  repaint) the chat the user just switched to. Teardown paths call `#clearBusy(id)`, since a
  session thrown away mid-run never emits `agent_settled` and would spin forever.

A compaction's own payloads only reach the renderer while its conversation is on screen, and
it has no transcript entry until the summary lands — so `#messages()` re-serves the running
「正在压缩上下文」 card from `#compacting` for an in-flight compaction. Without it, switching
away and back mid-compaction lost the card until the summary was finally written.

## 折叠运行过程（设置 → 对话）

`settings.collapseRuns` (设置 → 对话, on by default) folds a finished run's thinking and tool
calls behind one collapsed 「用时 …」 row, leaving the reply written after the last tool call on
screen. It is modelled on zcode's turn-history fold, including its rule that the fold is gated
on the turn's own terminal state.

- **The row is only drawn when the run is settled *and* wrote an answer — i.e. when the fold
  can actually happen.** A run still in flight, one that stopped on a tool call, and a failed
  one all render the plain transcript, with no 「用时」 row at all. That is the point: such a row
  could not be collapsed (it would hide the run's only output), and a header that cannot be
  collapsed over content the reader is watching reads as broken. zcode draws one there but
  labels it 「工作中/已停止」; hiding it is the simpler answer.
- **Nothing is folded mid-run, because the final answer is not knowable mid-stream.** The model
  may write prose, call another tool, then write again, so any rule keyed on 「the tail part is
  text」 guesses and unfolds again at the next tool call. Settling — `streaming` going false — is
  the confirmation, and it is the same verdict the sidebar's 运行中 mark uses (`agent_settled`).
- **The settled split is anchored on the last process part, not on 「the last text」.** `cut =
  index + 1` for the last part whose kind is `thinking` / `tool` / `group`; everything up to and
  including it folds, everything after it is the answer. That point is a fact already on screen,
  so the split needs no guess even for a reply whose prose arrived in several pieces.
- **Both halves must be non-empty.** A reply that never thought or called a tool has nothing to
  hide; one with no prose after its last tool call has no answer to leave out. Either way there
  is no fold, and a body that would render nothing (only hidden thinking) folds nothing either.
- **It is a render-time view, not a transcript change.** `RunCollapse`
  (`components/chat/run-collapse.tsx`) wraps the parts `groupParts` already produced, so
  the fold re-uses the same thinking / tool-card / model-divider renderers as the unfolded
  transcript, and toggling the setting needs no engine round-trip.
- **The header's 用时 and the footer's 耗时 are two different numbers, on purpose.** 耗时 is the
  turn's total, first round-trip's request start (`createdAt`) to the instant its last entry was
  persisted (`completedAt`, added by `sessionCompletionTimes` in `process-manager.ts`). 用时 is
  the work the fold hides: the same start, but ending where the reply's **final message began**
  (`messages[last].createdAt`). An engine message is one model request, so that boundary is
  exactly where the last tool call finished — the answer's own generation is not part of the
  process. A run that produced everything in a single request has no boundary to measure and
  falls back to that request's span. Both survive a reload, and because the fold only exists
  once the run has settled there is no live-ticking case. Both go through `formatDuration`
  (`lib/time.ts`), the app's only duration format (`3分钟 41秒`), so the two numbers read in one
  notation — a compact `3m41s` beside a `3分钟 41秒` was two spellings of the same unit. The
  compact formatter it replaced is gone, and `formatDuration` returns `""` for a null span, so
  the statistics popover spells out its own `—`.
- **Collapsed by default, and entirely the reader's afterwards** — nothing re-folds it under
  them. The main thread takes the setting as a `MessageList` prop (like `showThinking` /
  `showTimestamp`) so the memoised rows can skip re-rendering on each streamed token; the
  辅助对话 and 子 Agent panes read it from the settings store, because they are not memoised
  against a token stream the same way.

## 思考耗时（思考块的「持续了 N 秒」）

A thinking block's duration is measured, not derived from the transcript: pi records one timestamp
per message (its request start), so Main times each block as it streams and files the bounds in
`runtime/engine/reasoning.json`, keyed by the session entry id the message becomes
(`ReasoningStore`, `#timeReasoning`). `#messages` hands those bounds to `mapEngineMessages`, which
stamps them onto the thinking parts, and the renderer derives the elapsed value at render time —
which is why an open block keeps counting from its real start across a chat switch or a reload.

The bounds can be missing, and the transcript must still say something:

- **A provider that never opens with `thinking_start`.** `#timeReasoning` opens a block on
  `thinking_start`, so a stream that only ever sends `thinking_delta` used to leave `blocks` empty
  — and at `message_end` the message was filed with nothing. The whole run then read 「思考」 with
  no duration, in every reload, forever. Blocks are now opened lazily on the first delta (and for
  a second segment that arrives with no start event), so this cannot happen again. Real sessions
  in the wild have this shape: one had 229 thinking messages with no bounds at all.
- **Transcripts written before, or by a path that does not time them.** A delegated run's
  transcript (`getSubagentMessages`, the live `subagent_event` stream) and an imported chat carry
  no bounds at all.

So `ChatMessageRow` falls back to the span of the **round-trip the block came from**
(`messages[].createdAt` → `completedAt`) whenever a thinking part has no bounds of its own: the
row then reports that whole request's time, an upper bound rather than the thought alone, instead
of a bare 「思考」. Measured bounds always win. The owner lookup is a `Map<MessagePart, ChatMessage>`
built from the row's messages, which works because `mergeAssistantRun` passes thinking parts
through by reference.

## 运行时保持唤醒

Settings → 通用 → 运行时保持唤醒 (`settings.keepAwake`, on by default) holds the machine
awake while an agent run is in flight.

- `src/main/engine/keep-awake.ts` owns a single `powerSaveBlocker` and is the only place
  that starts or stops it. Two inputs decide the state: the preference, and whether
  anything is streaming — so turning the switch off mid-run releases it at once, and the
  last run to finish releases it while the switch stays on.
- It blocks `prevent-app-suspension`, not `prevent-display-sleep`: the run survives, the
  screen may still dim. A late-night run should not light the room.
- Runs are tracked per conversation id from the engine's `conversation_running` event,
  which is broadcast for background chats too, so a session the user switched away from
  still counts. `before-quit` clears the set. A compaction counts too: it is minutes of
  model work on the user's own machine, and it is the last thing to finish.

## Product constraints

- Code / Office / Cowork are first-class; pi-coding-agent is the default backend.
- Office and extra ACP agents come later; keep Host adapters (RPC/ACP) decoupled from the renderer.
- Built-in model provider is **fastvibe** (`https://fastvibe.dev/v1`). The user pastes an API key; FastVibe fetches `/models`, writes isolated `models.json`, then starts the embedded engine. Do not mention the backend runtime in the UI.
