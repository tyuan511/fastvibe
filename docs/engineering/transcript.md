# 转写呈现与运行过程

涉及用户气泡、错误、中止、过程折叠、思考、空白输出、上下文统计、技能与附件时阅读。

关联入口：[Markdown 渲染](markdown.md)、[会话生命周期](session-lifecycle.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 用户消息不渲染 markdown

转写里的用户气泡（`UserPromptBubble`，`components/chat/message-row.tsx`）画的是纯文本，
不走 `MarkdownView`。回复仍然走，所以这条只管用户自己写下的那一段。

- **理由不是「用不上了」，是它真的会错。** GFM 的裸 URL 自动链接一直到下一个空白才结束，
  而中文句子里没有空白：`https://github.com/can1357/oh-my-pi的实现，给我一个可行性分析`
  于是整句后半段变成一个链接，点下去是一个不存在的地址。带 URL 的提示词很常见，想让气泡
  画 markdown 的提示词不常见。
- **换行照原样保留**（`whitespace-pre-wrap`），长 URL/路径仍然断得开（`wrap-anywhere`，
  见「报错行」那一节为什么 `break-words` 不够）。
- **折叠按实际显示行数判断。** 主聊天与侧边 Agent 聊天共用 `UserPromptBubble`：默认最多两行，
  实际溢出才给出 展开/收起；宽度变化由 `ResizeObserver` 重新测量。展开后正文复用 `PROCESS_BODY_CAP`，
  最高为当前聊天阅读区的一半，超出内部滚动。输入框粘贴转附件仍用 500 字阈值，与转写折叠独立。
- **手机端同一判断**：`apps/mobile/lib/screens/transcript.dart` 的用户气泡用 `Text`
  而不是 `MarkdownView`（`native Markdown renderer` 的自动链接犯同样的错）。手机没有折叠，所以只改这一处。
- 预览：`mock.html?prompt=1`（一条带 URL 的短提示 + 一条 1189 字的粘贴）。验证：
  `test/user-prompt-plain.test.ts`、`test/attachments.test.ts`。

## 报错行（`shared/assistant-error.ts` + `components/chat/error-notice.tsx`）

失败的一轮回复显示的是一行结论 + 供应商的补充说明 + 可展开的原文 + 一键复制，而不是把 `errorMessage`
整句塞进一个红气泡。真正要处理的是三句话的形状，而且每一种都是**布局**问题，不只是阅读问题：

- 网关的失败是 `429: {"message":"…","id":"…","type":"insufficient_quota"}` —— 状态码粘着 JSON，转写里
  又是最醒目的一行，读者得先解析它才能判断「该重试还是该加钱」。
- SDK 的配置错误是三段话，最后一行是一个两空格缩进、`file:///Users/…` 开头的路径。
- git / pnpm 的失败是一整段带缩进的调用栈。

**不换行的长串会把整列撑宽。** `MessageContent` 是 `items-start`，没声明宽度的子元素按 fit-content
量，而一段 200 字符的路径 min-content 宽度就是整段路径——于是转写的 `scrollWidth` 超过 `clientWidth`，
整个会话栏横着滚。`break-words`（`overflow-wrap: break-word`）救不了：它只断开**会溢出自己行**的词，
而 fit-content 的盒子没有可溢出的宽度。所以：

- 卡片每一行都是 `wrap-anywhere`（Tailwind 4 的 `overflow-wrap: anywhere`，连 min-content 一起缩），
  **不是** `wrap-break-word`。这一条是可量化的：1680 / 1200 / 400 三种视口下 `documentElement.scrollWidth
  === clientWidth`，每张卡片自身 `scrollWidth === clientWidth`。
- **一行一条。** `describeAssistantError` 把原文切成 `headline` + `body[]`：首句是结论，其余每行一条
  （空行合并、缩进去掉），路径、URL、调用栈帧各自一行而不是粘在引导句后面。
- **带长 token 的行用等宽小字**（`looksLikePath`：整行没有空格且像路径/URL，或行里有 ≥32 字符的子串是
  路径/URL）。`at file:///Users/…/App.tsx:12:3` 与裸路径是同一个问题，所以整行一起变小，调用栈读起来像
  调用栈而不是「正文里塞了一个巨长的词」。
- **最多三行，其余在「查看详情」里**；详情块 `max-h-64 overflow-auto`，所以一百行也不会把转写顶走。
  没有可展开内容（`Connection error.`）就不画这个控件——展开等于把同一句再说一遍。

其余几条：

- **只在渲染层拆，不改引擎。** `map-messages` 交给渲染层的仍是供应商原话；状态码、`type`/`code`、首句
  和 pretty-print 后的原文都由 `describeAssistantError` 一次算出来。
- **状态码只认三种写法**：开头 `429:`、括号里 `(429)`、SDK 的 `413 status code`。别的三位数是别人家的
  行号（`test/assistant-error.test.ts` 钉住）。
- **内容为空的状态码不冒充结论**：`413 status code (no body)` 的 headline 是空的，界面显示
  「请求失败，没有返回更多信息。」，chip 仍然写 413。
- **复制是常显的**，不是 hover 才出来：这是这个控件存在的理由，而触屏没有 hover。复制的是**原文**
  （包含被 headline 省掉的分配建议和链接），因为那是要贴进工单的那一份；详情块本身也是 `select-text`。
- **样式是描边卡片，不是填充红块**：`border-destructive/25` + `bg-destructive/5`，状态码与 code 用等宽小 chip。
  失败的一轮只是转写里的一行，屏幕上最响的仍应是读者正在读的那段正文。
- **重试状态的供应商原文同样 pretty-print**（`RetryStatus` 的展开区），但那里保持 `text-xs font-mono`，
  因为它是运行过程的一部分而不是结论。
- 预览：`mock.html?error=1` 依次是 429 配额、三段配置错误 + 长路径、调用栈、503、一个 400 字符无断点的
  base64（撑宽那种）；`mock.html?error=plain` 是只有一句话、因此没有「查看详情」的错。

## 中止不是失败（`assistantStopVerdict`）

一个被中止的运行有**两种**落盘形态，而它们对读者是同一件事，所以必须画成同一行：
`stopReason: "aborted"`（SDK 读到了自己的 abort 标志）和 `stopReason: "error"` +
`errorMessage: "This operation was aborted"`（中止以一个抛出的 `AbortError` 收场，比如请求还
没开始写就被取消——实际转写里见过 `content: []`、`usage` 全 0、`durationMs: 1` 的这一形）。后者曾经是红色错误气泡里一句**没被翻译的
英文**：`AbortError` 是个 `name`，而 SDK 只把 `error.message` 写进转写，重载之后名字已经不在了。

- `assistantStopVerdict`（`shared/abort.ts`）把两者收成同一个 `"aborted"`，于是走
  `StopNotice` 那一行安静的 已中断；`assistantError`（Main 读转写）和 `errorFromAssistant`
  （渲染层收事件）都先问它，两条路径不会各判各的。
- 判定只认**整句相等**（`isAbortErrorText`，去空白与句点、大小写无关），绝不做子串匹配——
  `isAbortOutcome` 早就因为同一个理由拒绝相信文案，一句 `upstream aborted the response with
  status 500` 是真失败，不能被这条规则抹掉。它只管**呈现**：Main 的运行结论（`run-verdict`）
  照旧读 `stopReason`，队列该停还是停。
- 供应商的真实报错仍然原样进红泡：能翻译的只有自己产出的那些文案，所以
  `assistantError` 的空文案兜底走 `uiText`，不再硬写中文。

## 折叠运行过程

A finished run's thinking and tool calls always fold behind one collapsed 「用时 …」 row,
leaving the reply written after the last tool call on screen. It is modelled on zcode's
turn-history fold, including its rule that the fold is gated on the turn's own terminal state.
There is no setting for it — 显示思考过程 and 显示消息时间 were removed with it; thinking and
timestamps always show.

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
  transcript. It is not a preference, so nothing has to round-trip to the engine.
- **The header's 用时 and the footer's 耗时 are two different numbers, on purpose.** 耗时 is the
  turn's total, first round-trip's request start (`createdAt`) to the instant its last entry was
  persisted (`completedAt`, added by `sessionCompletionTimes` in `process-manager.ts`). 用时 is
  the work the fold hides: the same start, but ending where the reply's **final message began**
  (`messages[last].createdAt`). An engine message is one model request, so that boundary is
  exactly where the last tool call finished — the answer's own generation is not part of the
  process. A run that produced everything in a single request has no boundary to measure and
  falls back to that request's span. Both survive a reload, and because the fold only exists
  once the run has settled there is no live-ticking case. Both go through `formatDuration`
  (`lib/time.ts`), the app's only duration format (`3 分钟 41 秒`), so the two numbers read in one
  notation — a compact `3m41s` beside a `3 分钟 41 秒` was two spellings of the same unit. The
  compact formatter it replaced is gone, and `formatDuration` returns `""` for a null span, so
  the statistics popover spells out its own `—`.
- **Agent actions and artifact content stay in the process.** Creating agents, task graphs and presented file content remain inside the process fold. The header may expose the same files through `InlineThumbStrip` shortcut buttons; these do not move or duplicate the artifact body. Expanding the process restores the original controls in place. The turn's changed-file card appears once after the final answer and before the message actions when the run settles, regardless of whether the process is folded.
- **Collapsed by default, and entirely the reader's afterwards** — nothing re-folds it under
  them. Every transcript draws it the same way: the main thread, 辅助对话, and 子 Agent.
- **展开之后仍然限高，过程在折叠块内部滚动。** 一个长运行的过程可以有几十段思考与上百张工具卡，
  正文体的 `max-h` 曾经等于它们全部的高度：展开「用时 …」要看一眼刚才做了什么，就把这条回复留在屏幕上的
  那部分答案顶到窗口之外——折叠的意义正好被抵消。`lib/process-body.ts` 的 `PROCESS_BODY_CAP` 是一处定义，
  四个能装下一整个运行的折叠体共用它：`RunCollapse`、`ProcessOverflow`（长运行被截断的隐藏尾部）、
  `ToolGroupRow` 的工具批次（`ToolRow` 的 `scrollBody`）、就地展开的长提示词。
  - **上限是阅读区高度的一半，不是窗口的一半。** 阅读区 = 窗口减去标题栏与输入框，实测 913px 的窗口
    只有 717px 可用；这个值在 CSS 里没有任何单位能从转写内部拿到，所以 `MessageList` 的 viewport 自己把它
    写成 `--thread-height`（一个 ResizeObserver，窗口和输入框一变就重测），上限就是 `calc(var(--thread-height)/2)`。
  - **必须预留滚动条槽，否则展开/收起会闪出一根横向滚动条。** 应用自己那根是**占布局宽度**的 11px 经典条
    （不是 overlay），所以正文一超过上限、竖条一出现，就从里面抽走 11px（实测 `clientWidth` 672 → 661），
    所有行重新排版、变窄 11px，原本正好贴边的内容就溢到横向上——这就是「展开或收起内部工具块时短暂出现
    横向滚动条」那一下。`[scrollbar-gutter:stable]` 把槽位常驻，不管竖条在不在了，宽度都不再动（实测
    反复开关折叠、逐帧采样：修前同一个 body 出现 672 / 661 两个宽度，修后自始至终只有 661）。并且折叠正文
    **永不横向滚动**（`overflow-x-hidden`）：转写是屏幕上唯一该横向滚的东西，行内容全都得换行——实测塞一个
    3000px 宽的块，修前 `overflow-x: auto` 画出 11px 高的真横向条，修后 `barHeightPx = 0`。两条里
    `scrollbar-gutter` 是机制、`overflow-x-hidden` 是承诺，缺任何一个都会回到旧行为。
  - **只滚一层。** 有上限的折叠体可以套在另一个里（工具批次就住在「用时 …」里），两边都限高就是
    「滚动条套滚动条」——用户抱怨的正是这个。所以每个被限高的 body 都带 `data-process-body` 标记，
    `index.css` 里一条 `[data-process-body] [data-process-body]` 把里层那个的上限交还给外层：外层滚，
    里层撑开。没被套住的 body 保留自己的上限，这才是「运行中、上面还没有折叠」时工具批次的界。
    这条规则**必须在 `@layer` 之外**——`max-h-*` / `overflow-*` 是 Tailwind 工具类，写进 `@layer base` 会输；
    并且它重置的是 `overflow` 两个轴，只写 `overflow-y: visible` 会把 `overflow-x: hidden` 留在场上，
    而浏览器会因为两轴不一致把 `visible` 那轴算成 `auto`——滚动容器又回来了。
  - 单个工具卡不套这一层：它展开的是一个本来就自己限高的面板（终端 72、diff 80、参数与输出 60），
    那限的是**一个输出的长度**，不是「一层折叠」，再包一层只会多出一根用不上的滚动条。
  - `test/process-body-cap.test.ts` 钉住这几件事：四处都读同一个常量、都带标记、`--thread-height` 真的被
    发布、CSS 规则存在且在 layer 外、常量里同时有 `scrollbar-gutter:stable` 与 `overflow-x-hidden`。
    typecheck 看不见其中任何一项。
  - 滚动条用应用自己那根（见 [界面合同中的滚动条](ui.md)），所以这里不许出现 `scrollbar-width` / `scrollbar-color`。

## 连续工具折叠

Consecutive **settled** tools between two stretches of prose fold into one row, collapsed by
default (`collapseToolRuns` in `src/renderer/src/lib/tool-run.ts`). Nothing that is still being
written is ever folded — neither a call in flight nor a thought in flight; each stands on its own
line below the fold (see the bullet below), and joins it once it returns. Once the batch
has settled and the reply has moved on to the next sentence, the line is a summary of categories,
in the order they first appeared: 思考 (only with 折叠思考内容, always counted),
命令 (shell calls only, always counted),
读取, 写入 (write / edit / delete), 搜索 (search / web / list), 工具 (MCP, browser,
scripts, skills, anything else). One call inside a category names the file or query
(「已读取 process-manager.ts」); several say how many (「已读取 3 个文件」).
「已」is only on the first clause — 「已运行 2 个命令，读取 process-manager.ts」 — not
repeated on every verb. A named file is the underlined path link used everywhere else
— click previews it, right-click is the shared path menu — not a chip. A query or a
tool name is not a path and stays a chip.
A failed call is not counted on the summary line; the expanded row already marks it.
A thought is its own block and
splits the batch, the same way prose does (unless 折叠思考内容 says otherwise); it is not folded
into the row. Expanding the row shows the calls — 一批工具在 `ToolRow` 里靠 `scrollBody` 拿到和
「用时 …」同一个正文高度上限（`PROCESS_BODY_CAP`，见 折叠运行过程），批次再长也在这一行之下内部滚动；
而它套在「用时 …」里时，标记会让它把自己的上限交还给外层，于是一屏上只有一根滚动条。

- **任何还在写的东西都不进折叠，它自己占一行。** 曾经在飞的那个调用就是折叠行自己的文字（「正在运行 …」
  加一个 spinner），于是一行在两种身份之间反复横跳：它一会儿报「现在在做什么」、一会儿报「已经做完了什么」，
  而每跳一次 `liveTail` 就重判一次——「正在工作」那一行于是隔一会儿多出来、隔一会儿又没了，同一个状态在
  两个位置上闪。现在折叠行只数已经落地的东西，在写的调用（并行就各一个）站在它下面单独一行，跑完才归进
  折叠；`collapseThinking` 不开这个例外——一段还在写的思考同样站在自己那一行上（见下面「在写的思考」）。
  折叠行的 `persistKey` 是批次的**第一个**调用，所以下面的调用陆续落地时它不换身份、不重新挂载。
  `liveTool`、`ToolGroup.running`、`ToolRun.liveThinking` 和 `ToolRow` 的 `filler` 插槽都随这条规则删掉了：
  一行既然永远不会是「正在发生的事」，就不需要为它准备的 spinner、ticker 与抢剩余宽度的位置。
  预览：`mock.html?batch=live`（把一批里的最后一个调用改回运行中）。

- **Only a part the reader can see may break the batch.** `collapseToolRuns` drops a thinking
  or text part that would render nothing — the same two rules 空的思考不占一行 and
  模型输出的空白不占一整屏 apply (`thinkingTakesRow` / `blankTakesRow`). An invisible divider is
  worse than none: a provider really does finish a reasoning block whose whole text is one
  space (seen in a live transcript, sitting between two shell calls), and the reader got
  「已运行 6 个命令」 plus 「已运行 2 个命令」 with nothing between them and no way to ask why.
  The exception is the live tail — a blank thought that is the reply's last part still says
  「正在思考」, so it still splits.

- **折叠思考内容 (设置 → 偏好设置 → 对话, `settings.collapseThinking`, off by default) folds
  thoughts into the batch they sit in.** `collapseToolRuns` then takes
  `{ collapseThinking, streaming }`, a run's `items` are calls *and* thoughts, and the settled
  line counts the thoughts as its own category (「已写入 App.tsx，运行 2 个命令，思考 1 次」 —
  still in order of first appearance, still one 「已」). It is a *renderer* preference, so the
  the native mobile client consumes the shared Rust core projection and keeps the same transcript rules.
- **A thought only joins a batch that has a call in it.** The option folds thinking into the
  tool summary; two thoughts with no call around them have no summary to join, so they keep
  their own rows — otherwise the setting would hide reasoning behind a row that can only be
  read by expanding it. A blank thought is neither counted nor does it split the batch, which
  is 空的思考不占一行 said in the other direction.
- **在写的思考也自己一行，开关只决定它写完之后去哪。** `collapseThinking` 把思考折进批次，指的是
  **已经写完**的那段：它进入计数（「已思考 2 次」）、展开后在行里按顺序印出来。而一段还在流的思考——
  回复的最后一个 part 且本轮仍在跑（`streaming` 与它一起传进 `collapseToolRuns`）——和调用走同一条路：
  `flush()` 掉它前面的批次，自己作为一个 `thinking` part 输出，于是它拿到普通 `ThinkingBlock` 的
  「正在思考」闪烁与单行 ticker 预览，和没开这个开关时一模一样。`liveTail` 于是仍然只看「末尾是不是
  一个 text / thinking part」，不需要为一个折进来的思考开口子。
- **The expanded row prints the thoughts in order**, each as a 「思考」 mark over its text with
  the reasoning body's own left rule — no second chevron, since the row *is* the fold.
- **The caches know about it.** `groupParts` keys its per-message cache on the language, the
  fold and `streaming` — `streaming` because whether the tail thought is live is what decides
  whether it sits in the row or on its own line; `buildGroup` compares items by identity as well
  as tools, so a batch that is still gaining thoughts misses and stops missing once it settles.
- Preview: `mock.html?foldthink=1` (the settled line, thoughts counted), `?live=1` (a reply left
  in flight with a thought being written after its last call), `?live=1&foldthink=1` (the same,
  with the finished calls above it counted — the live thought is still on its own line),
  `?batch=live` (a call left in flight inside a batch).

`wait_agent` 只在运行中显示「正在等待」和可点击的成员身份；调用结束后隐藏，包括成功、超时返回和错误结果。
结束的等待不占行、不切断工具批次、不计入摘要，展开过程也不再显示；原始转写和模型收到的结果保持完整。
已完成的 `list_agents` 仍进入工具批次，计为「已查看团队 N 次」，单次查看也使用可展开的计数行；展开可查看
每次调用、成员身份与结果。运行中的查看、查看失败，以及创建、发消息、继续任务和中断保持独立行；正文和
未折叠思考仍切断批次。

Questions, todos, team-changing actions, presented files and the task graph stay on
their own line and break the run — the row is the status. Other single tools are never folded;
each already is its own description. The two folds are separate: this one is while the run is
going; once it settles, the outer 「用时」 fold takes the whole run — thoughts, calls, and these
summary rows alike — and leaves only the final answer on screen.

## 思考耗时（思考块的「持续了 N 秒」）

A thinking block's duration is measured, not derived from the transcript: pi records one timestamp
per message (its request start), so Main times each block as it streams and files the bounds in
`fastvibe.db`'s `reasoning_blocks` table (it was `runtime/engine/reasoning.json`, 268 KB rewritten
whole every 500 ms; a flush now writes the entries the last reply actually touched), keyed by the
session entry id the message becomes
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
  must not be written to the table at all. The bounds ride the *inner* event of `subagent_event`,
  because the renderer re-applies that object (`applySubagentStream` unwraps `event.event`).
  Without this a subagent's thinking row fell back to the whole round-trip while it streamed and
  had no timing at all until that round-trip ended.

