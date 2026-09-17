# FastVibe

Electron desktop client for agent work, code, office, and multi-agent cowork. The default engine is the embedded **`@earendil-works/pi-coding-agent` SDK** running in the Electron main process. Native pi state (`~/.pi`) is never used as the data root; FastVibe keeps everything under its own userData directory.

## Architecture

```
src/main/          Electron main: window, IPC, and embedded agent lifecycle
  engine/          Isolated runtime paths, provider configuration, and shared model/file helpers
  ipc/             Transport-neutral call table and broadcast hub
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
  models-dev.json        models.dev snapshot refreshed from 设置 → 关于, which wins over the bundled one
  runtime/engine/
    agent/sessions       session transcripts, passed to the SDK's SessionManager
    agent/.env           provider API keys, injected into the SDK's in-memory auth storage
    agent/oauth.json     subscription (OAuth) tokens — the one credential written to disk
    agent/models.json    the only provider config the SDK reads (custom + builtin providers)
    reasoning.json       thinking-block start/end times Main timed from the live stream
    usage-ledger.jsonl   append-only record of finalized turns, so 使用统计 survives deletion
    wt                   git worktrees for isolated conversations
    scratch              workspace for conversations not bound to a project
```

Paths are handed to `createAgentSession` programmatically (`agentDir`, `sessionManager`,
`settingsManager`) rather than through environment variables. Agent IPC channels use the
`engine:` prefix (`src/shared/ipc.ts`), exposed to the renderer as `window.fastvibe.engine`.

### Calls and pushes

Main's methods are registered on a transport-neutral table (`src/main/ipc/registry.ts`)
and its pushed messages leave through one hub (`src/main/ipc/broadcast.ts`). Neither
knows what is on the other end: Electron IPC is attached in `wireElectronTransport()`,
and a remote client is meant to be a second consumer of the very same table, so a method
cannot exist on the desktop and be silently missing elsewhere.

Two rules keep that true:

- **Register with `handle()`, never `ipcMain.handle`.** Handlers take `(payload, ctx)`;
  `ctx` carries the asking window, because `event.sender` is an Electron concept a
  non-IPC caller cannot produce. `settings:get-sync` is the one exception — `sendSync`
  has no counterpart on another transport, and the preload reads it before first paint.
- **Push with `broadcast()`, never a loop over windows.** A receiver is whatever
  registered a `send`; `{ except }` skips the caller that caused the write.

Registration must finish before `wireElectronTransport()` runs — anything registered

after the wiring loop is in the table and reachable by nothing.

### Reconstructing a conversation

`engine:get-snapshot` (`ConversationSnapshot`) is what a client reads to draw one
conversation exactly as it stands, a turn in flight included. Every field is read in one
synchronous stretch, so they cannot describe different instants — there is no snapshot
to splice against a stream.

What goes where is not obvious, and getting it wrong renders a plausible-looking but
wrong transcript:

- **`messages` already carries the turn's content.** `#messages` appends the reply being
  streamed as a trailing `running:<id>` row, with its unfinished tool calls marked
  running, and a running compaction as its own card. This is what lets a chat switch or
  a window reload show a reply in progress.
- **`turnEvents` therefore holds no stream events.** `slimStreamEvent` reduces
  `message_update` to a bare delta; replaying deltas onto a transcript that has already
  accumulated them draws the reply twice. Only the panel state the transcript has no
  place for is kept (`RETAIN_FROM_STREAM` / `RETAIN_FROM_EMIT`): a notice, a todo list,
  a retry banner, a model divider.
- **`pendingUi` carries parked prompts**, served from `#pendingUi` itself so what is
  offered and what can still be answered cannot drift. A prompt is delivered only as an
  event, so a client that connected afterwards would otherwise see a chat that had
  silently stopped, with a tool parked behind a question shown to nobody.

Every event carries a monotonic `seq` (`#stamp`). A caller that takes a snapshot and then
subscribes drops events at or below the snapshot's `seq` and applies the rest.

Retention is filled for **every** conversation, including background ones whose live
payloads are dropped by the `#activeId` filter in the session subscription — that filter
encodes one window's idea of "the chat on screen", and a second client may be looking at
another conversation.

### 远程访问（`src/main/server/`）

A second way into the same call table, for a browser on another device. `src/main/remote.ts`
holds everything Electron-shaped — settings, paths, the methods the settings pane calls —
so `server/` itself imports no Electron and could run without a GUI. It is handed the very
same `dispatch` and `subscribe` the windows use; that is what keeps a method from existing
on the desktop and being missing on the phone.

Four rules, each of which fails silently if broken:

- **Credentials never touch `settings.json`.** That file is handed whole to every renderer
  and re-broadcast on every write. The password hash and device tokens live in
  `remote-access.json` (0600), and no method serves it.
- **`policy.ts` classifies every method, exhaustively.** `assertPolicyCoverage` refuses to
  start the server when the table holds one that is in neither set, so adding a method
  breaks the server until somebody decides — a denylist alone would expose it by default.
  The bar for denying is narrow: whoever has the password can already ask the agent to run
  commands, so only calls that *hang* (native dialogs), act on the wrong machine's desktop,
  or hand over a lever they would not otherwise have (`providers:fetch`) are refused —
  plus `remote:*` itself, so a stolen token cannot lock the owner out.
