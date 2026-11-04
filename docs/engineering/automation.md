# Agent Team、Goal、Todo、定时任务与历史 DAG

涉及持久子代理、目标状态、清单、依赖图、执行恢复或定时任务回报时阅读。

关联入口：[扩展与 MCP](extensions.md)、[会话生命周期](session-lifecycle.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 内置 Goal、Todo、标题与 Question

- **Built-ins** — `goal.ts` adapts Codex's persistent goals (source and Apache-2.0
  attribution in `resources/extensions/goal/NOTICE.md`). It registers `/goal` plus
  `create_goal`, `get_goal` and `update_goal`. There is no separate plan mode.
  `todo.ts` is always on
  (no slash command): the model replaces the whole list each call.
  `session-title.ts` is also always on: the first user prompt is summarised into
  a short title via a fire-and-forget `modelRegistry.complete` call, then
  `pi.setSessionName`. Manual sidebar renames set `titleManual` so they are not
  overwritten. Parallel runs and side chats name the session up front and are skipped.
  - **That call is retried by the extension, because nothing else retries it.**
    `modelRegistry.complete` is a plain provider request — the SDK's `retry`
    setting only reaches the agent loop, compaction and branch summaries — so one
    transient 502 used to cost a chat its title for good: `attempted` was set
    before `generate()` and never cleared. The extension now runs the attempt
    under `pi.getSettings().retry` (`isRetryableAssistantError` +
    `retryDelayMs` from `pi-ai`, the same policy those summarisation calls use),
    reads the policy per call so a settings change lands without a reload, and
    falls back to the SDK's own defaults for fields the file does not store.
    A deterministic failure (quota, billing, a rejected key) and a reply with no
    usable title both stop early on their own terms: a deterministic error fails
    the same way however often it is sent, whereas an answer that is a sentence
    rather than a title — or one cut off at `length` — is worth another attempt
    instead of being clipped into garbage. Stop has to come through `agent_end`
    rather than `ctx.signal`: `before_agent_start` fires while `ctx.signal` is
    still undefined (the getter only has one from `agent_start` onward), so the
    extension owns an `AbortController` per call and aborts it when a run ends
    `aborted` (and on `session_shutdown`) — the backoff and the request in flight
    both end there, instead of a chat the user stopped paying for a title behind
    it. `test/session-title.test.ts` pins all of it against the real SDK.
  `output-language.ts` is always on: each `before_agent_start` appends the host's
  AI 偏好语言 requirement (from `FASTVIBE_AI_LANGUAGE_PROMPT`) to the system prompt.
  - **Goal** follows `openai/codex@f39e45e4a68db24c649a9b6b12d2e922cba616d1`:
    `active / paused / blocked / usage_limited / budget_limited / complete`, explicit
    model tools, full-objective completion audit and repeated-blocker audit. There is
    no completion text marker or fixed round cap. Pi's `agent_before_settle` commits
    hidden continuation input after SDK retry/compaction and queued user work; it
    does not fabricate a user message or re-baseline 本轮 Token. Every provider request
    gets fresh goal context, including Continue and after reload/compaction.
    Custom session entries persist state and null clear tombstones, read across all
    history branches so rewinding cannot revive a cleared goal. Reopening and resource
    reload preserve status without starting a request; explicit Stop pauses without
    self-resuming. Optional token budgets count main and descendant uncached input
    (including cache writes) plus output, trigger wrap-up steering and prevent another
    automatic goal turn. `goal-descendant-usage.ts` captures a child's goal at provider
    dispatch and reports once on completion, buffers reload gaps, and isolates late
    replies from replacement goals. Live children keep their parent session resident.
    Active elapsed time uses a monotonic clock and includes tools, but not paused/offline
    intervals. A missing budget is unbounded unless the operator configures
    `FASTVIBE_MAX_GOAL_TOKEN_BUDGET` (Pi flag `--max-goal-token-budget`), which supplies
    the default and caps explicit budgets. No budget is inferred from account/model limits.
    Three empty automatic turns block (user turns do not count; thinking and tools are
    activity). Three execution-backend failure turns without any successful tool also
    block; normal command failures do not. The model's semantic blocked/completion audit
    stays in the upstream prompt. `update_goal` can complete a stopped goal directly;
    responses include top-level `remainingTokens` and `completionBudgetReport`.
    `/goal pause|resume|clear|budget <total tokens>` controls the goal. Bare `/goal`
    keeps the composer armed badge until the next user prompt supplies the objective.
    `GoalPanel` renders status and token usage, with pause/clear available during a run.
    Vivi Router/Worker tools exclude all three goal tools. Verification:
    `test/goal-mode.test.ts` and `test/goal-descendant-usage.test.ts` use the real SDK
    with scripted providers; `test/session-reclamation.test.ts` covers live-child retention.
  - **Question** (`question.ts`, always on, main agent only — subagents load no
    extension but `folder-consent`) registers the `question` tool so the agent can stop and
    ask. It takes an array of questions and asks them in one panel (`questions` UI,
    see [扩展的问题 UI 合同](extensions.md)) with ←/→ paging and a progress stepper; on hosts without that UI it
    degrades to one `ctx.ui.select` / `ctx.ui.input` panel per question (`问题 i/n`).
    It returns a structured `questions` payload the transcript renders as a Q&A card
    (`question-answers.tsx`, tool family `question`). The whole call has a five-minute
    deadline, shared by fallback dialogs too. It passes the remaining timeout to the
    host so expiry both dismisses the panel and returns unanswered questions. That
    result tells the agent to continue independent work, leave decisions/approvals
    pending, and not immediately repeat the same questions; silence is never consent.
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
    - **One rule, both surfaces.** These three conditions live in `todoIsCurrent`
      (`lib/todos.ts`) and are reached through `useConversationTodo`
      (`lib/use-conversation-todo.ts`), which is what 会话资源 › 任务清单 reads as well.
      The resource panel used to draw any list the transcript held, so a plan the
      composer had closed — an abandoned 0/7 release checklist — stayed on screen
      beside the chat as though it were still the work in front of the reader, and
      the two panels contradicted each other about what the list meant. A surface
      that shows a *live* checklist goes through the hook; only the transcript's tool
      card keeps a finished turn's list, because that one is a record, not a claim
      about now.
    - **A newer user prompt closes it.** `todoSnapshot` (`lib/todos.ts`) reports the
      list together with whether it was written *before* the newest user message, and
      `todoIsCurrent` closes the panel while that is true. A checklist belongs to the
      request it was written for: asking something else must not resurface the
      previous task's leftovers the moment the new run starts, which is exactly what
      the transcript-derived panel did — it only knew the list existed, not which turn
      it was for. The list is not destroyed (the card keeps it), and it comes back the
      moment the agent writes one for the work in front of it. The extension's
      `before_agent_start` reminder is worded the same way — continue the list only
      if the request does — so the model is not pushed to resume an abandoned plan
      just because it is unfinished.
    - **Busy marks follow the run.** The header's leading glyph and the leading glyph
      of the item `in_progress` are `RunningMark` (`components/running-mark.tsx`) —
      the same circular mark the sidebar puts on a running conversation, shared so
      "a run is in flight" reads identically — but only while that conversation is
      working. Idle, a stalled item falls back to the plain circle (`StatusIcon`), in
      the panel and in the transcript card alike (the card reads the same flag through
      `TodoChecklist`): a stopped chat must not keep spinning.
    - **The `n/N` badge counts position, not completions.** `todoPosition` / `activeTodo`
      (`lib/todos.ts`) name *which* step the agent is on — `1/N` from the first moment,
      rather than sitting at `0/N` until that step closes. The completed count stays
      reachable as the badge's `title`. The tool card's row (`tool-presentation.tsx`)
      uses the same helpers, so the transcript and the panel cannot drift apart.