So `ChatMessageRow` falls back to the span of the **round-trip the block came from**
(`messages[].createdAt` → `completedAt`) whenever a thinking part has no bounds of its own: the
row then reports that whole request's time, an upper bound rather than the thought alone, instead
of a bare 「思考」. Measured bounds always win. The owner lookup is a `Map<MessagePart, ChatMessage>`
built from the row's messages, which works because `mergeAssistantRun` passes thinking parts
through by reference.

## 空的思考不占一行（`lib/thinking-row.ts`）

供应商确实会结束一个**没有内容**的思考块：本机 400 份转写里扫出 355 条，正文常常就是一个空格。
`map-messages` 只丢得掉空字符串，空格是 truthy，于是它一路走到界面，画成一行「思考 · 3 秒」，点开是空框——
一句关于从未发生的思考的陈述，夹在真正的思考与工具调用之间。

- **判定只有一处。** `thinkingTakesRow(text, live)` 是纯函数（`test/thinking-row.test.ts` 钉住），
  `message-row.tsx` 的 `partTakesRow` 把它同时用在转写、折叠运行过程的切点与 `processOverflow` 的收集上，
  三处不会各说各话。`text.trim()` 为空即算空（NBSP 也在 `trim` 之内）。
- **还在写的空思考照旧显示。** 它是回复最后一个 part 且本轮仍在跑时，「正在思考」是**在飞的工作**的真报告——
  思考的第一个 token 到来之前，那行闪光的字是读者唯一的信号。`liveTail` 的判定没跟着改，正是因为这一点：
  藏掉活着的空块，WorkingStatus 会补上第二行标记，那段等待反而更吵。