- **No password, no server.** `start()` throws rather than listening, and the default bind
  is `127.0.0.1`: a tunnel is what publishes it, and a slip in the settings pane cannot put
  a shell onto the local network.
- **Pushes begin at authentication, not at connection.** A socket that has not proved who
  it is is subscribed to nothing and closed after ten seconds.

The password is exchanged once for a device token (`POST /api/login`); tokens travel on
every later connection, are stored only as hashes, and are revoked one device at a time.
Guessing is slowed by a global exponential backoff — global rather than per address
because behind a tunnel every request arrives from the same one.

### 会话作用域（每一条引擎调用都要带 `conversationId`）

Main 每个会话一个 `AgentSession`，但引擎自己只有一个「当前会话」（`PiProcessManager.#activeId`）。
所有跟会话有关的调用都接受一个可选的 `conversationId`，`#sessionFor(id)` 据此取 session，
不传时才回退到 `#activeId`。**渲染层调用一律走 `src/renderer/src/lib/engine-client.ts`**，
它把 id 默认成 store 的 `activeId`；直接 `window.fastvibe.engine.*` 只应出现在这个门面里，
以及那些本来就不属于任何会话的调用（供应商、技能、MCP、导入…）。

这条不是洁癖：`#activeId` 是**每个窗口共享**的一个值。两个窗口各看一个会话时，谁最后
`conversations.open` 谁就拥有它，于是 A 窗口发出的提示会落到 B 窗口的会话里。
新增一个会话级 IPC 时，把 `conversationId` 一路带到引擎，并让门面带默认值。

同理，`getState(id)` 在会话未加载时**不能**退回活动会话——那会把另一个会话的状态
贴上被请求的 id 返回给渲染层。它走 `#ensureSession` 把那个会话取出来再答。

### 阻塞式插件请求：按会话排队 + 「等你」标记

`ctx.ui.confirm` / `select` / `input` / `editor` / `questions` 会**把工具停住**直到有人回答。
三点约定：

- **按会话存，不覆盖。** 渲染层的 `pendingPermissions` 是 `Record<conversationId, PermissionRequest[]>`。
  单槽版本会丢掉同一会话的第二个请求——而并行子 agent 共用父会话的 UI 上下文，八路
  同时要审批时只有最后一个能显示，其余七个的 promise 永远悬着。面板画队列头（`activePermission`）。
- **应答按 id 移除，不砍队首。** 引擎自己也会撤回请求（`confirm` 有 `CONFIRM_TIMEOUT_MS`，
  `abort` 会结算），撤回发 `extension_ui_dismiss`。若用「砍队首」，那条 dismiss 之后再应答
  就会误删**下一条**刚排队的请求。
- **取消只看得到当前会话。** `abort(conversationId)` / `#resolvePendingUi(conversationId)` 只结算
  那个会话的请求；`stop()`（退出应用）才是全部。曾经无条件清空全部，于是停 A 会用
  `confirm` 的 `false` 回退把 B 后台挂着的审批驳回——用户从没见过那条提问。

`extension_ui_request` / `extension_ui_dismiss` 在 `App.tsx` 的 `onEvent` 里**先于焦点路由**处理：
阻塞请求不是转录内容，后台会话卡在审批上时必须能点亮侧栏的「等你」和系统通知。
只有 `set_editor_text` 是例外——它写的是当前输入框，必须按会话过滤，否则后台会话会覆盖
用户正在打的草稿。

会话在等用户时：侧栏行显示 `Alert02Icon`（悬停换成停止按钮），窗口未聚焦时按
`settings.notifications === "approval"` 发系统通知。

Provider credentials are kept in FastVibe's isolated runtime and injected into the SDK's in-memory auth storage. Do not export these variables into the user's login shell or the in-app terminal.

## UI: shadcn Nova

- Style: **`base-nova`** (latest Nova on Base UI). Configured in `components.json`.
- Package manager is **pnpm**. Install and update primitives **only** via:

  ```bash
  pnpm shadcn add <component> -y
  ```

- Do **not** hand-write files under `src/renderer/src/components/ui/`. If a primitive already exists in shadcn (Button, Input, Textarea, Badge, Message, Bubble, Empty, Item, Alert, …), add it with the CLI and compose it.
- Product screens (chat thread, workspace chrome, tool cards) live outside `components/ui/` and **compose** shadcn primitives. Custom markup is allowed only when shadcn has no matching primitive.
- **A group part needs its group.** `DropdownMenuLabel` / `ContextMenuLabel` / `SelectLabel` are Base UI's `Menu.GroupLabel`, which throws `MenuGroupContext is missing` when rendered outside its group; the same applies to the other group-only parts. It is a **render-time** throw, so no typecheck catches it and it does not degrade gracefully — it unmounts the whole tree. That is how the composer's model menu, whose empty state drew a bare label, took FastVibe down the instant it was opened on an install with no models. Wrap every label in `DropdownMenuGroup` / `ContextMenuGroup` / whichever group the surface has.
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

### Provider icons

A built-in provider (内置供应商) is drawn with its own brand mark, and with a
neutral glyph when there is no brand to draw — never with nothing, so a provider
list keeps one visual rhythm. `components/provider-icon.tsx` is the only place
that decides; it is keyed by the **SDK's** provider id, so a built-in FastVibe
starts offering is already covered the day it appears.