## Agent Team 持久线程

- **Agent Team / Codex-style collaboration** — `resources/extensions/subagent/index.ts` exposes the Codex collaboration actions `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent` and `list_agents`. `spawn_agent` creates a persistent `AgentThread`; it is the internal creation action behind the Agent Team UI, not a separate user-facing page.
  - **Built-in roles follow Codex's current role model.** `explorer` is for narrow, facts-only codebase questions; `worker` is for owned implementation work and must be told its file/module ownership. FastVibe does not expose planner/reviewer as built-in child roles; review remains a parent-agent responsibility unless a user-installed role provides it. Role frontmatter accepts `model`, `thinkingLevel` and the Codex spelling `model_reasoning_effort`. Built-in roles are available in every `agentScope`; the scope filters only additional user/project role files. Matching definitions retain the precedence built-in → user → project.
  - **Child configuration inherits the parent by default.** A child receives the invoking conversation's model/provider fallback, reasoning level, working directory and runtime context. `fork_turns` accepts `all` or `none` and defaults to `all`; `all` seeds the child `SessionManager.inMemory` with the parent's current branch, while `none` starts with only the child task. Explicit model/reasoning overrides are validated through the configured model registry before the child starts.
  - **Role overrides are bounded.** A role may choose its own model, reasoning level and tool list, but it does not silently escape the parent conversation's cwd or runtime authority. FastVibe has no separate Codex approval/sandbox policy, so the inherited authority is the current FastVibe tool boundary.
  - **Persistent thread identity.** `AgentThreadStore` stores the thread tree, `taskName`, mailbox, status and revision in SQLite. Each thread gets a stable random display name and avatar seed. The Agent Team resource list, lifecycle events, side-pane tab and thread detail all use that identity.
  - **In-process runner.** The app embeds the pi SDK and keeps provider credentials in Main, so child agents run through `SubagentTurnRunner` in the same Main process with a throwaway SDK session. The child has its own session and context; its streamed events are published under the thread's turn id and its final mailbox result is persisted.
  - **Conversation Stop includes its team.** `abort(conversationId)` stops the main session and every live subagent control owned by that conversation, including runs still creating their session. It waits for all stop attempts and reports failures; other conversations are unaffected. `spawn_agent` also forwards its cancellation signal through the host to the runner. Normal parent completion leaves persistent child threads running; explicit Stop interrupts them and preserves their history for follow-up.
  - **Model awareness follows Codex V2.** `agent-team-context.ts` reads this conversation's existing threads at each provider request, including Continue, reload and post-compaction requests. It injects at most eight escaped identities in a 1 KiB `<subagents>` block; latest statuses stay behind `list_agents`. The roster is request-local, not a growing series of history entries. Static tool guidelines explain delegation, ownership, notification messages and explicit follow-up after a user asks to continue. The reference is Codex `a09812981de703f18f38015cd5d500ab373f616c` (`session/world_state.rs`, `agent/control/completion.rs`, `prompts/src/model_messages/multi_agent.rs`).
  - **Results are model mail, not an automatic run.** `AgentThreadStore.finishTurn` atomically commits a terminal status and a result keyed by thread + turn in the existing message table. Completed and failed results are addressed to their conversation; ordinary interruptions only retain partial output for follow-up. The request-time hook appends hidden `FINAL_ANSWER` entries between complete tool exchanges, persists the transcript, then acknowledges mail. A persisted notice id deduplicates a crash between those writes. Each request consumes at most eight results, showing 8,000 characters per result with a truncation note while the mailbox retains the full text. An idle/stopped parent never starts from these messages. UI `unread` and model `deliveredAt` are separate.
  - **Lifecycle and recovery.** `send_message` queues mailbox content without starting a turn; `followup_task` starts or resumes an idle thread; `interrupt_agent` stops the current turn while leaving the thread resumable; `wait_agent` wakes when a selected result arrives (other threads may still be running), when all selected threads have ended, on timeout, or on cancellation; `list_agents` returns the current parent/child tree. A completed runner releases its slot before waking waiters so an immediate follow-up cannot be swallowed. On process restart, active in-memory runs become persisted `interrupted` threads instead of remaining falsely `working`.
  - **Verification.** `test/agent-team-context.test.ts` uses the real SDK and a scripted model for request visibility, Continue, reload, compaction, tool pairing and durable deduplication. `test/agent-thread-mailbox.test.ts`, `test/agent-team-lifecycle.test.ts` and `test/subagent-team-prompt.test.ts` cover transactions, scoped waits, cancellation and collaboration guidance.
  - **Renderer.** `agent_thread_changed` registers a quiet Agent Team tab. The resource panel shows parent indentation, the side pane shows the thread transcript and read-only runtime state, and the shared `subagent-state` reducer keeps live events scoped by conversation and monotonic revision. The thread's display name and avatar are persistent, local SVG data; no network avatar request is made.
  - **Creation stays visible in history.** `spawn_agent` is a standalone agent action, showing the persisted result's name and avatar; clicking the name opens its thread. It stays in the settled run fold and process overflow with the other operations; expand the process to reach its clickable identity. Resources merge creation results, persisted threads and live `<threadId>:turn:<n>` runs under the thread id, with the latest turn owning live status; the avatar stays at the front while the running mark sits beside the trailing status. Thread tabs read the current turn's stream/cache and adopt revisioned thread updates, including a follow-up's start. Preview: `mock.html?resources=agents&lang=zh`.
  - **Agent tool actions share one identity format.** `AgentActionCard` renders create / wait / send / follow-up / interrupt / list as translated action sentences, without raw tool names or an extra "agent" noun. Avatar and name are one clickable button that opens that thread; each target in a multi-target action has its own button. Identity comes from preceding persisted creation results, the call's structured result and the conversation-scoped run registry (`lib/agent-tool.ts`), with no per-row request. The details trigger is a sibling so it never nests buttons. Waits appear only while running; once settled (including timeout or error), they disappear from both the transcript view and process summaries without changing persisted results or model context. Completed team checks fold into the tool process summary as counts, including a single check; expanding restores each check's clickable identities and details. Running or failed checks and team-changing actions remain standalone. Preview: `mock.html?resources=agent-actions&lang=zh|en`; tests: `test/agent-tool-presentation.test.ts`.

