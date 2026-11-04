# 会话生命周期、队列与压缩

涉及阻塞问题、运行标记、Stop、Continue、立即发送、handoff、前台容量保护与后台压缩时阅读。

关联入口：[持久化与恢复](storage.md)、[Agent 编排](automation.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## Handoff 与会话替换准备

**Handoff** (`handoff.ts`) is `/handoff <下一步>`. The current model writes a self-contained
prompt from this branch — the latest compaction summary plus what it kept, not the raw turns
that summary replaced — the user reviews it in `ctx.ui.editor`, and submitting that review
opens a new conversation and **sends the prompt there**: the dialog is the confirmation, there
is no second press in the composer. The editor's prefill has to reach the dialog or the summary
is discarded. The source chat stays. A bare `/handoff` asks for the goal. Like `/compact`, the
slash line is not a user message and is not steered into a live run, and a second prompt to
that chat is refused until the command returns. The new chat keeps the source chat's model.
The answer is not awaited (`sendUserMessage` resolves when the run is *over*): the new chat's
own events draw the reply, and the phone follows the open it started.

The replacement's first text submission is published immediately by
`#replacementContext`: an `opening_prompt` row and a `handoff` preparation status,
before the SDK awaits input hooks or memory retrieval. Main holds that row in
`#openingPrompts` and includes it in snapshots, so switching away or reconnecting
does not make it disappear. `sendOpeningPrompt` retires it after the SDK's user
`message_end` is persisted, without waiting for the answer; the renderer adopts the
real entry id instead of adding a second row. A refused/consumed submission removes
the pending row, unlocks the composer and returns its text. Do not mark this phase as
an agent run: the SDK has not started one yet.

**The new chat is told where it came from.** The source chat stays, and `conversation_search` reads it
by catalog id, which the new chat has no other way to learn. `withHandoffSource` appends one line naming
that id to the prompt *after* the review (so editing the summary cannot drop it); the id reaches the
extension as `ctx.ui.conversationId`, which `#extensionUi` sets for every context.

**A chat Main fills itself has to reach the sidebar like any other.** `preview` is what every
list in the sidebar filters on — and what marks the project's blank draft for 新对话 — but only
the renderer's `recordPrompt` wrote it, and a handoff sends its opening prompt from Main. The
creation-time `#healPreview` looked at a transcript that was still empty, so the new chat stayed
invisible until a restart. `#adoptPromptPreview` now runs on the conversation's first user
message and writes the same title and preview through `promptPreview` (`engine/prompt-preview.ts`)
that `recordPrompt` uses — one function, so the two paths cannot drift into different rows. It
defers to an existing preview, so a later message never rewrites the first, and to `titleManual`,
and it skips side chats, which the sidebar hides on purpose.

While the summary is being written the source chat's composer is the thing that is busy, so it
says so **in its own placeholder** and is disabled — the `handoff` status is read by id for the
conversation the composer sends to, not as a line above it.

## 阻塞式插件请求：按会话排队 + 「等你」标记

`ctx.ui.confirm` / `select` / `input` / `editor` / `questions` 会**把工具停住**直到有人回答。
三点约定：

- **按会话存，不覆盖。** 渲染层的 `pendingPermissions` 是 `Record<conversationId, PermissionRequest[]>`。
  单槽版本会丢掉同一会话的第二个请求——而并行子 agent 共用父会话的 UI 上下文，八路
  同时提问时只有最后一个能显示，其余七个的 promise 永远悬着。面板画队列头（`activePermission`）。
- **应答按 id 移除，不砍队首。** 引擎自己也会撤回请求（`confirm` 有 `CONFIRM_TIMEOUT_MS`，
  `abort` 会结算），撤回发 `extension_ui_dismiss`。若用「砍队首」，那条 dismiss 之后再应答
  就会误删**下一条**刚排队的请求。
- **取消只看得到当前会话。** `abort(conversationId)` / `#resolvePendingUi(conversationId)` 只结算
  那个会话的请求；`stop()`（退出应用）才是全部。曾经无条件清空全部，于是停 A 会用
  `confirm` 的 `false` 回退把 B 后台挂着的提问驳回——用户从没见过那条提问。

`extension_ui_request` / `extension_ui_dismiss` 在 `App.tsx` 的 `onEvent` 里**先于焦点路由**处理：
阻塞请求不是转录内容，后台会话卡在提问上时必须能点亮侧栏的「等你」和系统通知。
只有 `set_editor_text` 是例外——它写的是当前输入框，必须按会话过滤，否则后台会话会覆盖
用户正在打的草稿。

会话在等用户时：侧栏行显示警告色的「等待操作」badge（`Alert02Icon` + 文字，替下运行中
标记——停下来的会话不是在跑，是在等读它的人），通知在三种情况下发：窗口未聚焦时请求到达；
窗口在前但请求属于别的会话（面板只画在屏幕上的会话里，前台也一样看不见）；所有窗口失去焦点时
仍有未回答的请求（`notifyParkedPrompts`，提问是在用户看着时起的，离开的那一刻才第一次没人说）。
同一条请求只通知一次（`notifiedPrompts` 按 id 去重，请求结算后清除）。停止只在 composer；归档一个正在
运行的会话会 `abort` 它，侧栏行不再提供停止按钮。

供应商凭据的持久化与 SDK runtime 内存注入按隔离/全局模式区分，见 [模型凭据合同](models.md) 与 [Pi 引擎模式](../pi-engine-modes.md)。不要把这些凭据变量导出到用户的登录 shell 或应用内终端。

## 会话是否在运行（`conversation_running`）

Two different things can be in flight in one conversation, and the sidebar's 运行中 mark
means either: an agent **run** and a **compaction**.

- A run is `agent_start` → **`agent_settled`**, not `agent_end`. The SDK emits `agent_end`
  before it does everything else it still owes the same run: retrying a failed request
  (after an exponential backoff), auto-compacting, or continuing with messages an
  `agent_end` handler queued (`ctx.sendMessage` from a goal handler). Each of those
  then starts another `agent_start` *inside that same run*, and only `agent_settled` —
  emitted once, at the end of `_startRun`'s post-run loop — means it is over (it is
  the same condition as the SDK's `session.isIdle`). Ending the flag at `agent_end` made
  the mark, the footer and the stop button go idle for the whole backoff/compaction
  window. `PiProcessManager` sets `#running` on those two events and nothing else;
  `apply-engine-event.ts` keeps the renderer's `streaming` on the same pair.
- **A resume is a run too.** `continueTurn` (the composer's 继续) drives the resumed turn
  through the SDK's own run wrapper — `_startRun`, with `_prepareRun` returning no new
  message for that one call (1.2.0 replaced `_runAgentPrompt([])`; there is still no
  public entry point for continuing an interrupted turn) — and not the bare
  `agent.continue()` loop, because the wrapper is exactly where `agent_settled` and the
  post-run policy live. Calling the raw loop left a resumed run with nothing to clear the
  flag *and* with an `agent_end` claiming `willRetry` for a retry nothing would perform, so a
  502 mid-resume stuck the chat on 停止 (sidebar 运行中, keep-awake held, sends queued instead
  of sent) with no 继续 control, until some unrelated run settled it.
- The composer's 继续 control reads **`EngineSessionState.canResume`**, which Main derives
  from the transcript (`canResumeRun`, `src/main/engine/resume.ts`) — the last message is an
  assistant that did not finish (`error` / `aborted` / `length`), or a user / tool result no
  reply ever followed. Deriving it is the point: the only event that reports an abort is a
  *transient* stream payload, so a chat the user was not looking at, a reloaded window, or a
  socket that was away had no 继续 at all — and the dead-code half of this, an `agent_end`
  whose `stopReason: "aborted"` never survived `slimStreamEvent` because `errorSummary`
  kept only `error`, meant a user's own 停止 *never* offered one. `resume.ts` mirrors what
  `continueTurn` does to re-enter the loop, so the button and the call cannot disagree; the
  renderer pairs it with `working` because a run in flight is resumable by that same rule.
  The store copies it under the same ownership rule as the run flags (`canResume`), so a
  side chat's state reply cannot put 继续 on the main composer's send button.
- `runInterrupted` (`stores/session.ts`) is now only the *live event*'s verdict that a run
  stopped early — a terminal `agent_end` (`error` / `aborted`), or an `auto_retry_end`
  reporting failure with no such verdict on record (a retry chain the user stopped while it
  waited out the backoff, which the SDK ends after already dropping the failed attempt from
  agent state, so no errored message and no `agent_end` ever describe it). Its nullness
  tells that cancelled retry chain from one whose failure `agent_end` already reported;
  `agent_start`, `turn_start` and a fresh prompt clear it again. **It does not pause the
  queue.** Main owns durable queue pauses, and the renderer adopts only revisioned
  `queue_changed` / queue-call snapshots through `setQueueState`. Deriving another
  pause on `agent_settled` can overwrite a newer resume with an old failure. Likewise,
  a pause on an empty queue is not a reason to enqueue fresh input: once the chat is
  idle, Send starts a new turn even after an error. Existing queued items still retain
  their order and explicit resume policy (`lib/composer-race.ts`). Nor may such a pause
  catch a Send made *during* a run: Stop latches `stopped` even over an empty queue (so a
  Send racing the Stop is held), and every new run releases a latch that holds nothing
  (`releaseEmptyPause` on `agent_start`), not just a run started by `prompt()`. Before
  that, Stop → 继续 → Send held the message under 「由于你中断了当前响应」.
- A compaction keeps its own flag `#compacting`, for when it is not part of a run at all:
  `/compact`, and the threshold check a fresh prompt runs before it is sent. It is the only
  thing that can say such a chat is busy, and it is used to re-serve the 正在压缩上下文 divider.
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
  level down: `Main` finalises it when the sub-session's prompt has settled and its
  transcript/state have been cached, then publishes the terminal lifecycle.
- **Only 工作中 uses a nine-dot grid** (`components/working-mark.tsx`, `index.css`): its 1.2-second staggered opacity animation stays inside the reply's progress row and stops under reduced motion. Conversations, projects, todos and Agent resources keep the circular `RunningMark`; tool execution and retry status keep the ordinary Spinner, as do page, button and request loading. 工作中 reuses `ToolRow` for its 14px icon, normal text weight, spacing and running-label treatment, and shows whole seconds with one update per second. Agent action avatars are 16px.
- The renderer's `streaming` is deliberately *not* that mark: it means 「a run is in flight
  for the chat on screen」, and is read only where that is the question — the transcript's
  caret / working row / per-message footer, and whether a send is queued (steer or
  follow-up) rather than starting a turn (the 加入队列 / 发送 label, the placeholder, the
  queue drain). `streaming ⇒ working` always: a run is a subset of working, and a
  `conversation_running: false` for the chat on screen clears `streaming` in the same batch,
  so the two can never be seen to contradict each other.
- **The transcript keeps one live status below the reply.** `RunProgress`
  (`components/chat/run-collapse.tsx`) renders 「工作中 + elapsed duration」 throughout `streaming`,
  including thinking, tools, text output and retry backoff. It replaces the old conditional
  `WorkingStatus` and the separate elapsed header above the reply. The clock uses the merged
  reply's `runStartedAt ?? createdAt`, so remounting does not reset it; a local 1-second interval
  updates whole seconds without re-rendering the transcript, and unmounts on settle.
- **`engine:prompt` answers 「sent」, not 「finished」.** It resolves when the SDK accepts the
  prompt (`preflightResult(true)`, `pi/prompt-acceptance.ts`) and rejects only when it was
  refused; a run that fails afterwards is logged and reaches clients through its events. So a
  rejection is the one case where the caller rolls back the optimistic row and hands the text
  back to the composer. It used to stay open for the whole run, and over an SSH project its
  120s call deadline — or a dropped socket — rejected it mid-run: the sent message came back
  into the composer of a chat that was still working. Run-length calls (`prompt`,
  `prompt-conversation`, `continue`, `compact`) carry no remote deadline either
  (`callTimeoutFor`); a dead host still ends them through the SSH keepalive.
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
「正在压缩上下文」 divider from `#compacting` for an in-flight compaction. It is its own row
after the reply, the same quiet rule as a model switch — not a card inside that turn. While
it runs the label flickers; once the summary lands the same rule says 「已压缩上下文」.
Without the re-serve, switching away and back mid-compaction lost it until the summary was written.

## 排队消息的「立即发送」

队列本身在 `fastvibe.db`：`queue_items` 一行一条提示词（`position` 是同一会话内的顺序，拖动重排
只改这一列），`queue_state` 一个会话一行，装 `revision` 和那次 pause。它取代了 0600 的整份
`message-queue.json`。**「每次改动先落盘才对用户可见」这条没有变**：`#mutate` 先写行、后换内存，
写失败就抛，于是一条没进数据库的排队消息也不会出现在界面上。崩溃后的规范化也没有变——
`claimed` 的行保持 claimed、其余回到 pending、并把该会话暂停——那套规则是业务语义而不是文件格式，
`normalizeQueueFile` 现在读的是表。旧文件读不出来时这个 store 仍旧**报错**而不是当成空队列：
下一次写入会把没人读到过的提示词覆盖掉。

立即 on a queued row means: stop the reply in flight and send this row as the next turn.
Between the two runs there is a real gap — the old run has to settle, and the new prompt
still passes session setup, input hooks and memory retrieval before `agent_start` — and
everything that went wrong went wrong in that gap, on three layers at once.

**Main (`sendQueuedNow`, `pi/run-verdict.ts`, `pi/send-now.ts`)**

- **A verdict that was asked for survives `turn_start`.** Aborting a run in the middle of a
  tool call makes the agent loop close that tool's turn and open one more (`turn_start`)
  before it reads the abort and ends. Clearing `#interruptedRuns` there left the aborted
  reply to be read as a failure: 立即 paused the queue with 「当前响应出错」 over the very
  message it was sending and raised a 任务出错 notification, and a plain 停止 was filed the
  same way. Only a verdict read off a reply (`error`) is dropped by a new attempt; `stopped`
  and `handoff` are consumed by `agent_settled` alone — and by whoever set one with no run
  live to read it (`abort()` on an idle chat).
- **The stop ends the run, not just the request.** `agent.abort()` has nothing to abort
  during a retry backoff or a compaction, and after an aborted request the session carries
  on with whatever was queued for it (a goal's continuation, a steer). `#interruptForNextPrompt`
  calls `session.abort()`, and answers parked extension prompts first, as `abort()` does.
- **A span keeps the chat working across the gap** (`SendNowSpans`). `#working()` is `#busy()`
  or an open span, and it is what a client is told: `conversation_running`,
  `EngineSessionState.running`, the snapshot. `#busy()` stays the run-or-compaction half,
  because the queue drain and steering read it and the gap is exactly when a prompt *may* be
  submitted. A span ends when the run it waits for starts, or when it cannot: the queue is
  paused, the row is gone, or a drain finished with nothing further scheduled. That is
  checked where the queue changes (`#emitQueue`) and where a drain ends, not at each place
  that could cause it.
- **The clicked row stays next until a drain can act on it.** A drain that found the chat
  busy used to forget `#preferredQueueIds` on its way out, so the run's own settle — which
  drains with no preference — sent the head of the queue instead. The pause, the preference
  and the span are all set *before* the run is stopped, because its settle acts on them.
- Two marks ride the stream: `replaced: true` on the `agent_end` / `agent_settled` of the
  run that was stopped for a message, and `queueId` on every user `message_start` (`null`
  for a turn that is nobody's row).

**Renderer (`sentNow`, `applyAroundSentNow` in `stores/session-reducer.ts`)**

- The click draws the turn at once: a `queue:<id>` prompt and a `queue-reply:<id>` reply.
  **One at a time** — a second click takes the first back, since Main sends whichever was
  asked for last. A slash line is not drawn (`/compact` waits for the run and starts no turn).
- **What the stopped run still says goes above the turn.** The transcript reducer addresses
  "the trailing reply", and the click put an empty one there while the old run was still
  talking: its last deltas, its tool results and the 已中断 of its own abort landed in the
  new turn, then vanished at the next transcript read. While `sentNow.over` is set, events
  are applied to the transcript above the turn; it is released by that run's
  `agent_settled` (or the `compaction_end` of a standalone compaction).
- **The turn is taken back whenever Main is not sending it**: the chat goes idle with the
  prompt still unadopted, the queue is paused after the click, the row leaves the queue
  undelivered, a user echo names another row, or the call itself is refused. Taking it back
  is always safe — the path that draws nothing is complete on its own.
- `queued` is Main's queue whole. The drawn row is left out where the tray is drawn
  (`visibleQueue`), not out of the store: a Send made meanwhile has to queue behind it.
- A transcript read keeps the drawn turn only for its own conversation; the read that opens
  another chat used to carry it across.

The reply that was cut keeps its 已中断 mark, as it does after 停止: it is where that reply
stops. What must not appear is an interruption on the *new* turn, or a paused queue.

## 原生压缩的窗口保护（`engine/native-compaction.ts`）

主会话保留 Pi 原生的摘要提示词、切点、文件清单和持久化。自动压缩在用量超过窗口的 **90%** 时触发，按当前模型
窗口动态计算，不改设置文件；Pi 默认固定预留 16K，在 1M 窗口上会拖到约 98.4%。即使不换模型，工具输出突增、
估算误差或供应商实际限制也可能导致摘要请求超窗；切到较小窗口时，已有历史更可能放不下。
`installNativeCompactionGuard` 包装 Pi 1.2 的 `_runDefaultCompaction`（手动与自动共用），先解析实际压缩模型，
为指令、输出和安全余量留位置，再按 UTF-8 字节估算输入。能放下的保持原路径；超出的用 Pi 原生增量摘要按片段处理，
前一片摘要传给下一片，原始转写不改写。供应商仍报超窗或因输出空间不足截断时，按实际失败请求再减半重试，最多六次缩减。
旧摘要本身太长也参与分片；只在最后结果附完整文件清单，累计各片用量。用户取消立即退出，鉴权等非容量错误不通过缩小历史重试。
触发用的 reserve 是窗口的 10%，**与摘要输出预算分开**：调用原生总结前将 preparation 的 reserve 还原为原生配置，
避免 1M 窗口的 100K 触发余量变成 80K 摘要输出。实际摘要 reserve 和保留尾部在小窗口时最多取窗口四分之一，
较大窗口仍用原配置。未获得有效窗口时回退原生 reserve；关闭自动压缩仍然有效。
落盘前用 SDK 的内存会话投影检查「摘要 + 系统提示/工具声明 + 保留尾部」：必须能装进目标窗口并留出回复空间，
自动压缩还必须比原上下文更小。声明窗口大于实际容量时，按被拒绝请求学习**会话内、物理端点/模型/声明窗口隔离**的预算，
同步缩小触发阈值与保留尾部；摘要已变小但尾部仍过大时，按当前投影重新选边界，把移出的消息继续交给原生摘要，工具调用与结果不拆开。
普通回复在压缩后仍超窗也能继续有界缩窗，不受 Pi 的单次恢复限制；成功回复结束这一轮恢复计数，旧压缩点之前的回复不能再次下调预算。
学到预算后，触发阈值还要为安全余量和至少 1024 token 的回复留空间，普通请求输出按剩余空间限制；新输入落在原生检查之后而挤满窗口时，
在发请求前用容量错误进入原生恢复，不发送 128 token 的空回复。达到主动输出上限的 length 不是供应商提前截断，不能被 Pi 隐去并重跑。
容量恢复耗尽后才记录失败历史的指纹；新增错误行或“继续”提示不解锁，且通过请求/运行收尾门禁停止，不调用 abort 冒充用户中断。
Pi 因“没有可裁剪历史”直接返回的路径也要发出可见错误。改模型/窗口、编辑或切换历史后可恢复；显式 `/compact` 重新探测预算，取消或非容量错误保留此前保护。
已压缩分支（包括只剩摘要）的手动重试补上原生 preparation 的空缺，沿用原生前后钩子、取消句柄、appendCompaction 和上下文重建。
必要时追加上下文不可见的边界元数据，不删除原始消息。鉴权、限流、网络故障不按容量错误缩窗；预算变化只写诊断日志，不改供应商配置。
这是对 SDK 实例内部方法的适配，`test/native-compaction.test.ts` 用真实 SDK 验证窗口不一致、多次缩窗、尾部重切、手动重试、取消、截断和恢复任务；
升级 Pi 必须保留这项测试。它不加载已放弃的自定义摘要、遮蔽、入口限长或回放方案。

**后台压缩上下文**是独立的用户开关，默认关闭。打开后，一轮正常结束且上下文达到 75% 时，Main 在独立的内存会话快照上异步生成摘要；不调用原会话的 `compact()`，不显示开始/失败通知、正在压缩分隔线或运行标记，下一轮发送、继续和排队消息都不等待它。摘要完成时原会话若仍在运行，结果暂存到空闲边界再发布；只有成功追加 checkpoint 后，会话里才显示一条「已压缩上下文」。发布把 checkpoint 接到当前 leaf，保留快照之后新增的所有消息；分支、上下文编辑、模型或已有压缩变化使旧结果失效时静默丢弃。停止、删除、回收和引擎退出取消后台请求。失败只记日志，前台 90% 容量保护独立运行，需要强制压缩时取消旧后台任务，不等待后台摘要。原始转写保持完整，下一请求从 summary 与 retained tail 重建 projection。验证见 `test/background-compaction.test.ts`。