- **顺带修掉折叠的一个哑 bug。** 空思考落在回复**末尾**时，旧切点把它算作过程，`cut` 推到 `parts.length`，
  `parts.slice(cut)` 里再没有 text——那一轮**根本没有「用时」折叠行**，整段过程摊在屏幕上。
  切点现在只跳过真正占一行的 part，`fold` 里「body 会不会是空的」那条检查也被同一个条件包含了。
- **不在 Main 过滤。** `applyThinkingTimings` 按**内容顺序**把测到的时长配对给各个思考块，先在投影里丢掉空块
  会让后面每一块各拿错一份时长。原生手机自己解析事件，这一行仍然会画——要一起收掉得去
  `apps/mobile` 那边做同一条判断。
- 预览：`mock.html?thinking=blank`（在真实思考前塞一个空格块，最后一轮末尾再塞一个）。

## 模型输出的空白不占一整屏（桌面规则与旧手机测量）

远端模型退化时会交出一大段**没有内容但有高度**的输出，转写中间出现一千多像素的空白，读者只会以为卡住了。
关键事实：**换行符不是元凶**。`remark-parse` 只把 ASCII 空格与行结束符当空白，`\n{40}` 渲染成空文档；
能留下高度的是解析器看不见、浏览器认得的那些东西——`<br>`、`&nbsp;`、全角空格 `U+3000`、零宽字符（`U+200B`/`FEFF`）。
`String.prototype.trim()` 会去掉 Zs 一类的但留下 Cf 一类，所以「有没有内容」也不能交给 `trim`。

