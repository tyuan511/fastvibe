# Vivi Bot 实现说明

Vivi 现在采用“长期 Router 会话 + 持久 Worker 会话 + 薄持久编排层”。Router 的 SDK transcript 只服务于协调和执行，用户界面消费独立的聊天消息通道；内部编排保存输入、执行代次、问题、结果和投递回执，不再以 Run / Task / Attempt 作为产品或运行时主体。

## 数据与运行

- `src/shared/bot.ts` 定义会话、输入、问题、结果、投递和快照合同。
- schema v13 新增 `bot_chat_messages`，保存 Router 发给用户和用户发给 Vivi 的明确聊天消息。schema v11 的旧表保留在数据库中，不进入新调度器。
- `BotStore` 只保存编排事实；会话正文、模型状态、队列、挂起 UI 和实时事件仍归引擎及会话转写所有。
- `conversationId` 是 Worker 的稳定身份。首次创建使用 `creationKey` 幂等恢复；补充、回答、继续和结果回报都沿用同一个会话。
- `epoch` 是停止与恢复边界。停止先持久化暂停和新 epoch，再中止 SDK；旧执行的迟到结果不能重新激活会话。
- Worker 结果先写入结果表，并在用户 feed 保存关联结果、验证信息和产物的结果消息，再写入 Router outbox。Router 仍通过 `bot_reply` 给出自然语言汇总；内部 `BotChanged.delivery`、阶段进度和结果卡不直接触发宠物消息，宠物只消费显式 Router 回复。
- 问题跨重启保留。回答会进入同一 Worker 会话的新 epoch；旧问题不能重复回答。
- 进程退出时 running/accepted 输入变成 `uncertain`，所属会话暂停，不自动重放可能已经产生外部副作用的执行。显式继续会在原会话中创建恢复输入。
- 停止全部后，新 `requestId` 的用户输入会重新开放 Router；重复旧请求不会恢复 Router，也不重放已取消输入或恢复 Worker。Worker 仍需显式继续。
- 输入的图片写入 `BotInput` 的 JSON，和文字、目标会话一起参与幂等校验。纯图片输入有效，图片经 Host 和 `runBotSession` 传给 SDK 的 `prompt(..., { images })`。
- 用户 feed 的 `text` 只保存展示正文，复用 `stripPromptMetadata` / `extractPromptAttachments` 将文件路径和长粘贴还原为附件；图片以 `ChatAttachment` 随消息持久化并传给标准聊天附件条。解析使用 trim 之前的原始提示，纯文件、纯粘贴和纯图片消息重开后仍保留附件；模型队列中的文字和图片保持原样。
- Router 的实时上下文只携带当前执行输入的 `requestId` 与已知会话；排队中的输入不会改变当前执行。Router 每次请求都收到最新本地项目列表，按当前对话语义通过 `bot_create_work.project` 选择项目（精确主目录路径）。项目 Worker 的 catalog 同时绑定项目标识和真实 cwd，正常加载项目规则与多文件夹上下文；无项目的 Worker 默认按稳定创建 key 分配自己的 `vivi/workspaces/<hash>`，重试、继续和补充沿用该目录。只有显式指定 `workspace: "vivi"` 才共用 Router 的 `vivi/outputs` 总工作区，且不能与 project 同时指定。未知、远程或无法访问的项目明确报错，不回退到其他目录。已有 Worker 保留创建时的工作区，不迁移历史产物。

## 引擎与工具

`PiProcessManager` 为 Router 和 Worker 创建 `bot-router` / `bot-worker` catalog 会话，使用现有 SDK 的持久转写、压缩、取消和按会话读取能力。BotRuntime 只负责创建会话、接受输入、控制 epoch、调度执行和投递结果。

`bot-session-extension.ts` 使用 SDK 工具与事件机制：Router 可以读取当前会话上下文、创建工作会话、通过 `bot_send_message` 向原 Worker 投递补充要求、通过 `bot_reply` 向 Vivi 用户发送一条简短反馈、停止或继续指定会话；Worker 可以报告结果或持久化问题。两种角色都能通过 `bot_progress` 上报真实阶段与有用的中间成果。进度不结束回合，最终回复、报告和问题才结束；每轮捕获输入 ID 和 epoch，不能把工具调用 ID 当作输入 ID，停止后的迟到调用不得更新下一轮。普通文本收尾只作为兼容兜底转成 Router 消息，新的 Router 指令应使用 `bot_reply`，不能依赖 transcript 作为用户界面。