## 历史：子 agent 任务编排（DAG）

> 以下保留旧 DAG 的设计、持久化、调度与验证资料。当前内置扩展清单未注册 `dag.ts`，源码中未找到 `DagScheduler` / `runDagTool` 或旧 `subagent` 批量工具；这些历史约束不是当前工具能力或校验保障，不据此恢复或新增接口。

当前独立任务使用 `spawn_agent` 创建持久线程，传入 `message`、`task_name` 和合适的 `agent_type`；多个独立任务分别创建并协调写入范围。结果用 `wait_agent` 等待，已有线程继续工作用 `followup_task`；`send_message` 只补充上下文。中断、重载或压缩后先 `list_agents`，复用匹配线程。下文旧 `subagent` / `tasks` 和 `dag_*` 只描述历史调用面。

主 agent 用 `dag_*` 动态生成依赖图，`PiProcessManager` 持有 `DagStore`、`DagScheduler`、工具宿主和运行记录。
一个会话一张图；`/handoff` 只交接结果，不迁移或接管任务编排。设置里的 `dynamicDag` 只决定主 agent 的活动工具集。

- **独立任务直接委派。** 一个独立任务用 `subagent` 的 `agent + task`，多个互不依赖的任务用 `tasks` 并行。
  `runDagTool` 在创建节点前校验顶层批次：每个节点必须参与新节点之间或指向已有节点的 `depends_on` 关系；
  单个独立节点、独立并行批次、混入依赖图的孤立节点都整批退回并提示使用 `subagent`，不分配编号、不启动运行。
  已有协调者在自己的作用域内追加子任务仍然允许；不要为满足校验虚构依赖或额外规划/审查节点。