- **两条规则，都在渲染层。** `isBlankOutput` 判「这一块没有可读的东西」，`blankTakesRow` 让它在**不是活尾**时不占行
  （活尾保留是故意的：模型开头先打几个换行是正常形状，那上空泡里闪的光标是运行还活着的唯一信号）。
  `collapseBlankRuns` 把病态的连刷削成两个：`<br>`×60 → `<br><br>`，≥ 3 行纯不可见字符 → 普通空行（**不是删掉**，
  所以两端的段落还是两段），一行里 ≥3 个连续不可见字符 → 一个空格。一个 `<br>`、一个 `&nbsp;` 原样留着：
  那是有人真想要的排版。
- **一条规则只住一处。** 折叠在 `MarkdownView` 开头做（切块之前），所以流式、重开转写、工具卡、文件预览、
  release note 看到的是同一份 HTML；`thinking-row.ts` 的空思考判定也改成调用 `isBlankOutput`，
  思考与正文不会对「空」各说各话。`message-row.tsx` 的 `partTakesRow` 统一回答「这个 part 占不占行」，
  `fold` 的「回复有没有答案」也改成要**看得见**的 text——否则一段纯空白的尾巴会假装那是答案。
- **不改写转写，也不改发给模型的字节。** 跟检查点/压缩同一道理：磁盘上的东西是事实，界面是呈现。
  代价是那些空白 token 仍然计费，那是上游模型的问题，不是这里的。