## 对话反馈

- `WorkSnapshot.progress` 从持久输入、当前 epoch、待答问题与结果推导每个会话的进度，不增加 Task / Run / Attempt 层级。开始与完成时间随输入保存，切页和重连不重置计时。快照更新通过带 revision 的事件触发读取，终态不能被旧失败或迟到快照覆盖。
- 发送中的用户行和承接状态只在设备本地存在；宿主接收后采用同一个请求 ID 的持久行。失败撤回乐观行并保留草稿和附件。临时状态位于对话末尾，不写进聊天记录，也不把历史回复标成流式。
- 排队、理解、规划、安排、执行、等待回答与汇总必须来自真实状态或 `bot_progress`。没有真实阶段变化时不轮播文字，不编造步骤数、百分比或预计完成时间。
- 阶段成果可保存成 `kind: progress` 的简短消息；同一用户请求最多三条，重复与过密消息被限制。最终 `kind: result` 保存摘要、状态、验证与产物；两种消息都独立成行，不合并进 SDK 的多轮回复或「用时」折叠。
- 进度问句（包括「现在到哪了」这类整句短问）和普通消息一样交给 Router，由它读取实时进度、待答问题和结果后用 Vivi 的口吻回答；不再有绕过模型的固定文案。等待期间主界面只有一行「正在处理…」。Router 回答进度问题时不新建工作、不恢复暂停的工作。历史库里旧的 `intent: "status"` 输入仍被进度推导忽略。
- 部分完成、失败、中断与未确认交付分别呈现，并保留已有产物。继续处理沿用原会话；回答问题、补充要求和停止全部使用同一业务 API。

## 独立 Markdown 记忆

Vivi 自带常开记忆，独立于设置中的普通长期记忆，没有用户配置入口。文件位于 `runtime/engine/vivi/memories/`：`memory_summary.md` 是自动注入的摘要索引，`MEMORY.md` 是详细正文，`raw_memories.md` 和 `rollout_summaries/` 是提炼材料；旁边的 JSON 只用于去重、重试与恢复，不保存另一份正文，也不新增数据库表。

明确“记住、更正、忘掉”通过 Router 的有界记忆工具处理，校验当前用户原话、输入身份及文件版本后发布。Worker 仅能读取；创建或补充工作可带最多三项 `memoryRefs`，在真正执行时重新解析最新章节。隐藏快照支持投影去重、压缩后补回和更正后的旧工具结果过滤。

后台提炼由输入收尾触发，按实际 SDK entry 区间读取新增工具材料。内部编排工具、思考、已注入的记忆和状态查询不作为经验。首次跳过旧历史，同一来源只处理一次；失败不阻塞工作。整理使用受限临时副本，验证后按 generation/revision 进行发布，旧结果不能覆盖新的明确约定。原始笔记和 raw 集合有保留上限，已整理的长期知识不会随原始笔记轮换自动删除。

遗忘会清空原始提炼笔记并推进旧来源截止，保留未编辑的正文主题；因此可能同时清理其他主题的原始佐证。完整机制与边界见 [Vivi 记忆层设计](vivi-memory-design.md)，回归为 `test/vivi-memory-*.test.ts`。

## 界面与宠物