- **统一引擎、统一传输。** `ctx.ui.dag` → `runDagTool`，SSH Agent 注册相同的 `registerDagIpc`；`dag_changed` 经引擎事件推送。
  `dag:list` 汇总本机与已连接主机，其余 `dag:*` 按 `conversationId` 路由。API 加在 `shared/api.ts`，方法进远端策略表。
- **编号和尝试分开。** 节点 `T-0001`；尝试 `T-0001`、`T-0001.2`…。全局序号单独持久化，不因删图回退。
  状态和转写以 `subagentKey(runId, conversationId)` 隔离；首次列表与实时推送由 `watchDagGraphs` 合并。
- **角色可以复用。** `agent` 按名字取设置里的系统指令、工具、模型和推理强度；否则主 agent 写 `profile`。
  显式授予的已连接 MCP 工具也可使用；`profile.skills` 明确开启技能目录。普通委派仍保持原来的工具行为。
  新节点保存 `fallbackModel`，重启后恢复不会悄悄退回默认模型。
- **受控层级。** `coordinator: true` 才能创建子任务，最多三层。协调者仅有只读工作区工具，写入交给执行节点。
  `parentId` / `parentRunId` 是归属；`dependsOn` 是执行依赖，二者不能混用。子任务不能依赖等待它的父任务或父任务的下游。
  宿主限制子协调者只能管理自己当前尝试创建的子树；执行节点只可读取自己的上游和历史结果。