- **以下是旧 Flutter/Dart 空白处理的测量与实现资料，并非 Rust core 实现。** 原记录路径 `apps/mobile/chat/blank_output.dart` 与 `test/blank_output_test.dart` 在当前工作区未找到；当前入口是 `apps/mobile/lib/chat/markdown_view.dart` 与 `apps/mobile/lib/screens/transcript.dart`，本次只核对文档，未验证这些旧规则已经恢复。以下保留测量和接入方案供后续复验。两边曾各写一份，
  是因为两端用不同的引擎解析 Markdown：实测（`test/blank_output_test.dart` 量渲染高度，非猜）
  `native Markdown renderer` 把 `&nbsp;`、零宽字符刷成一屏（1120 / 866 px），但把全角空格 `U+3000` 当空行（66 px）——
  正好和 `remark-parse` 相反（那边 U+3000 是内容，`&nbsp;` 在段内会被 HTML 折叠）。所以规则取**并集**，
  不按计划只修当前看得到的那几种；两个文件保持一致比削规则值钱。接入点同样只一处：
  `MarkdownView.build` 里 `collapseBlankRuns`，另加 `transcript.dart` 的 `_block` 用 `blankTakesRow(text, live && isLast)`
  决是否占行（手机这端 `native Markdown renderer` 还会在**软换行**处断行、并丢掉后面没有换行的内联 `<br>`，
  所以上述实测形状都带 `\n`）。
