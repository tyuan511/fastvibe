# 普通记忆与 Vivi 的补充工程约束

本页补充运行时接入、呈现与回归细节，不替代既有记忆设计或 Vivi 当前架构。

关联入口：[普通长期记忆](../memory.md)、[Vivi 当前实现](../vivi-bot-implementation.md)、[Vivi 记忆](../vivi-memory-design.md)、[Vivi DSH 目标](../vivi-architecture.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

> Vivi 当前仍是 Router/Worker 持久会话实现；DSH 是已确定但尚未实现的目标。普通记忆的开关与数据清理不控制 Vivi 记忆。

## 长期记忆（`engine/memory*.ts`，详见 `docs/memory.md`）

照搬 Codex 的文件式记忆（`codex-rs/memories`），**一个开关加一个模型选项**（设置 → 长期记忆，默认关；模型留空 = 跟随轻量模型，阶段 1 和阶段 2 共用，Codex 是分开的两项；选的模型不可用时按 轻量模型 → 默认模型 → 活动对话的模型 依次退回）。关 = 不读、
不写、不注入；文件留在磁盘上，直到用户点「清除」。原来的三种模式（默认 / 语义 / JEV 增强，SQLite + embedding +
关系图）已整体移除，`removeLegacyMemory` 在启动时删掉遗留的 `memory.sqlite` 和模型缓存。

- **四份提示词是 Codex 原文**，放在 `resources/memories/`（`stage_one_system.md`、`stage_one_input.md`、
  `consolidation.md`、`read_path.md`，Apache-2.0，`NOTICE.md` 记着来源提交和改过的几行），运行时按路径读
  （`memory-templates.ts`，和内置扩展/技能同一套 `FASTVIBE_RESOURCES_PATH`，打包要有 `extraResources` 那一条）。
  改它们就是改每个用户的记忆长什么样；想和上游对齐就重新抓原文，不要凭印象改写。
- **提炼参数沿用 Codex 默认值**（`memory-plan.ts`）：对话文件安静 6 小时、不超过 10 天才读；每轮 2 个。
  普通记忆与 Vivi 的遗忘规则共用 `engine/memory-retention.ts`：初始半衰期 7.5 天，强度低于 1/16 才到期；间隔至少 24 小时的有效使用翻倍半衰期，最高 90 天。因此未强化时 30 天不用到期，强化后为 60 / 120 / 240 / 360 天。明确保存的来源使用相同规则；旧累计引用数不换算成强化，检索命中和摘要注入不续期。整合最多 256 个来源，按衰减强度和有界强化权重选取。看的是转写**文件的 mtime**，不是 catalog 的 `updatedAt`（改名也会动它）。
- **阶段 1**：模型读一个对话，返回 `{ raw_memory, rollout_summary, rollout_slug }`；笔记或回顾为空 = 没什么
  值得记的，记下来、转写不变就不再问。读入和输出两端都过 `redactSecrets`（`[REDACTED_SECRET]`）。
- **账本在数据库里**：`MemoryStateStore`（`engine/memory-state.ts`）把 `outputs` / `empty` / `failures`
  三个按会话 id 键住的 map 各写成一张表，`lastRunAt` / `error` 进 `memory_meta`。它替代了整份重写
  295 KB 的 `memory-state.json`；「清除」要连着清这几张表，不只是删文件夹。`memory.json`（开关与模型
  选择）是配置，不迁。
- **阶段 2**：把选中的写成 `raw_memories.md` 和 `rollout_summaries/`，再起一个**一次性 agent 会话**（工作目录
  就是记忆文件夹，工具只有 read/edit/write/grep/find/ls，没有 bash、没有扩展，medium 推理），用 Codex 的
  `consolidation.md` 当唯一一条用户消息。Codex 用 git 仓库给它 `phase2_workspace_diff.md`；这里没有 git 可依赖，
  所以文件夹旁边留一份**基线副本**（`memories-baseline/`），差异自己生成（`memory-workspace.ts`，Myers 行差异，
  `git apply` 验证过）。文件夹和基线一致且产物有效 = 不唤醒 agent。
- **产物校验**：`MEMORY.md` 是文件、`memory_summary.md` 第一行恰好是 `v1` 且全文不超过 20,000 个 UTF-16 字符、没有符号链接（会被删掉）。不过关
  就报错、**不推进基线**，下一轮 agent 会再看到同一份差异。
- **读取**：隐藏扩展在 `before_agent_start` 把 `read_path.md` 的固定规则追加到当轮系统提示，摘要（上限
  20,000 字符）则作为隐藏上下文快照持久化。预算内全文保留；旧的超长摘要由 `memory-summary.ts` 按章节分配预算，优先给检索目录，目录内按项目/日期分配；放不下的目录长条目保留完整标题与检索指引，不再只截前缀。省略提示允许按范围补读全文，全文哈希让被省略尾部的更新也触发新快照。整理提示要求目录占至少一半预算；超长产物在同一整理会话内修复一次，仍超长不推进基线。内容变化才追加；从会话投影判断是否已存在，重载、分支和压缩后都能
  正确复用或补回。关闭记忆或摘要消失时，后续请求过滤全部旧快照，原始转写仍保留。没有记忆工具，智能体用普通的 `read` / `grep`。
- **使用次数靠引用块**：read_path 要求用了记忆的回复末尾带 `<oai-mem-citation>`，里面的 `rollout_ids`
  （就是对话 id）经 `MemoryManager.noteReply` 记一次使用，决定整合时谁留下。引用块对读者没用，
  `stripMemoryCitation`（`shared/memory-citation.ts`）在 Main 映射转写时和渲染层 markdown 里都会去掉，
  流式时连半截标签也不露；手机读的是同一份投影，所以不必自己认这个标记。
- **只包住引用块的代码围栏要一起删。** 模型照抄协议的示例（示例本身画在围栏里）就会带上一对
  ``` ，只删标签会把那对留下，而「一对空围栏」正是界面眼中的代码块——每条回复末尾多出一个空框。
  判定条件是**围栏行与标签之间只有一个换行、且围栏行除标记和信息串外没有别的内容**；隔着一个空行的
  围栏属于上面那个真正的代码块，绝不能被吃掉（`test/memory-citation.test.ts` 同时钉住正例和这些反例）。
  半截引用块也在围栏里时同样删掉开栏，否则流式期间会画出一个不断变长的空代码框。
- **纯逻辑与副作用分开**：`memory-plan.ts` / `memory-transcript.ts` / `memory-templates.ts` / `memory-workspace.ts`
  只碰文件或不碰，`memory.ts` 的 `MemoryManager` 通过 `MemoryRuntime`（目录、转写、模型、agent）与引擎对话，
  所以 `test/memory-*.test.ts` 能用假的运行时完整跑一遍。
- **新旧配置**：没有 `version: 2` 的 `memory.json`（旧版本一律常开）读作「关」，不会静默开始把对话发给模型。
- **和 Codex 不一样的地方**写在 `docs/memory.md` 末尾：无状态数据库/租约、定时触发而非会话启动触发、阶段 1
  输入是渲染文本、整合 agent 没有 shell、没做 `/memories` 单对话开关和额度保护。

## Vivi 持久会话的输入与恢复

`BotInput` 的文字、图片、目标会话与本次项目选择共同决定请求幂等性，图片写入输入 JSON 并经 Host → `runBotSession` → SDK prompt 传递，只有图片的输入也有效。Router 的实时上下文只读取正在执行的输入，带上其 `requestId`、已知会话及最新本地项目列表；后续排队输入不能提前改变正在执行的请求。Router 按当前对话语义通过 `bot_create_work.project` 选择精确项目主目录，真实会话同时绑定 project 与 cwd，正常加载项目规则和多文件夹上下文。无项目的 Worker 默认各有稳定独立的 `vivi/workspaces/<hash>`，只有显式 `workspace: "vivi"` 才共享总 `vivi/outputs`；两者不可同时指定。项目不存在、远程或目录不可访问时明确拒绝，不回退。补充、继续和重启保持已有 Worker 工作区，不迁移历史产物。

停止全部使旧 epoch 失效并暂停会话；新 requestId 的用户输入可以重新开放 Router，重复旧请求不能恢复，也不重放取消输入或自动恢复 Worker。Router 通过 `bot_send_message` 向已有 Worker 发送补充要求，暂停的 Worker 仍需先显式继续。工作会话详情在所有提前返回之前调用一次 `useBotSnapshot`，会话与结果共用它，不能在 JSX 条件中调用 Hook。

启动时 `BotStore.recover()` 为应用退出中断的输入记录 `restartRecovery`；Router 自动收到持久检查输入，读取已有 Worker 状态与结果，再沿原会话继续未完成工作。恢复输入要求先核对实际文件与外部效果，保留原要求、图片、记忆引用与后续队列；ready 只恢复汇报，blocked/failed 与待答问题不自动执行。主动停止递增 epoch 并清除恢复标记，旧检查与迟到继续工具均不能解除暂停；主动暂停的 Router 也不被重启唤醒。恢复回归见 `test/bot-restart.test.ts` 与 `test/bot-restart-sdk.test.ts`。

验证见 `test/bot-runtime.test.ts`（停止/重启、图片持久化、输入项目隔离）、`test/bot-engine.test.ts`（真实 SDK 图片请求、Router 补充进入原 Worker）及 `docs/vivi-bot-implementation.md`。

## Vivi 对话反馈

Vivi 主聊天的临时承接与真实进度来自 `WorkSnapshot.progress`，按输入回执、epoch、待答问题和结果推导，不从用户可见文本猜测，不增加 Task / Run / Attempt 层级。发送中的乐观用户行用请求 ID 与持久 feed 去重，失败撤回并保留附件；临时状态不落盘，历史回复不假装流式。开始时间随输入保存，切页、重连不重置。

Router 和 Worker 共用 `bot_progress` 上报真实阶段，有价值的阶段成果才用 `milestone` 进入聊天，同一用户请求最多三条并去重、限频。最终报告包含摘要、证据和产物；阶段行与结果行不合并进普通 SDK 回复，也不进入「用时」折叠。结果、进度和内部投递不触发宠物消息，宠物仍只消费显式 Router 回复。

进度问句和普通消息一样交给 Router，由 Router 按实时进度、待答问题和结果用 Vivi 的口吻回答（`main/bot/vivi-voice.ts` 是口吻的唯一来源），等待期间主界面只有一行「正在处理…」；回答进度问题不新建工作、不恢复暂停的工作。主界面没有状态卡片、阶段名或操作按钮，停止用输入框的停止键。失败、未确认交付和中断不得呈现为成功，已有产物保留，继续沿用同一会话。扩展每轮捕获 input ID 与 epoch，不以工具调用 ID 代替，停止后的迟到进度和报告不能影响新一轮。详见 `docs/vivi-bot-implementation.md`，验证包括 `test/bot-conversation-progress.test.ts` 的真实 SDK 流程。

Vivi 主聊天使用独立的 `ViviMessageList` / `ViviMessageRow`，按消息虚拟化，直接呈现用户消息 feed；普通 Agent 会话与右侧执行详情仍用原来的 `MessageList`。用户气泡靠右，使用 `vivi-user-bubble` / `vivi-user-bubble-foreground` 的固定蓝色配对（只区分浅色/深色，不随主题主色或玻璃效果变化）；Vivi 气泡靠左，阶段消息使用普通正文色。连续同一方的消息只收紧间距、不合并，头像只在分组开头显示。主聊天没有轮次目录、提问吸顶、两行用户消息折叠或执行耗时。`lib/vivi-message-layout.ts` 统一计算时间分隔：第一条、间隔至少五分钟、跨本地日历日期；首条与跨天显示日期，今天/昨天按读者的日历判断，精确时间可通过悬停或消息右键菜单查看。复制、附件、Markdown、错误恢复和原有待答请求继续复用已有组件。预览 `mock.html?vivi=chat&theme=light|dark&lang=zh|en`；规则回归为 `test/vivi-message-layout.test.ts`。

Vivi 主聊天的 `ViviRequestsPanel` 在 composer 上方统一展示 `BotAttention` 与所属 Router/Worker 的插件阻塞请求（confirm/select/input/editor/questions），显示来源并可切换，普通聊天请求不混入。插件应答保留原 id 走 `engine.respondPermission`，成功或 dismiss 后才按 id 移除，失败保留草稿；持久问题仍走 `bot.answer`。`engine.getPendingUi` 是全局轻量存量入口，不读取转写；`pending-ui.ts` 在读取前订阅、缓冲 request/dismiss，重放后一次安装共享 `pendingPermissions`，防止迟到快照复活已撤回请求。`PermissionPanel` 的 embedded/active 模式让隐藏表单保留草稿但不监听键盘，当前表单也只处理自身可见范围内的按键，editor 在 Vivi 内联预填编辑；普通聊天仍使用原来的 editor 弹窗，Vivi 打开时不展示它。这里只恢复仍在 Main 等待的插件 Promise，不持久化进程退出前的 Promise。预览 `mock.html?vivi=requests&lang=zh|en`，回归 `test/vivi-requests.test.ts`、`test/vivi-plugin-requests.test.ts`。

## Vivi 独立 Markdown 记忆

Vivi 的记忆由 `src/main/bot/memory/` 管理，常开、没有配置入口，不读全局 `MemoryConfig.enabled`。`runtime/engine/vivi/memories/` 保存 `memory_summary.md`、`MEMORY.md`、`raw_memories.md` 和 `rollout_summaries/`，旁边的 `memory-state.json` 只记来源指纹、游标与重试。没有新数据库表；普通记忆清理不影响这套文件。

Router 通过 `bot_memory_read/search/update` 查阅和维护记忆，Worker 只有只读工具。明确更新必须绑定当前用户输入、原话、requestId 和 epoch，文件 revision 不匹配时拒绝覆盖；用户说已记住前必须写入成功。分派的 `memoryRefs` 最多三项，执行时按当前 Markdown 章节重新读取。隐藏 `vivi-memory-context` 在请求投影中只留有效快照，压缩后补回，版本变化撤回旧记忆工具结果，普通工具配对保持完整。

后台在输入真正收尾后提炼；`memoryBranch` 用 SDK entry ID 限定本轮材料，排除内部 `bot_*` 调用、思考、注入记忆及用户元数据，只在选中来源后加载实际工具片段。显式保存和收尾后的同一输入共享稳定来源指纹，不重复提炼；遗忘截止使用原始要求时间，旧工作迟到完成不能重新学习。整理在隔离工作副本进行，模型调用不持发布锁；发布前核对来源、generation 和文件 revision，使用目录锁、journal 和原子文件替换恢复多文件写入。Vivi 整理器使用 `workspaceOnly` 文件工具边界，普通全局记忆行为不变。

详细结构和遗忘时清理原始笔记的取舍见 `docs/vivi-memory-design.md`；回归为 `test/vivi-memory-*.test.ts`。Vivi 与普通记忆共用遗忘曲线、强化间隔、过期阈值、256 来源上限及整理策略；Vivi 的文件账本保存可选 `retention` 元数据，兼容旧状态。按需读取来源笔记或带明确来源引用的正文片段提供使用反馈，单纯搜索和摘要注入不强化；普通记忆从回复引用取反馈。无新输入也每小时维护，到期清理须和正文、索引一起成功发布；失效文件名引用残留时拒绝发布，并保留上一版。语义是否完全清除仍依赖整理模型。记忆维护不新增 UI、配置、宠物通知或 Worker 自动重放。

## Vivi 桌面宠物

`main/vivi/pet-window.ts` 管理两个独立透明窗口：模型窗口始终只有宠物大小，通知窗口只装文字。`surface` 的坐标属于通知窗口；模型 canvas 始终位于自己窗口的 `(0, 0)`。不要再为气泡扩缩模型窗口：原生 frame 更新和渲染进程 canvas 偏移是两次绘制，拖动开始、落地以及屏幕边缘换侧时会瞬间跳位。通知窗口跟随相同的全屏父窗口，移动期间隐藏，销毁时独立清理。

`ViviSnapshot.moving` 包含拖动、抛掷与落地弹簧回弹。模型 renderer 在 `ViviDragPhysics` 不再 active 且连续稳定 120ms 后，通过 `vivi:motion-settled` 回传最后一个运动样本的 `at`；Main 核对来源窗口、最新时间戳及鼠标/拖动/飞行状态后才恢复文字。移动期间暂停通知的五秒寿命，新消息等停稳后再完整展示。重复的 actors/visible 快照不得触发布局或立即重绘。

通知只展示成功任务的最终回复，不轮询，不展示过程文字、工具状态、思考、等待或错误。单击宠物会触发动作和轮换的本地调侃文字，经 `vivi:click` 从模型窗口转给独立文字窗口；调侃不调用模型、不写入聊天，无论主窗口是否在前台或任务通知是否关闭都响应点击，保留移动暂停与五秒自动关闭规则，且不带会话跳转目标。`setBubble` 显式携带 `notification | feedback` 类型，Main 和文字组件都只对任务通知应用前台隐藏与 `settings.messages` 开关；设置里的「显示任务通知」不控制点击调侃。双击仍打开 Vivi。`ViviCompletionState` 丢弃新运行开始前或较新完成事件之前发起的迟到读取，失败/中断/工具结尾不回退展示之前的过程文字。文字和点击目标来自同一条完成记录，点击始终打开其 `conversationId`。Bot 的 Router/Worker 由 `openPetConversation` 分流到 Vivi 工作台，不经普通聊天的 `conversationsOpen`，不能改变普通聊天的 `activeId` 或绕开 BotRuntime；普通会话仍走原聊天导航。验证见 `test/bot-pet.test.ts`、`test/vivi-pet-motion.test.ts`、`test/vivi-completion.test.ts`、`test/vivi-notification.test.ts`。