- **等待释放名额。** 同一引擎最多五个 DAG 执行者；实际宿主同一供应商最多三个。调度轮转覆盖全部图。
  协调者的 `dag_wait` 释放名额，返回前重新获取，不能出现父任务占满槽位、孩子永远起不来的死锁。
  同一个协调者只能有一个等待调用，等待范围必须是自己的子任务。取消也能释放等待恢复执行名额的调用。
- **写入范围是调度契约。** `write_paths` 声明工作目录内的文件或目录；同一目录下重叠的写任务串行执行。
  未声明范围的写任务保守地占整个工作区。它不是文件系统沙箱；不为每个节点自动建 worktree。
- **依赖与输入分开。** `context_from` 是 `depends_on` 的子集；空数组表示只等执行顺序，不注入上游文字。
  上游摘要合计最多 16000 字符，每个最多 6000；启动前还按模型窗口、完整系统规则和工具 schema 估算可用预算，留出输出与运行空间。
  项目规则不会被自动删减；规则和必要任务说明本身放不下时，明确失败，不悄悄截掉约束。
- **完整结果是产物。** `dag.json.results/<conversation>/<runId>.txt` 存完整输出（大块产物一直是文件，
  不在库里），图内仅保留有界预览。图与节点在 `fastvibe.db` 的 `dag_graphs` / `dag_nodes` 里，
  编号计数器是 `dag_meta` 的一行，并且和它命名的节点在同一次事务里自增。
  `dag_result` 支持 `offset` / `limit`、`query` 和旧 `run_id`；UI 的 `dag:output` 同样分页读取。不能把图内预览称为全文。
  每个模型轮次结束保存当前执行过程和已有文字产出；结束后落盘的 DAG 转写从内存缓存释放，需要时读文件。
- **显式结果与验收。** DAG 节点结束前必须 `dag_report`，给出 `completed` / `blocked` / `failed`、摘要、证据和产物路径。
  有验收条件的任务声明完成必须带证据；协调者必须等子任务结束并对失败/取消分支作出解释与最终判断。
  报告是 agent 的完成声明，不是自动独立验证；重要改动应另设验证节点。报告之后再调用其他工具会使报告失效。
  `blocked` 与失败一样阻止下游，UI 单独显示。只能 `completed` 解锁依赖。
- **时限与重试，不按 token 停。** 子任务不再因轮数或 token 用量被终止：缓存读取和读大文件会把累计 token 很快顶过旧的 30 万上限，任务还没写完就被掐掉。用量仍按消息增量记在节点和祖先上，只供查看，压缩或重试不清零，但不会停任务。
  仍有执行时限（默认 3600 秒）和重试上限（默认 5 次）。`dag_update` 可修订未运行或失败/阻塞/取消任务的说明、验收、时限和重试次数，随后显式重试；运行中用 `dag_send` 补充证据。
- **完成通知有回执。** `observedOutcome` 随图持久化，`dag_wait` 只确认它实际返回的节点。
  历史取消节点不压住新结果；全图停止由独立的 `paused` 标记表达。失败/阻塞可以提前唤醒主 agent，正常完成按图收束。
  通知失败保留未交付状态；隐藏 custom message 的 `noticeId` 防止模型后续响应失败导致重复投递。
  `dag_status(after_revision)` 可只读变更，`dag_wait(mode:any)` 可先处理结束的分支；默认不回填所有节点的原始输出。
- **停止和恢复。** 主会话 Stop 先停调度并取消整图；节点 Stop 级联取消它的子树。
  退出先 `DagScheduler.stop()` 再释放会话，旧运行收尾不能起新任务。重启把未完成节点标为 cancelled，必须显式恢复。
  恢复保留已完成工作；协调者新尝试不继承旧尝试的活动子任务，而是根据保存的产物重新规划。重试不会撤销已发生的外部副作用。
  `#resumeWanted` 处理停止尚未收尾时的恢复，再次 Stop 以最后一次停止为准。
