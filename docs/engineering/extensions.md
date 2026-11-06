# 扩展、技能、MCP 与工具桥接

涉及扩展加载、技能发现与市场、CUA、浏览器、问题 UI、MCP、codemode 和工具搜索时阅读。

关联入口：[Agent 编排](automation.md)、[会话生命周期](session-lifecycle.md)、[工作区与媒体](workspace-and-media.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## Plugins & extensions

> 隔离模式下的目录与安装描述保留在此；全局模式共享 pi 配置及资源，模式边界以 [Pi 引擎模式](../pi-engine-modes.md) 为准。技能的实际清单以源码入口为准。

The 插件 pane (`#/settings/extensions`, `components/plugins/plugins-page.tsx`) lives in
Settings directly below 技能; the workspace sidebar has no plugin entry. FastVibe hosts pi extensions (the SDK's plugin system) and bridges their
terminal-only surface onto the GUI. **Built-in** extensions ship with the app
(`resources/extensions/goal.ts`, `handoff.ts`, `todo.ts`, `question.ts`, `folder-consent.ts`, `session-title.ts`,
`browser-use.ts`, `computer-use.ts`, `web-search.ts`, `conversation-search.ts`, `worktree.ts`,
`output-language.ts`, `app-config.ts`, `schedules.ts`, `subagent/index.ts`; the full current list is `BUILTIN_EXTENSIONS`. `dag.ts` belongs to the [historical DAG material](automation.md)); anything else
the user installs at runtime via 设置 → 插件, which writes to the isolated `agentDir`
(`ExtensionManager` → SDK `DefaultPackageManager`), never `~/.pi`.

## 技能发现、路径与同名遮蔽

**内置技能是另一套东西**：`resources/skills/<name>/SKILL.md`，由 `builtinSkillPaths()`（`BUILTIN_SKILLS`，
新增一个就要在那里加一行）列进每个会话的 `additionalSkillPaths`。它们只是提示词，不注册工具，也不需要
`extraResources` 之外的处理（`resources/skills` 已经整目录拷到 `resourcesPath/skills`）。具体清单以 `builtinSkillPaths()` 为准，包括 Office/PDF 等技能。`browser-use`、`computer-use` 是 FastVibe 自写；
技能的上游来源包括：`skill-creator` 来自 anthropics/claude-plugins-official（Apache-2.0），`find-skills` 来自
vercel-labs/skills（MIT）——各自目录里带 `LICENSE.txt`，`SKILL.md` 的 description 都改成了中文，并加了
「你运行在 FastVibe 里」一节纠正原文里不成立的部分（`skill-creator`：`claude -p` 子进程、评测 HTML
viewer、`present_files` 都不存在，流程要落到对话里；`find-skills`：`npx skills add` 默认装到
`~/.claude/skills` 这类目录，FastVibe 读不到，必须加 `--agent universal`）。它们不可删除：`SkillManager`
的 `removable` 只看 `agentDir/skills`，所以内置技能在 设置 → 技能 里显示为全局且没有删除按钮。

**同名技能会静默遮蔽，且用户目录胜出。** `loadSkills` 按名称去重（`addSkills`），先到先得：`additionalSkillPaths`
（内置）在 `enabledSkills` 之后，所以 `~/.agents/skills/find-skills` 会把内置的同名技能顶掉，只留一条
`type: "collision"` 诊断——而 设置 → 技能 只渲染 `skills`，**界面上看不出发生了遮蔽**。本机就碰上了这样的
组合（用户目录里有一个 `find-skills`）。所以新增内置技能前先确认没有常用名字会被用户版本盖住；真要确认
生效，得看 `filePath` 指向哪个目录，不能只看列表里有这一行。

**人写的技能落在 `.agents/skills/`，这是 SDK 原生发现路径，不是 FastVibe 自己加的**（`package-manager.js`
的 `resolve()`：`~/.agents/skills` 恒为 user，`<cwd>/.agents/skills` 及各级祖先目录为 project——后者还要
过项目信任，`SettingsManager.create` 默认 `projectTrusted: true`，FastVibe 不开 preTrust 那套）。所以
「技能放哪」有四种答案，而 设置 → 技能 只能把前三个里的一部分标成「全局」/「项目」：

| 路径 | scope | FastVibe 里可见 | 备注 |
| --- | --- | --- | --- |
| `~/.agents/skills/<name>/` | user | ✅ | 全局，机器上每个项目（**推荐**） |
| `<cwd>/.agents/skills/<name>/` | project | ✅ | 只在该项目及子目录（**推荐**） |
| `<cwd>/.pi/skills/<name>/` | project | ✅ | pi CLI 的位置；能用但没人知道，别用 |
| `~/.pi/agent/skills/<name>/` | user | ❌ | agentDir 被指到 FastVibe 自己的目录，读不到 |
| `runtime/engine/agent/skills/` | user | ✅ | FastVibe 私有（`paths.skillsDir`），设置里可删 |
| `resources/skills/` | user | ✅ | 内置，随包发布，不可删 |

祖先目录里的 `.agents/skills` 也会被扫（到 git 仓库根为止），但会盖到同项目下一堆无关子目录上，几乎总是弄错。

`skill-creator` 的「技能写到哪里」一节把这件事写成了一条硬规则：**先问用户全局还是项目，再动手写**，
不能默认往 `.agents/` 里塞。

## 从 skills.sh 搜索并安装（`engine/skills-market.ts`，设置 → 技能）

技能市场这一步以前只存在于 `find-skills` 这个技能里：让模型去 shell 一句 `npx skills add`。
现在 设置 → 技能 自己就能搜、自己就能装，装完的行和手写的技能完全一样——同一个列表、同一个删除按
钮。三个方法（`engine:search-skill-market` / `engine:skill-market-detail` / `engine:install-skill-market`）
都进中立调用表，桌面与 SSH Agent 注册同一份，也都允许远程调用：整条路上没有一个本地对话框，手机
因此比 `导入` 反而多做得了事。

那一行的控件因此是 **搜索 / 刷新 / Skill 市场 / 导入**：`导入` 从 ⋯ 菜单提到了一级按钮，手写技能的
`新建` 入口去掉了。`engine:create-skill` / `SkillManager.create` 留着，但**现在没有任何调用方**——方法
本身能建一个技能，只是界面上没有按钮了；要恢复入口就在同一行加回一个，要真删就连着方法、通道和策略
条目一起删，别只删一半留一个没人调的入口。

- **不再走 `npx skills`，是有意为之。** 那句话要 Node 工具链在 PATH 上（安装版里不成立），要在终端
  里盯着它跑完，而且它的 `--agent` 落点 FastVibe 未必读得到：`universal` 的全局目录是
  `~/.config/agents/skills`，`pi` / `codex` 才是 `~/.agents/skills`。自己取归档、自己写盘，换来的是
  一个可测的函数和一条不会骗人的成功提示。
- **`skillId` 不是仓库里的目录名。** skills.sh 发布的是 SKILL.md 的 `name:`，`vercel-labs/agent-skills`
  就把 `react-best-practices/` 这个目录以 `vercel-react-best-practices` 的名字发布。所以安装先读归档
  里每个 SKILL.md 的 frontmatter 再比名字，退回目录名；**匹配不上就说清仓库里有哪些**，因为「找不到」
  和「这个仓库根本没有技能」是两件事，而后者才是真的没有。
- **同名技能不会被悄悄盖掉。** SDK 按名字去重、先到先得，静默写第二份等于一次假装成功的安装；
  所以只有当已有那一份是 FastVibe 自己装的（`removable`）才允许覆盖，内置 / 项目 / 用户自己
  `~/.agents/skills` 里的一律拒绝并说明原因。覆盖是「先搬开、再改名、失败搬回来」，一次装坏不会
  留下一个空目录。
- **只有 GitHub 的 `owner/repo` 装得了。** 索引里也返回裸域名来源（`developer.paddle.com`、
  `skills.volces.com`），这类行画成「该来源需在网页上安装」而不是一个注定失败的按钮；`a/b/c` 这种
  三段路径同样拒绝，不猜。
- **不 shell out `tar`。** `cua-driver-install.ts` 那么做是有先例的，但那条路只在 macOS。一次安装会
  跑在 Linux 无头 Agent 和 Windows 上，那里「有没有 tar」不是能赌的 yes；Node 自带 zlib，而 tar 里
  真需要的那几种记录（POSIX `prefix` 字段——实测 GitHub 的归档就用它拼超过 100 字符的路径、GNU `L`
  长名、PAX `path=`）加起来不到 200 行，就是 `engine/gzip-tar.ts`。它只交出表头和被点名的字节，
  **从不写盘**：链接是一种要被看见、然后跳过的类型，而不是一个可以照抄的文件。
- **上限写在动手之前。** 下载 48 MiB（GitHub 的源码归档实测 0.8–4 MiB）、单技能 400 个文件 /
  24 MiB、解包总量另有上限；归档里的每个路径都要过 `safeRelativePath`，`..` 段一律拒绝（哪怕它折回来
  还在目录内——源码归档不该有这种段，放宽它只是给构造出来的归档多一条路）。
- **搜索索引没有说明文字**，只有 slug、来源和安装数，所以说明是点开那一行时才去取一次
  `<meta name="description">`，不是给三十行各发一个请求。搜索结果按查询缓存 5 分钟，重新搜索按钮带
  `refresh` 越过去——安装数这种东西，用户就是想再看一次。
- **装完走 `#reloadSkills()`**，和 新建 / 导入 同一条路：空闲会话立刻重载，正在回复的那一条等它 settle。
- `fastvibe_config_*` 因此多了 `skills.market_search`（读）与 `skills.market_install`（写），智能体也
  能用同一句话装技能，不必再借终端。内置技能 `find-skills` 已改成先荐这条路。
- 预览：`mock.html?dialog=skills-market#/settings/skills`（`&q=paddle` 看不可安装来源那一行，
  `&lang=en` 看英文不溢出）。

## 宿主工具不设审批门禁

- **No approvals.** FastVibe never asks the user to approve a tool call: there is no
  permission mode, no sandbox extension, no 始终允许 list and no 完全访问 warning, and a
  tool runs as soon as the model calls it. What still reaches the user is a *question*
  (`question`, `ctx.ui.select` / `input` / `confirm` from a plugin), which is the agent
  or a plugin asking for information, not FastVibe gating an action. `folder-consent.ts`
  is the one extension that hooks `tool_call`, and it never blocks or asks: it stats a
  macOS-protected folder (Desktop, Documents, iCloud…) from the main thread before a
  tool touches it, because the OS only remembers its own folder dialog when the access
  came from there (`mac-folder-consent.ts`). Do not re-add a gate here without the
  user asking for one.

## 电脑操控与 CUA 桥接

- **Computer use** downloads its engine the first time 设置 → 电脑操控 → 允许操作电脑 is turned on. The installer does not carry the `cua-driver` worker or the `@trycua/cua-driver-*` native library (together ~80 MB). The small JS bindings stay, so the platform package can be resolved from the data directory after the download. A dev tree still fetches the worker in `predev`. Do not put either artifact back into `electron-builder.yml`.
- **CUA 观测和操作桥接**（`src/main/pi/cua-bridge.ts`、`resources/extensions/computer-use.ts`）必须把 SDK 的结果分成两条路径：模型通过 `content` 读取可行动文本和结构化结果，渲染层通过 `details` 读取完整元数据。`window_state` 保留旧的交互元素 `elements` 兼容形状，并在 `treeElements` 提供完整无障碍树、层级、截断/降级状态和截图实际尺寸；截图经过 bridge 的压缩后，快照里的尺寸、MIME 和 scale 必须对应压缩后的图片。动作结果的 effect、route、verification 和 evidence 枚举先转成人类可读值再交给模型。
  - 工具流程是「定位应用 → 定位窗口 → 读取窗口树 → token 操作 → 验证结果」。`computer_verify_state` 用于点击、输入、拖动后的状态确认；`computer_batch` 只允许参数完整的 action 联合，最多 32 步，不能把半个窗口作用域静默降级到桌面作用域。
  - CUA SDK 的 session、授权、运行时诊断和 cursor 主题配置属于宿主控制面，不注册成模型工具；模型可用的动作包括窗口观测、点击、输入、按键、滚动、拖动、移动指针、调整窗口、屏幕/指针观测、状态验证、菜单和剪贴板。
  - 这条契约由 `test/cua-observation.test.ts`、`test/cua-driver-spec.test.ts` 和 computer-use extension 的 TypeScript 检查覆盖。新增 CUA SDK 字段时先更新 bridge 的 model-facing content，再更新 details 和测试，不能只扩展 Main 的内部类型。

## 内置浏览器桥接

详细实现和复验入口见 [浏览器自动化](../browser-automation.md)。默认保留 DOM 语义快照；可选原生 Accessibility 模式共享两种后端的 CDP 映射。区域读取使用唯一 selector 或最新 rootRef，深度/节点预算与未展开的 iframe 边界必须可见。

- **Browser use** — `browser-use.ts` is the tool surface for FastVibe's own side-pane
  `<webview>`; it holds no browser code. Every call crosses `browser:request` /`browser:response`
  (`src/main/pi/browser-bridge.ts`, one pending map keyed by request id, 30s default budget) into
  `handleBrowserRequest` (`components/layout/side-pane-browser.tsx`), which owns the webview
  registry and injects the page scripts. The payload is **one shared `BrowserRequest`**
  (`@shared/types`) — the extension, the bridge and the renderer must not re-declare it.
  - **Script batches use `codemode`, not a second browser runtime.** Every `browser_*` tool
    declares an `outputSchema` and returns `structuredContent`, so scripts consume objects
    (`page.elements`, `opened.tabId`) and tab-list arrays directly. A failed action (`ok`,
    `clicked`, `filled` or `loaded` equal to false) throws with its diagnostic data: merely
    returning `isError` with structured content would still resolve inside codemode and let a
    form keep submitting. One script can observe, branch, fill, submit and verify while only
    returning the required result to the model. Same-tab steps are sequential; independent
    reads on different tabs may run in parallel. A disabled codemode keeps direct tools usable.
    `browser_wait` polls a cheap shared `checkBody` through both backends for visible selector,
    body text and/or URL substring (all supplied conditions must match, 10s default, 60s max),
    pins the first resolved tab and honours Stop between probes and during its delay. Probes
    never re-stamp snapshot refs. Tool descriptions, prompt guidelines and the built-in
    browser-use skill all teach this route. `test/browser-script.test.ts` runs the real SDK
    and QuickJS for structured return values, sequential execution, failure before submit,
    timeout, tab pinning and cancellation; page-condition semantics are tested separately.
  - **Injected scripts are the fragile part.** Electron reports a script that never compiles as
    `GUEST_VIEW_MANAGER_CALL: Script failed to execute`, naming neither the script nor the cause —
    a single missing brace made every `browser_snapshot` fail. So page scripts are wrapped
    (`inject`) to return `{ok, value|error}` as data, and `pnpm check:scripts`
    (`scripts/check-injected-scripts.mjs`, wired into `typecheck` and `prebuild`) parses each one
    with its `${...}` interpolations neutralised. Add a page script → it must stay parseable.
  - **Elements are addressed explicitly.** Each snapshot owns a new opaque Ref namespace
    and a Map of exact DOM objects; `data-fv-ref` is only an annotation, never identity.
    Re-snapshotting, navigation and node replacement invalidate earlier refs. A supplied ref
    that cannot resolve returns `STALE_REF` and never falls through to selector or text.
    Snapshots retain `elements` and selectors in `structuredContent` / `details` for Codemode
    compatibility, while model-facing `content` is compact semantic text with hierarchy,
    names, states and non-duplicate page text. Password/file values must stay suppressed.
    Scoped reads resolve the exact root before invalidating prior refs; invalid or ambiguous
    scopes must fail rather than return a whole page. Drill-only refs are recorded separately
    and cannot dispatch clicks. AX refs are bound through `backendDOMNodeId` in the same
    private execution context, never reconstructed by role/name. Unmapped virtual nodes and
    iframe boundaries cannot acquire actionable refs; incomplete results carry limitations.
  - **Input routes are explicit.** Shared native input execution uses Chromium CDP `Input`
    events; this is browser input injection, not physical hardware. Semantic controls retain
    a labeled page-script fallback before native dispatch. An uncertain delivery cannot be
    replayed as a DOM click. Stop/deadline checks prevent subsequent input; releasing held
    buttons or keys remains cleanup. A successful click still needs an observed result.
  - **Reuse, not sprawl.** `browser_open` navigates the tab already on screen (one Chromium guest
    per call made later calls slow and timeout-prone); `newTab: true` is the escape hatch. A tool
    never un-collapses the pane to show that tab (`openBrowserQuiet`): the page loads parked, the
    tab sits in the bar, and the pane opens only when the user opens it — the same rule a delegated
    run's tab follows. Opening the browser from the pane's own menu still shows it. A
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
  - **A guest's popup never becomes a second window.** A `window.open` — or a `target="_blank"`
    link, which the injected click runs like any other click — was answered by Electron's
    default window-open handling, which *creates a `BrowserWindow`*: a chrome-less guest no pane
    owns, shown in front of whatever the user was doing, with nothing on screen to explain it.
    `guardGuestPopups()` (main, registered before any window exists) denies every one of them
    and loads the address in the tab that was already being driven instead — which is what the
    model meant by clicking the link, keeps the tab id it holds valid, and leaves the pane's
    `did-navigate` listener to keep the title and `Entry.url` in step, so a recovery resumes the
    popup page rather than the page it opened from. Only `http(s)` is followed: every other
    scheme carries no address of its own or is a hand-off to another program — the same
    interruption through a different door. The pane's webview carries `disableDialogs` for the
    same reason one door over: a page's `alert` / `confirm` / `prompt` is a native modal by
    default, which lands in front of the user *and* parks the guest, so the tool call waits on a
    button nobody is there to press.
  - **A guest is never re-parented.** Chromium tears the guest down when its `<webview>`
    element is moved in the DOM — every call after that fails with `Invalid guestInstanceId`,
    and re-assigning `src` does not bring it back. So every guest's host lives in one layer
    (`getLayer`) that is attached to `document.body` once and only *positioned*: stretched
    over the tab's viewport while that tab is on screen, parked off-screen otherwise
    (`showGuest` / `parkGuest`, never `appendChild`). The park/edit-run design this replaced
    moved the host out of the park when the pane mounted it, so the guest died on open,
    `usable()` retired the fresh tab, and retiring the last tab collapsed the pane — the
    闪一下 the side pane did when a tool opened the browser. The layer follows the pane's
    width through its clipping ancestor's rect — the panel's own clipping box, which is what
    shrinks, so the guest is never wider than the pane it sits in; a parked or momentarily
    zero-sized guest stays found
    (`guestAlive` probes `getURL`), which is what keeps browser-use in a background chat
    working.

## 网页与会话搜索

- **Web search** — `web-search.ts` registers a client `web_search` tool only while the
  session model speaks `openai-responses`. Execute opens a *side* `{baseUrl}/responses`
  request with the hosted `{ type: "web_search" }` tool (auth from `modelRegistry`); it is
  **not** injected into the main conversation, because pi-ai cannot parse `web_search_call`.
  Completions / Messages models drop it from the active set. Do not vendor `pi-web-search`.
- **Conversation search** — `conversation-search.ts` registers `conversation_search`, which
  treats a catalog conversation id like a file path and a focused query like `grep`. Main
  resolves the id through the catalog, searches the target's current branch without activating
  it or creating an `AgentSession`, and returns bounded snippets plus a little surrounding
  transcript. A session already in memory supplies its live branch pointer; an unloaded one is
  parsed into `SessionManager.inMemory`, never `SessionManager.open`, so a read cannot migrate
  or rewrite the transcript. System prompts, thinking blocks, images and hidden custom messages
  are excluded. It is available to main sessions only;
  throwaway subagents still load just `folder-consent`.

## 应用配置、展示与 Worktree

- **App config** — `app-config.ts` registers `fastvibe_config_get` / `fastvibe_config_apply`, the
  agent's hands on FastVibe's *own* settings panes; the built-in skill `resources/skills/fastvibe-setup`
  is the playbook (how remote access, MCP servers and the UI settings are filled in for the user).
  The extension holds no settings code: `ctx.ui.appConfig` reaches `runAppConfig`
  (`src/main/app-config.ts`, injected with `engine.setAppConfigHost` so an SSH Agent runtime answers
  "not available"), which dispatches the very methods the panes call, so writes broadcast like a click.
  - **An allowlist, never a channel pass-through.** Actions are named in `src/shared/app-config.ts`
    (Main's table is typed against it); `overview` and every unknown-action error serve the catalog,
    because the extension ships as a loose file and cannot import `@shared` to list it.
  - **No action returns a secret** (SSH passwords stripped), and
    **`settings.set` refuses `remote*` and `proxy*` keys**, which have their own actions.
  - **The remote-access password never reaches the model**: `remote.set_password` collects it with
    `ctx.ui.input` inside the extension. Writes run without a confirmation; the skill tells the
    agent to say what it is about to change first.
- **Present** — `present.ts` registers `present`, which puts an image, a video, an HTML page or an Office document into the conversation; see [会话内联预览](workspace-and-media.md).
- **Worktree** — `worktree.ts` exposes list / create / bind / unbind over the host's
  worktree methods. Creating or binding **switches the conversation's workspace**, which is
  a change to the user's machine they never asked for, so the tool's prompt guidelines make
  the agent state why and stop, then wait for the user to agree — a suggestion, not a
  decision.

## 扩展加载与 GUI 接入

- **Loading** — `src/main/pi/extension-manager.ts` resolves the built-in entry
  points (from `resources/extensions` in dev, `resourcesPath/extensions` packaged;
  `electron-builder.yml` copies them via `extraResources`) and `#createSession`
  passes them through a per-session `DefaultResourceLoader`
  (`additionalExtensionPaths`). `pnpm-workspace.yaml` pins `@earendil-works/pi-tui`
  to the SDK's version so host and plugins share one instance. The SDK keeps loaded
  extensions for **one cwd at a time** and loads them all again for a session in another
  folder — and every scratch chat has its own — so jiti's disk cache matters: ~110 ms of
  transpiling per open without it, ~6 ms with it. It stays on in packaged builds too: jiti
  writes it under `os.tmpdir()/jiti` (the loader inside the asar has no `node_modules/.cache`
  beside it), switches itself off when that is not writable, and keys each file by a hash of
  its source, so an update cannot serve stale code. Do not set `JITI_FS_CACHE=false` again.
- **Mode** — `bindExtensions` binds `mode: "rpc"` (not the default `"print"`).
  TUI-first plugins gate on `ctx.mode`, and `"print"` makes them refuse to run;
  `rpc` also makes them fall back to string widgets / select-editor dialogs.
- **Dialogs** — `select/confirm/input/editor` flow through `extension_ui_request`
  / `respondPermission`, and FastVibe adds a non-SDK `questions` method to the UI
  context (`#extensionUi` → `FastVibeExtensionUIContext`) for single-panel
  multi-question prompts; `questions` answers ride `respondPermission.answers`.
  `confirm` (a yes / no question), `select` (pick an option), `input` (free-form answer)
  and `questions` (multi-question, paged) render as the inline `PermissionPanel` in the composer
  slot — one panel for every kind of question; only
  `editor` (multi-line prefill) keeps the modal `PermissionDialog`.
- **A dialog that holds typed text does not close on an outside press.** `PermissionDialog`
  passes Base UI's `disablePointerDismissal` for `editor` and `input`: a modal backdrop covers
  the whole window, so one stray click anywhere outside the popup used to throw away a summary
  or answer that took a while to write. Cancel and the ✕ (and Escape, which is deliberate) still
  close it. `confirm` / `select` keep the ordinary behaviour — there is nothing typed to lose.
- **Fire-and-forget UI** — `notify`, `setStatus`, `setWidget` (string lines) and
  `set_editor_text` reach the renderer store and render as toasts, a status row, a
  panel above the composer, and composer prefill (`ExtensionWidgets`,
  `ExtensionNotices`). A status key FastVibe draws with its own chrome is listed in
  `BADGE_STATUS_KEYS` (`extension-surface.tsx`) so the same sentence is not printed
  twice: `goal` is the `GoalPanel`, `goal-armed` a badge, and `handoff` the composer's
  own placeholder. A surface that knows which chat it belongs to reads a named status by
  id (`useExtensionStatusValue`) — `useExtensionStatus` answers for the chat on screen,
  which puts a 辅助对话's composer on the main chat's state.
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

## TODO: remaining TUI→GUI gaps

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

## MCP（`src/main/pi/mcp-manager.ts`）

MCP servers are configured in 设置 → MCP 工具 and stored in `mcp.json`. The wire protocol is
**`@earendil-works/pi-mcp`** (the standalone library pi's own MCP support is built on): `McpClient`,
`StdioTransport`, `StreamableHttpTransport`, `toLlmContent`. FastVibe's `McpManager` stays the owner
of connections, config and the settings pane's status.

- **Not pi's built-in MCP extension, on purpose.** `createMcpExtension()` keeps its state inside the
  factory call, so every session would spawn its own copy of every stdio server (N chats × M
  servers), where `McpManager` connects once per engine and hands the tools to every session. It
  also exposes no connection state — the settings pane's 已连接 / 工具数 / 错误 has nothing to read —
  and its `/mcp` manager and sign-in screens are terminal UI. SDK sessions do not load the built-in
  extensions at all (only the CLI does), so nothing here is switched on by an upgrade. Revisit if pi
  exports a status API and a way to share connections.
- **Tool names stay `mcp_<id>_<tool>`** (pi's would be `mcp__<server>__<tool>`): the id is stable across
  renames and the transcript, sandbox and renderer already know this shape.
- **A stdio server gets a short inherited environment** (`PATH`, `HOME`, `USER`, `SHELL`, `LOGNAME`, `TERM`,
  plus `LANG` / `LC_CTYPE` — see [终端与子进程的 locale](desktop-runtime.md); the Windows equivalents) plus its own `env` —
  `inheritEnv: false`. The transport's default is
  all of `process.env`, which is the app's business, not the server's. A test pins this.
- **Results keep their images** (`toLlmContent`; the old text-only join turned an image into a JSON
  string), and an `isError` result sets the tool result's error flag — the model is told the call
  failed instead of reading an error as an answer. The call's `signal` is passed on, so Stop cancels it.
- **A server that exits later is shown as down.** `client.onClose` drops the connection from the map
  and records 「连接已断开」, guarded by identity so a deliberate reconnect (`connectAll` closes first)
  is not reported as a loss. There is no lazy reconnect: save the settings or reload to bring it back.
- **Servers connect in the background; the engine does not wait.** `start()` used to `await
  connectAll()` before building the first session and reporting ready, which put the slowest server
  (an `npx` download, a remote endpoint) in front of the first chat — 0.5–1.5 s on a normal config and
  up to the 20 s the two connect timeouts allow. `#startMcpConnect` now runs it behind `start()`; when it
  finishes, every live session is queued for the same `session.reload()` a settings change uses
  (skipped when nothing connected, so a user with no servers pays no reload). A session registered
  *between* its extensions reading the tool list and the connect finishing is caught at registration by
  `#mcpVersion`. **A turn still sees the tools:** a person's prompt waits up to 3 s for the connect
  (`MCP_PROMPT_GRACE_MS`), queued rows and scheduled tasks wait for all of it (`#promptWhenIdle`), and the
  settings pane waits 1.5 s so it shows how each server ended up. `McpManager.connectAll` stamps each run
  with a generation taken *synchronously* (before its first await); a connect that finishes under an
  older number closes its client and records nothing, so an overlapping save or a `stop()` cannot leave a
  child process unowned or refill the map the newer run just emptied, and a save never waits on a hung
  server. The log line `[mcp] k/n servers connected in N ms (in the background …)` says how long it took.
- **重新连接 (设置 → MCP 工具，每个服务器行右侧的刷新图标).** `engine:reconnect-mcp-server` `{ id }` →
  `PiProcessManager.reconnectMcpServer` → `McpManager.reconnect(id)`: drop that one connection, connect it again, leave the
  others alone, then queue **every** live session for `session.reload()` and await the idle ones (a second pass covers a
  reload that was already running and never saw the sessions queued just now). A session in the middle of a reply is
  reloaded when it settles, never under a tool call. `reconnect` bumps a per-server epoch, so a connect of the same
  server still in flight (the launch-time one, a hung endpoint) closes itself when it finally answers instead of
  replacing the newer connection. It saves nothing, so unlike `engine:save-mcp-servers` it is not in the gateway's
  config-sync set: an SSH Agent's own servers are untouched. A disabled server's button is disabled (the toggle is what
  connects it); the toast says whether *that* server ended up connected, and the row's badge carries the reason.
  Allowed remotely, registered on the headless Agent too. Preview: `mock.html?lang=zh#/settings/mcp`.
- **The form edits the standard `mcpServers` JSON as well as fields.** `shared/mcp-config.ts` is the one
  reading of that shape — Claude Desktop / Claude Code / Cursor (`mcpServers`), VS Code (`servers`), a bare
  name → entry map, or a README fragment missing its outer braces. The settings pane (paste, edit one
  server) and Main (reading a stored `mcp.json`) both go through `serverFromEntry`, so they cannot
  disagree about what an entry means. Differences between the two callers are deliberate: pasting refuses
  `type: "sse"` (this app cannot speak it) with a reason, while loading a stored file reads it as HTTP
  (`lenient`) so the row stays in the list and the connection error explains itself.
- **Pasting merges by name and keeps the stored id**; editing one server replaces it whatever it is now
  called. The id is what the engine names the server's tools by.
- **`env` is edited as `KEY=value` lines and `headers` as `Name: value` lines** (`parseMap`). The value is
  everything after the first separator, so `Authorization: Bearer a:b` and `URL=https://x/?a=b` survive,
  and a line that is not an entry blocks saving instead of being dropped. The textareas switch off
  spell-check and auto-capitalisation: a phone keyboard otherwise "corrects" a token.
- **Secrets in `mcp.json` reach the renderer.** `engine:list-mcp-servers` returns `env` and `headers`
  values so the form can show them for editing, to the remote client as well — the same trust as asking
  the agent to run a command, and the reason no policy change was needed. The settings pane strips the
  status fields (`connected`, `tools`, `error`) before saving, so they are not written back to the file.
- **Not done: OAuth sign-in** (the main reason to want pi's MCP). `pi-mcp/oauth` has the flow (PKCE,
  discovery, dynamic registration, a loopback callback server); what is missing is a credential store,
  a 登录 control in the pane and an IPC method — which opens a browser on the host, so
  `server/policy.ts` has to classify it. Servers that need a bearer token work today through `headers`.
- Not done either: tool-result truncation (a huge result goes into the context whole, as before)
  and MCP resources.

## 代码模式 and 工具搜索（`codemode` / `tool_search`）

Two SDK tools, loaded in `#createSession` as the hidden extensions `fastvibe-codemode` and
`fastvibe-tool-search` (the SDK loads neither in an SDK session by itself; only its CLI does).
`codemode` takes one argument, `code` — JavaScript source, not JSON — and runs it in a QuickJS
sandbox on a worker thread; the script calls other tools as `tools.<name>(…)` (in parallel, if it
likes) and only what it prints reaches the model. `tool_search` finds tools that are not declared
and declares the matches for the next request.

- **On by default, with a switch each** (`settings.codemode` / `settings.toolSearch`, 设置 → 偏好设置
  → 对话 — agent behaviour, and `codemode` works with no MCP server at all). The keys are read as
  *off only when `false`*, so an install that never wrote them has both; the renderer's default is
  `true` and drops a non-boolean. Both tools are registered inactive, and `fastvibe-tool-modes`
  (`engine/tool-modes.ts`) sets their place in the active set on every `session_start`, a reload
  included — the SDK's `defaultTools` setting can only add, never take away. An enabled MCP server
  whose `exposure` can only be reached through a tool keeps that tool on even with its switch off:
  a `codemode` server has no declared tools without `codemode`, and a `deferred` one has none until
  `tool_search` loads them (the rule pi's own MCP support applies when a server connects). Everything
  else in the active set is left as it was, so a set another extension narrowed stays narrowed.
  The cost of leaving them on is their descriptions in every request (pi measures about 3.3K tokens
  for `codemode` with the default tools), which is what the switches are for.
- **A settings write that changes either key reloads every session** (`refreshToolModes`, the MCP
  reload path: an idle session at once, a running one when it settles). `toolModeSettingsChanged`
  compares exactly those two keys, so no other setting costs a reload.
- **`exposure` is per server** (`direct` | `deferred` | `codemode`; default `direct`, which is *not* pi's
  default of `codemode` — an existing server must not lose its tools). It is the form's select, the
  JSON's `exposure` key (pi's `codemode-deferred` spelling reads as `codemode`; `hidden` reads as
  switched off) and the `exposure` / `namespace` the tool is registered with. The namespace carries
  the server's name and its own `instructions`, which a script reads with `describeNamespace()`.
- **Nested calls go through the same hooks as direct ones**, and arrive as `tool_execution_*` events
  with `parentToolCallId` (ids `<call>/<n>`). The renderer keeps such a call in `message.tools` — the
  turn's changed-file chips read it, so a script's `write` is still listed — but gives it no row
  (`ToolCallBlock.parentId`, and `upsertTool` pushes no part for it). The `codemode` card draws the
  calls itself from `details.calls`, which each streaming `tool_execution_update` carries, so the
  list fills in while the script runs. After a reload the nested calls are not in the transcript
  (the SDK does not persist them as messages), so the card still lists them but a script's `write`
  no longer appears among the changed-file chips.
- **The sandbox runs from inside the asar**: a script with two parallel tool calls was run from a
  packed `app.asar` under Electron in node mode (`ELECTRON_RUN_AS_NODE`) and returned the same as from
  a plain directory, so no `asarUnpack` entry was added. It has not been run in a packaged window.
- **Hooks**: a script's nested calls reach `tool_call` hooks like any other call.
- `test/codemode-session.test.ts` runs the real SDK end to end — extensions, an MCP server behind
  `McpManager`, a scripted model (`createFauxCore`) — so what is declared, what a script can reach and
  what the events look like are pinned together.