- `/vivi` 是独立入口，保留普通会话的 `activeId`。主聊天读取 `WorkSnapshot.messages` 映射出的独立 Router 聊天 feed，不读取 Router 的 SDK transcript，也不做“完整 transcript + 前端过滤”；思考、工具调用、运行中/中断/失败的执行记录以及 Worker 内部回执天然留在后台。右侧打开工作会话后仍可查看对应 Worker 的完整真实转写。
- 右侧面板展示工作会话列表；打开后直接绑定 `conversationId`，通过 `engine.getSnapshot(conversationId)` / `engine.getState(conversationId)` 读取自己的会话状态。
- 工作会话详情复用标准 `MessageList` 与完整 `Composer`，支持附件、队列、停止和继续，并跟随普通主会话模型。关闭面板不会停止会话，切换会话不会丢失草稿。
- 不再提供任务详情、Attempt 选择或任务弹窗。问题卡片和结果状态引用持久编排记录，但内容仍回到对应真实会话。
- 宠物只呈现聚合活动和 Router 的显式最终消息，不拥有执行状态；Worker delivery 是内部协调事实，不直接成为用户通知。通知目标使用 Router `conversationId`，不依赖已删除的 Run/Task 标识。
- 点击宠物完成气泡时，通过引擎识别 Router/Worker，进入 Vivi 工作台并定位该会话，不写普通聊天的 `activeId`；普通聊天的完成气泡仍打开原聊天。`conversation-navigation.ts` 是这两条导航的统一分流入口，回归测试从真实 Bot completion 的点击目标验证这条边界。
- 共用 Composer 不保留没有调用方的 `textOnly` 模式；工作会话继续使用完整输入框。

## 协议边界

Bot 业务通过中立调用表和 `engine` capability 暴露，桌面与 headless Agent 共用。桌面导航只发给工作台窗口；普通会话的 activeId 不会因打开工作会话而改变。Vivi 的桌面宠物控制仍是本机能力。

## 验证

验证不连接真实 userData，不修改供应商或用户会话：

```bash
pnpm typecheck
pnpm exec electron-vite build
node --test test/bot-engine.test.ts test/bot-conversation-progress.test.ts test/bot-runtime.test.ts test/bot-store.test.ts test/bot-progress.test.ts test/vivi-chat.test.ts test/bot-notifications.test.ts test/bot-pet.test.ts
FASTVIBE_IROH_BIN=/Users/yuantang/code/fastvibe/resources/iroh/fastvibe-iroh pnpm test
```

首轮 review 修复后的验证基线：完整测试 **2192 项通过，0 失败，0 跳过**；类型检查、注入脚本检查和 Electron/Vite 构建通过。新增回归覆盖停止后的 Router 接单与 Worker 保持暂停、图片持久化与真实 SDK 图片请求、独立用户消息 feed、Worker 内部投递不泄漏到主聊天、`bot_reply` 结束 Router 回合，以及真实 SDK Router 向原 Worker 投递补充要求。

附件 review 修复后的验证：完整测试 **2194 项通过，0 失败，0 跳过**；类型检查、注入脚本检查和 Electron/Vite 构建通过。附件回归覆盖混合文字/文件/粘贴/图片、只有附件的消息、重复提交，以及 SQLite 关闭重开后经 `WorkSnapshot.messages` 到 `botChatMessages` 的完整链路。

工作会话详情只在提前返回之前调用一次 `useBotSnapshot`，会话与结果共享同一份快照。无头 Chromium 在亮色、暗色下均通过延迟 Worker snapshot 的「加载中 → 完成」检查，没有 React Hook 顺序错误。

浏览器预览使用 `src/renderer` 作为 Vite root：`mock.html?vivi=1&lang=zh#/vivi`，空状态使用 `vivi=empty`；`vivi=progress|result|recovery` 分别展示并行进度与阶段汇报、完成结果、失败后继续。预览数据是脱敏 fixture，未作为真实供应商端到端证明。

对话反馈实现验证：完整测试 **2210 项通过，0 失败，0 跳过**；类型检查、注入脚本检查及 Electron/Vite 构建通过。真实 SDK 脚本模型覆盖阶段工具不会结束工作、输入与 epoch 绑定、报告收尾与后续补充；运行时回归覆盖汇报限频去重、快捷查询、停止竞争、同实例恢复和重启后的结果接续。无头 Chromium 覆盖中英文、亮暗主题、1280px / 390px 的阶段与结果布局，发送失败回滚、等待期间离开页面、重试去重、草稿保留、并行展开、暂停/继续和原会话补充入口，无渲染异常或横向溢出。

## 后续阶段

定时交办、IM、SSH 项目执行、多 Bot、独立历史全文搜索和结果未读计数尚未接入。持久投递提供逻辑去重与恢复，不承诺任意外部副作用 exactly-once；继续执行前仍需核对现场效果。