- 验证：`test/blank-output.test.ts` 跑**真的** markdown 管线（与 `markdown-html.test.ts` 同一做法），
  钉住「`\n{40}` 本来就不渲染」这条前提，再钉住每种病态形状收敛以后的 `<br>` / `<p>` 个数。
- 预览：`mock.html?blank=1`（最后一轮回复里刷 60 个 `<br>`、20 行全角空格和一段 `&nbsp;`）。

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
- **The event handler's reads are coalesced** (`lib/coalesce.ts`, in `use-app-bootstrap.ts`).
  A finished run sends `agent_end` and then `agent_settled`, each asking for state, the
  transcript tail and stats, and every `tool_execution_end` asked for stats again: a burst
  is now one read (16 ms for state and transcript, 250 ms for stats), and a read asked for
  while one is in flight still runs once more after it. `createConversationRefresh` itself
  stays immediate — App's own reads on open go through it directly.
- **A long turn costs the same per token as a short one.** Three things grew with the number of
  tool calls in the reply being streamed (measured by replaying 5 → 400 calls and then 300 text
  deltas in an offscreen window: main-thread busy 0.6 s → 2.4 s, long tasks from 400 calls on;
  now 0.8 s → 1.0 s, none). `TurnRail` re-measured every tick with `getBoundingClientRect` after
  *every* render — and it renders on every scroll tick, which a following reader produces
  continuously — so it measures only when the tick count changes (`useLayoutEffect` deps).
  `groupParts` rebuilt every settled tool run's `ToolGroup` per flush, writing its summary line again and
  defeating `ToolGroupRow`'s memo, so a group is reused while it holds the very same tool blocks, in order,
  under the same language (`builtGroups` in `lib/group-parts.tsx`; finished tool blocks keep their identity
  because `applyEngineEvent` clones only the block being written).