- **校验整批原子执行。** 每批最多 30、每图最多 100，验证引用、工具、时限与重试、层级和环后才分配节点。
  图节点对外返回深拷贝；完整输出保存成功后才发布完成。删会话同时停图、清产物和转写。
- **展示。** `dag_add_tasks` 原位画本批内联图，随运行过程一起折叠；最大化显示整张图。
  节点详情展示父子任务、验收、结论、证据和分页结果。执行页复用 `SidePaneSubagent`，用 `dagRunStatus` 映射终态。
  DAG 运行不自动打开标签页；侧栏子任务行按需打开所属会话里的执行页。
  - **内联图默认收起成一行**（`dag/dag-inline.tsx`），点标题行才展开画布：三个任务就是一屏的点阵和卡片，
    比产生它的那条回复还占地方。收起时标题行仍是完整的一行——状态、进度条、`取消全部`、最大化都在，
    所以不打开也能停掉在跑的一批；和 composer 上方那个任务清单同一个「一行 / 点开」的形状。
    折叠状态**不落盘也不跨会话记**：「默认收起」才是重点，一次运行里点开过的那张图对下一轮没有话说。
    - **`取消全部` 与最大化必须是触发器的兄弟，不是它的孩子。** Base UI 的 `CollapsibleTrigger` 画的是
      `<button>`，而 button 不能嵌 button：套进去要么整条被丢弃，要么一次「展开」点击把整图取消了。
      所以 `DagSummary` 多一个 `hideActions`，内联卡自己画 `DagGraphActions`；最大化对话框两个都不传，
      照旧拿到那排按钮。`test/dag-inline-fold.test.ts` 钉住这三件事（默认收起、图在 panel 里、按钮不嵌套）。
    - 预览：`mock.html?dag=1`（`DAG_MESSAGES` 里那条 `dag_add_tasks` 指向 DAG fixture 的 T-0001…T-0003）。

## 定时任务（`pi/scheduled-task-manager.ts`、`components/schedules/`）

- 任务与运行记录在 `fastvibe.db`（`scheduled_tasks` / `scheduled_runs` / `schedule_meta`），取代
  `scheduled-tasks.json`；运行的 `position` 是列，因为 `queued()` 反着读这个顺序。「应用退出时还在
  running」的行在下一次打开时被标成 `interrupted`，这条规则读的是表，和读文件时一样。
- `maxRunSeconds` 默认 3600（允许 1–86400 秒）；到期中止运行，等执行器真正结束才释放名额，不能让尚未停下的工具与下个任务重叠。
- 忙碌时手动运行持久化为 `queued`，同一任务不会重复排队；已排队但未执行的任务可在重启后继续，已开始的仍标记中断、不自动重放。取消排队和暂停未来执行会清除对应待执行项。
- 已有待执行项时新的触发会记录为 `missed`，注明排队冲突，并推进下一次触发时间；不重复入队、不静默丢失。
- `missedPolicy` 默认 `run-latest`（24 小时内补最近一次），也可选 `skip`（超过一分钟跳过）；入队和真正开始时都检查，避免长队列让过期任务执行。

页面是和插件页一样的卡片网格，点卡片弹窗看详情/历史，新建与编辑也在弹窗里（没有左右分栏）。

- **结果回报到发起会话。** agent 的 `schedule_create` 默认把当前会话记成 `notifyConversationId`（参数 `reportBack: false`
  关掉；`schedule_update` 的 `reportBack` 开关同理，补丁里 `""` 表示清除）。界面里建的任务没有这个字段。
- **每次运行结束由 `ScheduledTaskManager` 回调 `#announceScheduleResult`**，只在 `finish` 真正把运行从 `running`
  改走时触发——退出应用时 `stop()` 已先标成「已中断」，不通知。形态照搬 DAG 的 `dag-settled`：隐藏的自定义消息
  （`schedule-result`，`noticeId` = run id 去重）带运行对话 id 与最终回复，`triggerTurn + followUp`，让那边的 agent
  向用户汇报；转写里 `map-messages` 只画 `details.notice` 一行。发起会话已被删除或就是运行会话本身时不发。
