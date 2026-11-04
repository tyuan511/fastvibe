# 架构、调用表与会话快照

涉及跨进程接口、快照恢复、目录广播、多文件夹上下文与会话作用域时阅读。

关联入口：[App Server 协议](../app-server-protocol.md)、[多文件夹项目](../multi-folder-projects.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 产品与数据边界

Electron desktop client for agent work, code, office, and multi-agent cowork. The default engine is the embedded **`@earendil-works/pi-coding-agent` SDK** running in the Electron main process. Conversation transcripts and FastVibe business data stay under userData. Pi configuration may come from the isolated runtime or the user's global pi directory; see [Pi 引擎模式](../pi-engine-modes.md).

## Architecture

> 以下目录图以隔离配置为例；全局 pi 配置来源见模式文档。DAG 文件与表名来自历史布局，不能据此推断当前仍提供 DAG 工具，详见 [历史 DAG 资料](automation.md)。

```
src/main/          Electron main: window, IPC, and embedded agent lifecycle
  engine/          Isolated runtime paths, provider configuration, and shared model/file helpers
  ipc/             Transport-neutral call table and broadcast hub
  pi/              Embedded pi-coding-agent host, MCP bridge, and multi-session lifecycle
src/preload/       Electron half of `window.fastvibe` (the shape is `src/shared/api.ts`)
src/renderer/      React UI (Vite renderer)
  src/components/ui/   shadcn-generated primitives only
  src/components/      product composition (chat, layout)
src/shared/        IPC channels and types used by main + renderer
```

Runtime data lives under the app userData directory:

```
~/Library/Application Support/FastVibe/
  settings.json          UI prefs (theme, chat behaviour) — not localStorage
  fastvibe.db            所有「数据类」状态：会话目录、检查点、思考耗时、记忆账本、
                         排队消息、DAG、定时任务（见 SQLite 存储）
  dag.json.results/      每个 DAG 节点运行的完整产出文本（大块产物，仍是文件）
  providers.json
  account.json           FastVibe account sign-in (device token + who it is), 0600, never served
  mcp.json
  models-dev.json        models.dev snapshot refreshed hourly and from 设置 → 关于; wins over the bundled one
  runtime/engine/
    agent/sessions       session transcripts, passed to the SDK's SessionManager
    agent/.env           provider API keys, injected into the SDK's in-memory auth storage
    agent/oauth.json     subscription (OAuth) tokens — the one credential written to disk
    agent/models.json    the only provider config the SDK reads (custom + builtin providers)
    usage-ledger.jsonl   append-only record of finalized turns, so 使用统计 survives deletion
    memory.json          长期记忆开关（`{ version: 2, enabled }`，配置不迁）
    memories/            智能体读取的记忆文件夹：memory_summary.md、MEMORY.md、rollout_summaries/…
    wt                   git worktrees for isolated conversations
    scratch/<conversationId>   workspace for one conversation not bound to a project
```

`conversations.json`、`checkpoints.json`、`reasoning.json`、`memory-state.json`、
`message-queue.json`、`dag.json`、`scheduled-tasks.json` 是这些表的*前身*：每个 store 第一次打开时
把自己的旧文件导入数据库，然后改名成 `<名字>.migrated-<时间戳>` 留在原地，不再读写。

Paths are handed to `createAgentSession` programmatically (`agentDir`, `sessionManager`,
`settingsManager`) rather than through environment variables. Agent IPC channels use the
`engine:` prefix (`src/shared/ipc.ts`), exposed to the renderer as `window.fastvibe.engine`.

## Calls and pushes

Main's methods are registered on a transport-neutral table (`src/main/ipc/registry.ts`)
and its pushed messages leave through one hub (`src/main/ipc/broadcast.ts`). Neither
knows what is on the other end: Electron IPC is attached in `wireElectronTransport()`,
and a remote client is meant to be a second consumer of the very same table, so a method
cannot exist on the desktop and be silently missing elsewhere.

Two rules keep that true:

- **One bridge, one table.** `window.fastvibe` is built by `createFastVibeApi`
  (`src/shared/api.ts`) over a transport (Electron IPC in the preload). A method belongs in the
  neutral call table so the phone's App Protocol reaches it too, not in a one-off handler.
- **Register with `handle()`, never `ipcMain.handle`.** Handlers take `(payload, ctx)`;
  `ctx` carries the asking window, because `event.sender` is an Electron concept a
  non-IPC caller cannot produce. `settings:get-sync` is the one exception — `sendSync`
  has no counterpart on another transport, and the preload reads it before first paint.
- **Push with `broadcast()`, never a loop over windows.** A receiver is whatever
  registered a `send`; `{ except }` skips the caller that caused the write.

Registration must finish before `wireElectronTransport()` runs — anything registered

after the wiring loop is in the table and reachable by nothing.

## Reconstructing a conversation

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

## 目录变更要广播（`workspace:changed`）

The conversation/project catalog is **pushed**, not polled. Every client used to read it
once — `conversations.list()` at mount — and never again, so a chat created in one window
never appeared in another, a delete left a row that opened nothing, and over remote access
that was the entirety of what a phone ever saw: the sidebar it connected with, frozen.

The notice hangs off `ConversationCatalog.#flush()`, which is the single funnel every
mutation already reaches through `#write()`. Announcing at the dozen methods that mutate
the catalog is how the next one added silently stops reaching the other clients — the same
failure `ipc/broadcast.ts` exists to end — and the 40ms debounce that coalesces the
`writeFileSync` coalesces the push for free, so one user action is one notice rather than
one per mutation (「switch this chat to a project」 is four). It fires **after** the write,
so a client that re-reads anything from disk in response cannot be handed the older state.

`applySnapshot` takes the projects and the conversations. **The active conversation is
followed separately**, because adopting it is a navigation and has to go down the same
path a click does — `handleOpen(id, "remote")`, which reloads the transcript and collects
the abandoned empty draft exactly as a local switch would. It replaces the route rather
than pushing: the jump was not this person's navigation and does not belong in their back
stack.

Two things keep that follow from echoing:

- **`setActive` is a no-op for an unchanged id**, so the `conversations.open` a client
  makes in order to follow announces nothing, and the exchange stops after one hop.
- **`intendedActiveId`** (`App.tsx`) is the conversation a client believes it *should* be
  showing, which is not `activeId` — where it has arrived. `openConversation` marks the
  catalog active before it loads the transcript, so the push overtakes the reply to the
  very call that caused it; a client comparing against `activeId` alone sees an id it has
  not reached, concludes somebody else switched, and fires a second identical open. That
  is a duplicate transcript fetch on every switch, which over a tunnel is the expensive
  kind. The id is therefore claimed *before* the hop in `handleOpen`, and kept current in
  `applyOpen` for the paths that cannot know it until their call returns.

A client's own snapshot is not skipped (no `except: origin`): the originator already holds
the same state as its call's result, so applying it again changes nothing, and threading an
origin down through the engine to the catalog would buy only that.

## 多文件夹项目

A project can own several local folders. `Project.cwd` stays the primary folder and the project's identity; `folders` holds the rest, in order. A missing `folders` is a single-folder project. Remote (`kind: "remote"`) projects cannot gain extra folders.

- **Creating.** 添加本地项目 opens a dialog: a name (empty means the first folder's name) and an ordered folder list. The first folder is primary. `projects:pick-folder` is the native dialog and is denied remotely; `projects:create` / `add-folder` / `remove-folder` / `set-primary` are allowed.
- **Primary change rekeys the project.** `conversation.project` and settings keyed by the old path (`projectDefaults`, sidebar fold lists) move with it. Existing chats keep their own `cwd`; only new chats use the new primary folder. The name follows the new folder's basename only when the user had not renamed the project.
- **The agent receives live folder context.** A hidden `fastvibe-project-folders` extension appends a context snapshot when absolute paths, the working directory, or git status change. An unchanged snapshot is reused from the compaction-aware session projection; a one-folder project removes old folder snapshots from requests. Delegated runs do not load the extension, so the same sentence is appended to their system prompt. Tools already accept absolute paths; there is no extra sandbox.
- **The other folders' AGENTS.md and skills are named, not loaded** (`engine/project-folder-resources.ts`). The SDK walks only the session's `cwd`, so a second repository's rules and `.agents/skills` are invisible to it; loading them would put them into every request, and most turns never touch that folder. So the folder snapshot lists, under each other folder, its instruction files and its skills (name, a one-line description, the `SKILL.md` path), and tells the agent to read them only before it changes files there. Each folder walks up to its own repository root (a folder outside any repository is only itself, never up to `/`), and a directory on the session's own ancestor chain is skipped — the SDK already loaded it. The snapshot is re-read at every prompt, so a folder or skill added later appears on the next turn with no reload. Such a skill is not a `/skill:` command and is not in 设置 → 技能.
- **`@` searches every folder.** `workspace:search-files` adds the project's other folders on the desktop (`otherProjectFolders`); their hits are named `<folder>/<path>`, ranked with the primary's, and a file reachable from two roots is listed once. The SSH Agent's handler is unchanged — a remote project has one folder.
- **Git is per repository.** `projects:repos` resolves each folder with `git rev-parse --show-toplevel` and collapses folders that share a checkout. The Git pane shows a repository switcher only when there are two or more. Checkpoints record one HEAD per repository (`repos` on the checkpoint); older checkpoints still restore from the single `cwd` + `head`.

## 会话作用域（每一条引擎调用都要带 `conversationId`）

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