- **Context waits for `turn_end`; request speed refreshes on assistant `message_end`.**
  The completed assistant message carries its own output usage and duration, so stats refresh
  then, before a potentially long tool execution. The coalesced read follows persistence.
  This does not reload state or the transcript: the context window is re-read at `turn_end`,
  once the tool results are in too.
- **The ring's own number is the provider's, not a guess.** `getContextUsage()` takes the last
  valid assistant `usage.totalTokens` — the real size of that request, system prompt and tool
  schemas included — and only estimates the messages that arrived after it. So the ring's 已用
  and the Token row are not the same measurement: one is a single request's context, the other
  the cumulative *uncached* input, and a high cache hit rate makes the two look alike.
- **The rows under the ring have explicit scopes.** 本轮 Token comes from `SessionStats.turn`,
  cut out of the transcript by `engine/turn-usage.ts`:
  everything after the last user message on the current branch — so a steer re-baselines it,
  hidden `/goal` continuations remain in the same turn, and a failed request that was retried still counts
  because it was billed. Cache-warm `usage` entries and a compaction's own usage fall inside
  the window and belong to it. 输出速度 uses `SessionStats.lastRequest`: the latest persisted
  assistant request's output divided by that same request's `durationMs`, including first-token
  wait. It updates after each request and keeps the previous sample while the next streams.
  `lastRequestUsage` reads the current branch, including tool-call replies, and falls back to
  that message's request stamp → entry-persist span for transcripts without `durationMs`.
  Without timing or positive output the UI shows `—`, never an earlier timed request's speed.
  Compaction/usage entries and tool waits cannot enter this request's numerator or denominator.
  `turn.modelMs` remains for protocol compatibility; output speed does not use it.
  Everything else (会话 Token,
  步骤, 缓存命中率, 费用) is the whole conversation: `getSessionStats()` adds up
  `getEntries()` — every entry, including history a
  compaction replaced and attempts an in-place retry abandoned. The heading used to read
  「轮次统计 / Turn stats」, which promised neither of those. 费用 is a third scope again:
  `#sessionCost` walks `session.state.messages` (current branch, post-compaction), so a
  compacted conversation costs less there than 会话 Token implies. Do not add a row without
  saying which scope it is, and do not move the turn cut into Main's memory — deriving it from
  the transcript is what makes a reload, a chat switch and a reconnecting phone show the same
  number.
- **Cache hit rate is `cacheRead / (input + cacheRead)` — deliberately no `cacheWrite`.** The
  row answers "how much of the prompt was served from cache", and cache *writes* are not hits;
  they are billed at their own rate, which 费用 already reflects. (ZCode's bar divides the same
  way; its `input_tokens` merely folds the cached read in, so its denominator looks different.)

## 技能调用的呈现（`shared/skill-invocation.ts`）

`/skill:office 帮我写个周报` 会被引擎展开成**整份 SKILL.md**再落盘：
`<skill name="…" location="…">\n正文\n</skill>` 后面接上用户自己写的话。那是给模型的说明书
（3 KB 到 40 KB），不是读者写下的东西，所以转写里不展开它，只画一枚 badge（图标 + 「技能 名字」）
加上用户自己的话。发送后的 badge **不可点**，hover 给一句说明；引擎那份正文一个字都不改，模型照旧读完整技能。

- **两种拼写都要认。** 落盘的是展开后的块，而队列行、刚点发送画出来的那一行、`/handoff` 由 Main
  补的第一条消息，都还是草稿形态 `/skill:name 正文`。`parseSkillInvocation` 同时读这两种，
  所以同一轮在「刚发出」「重开转写」「手机」三处看起来一模一样。正则**锚定整条消息**：
  一条只是*引用*了这段标记的回复不是技能调用，不能被折掉（`test/skill-invocation.test.ts` 钉住）。
- **折叠发生在四个地方，`text` 从此只有用户的话。** Main 的投影（`engine/map-messages.ts`）折好
  `text`、`parts` 并挂上 `message.skill`；渲染层三个建行点（`stores/session.ts` 的 `addUserMessage`、
  `session-reducer.ts` 的 `optimisticQueuedTurn`、`apply-engine-event.ts` 的 `userRowFromEngine`）
  用同一个 `skillDisplayOf` 折，否则乐观行会在本轮结束时被换成另一条长得不一样的行。
  队列行（`components/chat/message-queue.tsx`）在渲染时折，因为队列里存的就是草稿原文。
  好处顺带有一致的一条：`previewTranscript` 之后，大段技能正文根本不过 IPC，手机也只会看到那句话。
- **编辑/复制/重试/历史召回要把命令放回去**（`skillCommandOf`）。行上的 `text` 已经没有 `/skill:` 了，
  照着它重发就等于**悄悄丢掉这一轮依赖的技能**——引擎展开的是命令，不是这一行。