- The marks are **vendored from LobeHub's icon set** (https://lobehub.com/icons,
  MIT), each icon's `Mono` variant only — the one drawn to work on any background.
  They are inlined `currentColor` paths rather than `<img src>`, exactly like
  `agent-brand-icon.tsx` and for the same reason: a monochrome mark that follows the
  theme beats a raster asset that pins a palette colour (see the theming rules).
- Two providers match nothing on purpose: `radius` (a pi-only gateway) and any
  `custom-…` provider, which has no brand at all. Both get the fallback glyph,
  muted so it does not read as a logo.
- It appears wherever a provider is *presented*: 设置 → 供应商's list and detail
  header, 添加供应商's 内置供应商 picker, the composer's model submenus, and
  设置 → 供应商 → 默认模型. Not in the model picker, where every row is one
  provider by definition, nor in 使用统计, which is a model breakdown.
- The mark is drawn at **14px** (`size-3.5`) *with its artwork inset* — the `viewBox`
  is grown to `-2 -2 28 28`, so a mark drawn to LobeHub's full 24-unit grid occupies
  24/28 of the box. The box matches the fallback glyph and the neighbouring rows
  (so labels do not shift), while the inset is what makes a logo and the outline
  glyph look the **same size**. Both numbers are load-bearing: a filled mark filling
  100% of a box that a Hugeicons stroke icon only fills ~92% of reads distinctly
  larger than the icon beside it, and that is what made the first pass look oversized.
  Do not "fix" either one on its own.

### Code highlighting

Syntax highlighting is **shikiji** (`src/renderer/src/lib/highlight.ts`), used by
both the markdown code fences and the file preview — except for a diff, which is
rendered rather than highlighted (below).

- The highlighter is created lazily (`getHighlighterCore`, wasm engine); grammars
  are code-split and loaded on demand, so only languages actually shown are fetched.
- Colors come from `createCssVariablesTheme`, mapped in `index.css` onto the app's
  `--code-*` tokens — every theme highlights correctly with no per-theme setup.
- `useHighlightedCode(code, language)` is the React entry point: it debounces (so a
  streaming fence is not re-tokenized per token) and caches by `(language, code)`.
- **A diff is not highlighted, it is rendered.** `components/chat/diff-view.tsx` is the
  one renderer for every diff the app shows — a tool call's file change, a ```diff
  fence in a reply, a `.patch` preview, the right pane's git diff — and `lib/diff.ts`
  reads the line numbers out of the diff itself: `@@` hunk headers where a real
  unified diff has them, pi's baked-in `- 12   label` column where it does not (that
  format carries no headers at all). The gutter never counts rows — it used to show an
  invented index beside pi's real number — and a fragment with neither (what a model
  usually writes by hand) renders unnumbered rather than misnumbered. shikiji is out of
  the loop for these: its CSS-variables theme maps nothing for `markup.inserted` /
  `markup.deleted`, so a `diff` fence came out flat and monochrome.
- The wasm engine needs `'wasm-unsafe-eval'` in the CSP `script-src` (`index.html`).

### Math (LaTeX)

A reply's `$…$` and `$$…$$` render as typeset math. `markdown-view.tsx` mounts
**`remark-math` + `rehype-katex`** (both module-level `PluggableList` constants — an
inline array would be a new identity on every streamed token and defeat the `memo`
that exists for exactly that), and `index.css` imports **`katex/dist/katex.min.css`**.
Importing from CSS rather than JS is what keeps the fonts with it: KaTeX's
`url(fonts/…)` resolves against the package, so Vite emits the twenty `.woff2` files
into the renderer bundle and the app stays offline-clean under `default-src 'self'`.
No CSP change is needed.

- **Colour is inherited, so there is nothing per-theme to do** — and nothing that
  *could* be done: KaTeX reads no custom properties of its own. It inherits `color`
  and the font stack, so all twenty themes work untouched. The one exception is the
  error fragment, which gets `errorColor: "var(--destructive)"` from the plugin
  options. `index.css` only adds layout (a display block scrolls instead of
  stretching the bubble).
- **`throwOnError: false`, always.** A half-streamed formula is the normal case here,
  not an error: `$$\frac{1}{` must draw itself in the error colour, never throw into
  React and never log. `strict: false` for the same reason — KaTeX's warnings about
  constructs it merely tolerates are noise in a chat log.
- **`$` is not a reliable math delimiter in this app, so `lib/remark-strict-inline-math.ts`
  judges it.** `remark-math`'s default pairs any two `$` on a line, and a reply about
  shell, config or money is full of them — `$HOME/.config`, `$PATH`, `$5 到 $10` — each
  of which rendered as a garbled equation. Disabling single-dollar math is not the
  answer either (`$O(n\log n)$` is exactly what people type). The plugin keeps
  `remark-math`'s tokenizer and re-reads each node against **Pandoc's `tex_math_dollars`
  rules** — no space inside either fence, no digit right after the closing one —
  putting a rejected run back as the literal text the reader wrote. Display math
  (`$$…$$`) and fenced ` ```math ` are never touched: their fences are unambiguous.
  The rules are unit-tested in `test/markdown-math.test.ts`; a change here is a
  change to what every reply looks like, so run them.
- Code is out of scope by construction — a `$HOME` inside a fence or a code span is
  never a math node, so no shell snippet in a tool card can be eaten by this.

## Theming

The app ships light **and** dark themes; never assume light.

- `src/renderer/src/lib/themes.ts` is the single source of truth. It holds twenty
  first-party themes (ten light, ten dark) modelled on the most-installed VS
  Code themes — GitHub, One Dark Pro, Dracula, Tokyo Night, Catppuccin, Nord,
  Night Owl, Gruvbox, Monokai, Rosé Pine, Ayu, Everforest, Solarized, Quiet Light.
  Each theme is a compact `ThemeSeed`; `buildTokens` derives the full
  shadcn / Base UI token set from it (`--background`, `--primary`, `--sidebar-*`,
  `--warning/--success/--info`, `--code-*`, …), plus `--destructive-foreground` for the text
  drawn on a filled destructive surface (the title bar's close button), which every theme wants
  the same near-white.
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

## 语言 / i18n

设置 → 通用 → 语言 has two independent picks, both `zh | en`:

- **界面语言** (`settings.uiLanguage`) drives every string the user reads. The
  renderer uses **i18next + react-i18next** (`src/renderer/src/lib/i18n.ts`).
  Namespaces live in `src/renderer/src/locales/{zh,en}/{common,app,chat,settings,sidepane}.json`.
  Components call `useTranslation("<ns>")`; shared lib modules call `i18n.t` at
  render/event time so they never freeze the language of module load. `applyUiLanguage`
  stamps `<html lang>` and is applied pre-mount in `main.tsx` (like the theme) and
  live via `useLanguageSync`. An existing install without the key keeps 中文; a
  brand-new install follows the OS locale (`detectSystemLanguage`).
- **AI 偏好语言** (`settings.aiLanguage`) is injected on every turn by the built-in
  `output-language` extension (`before_agent_start` appends a language requirement
  to the system prompt). Main owns the wording (`src/main/engine/ai-language.ts`)
  and writes it to `FASTVIBE_AI_LANGUAGE_PROMPT`; the extension just appends whatever
  it finds, re-read per turn so a settings change lands in a running session.
  Subagent sessions (`noExtensions`) get the same sentence via `appendSystemPrompt`.
  User-facing engine/extension copy follows `FASTVIBE_UI_LANGUAGE` (`uiText` in
  `src/main/engine/ui-text.ts`).

Both values are written to `settings.json` with the other prefs. Main syncs the env
vars on every settings write (`applyLanguages`) and at startup.

Do **not** hardcode user-visible copy in product components. Add a key to the matching
namespace JSON (zh value byte-identical to the original Chinese) and render it with
`t(...)`. Language picker labels (`简体中文` / `English`) stay untranslated on purpose.

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
- Every pane draws its rows through `settings-group.tsx` (`SettingsGroup` /
  `SettingsRow`): a card of label + one-line description + control on the right, with a
  divider between rows. A pane that hand-rolls its own row drifts in padding, type
  scale and control alignment — 关于's cells did, and had to be rebuilt on these.

## 标题栏（Windows / Linux）

macOS insets its traffic lights into the app's own first row (`titleBarStyle: "hiddenInset"`),
so the sidebar's `h-11` row is built around them: the clearance, then 收起侧边栏 /
后退 / 前进, with the logo and wordmark on the row below. Neither of the other two has anything
to inset, and a native title bar above an app that already has a top row is two bars with one of
them empty.

So on Windows and Linux FastVibe draws the whole bar itself
(`components/layout/title-bar.tsx`): the brand, those same three controls, 搜索, and minimise /
maximise / close — one `h-11` row above the sidebar/main split, whose single switch is
`HAS_CUSTOM_TITLE_BAR` (`lib/platform.ts`). A bar **spanning the window**, rather than controls
floated over whichever row happens to reach the top-right corner, is what keeps the window
controls out of the side pane's tab strip: the split layout below simply starts at y=44.

- **Main goes frameless.** `titleBarStyle: "hidden"` (plus `frame: false` on Linux, where the
  window manager is the unpredictable part), so the native bar is gone and ours is the only one.
  The controls are hand-drawn rather than `titleBarOverlay`'s native ones: those cannot be
  previewed in a browser, cannot follow the theme, and would land on the tab strip anyway. Main
  exposes `window:minimize` / `window:toggle-maximize` / `window:close` — each acting on the
  window that asked — plus a `window:state` push, because the OS can maximise too (snap,
  double-click, a window-manager key), so the glyph is not derivable from our own clicks.
- **The platform comes from the preload, not the user agent.** `app.platform` is a plain string on
  the bridge, read before the first paint, and every `IS_MAC` in the renderer — keybinding labels
  included — now reads it through `lib/platform.ts`.
- **Nothing the macOS layout keeps in the sidebar is drawn twice.** Where the bar exists, the
  sidebar's title row and its logo row are gone and the logo/搜索 live in the bar instead;
  `SidebarCollapsedChrome` drops its toggle and the main header its 展开侧边栏 button, because the
  bar is on screen in both sidebar states.
- **The settings pane starts below the bar** (`top-11`) and drops its own traffic-light spacer:
  the window controls have to stay reachable from settings, and its content must not slide under
  them.
- **Preview**: `mock.html?platform=win32` (`src/renderer/src/mock/preview.ts`, which also stubs
  the window API) renders the whole thing in a browser — how the layout was checked without a
  Windows machine.

## Providers

FastVibe (`https://fastvibe.dev/v1`) is **one provider among others**, not a forced
onboarding gate. There is no connect wall and no separate 「not configured」 engine
state: an install with no provider boots an ordinary engine whose model list is
empty, and that empty list is the whole signal. The composer reads it — it goes
read-only and its placeholder asks for a model — and the model chip's popover says
暂无模型 above the 管理模型 entry that leads to Settings → 供应商. Users can equally add
any OpenAI-compatible provider there.

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