- **标题与预览同理。** `promptPreview`（侧栏那一行）与 `session-title` 扩展都先折回命令形态，
  否则一条技能说明会变成会话名。扩展是散文件、不能 import `@shared`，所以它自己抄了一份正则，
  测试比对两处字面量一致（和 `present` 的扩展名清单同一个办法）。回复推荐反过来：只要用户那句话
  （`stripSkillInvocation`），技能正文对「下一句他会问什么」没有信息量。
- **badge 的 tooltip 用技能自己的 description**，来自 composer `/` 面板那份列表（`lib/skill-descriptions.ts`
  的模块级缓存，App 每次 `listSkills` 写一次）；引擎在消息里只留了 `location`，所以列不出来的技能退回路径。
- **输入框也是 badge。** `lib/skill-draft.ts` 保留完整命令作草稿，Textarea 只编辑正文；
  不用会 trim 的消息解析器，以免吞掉输入中的空格和换行。光标和 `@` 文件选择按可见正文计数，
  点击移除或在正文开头按 Backspace 取消技能。正在输入的名称不提前变成 badge，避免短名称截断长名称。
- **手机端同样保留技能。** `ChatMessage.skill` 解码和 copy 都保留标识，用户行画 badge；
  纯技能消息不画空泡，复制和再次使用通过 `promptText` 还原命令。旧服务端的展开块和本地乐观命令也折叠。
- **侧边搜索仍读原始转写**，命中可能落在技能正文里。
- 预览：`mock.html?skill=1`（一轮带话的技能调用、一轮只有 badge、队列里再来一条草稿形态）。

## 编辑最后一轮要带齐附件（`shared/attachment-metadata.ts`）

转写里那一轮用户消息的 `text` 不是读者看到的那句话，它是**引擎持有的整条提示词**：人的话 + 我们追加的模型可见元数据 + 引擎自己追加的图片尺寸说明。编辑和重试都从这里重建附件，所以读它的顺序错了，界面就少带东西。

- **磁盘上的顺序是固定的**：话 → `<fastvibe-attachments>`（文件路径列表）→ `<fastvibe-pasted-text>`（长粘贴的正文）→ `[Image: original WxH, displayed at …]`。最后一条是 pi 写的（`core/agent-session.js` 用 `${prompt}\n\n${hints}` 拼，所以**没有话的提示也以空行开头**），它排在**我们自己那两个块之后**。因此任何按块尾锚定 `\s*$` 的正则，只要那条说明还在，就一个块都读不到——曾经就是这样把带截图的提示里的文件整份丢掉。`extractPromptAttachments` 第一步必须是 `imagePromptText`。
- **一条规则只住一处**：`imagePromptText`（去掉尺寸说明）、`stripPromptMetadata`（再去掉两个块）、`extractPromptAttachments`（把块读回成 chip）都在 `@shared`，渲染层用 `stripImageDimensionNote` / `stripAttachmentBlock` 这两个别名组合它们。Main 的投影（`engine/map-messages.ts`）、实时事件行（`lib/apply-engine-event.ts`）、侧栏那一行（`engine/prompt-preview.ts`）与输入框预填（`promptAsSent`）都走这条路，所以重载、切会话、手机和编辑看到的是同一份文字。
- **chip 必须带着能重发的东西**。粘贴的 chip 光有名字画得出来、发不出去：`attachmentPromptSuffix` 只认 `item.text`，于是编辑一次就等于悄悄把模型正在回答的那段长文本删掉。所以 `extractPromptAttachments` 把 `content` 还原成 `text`。
- **没有话的一轮也要能编辑**。只贴一张截图是一个真实的回合，而编辑器曾经要求 `text.trim()` 非空（`InlinePromptEditor` 的 submit 与 `App.tsx` `handleEdit` 各一处），于是那一轮根本没有出路。`amendable()` 与 `canSend` 因此是「有话 **或** 有技能 **或** 有附件」。
- **编辑提交的是整份草稿**（`PromptDraft = { text, attachments }`）：附件在编辑卡里可逐个移除，`handleEdit` 用**留下来的**那些重新拼 `attachmentPromptSuffix` 与 `attachmentsToImages` —— 删掉一个 chip 是真的把它从这一轮拿掉。预填的文字来自 `promptAsSent`，它已经剥掉尾部，所以重发不会拼出第二个块。
- **`session-title.ts` 是散文件，不能 import `@shared`**，所以它抄了一份 `MODEL_FACING_TAIL`；`test/attachments.test.ts` 逐个字面量比对两处，漂移就失败。替换要发生在 `trim()` **之前**（块锚在引入它的空行上，没有话的提示正是以那个空行开头）。
- 验证：`test/attachments.test.ts`（说明在后面时仍读得到文件块；粘贴带着正文；中途引用了说明的句子不动；与扩展那份副本一致）、`test/prompt-preview.test.ts`（尺寸说明不参与命名；只有截图的会话叫「图片」；只有文件的会话用文件名）。