**A built-in can also be configured by a subscription login (OAuth).** Claude
Pro/Max and ChatGPT Plus/Pro are the two people actually want, but nothing names
them: a provider's capability is read off the SDK, where `auth.apiKey.login` says a
pasted key is a real path and `auth.oauth` says a login ships with it
(`native-providers.ts`). Only `amazon-bedrock` / `google-vertex` stay hardcoded as
unsupported — their credentials are ambient cloud ones. That is why `openai-codex`
(login only, `supportsKey: false`) is offered at all, and why an SDK release that adds
a login reaches the UI with no change here.

- **Two credentials, two homes.** An API key is a secret the user pasted and goes to
the engine's in-memory overlay, never to disk. A subscription token is the opposite:
its refresh token has to survive a restart or the user re-authorises in a browser
every launch, so `oauth-store.ts` persists it to `runtime/engine/agent/oauth.json`
(0600, written through a temp file and renamed). `ModelRuntime.create` wraps whichever
store it is given, so a key still outranks a token for the same provider —
`RuntimeCredentials.read` checks the overlay first.
- **That is why a successful login drops the provider's API key.** Leaving one behind
would silently keep billing the key and make the subscription the user just
authorised do nothing. The provider detail says the same thing in words when both
credentials exist.
- **Connected means either credential.** `connectedProviderIds` is what
`applyProviders` (which models the composer sees) and `usableProviders` (which
providers `reloadProviders` keeps in the overlay) both filter on; a provider with
neither contributes no models anywhere, which is the whole «not connected» signal.
Signing out therefore removes the models without removing the entry, exactly like
clearing a key.
- **The flow is pi-ai's; the GUI only carries it.** It owns the PKCE pair, the loopback
callback server and the device-code polling, and asks for a human through `notify`
(one-way: `auth_url` / `device_code` / `info` / `progress`) and `prompt` (a round trip).
Both ride `providers:oauth-event`, with the answer coming back through
`providers:oauth-answer`; `Main` opens the `auth_url` / verification URI with
`shell.openExternal` and the dialog shows it too, because a browser that will not come
up has to stay recoverable by hand. **A prompt can be withdrawn while it is on
screen** — an Anthropic login opens the browser *and* offers a paste box, and aborts
the box the moment the callback arrives — so the flow's own `prompt.signal` and a
user cancel both emit `prompt_cancelled` and the dialog takes the question back down
(`oauth-login-dialog.tsx`). A login that fails *after* its credential landed (the
runtime's own synchronisation pass can throw) still counts as signed in: re-authorising
for nothing is worse than a missing confirmation.
- **`supportsKey: false` hides the key field**, in both 添加供应商 and the provider
detail; the login is the only way in. A built-in added this way is created with an
empty key, which `addNativeProvider` accepts only while a token is actually stored.
- **A subscription login is not always the plan's included usage, and the GUI says
so.** A Claude Pro/Max login used by a third-party harness is charged per token
against the account's «extra usage» balance, and refused outright — `third-party apps
not draw from your extra usage` — while that balance is not enabled. pi's own CLI
warns about this; the GUI did not, so the refusal was the first the user heard of it,
after the provider was connected and a prompt already sent. `NativeProviderOAuth`
carries an optional `extraUsage.url` for such a login, set from `EXTRA_USAGE_LOGINS`
in `native-providers.ts` (Anthropic is the one that works this way — it is a billing
fact, not an SDK capability) and drawn by `oauth-extra-usage-note.tsx` under the
订阅登录 row in the provider detail and in the login dialog's success state.

**Editing a provider never restarts the engine.** `PiProcessManager.reloadProviders()`
mutates the live `AuthStorage` (set/remove keys), rewrites `models.json`, then calls
`ModelRegistry.refresh()` on the *same* instance every session already holds, and
re-points each idle session at the refreshed `Model` object (`agent.state.model`,
quietly — a settings edit is not a user model switch and must not append a
`model_change` entry). A run that is still streaming keeps the config it started
under and is rebound on `agent_end`. Only a cold engine (no runtime/registry yet —
the first provider, or `start()` after a crash) takes
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
while no conversation exists is dropped as soon as one is activated. Nothing may throw
before that branch is reached: `#activeSession()`'s `#ensureReady()` used to reject with
「尚未配置模型供应商」 on an unconfigured engine, which made the chips unusable in exactly
the first-run state they exist for.

**Nothing on the first-run path is an error.** A fresh install has no conversation and
possibly no provider, and that is a state the composer has to work *in* rather than
fail in. There is no status for it: the engine boots normally and the model list being
empty *is* the signal. `App.tsx` holds the composer read-only on that condition
(`canChat` needs a model) with a placeholder asking for one, hides the suggestion chips
that would only fill a box that cannot be sent, and the model chip reads 「添加模型」
with a popover saying 暂无模型 above 管理模型 → 设置 → 供应商. `handleSubmit`'s refusal
(a send with no model keeps the draft and raises the 「还没有配置模型」 alert) stays as
the safety net behind the disabled input — a queued prompt can still drain into it if
the last provider is removed mid-run. Once a provider is connected a send needs no extra
step: the new session resolves its own model (`findInitialModel`), and every
session-scoped choice that could be made before a conversation existed (the
model/thinking chips, 自动压缩 read in `#createSession`) is adopted by the session that
appears.

**A conversation can exist before a model does.** The SDK substitutes a placeholder
model (`provider: "unknown"`, from pi-agent-core's `DEFAULT_MODEL`) on a session that
has none, so a chat created on a fresh install is a real session with no model rather
than a refusal: `#state` reports that placeholder as *no* model (otherwise 「unknown」
would land on the composer's chip), and `#rebindModel` treats it as the 「model is gone」
case, which is how such a conversation adopts the provider the user connects
afterwards.

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
terminal-only surface onto the GUI. Nine **built-in** extensions ship with the app
(`resources/extensions/plan.ts`, `goal.ts`, `todo.ts`, `permission-sandbox.ts`, `session-title.ts`,
`browser-use.ts`, `web-search.ts`, `output-language.ts`, `subagent/index.ts`); anything else
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
  `output-language.ts` is always on: each `before_agent_start` appends the host's
  AI 偏好语言 requirement (from `FASTVIBE_AI_LANGUAGE_PROMPT`) to the system prompt.
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
    `subagent_event` / `subagent_state` / `subagent_lifecycle` (see `#trackSubagentEvent`), which the
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
    included), plus the main composer in its read-only mode (below) — a delegated run
    is not a conversation the user can steer, but it is one they can read and stop. The
    delegated brief is the opening user message, pinned on the
    tab as `subagentBrief`: the pane reads it from there, not from `subagents`,
    because that list is replaced by every `getSubagents` snapshot and a brief
    derived from it blanked the transcript mid-run. The cached transcript is read
    only once the run is over, and the empty state is chosen by the pane rather than
    by `MessageList`, so the scroller is never swapped for it mid-flight. The tab is
    titled `role · 运行中/已完成/已终止/失败`.
  - **The run's own composer, read-only.** `SidePaneSubagent` draws the main
    thread's `Composer` with `readOnly`, and the stop button it keeps is what
    terminates the run. A delegated run cannot be steered, but its state is worth
    reading — which model it is on, how full its context window is — so the pane
    keeps the context ring and its popover, the model and thinking chips (as plain
    `StaticChip` labels, since `Chip` is a button with nothing behind it here), and
    drops everything that would change the run (attach, the permission menu, the
    model / thinking menus, send). `model` / `thinkingLevel` / `contextUsage` are
    pushed as `subagent_state`: the engine holds them, the transcript does not, so
    Main publishes them on `agent_start` / `turn_end` / `agent_settled` (the same
    boundaries the main thread refreshes its ring on) and records them on the
    `SubagentInfo` so a pane opened later gets them from the `getSubagents`
    snapshot. `usagePercent` accepts just `{ contextUsage }` for this, since a
    delegated run has no `EngineSessionState`.
  - **Stopping one run notifies the main agent.** `abortSubagent` aborts the run's
    own session, which settles the parent's `subagent` tool call: the tool returns
    `isError` with `已被用户终止`, and that tool result is what the main agent reads as
    the reason its delegation ended. The run's own lifecycle status is `aborted`
    (已终止), distinct from `error` so a deliberate stop is not drawn as a failure.
    A parked permission prompt is answered first *and scoped to this run* — the run
    shares the parent conversation's UI context, so `#pendingUi` entries carry an
    `owner` and `#resolvePendingUi(conversationId?, owner?)` filters on it; the
    `tool_call` hook cannot observe the abort while it awaits a prompt, so leaving
    it parked would hang the tool. Stop-a-chat still answers every prompt of that
    conversation (its own and its runs').
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
pnpm test           # node's own runner over test/*.test.ts — pure modules only, no DOM
pnpm check:scripts  # only the browser page scripts (a compile error there is a
                    # `Script failed to execute` at tool-call time, not a build error)
pnpm shadcn add <component> -y
```

### 主进程文案里不要出现独立的 `import`

`package.json` 是 `"type": "module"`，主进程产物是 ESM，于是 electron-vite 的
`vite:esm-shim` 会往 bundle 里补一段 `createRequire` 垫片 —— 插入位置由
**正则**（不是 AST）找出的「最后一条静态 import」决定。正则会把任意字符串字面量里
的独立单词 `import` 当成一条 import：一句 `"…compact after import"` 就让它把垫片
插进了 `parts.join("；")` 的引号中间，构建以毫无线索的
`[vite:esbuild-transpile] Unterminated string literal`（指向一个 `join("`）失败。
写主进程英文文案时避开这个词（用 `loading` / `found` 之类替代）。

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
- `src/main/engine/models-dev.ts` reads the user-updated snapshot first
  (`models-dev.json` in the app data dir) and the bundled one second, and is otherwise
  the app's only runtime network call for metadata — always user-initiated, from
  设置 → 关于 (`models-dev-update.ts`). Deleting the updated file falls back to the copy
  the app shipped with, and a corrupt one is ignored rather than trusted. Both writers
  share one encoder (`scripts/models-dev-encode.mjs`, also used by
  `scripts/sync-models-dev.mjs`), so what 关于 downloads is the format the decoder
  already reads; a successful update then re-derives `models.json` through
  `PiProcessManager.reloadModelMetadata()`, which refreshes live sessions like a
  provider edit but never boots a cold engine. `normalizeModelKey` must stay identical
  to `normalize` in the sync script.
- Resolution order: the updated `models-dev.json`, then
  `process.resourcesPath/models-dev/index.json`, then `resources/models-dev/index.json`.
  Packaging must copy the directory via
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
- **Transcripts written before, or by a path that did not time them.** An imported chat, and
  any transcript from a build that predates the timing pass, carries no bounds.
- **A delegated run is timed too.** `#timeReasoning` is keyed rather than conversation-bound and
  is driven for a sub-session as well, filing into `#subagentReasoning`
  (`Map<subagentId, Map<entryId, bounds>>`) instead of the persisted `ReasoningStore` — a
  sub-session is `SessionManager.inMemory`, so its entry ids name nothing once the run ends and
  must not be written to `reasoning.json`. The bounds ride the *inner* event of `subagent_event`,
  because the renderer re-applies that object (`applySubagentStream` unwraps `event.event`).
  Without this a subagent's thinking row fell back to the whole round-trip while it streamed and
  had no timing at all until that round-trip ended.

So `ChatMessageRow` falls back to the span of the **round-trip the block came from**
(`messages[].createdAt` → `completedAt`) whenever a thinking part has no bounds of its own: the
row then reports that whole request's time, an upper bound rather than the thought alone, instead
of a bare 「思考」. Measured bounds always win. The owner lookup is a `Map<MessagePart, ChatMessage>`
built from the row's messages, which works because `mergeAssistantRun` passes thinking parts
through by reference.

## 上下文用量（composer 的上下文环）

The composer's context ring and its popover read `session.contextUsage`, which only a state
reply carries — the engine derives it from the messages it holds (`getContextUsage()`), never
from an event payload. So it is as fresh as the last `reloadActiveState()`.

- **A run grows the context at every turn boundary, so `turn_end` refreshes it.** `turn_end`
  fires after each assistant message — every LLM round trip, tool calls included — and the
  agent immediately feeds the results into the next turn, so the window moves several times
  per run. Only the run boundaries (`agent_end` / `agent_settled` / compaction ends) used to
  re-read it, which left the ring frozen at whatever the chat was opened with for the length
  of a long task. Switching away and back appeared to "fix" it because `conversations.open`
  answers with a fresh `#state()`.
- **Not `message_end`.** An assistant message that only requested a tool call has no usage
  yet, and the tool result that follows does not move the window on its own; refreshing per
  message would re-read the whole transcript several times a turn for a value that cannot
  change. `turn_end` is the first point where the turn's usage (and its tool results) are in.

## 在会话中查找

`Cmd/Ctrl+F`（`findInConversation`）在转录上方打开一条查找栏（`components/chat/find-bar.tsx`）。

- **在渲染层匹配，不问引擎。** 转录已经在内存里（`findMatches` 只扫 `message.text`），
  敲一个字就重读一次磁盘会把「在屏幕上找东西」变成一次 IPC 往返。只搜正文：
  思考与工具输出卡片另有入口，纳入命中列表只会让 `n/N` 数出看不见的位置。
- **滚动用 scroller 自己的 `scrollToMessage`。** 行 id 是引擎的 entry id，不是位置，
  所以重试/编辑分支过的会话仍然落得准。`FindBar` 因此必须渲染在
  `MessageScrollerProvider` **内部**（它用 `useMessageScroller`）。
- **不在打开状态时什么都不做。** 那条滚动 effect 的依赖里有 `matches`，而它在每个
  流式 token 上都是新数组——曾经关掉查找栏后转录仍被每个 token 拽回旧命中、不再
  跟随底部。
- **从命令面板的正文命中进来时**（`onSelectChat(id, needle)`），会话打开的同时把查找栏
  预填成那个关键词：它只能告诉你「这个会话里有」，只有转录能告诉你「在哪里」。

## 顶层错误边界

`components/error-boundary.tsx` 包在 `main.tsx` 的最外层。渲染期抛错会卸载 React 拥有的
整棵树，而这个项目真的发生过：空模型列表下把 group label 画在 group 之外，Base UI 抛
`MenuGroupContext is missing`，整个窗口变白；typecheck 看不见（它是运行时不变式，不是类型错），
子树也拦不住。边界只做两件有用的事：说清楚出了什么错（含报错文本），以及给一条出路
（重新加载界面；会话与运行都在 Main，重载不丢东西）。错误也写进 `logs/renderer.log`
（`logError`）——React 接管的抛出不会到 `window.onerror`，否则最重要的那次崩溃反而查不到。

## 重试与文件回退（checkpoint）

「重试这一轮」回退的是**对话**（`navigateTree`），工作区文件原本留在原地，于是重试是在
上一轮已经改过的代码上重跑——第二次看到一个半应用的编辑，或者一个因为文件已有新内容
而变成空操作的 `write`。两者都是静默的。

- **捕获发生在写入之前。** 引擎在 `tool_execution_start`（工具真正执行**之前**）用
  `readBefore` **同步**读一遍原文，每个文件每回合只读一次（第二次再读就是第一次编辑的
  产物了），然后串行落盘（`captureCheckpoint` 里有 `git rev-parse`，并发会乱序覆盖）。
- **回合边界由 `#beginTurn` 划，不由 `agent_start` 划。** 一个用户回合会发多次 `agent_start`：
  重试、压缩后继续、`agent_end` 排队的继续、goal 模式的下一轮。在那里清空累加器会把
  本回合写过的文件重新读成「原文」，并在一个只读回合后把上一回合的文件表当成本回合的。
  `continueTurn` 不划界（它是同一个回合的续跑）。
- **回退是问出来、不是自动的。** `retryRewind` 弹窗列出文件；「保留文件改动」**也照常重试**
  （它回答的是文件那个问题，不是要不要重试）。用户可能在提示词与重试之间自己动过这些文件，
  所以不能静默还原。
- **回退不全时必须说出来。** 二进制/过大/未被 git 跟踪的文件没有可回退的内容
  （`restoreCheckpoint` 记进 `skipped`），于是拼一个半还原的工作区再重试——正是这个功能
  要防的事。

## 始终允许（permission rules）

`lib/permission-rules.ts`，存在 `settings.permissionAlways`（`method:title:message` 键）。
它曾经是 session store 上的一个字段：不跨会话、重启即失。而「始终允许」一旦会忘，
就比不提供更糟——用户已经不再期待被问了。同一个 bash 模式从每个会话都会到达沙箱，
所以这是一条关于**这台机器**的偏好，不是关于某个会话。键刻意不含会话与请求 id（那正是
要忽略的东西），也不只看方法（`运行命令：npm test` 与 `运行命令：rm -rf …` 的 message 不同）。
设置 → 通用 里有条数与清除。

## 设置跨窗口同步

偏好写在一份 `settings.json`，但每个窗口各持一份启动时读的内存副本。一处写入后 Main 发
`settings:changed`（`broadcast(..., { except: origin })`，不回传给发起者），接收方的
`applyRemote` 只写 localStorage、**不回写磁盘**——回写会让两个窗口永远互相同步。
「恢复默认」（`settings:clear`）也算一次写入，同样要广播，否则另一个窗口会继续用旧副本
并在下次保存时把刚清掉的值写回去。

## 系统通知（设置 → 通用）

`settings.notifications`：`done`（任务完成）/ `approval`（后台会话停在审批上）/ `off`。
Main 在每个事件上读一次文件，所以改完立即生效。两个通知回答的是不同的问题：跑完是
「可以回来看结果」，停在审批上是「你不回答它就永远走不下去」——后者才是真正需要打扰用户的。
只有会阻塞的 dialog 方法算数（`isBlockingPrompt`）；`notify` / `setStatus` / `setWidget`
是单向的，不能触发通知。

## 测试

`pnpm test` —— Node 自带 runner 跑 `test/**/*.test.ts`，只测**纯模块**（无 DOM、不引 zustand/React）：
`lib/diff.ts` 的行号读取、`engine/pricing.ts` 的价格阶梯、`lib/todos.ts` 的 `n/N` 语义、
`engine/checkpoint.ts` 的捕获与还原。这一层抓的是运行时不变式——比如「一个未跟踪路径不能让
整批 `git checkout` 失败」——typecheck 看不见它们。

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

## 自动更新（updater）

`src/main/updater.ts` owns electron-updater. Background checks run once shortly after
launch and then every 10 minutes, and they only ever *announce* a version: downloads are
user-initiated (`autoDownload` is off), from the manual-check dialog or the small button
to the right of the sidebar's 设置 row. The sidebar button and the dialog both read the
same `update:state` stream (`AppUpdateState`), so 「download → progress → restart」 cannot
disagree between them.

**`releaseNotes` is HTML, not markdown.** electron-updater's GitHub provider builds it
from the releases **Atom feed** (`<content type="html">`), i.e. GitHub's already-rendered
HTML — so rendering it with `react-markdown` showed the raw tags. `release-notes.tsx`
parses it and rebuilds a whitelist subset as React elements (never `dangerouslySetInnerHTML`;
unknown tags unwrap, `javascript:` hrefs and `<script>` are dropped), and falls back to the
markdown renderer when a feed does hand us markdown.

## Product constraints

- Code / Office / Cowork are first-class; pi-coding-agent is the default backend.
- Office and extra ACP agents come later; keep Host adapters (RPC/ACP) decoupled from the renderer.
- Built-in model provider is **fastvibe** (`https://fastvibe.dev/v1`). The user pastes an API key; FastVibe fetches `/models`, writes isolated `models.json`, then starts the embedded engine. Do not mention the backend runtime in the UI.
