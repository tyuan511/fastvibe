# Vivi Bot 实现说明

Vivi 现在采用“长期 Router 会话 + 持久 Worker 会话 + 薄持久编排层”。用户界面直接面对会话，内部编排只保存输入、执行代次、问题、结果和投递回执，不再以 Run / Task / Attempt 作为产品或运行时主体。

## 数据与运行

- `src/shared/bot.ts` 定义会话、输入、问题、结果、投递和快照合同。
- schema v12 新增 `bot_conversations`、`bot_v2_inputs`、`bot_attention`、`bot_results` 和 `bot_outbox`。schema v11 的旧表保留在数据库中，不进入新调度器。
- `BotStore` 只保存编排事实；会话正文、模型状态、队列、挂起 UI 和实时事件仍归引擎及会话转写所有。
- `conversationId` 是 Worker 的稳定身份。首次创建使用 `creationKey` 幂等恢复；补充、回答、继续和结果回报都沿用同一个会话。
- `epoch` 是停止与恢复边界。停止先持久化暂停和新 epoch，再中止 SDK；旧执行的迟到结果不能重新激活会话。
- Worker 结果先写入结果表，再写入 Router outbox。投递进入 Router 的真实会话后才产生 `BotChanged.delivery`，通知按稳定 delivery id 去重。
- 问题跨重启保留。回答会进入同一 Worker 会话的新 epoch；旧问题不能重复回答。
- 进程退出时 running/accepted 输入变成 `uncertain`，所属会话暂停，不自动重放可能已经产生外部副作用的执行。显式继续会在原会话中创建恢复输入。
- 停止全部后，新 `requestId` 的用户输入会重新开放 Router；重复旧请求不会恢复 Router，也不重放已取消输入或恢复 Worker。Worker 仍需显式继续。
- 输入的图片与项目选择写入 `BotInput` 的 JSON，和文字、目标会话一起参与幂等校验。纯图片输入有效，图片经 Host 和 `runBotSession` 传给 SDK 的 `prompt(..., { images })`。
- Router 的实时上下文携带当前执行输入的 `requestId/project` 与已知会话列表；排队中的项目选择不覆盖当前输入。创建 Worker 未显式指定项目时，使用当前 Router 输入的选择；未选项目则使用默认输出目录。

## 引擎与工具

`PiProcessManager` 为 Router 和 Worker 创建 `bot-router` / `bot-worker` catalog 会话，使用现有 SDK 的持久转写、压缩、取消和按会话读取能力。BotRuntime 只负责创建会话、接受输入、控制 epoch、调度执行和投递结果。

`bot-session-extension.ts` 使用 SDK 工具与事件机制：Router 可以读取当前会话上下文、创建工作会话、通过 `bot_send_message` 向原 Worker 投递补充要求、停止或继续指定会话；Worker 可以报告结果或持久化问题。Worker 不可递归创建智能体、操作 DAG/定时任务、修改全局配置或自动创建 worktree。普通文本收尾只表示这一轮空闲，不会被自动判定为目标完成。

## 界面与宠物

- `/vivi` 是独立入口，保留普通会话的 `activeId`。主聊天展示 Router 真实转写。
- 右侧面板展示工作会话列表；打开后直接绑定 `conversationId`，通过 `engine.getSnapshot(conversationId)` / `engine.getState(conversationId)` 读取自己的会话状态。
- 工作会话详情复用标准 `MessageList` 与完整 `Composer`，支持附件、模型、队列、停止和继续。关闭面板不会停止会话，切换会话不会丢失草稿。
- 不再提供任务详情、Attempt 选择或任务弹窗。问题卡片和结果状态引用持久编排记录，但内容仍回到对应真实会话。
- 宠物只呈现聚合活动和最终交付通知，不拥有执行状态。通知目标使用 `conversationId`，不依赖已删除的 Run/Task 标识。

## 协议边界

Bot 业务通过中立调用表和 `engine` capability 暴露，桌面与 headless Agent 共用。桌面导航只发给工作台窗口；普通会话的 activeId 不会因打开工作会话而改变。Vivi 的桌面宠物控制仍是本机能力。

## 验证

验证不连接真实 userData，不修改供应商或用户会话：

```bash
pnpm typecheck
pnpm exec electron-vite build
node --test test/bot-engine.test.ts test/bot-runtime.test.ts test/bot-store.test.ts test/bot-notifications.test.ts test/bot-pet.test.ts
FASTVIBE_IROH_BIN=/Users/yuantang/code/fastvibe/resources/iroh/fastvibe-iroh pnpm test
```

当前结果：完整测试 **2177 项通过，0 失败，0 跳过**；类型检查、注入脚本检查和 Electron/Vite 构建通过。新增回归覆盖停止后的 Router 接单与 Worker 保持暂停、图片持久化与真实 SDK 图片请求、逐条输入的项目选择，以及真实 SDK Router 向原 Worker 投递补充要求。

工作会话详情只在提前返回之前调用一次 `useBotSnapshot`，会话与结果共享同一份快照。无头 Chromium 在亮色、暗色下均通过延迟 Worker snapshot 的「加载中 → 完成」检查，没有 React Hook 顺序错误。

浏览器预览使用 `src/renderer` 作为 Vite root：`mock.html?vivi=1&lang=zh#/vivi`，空状态使用 `vivi=empty`。预览数据是脱敏 fixture，未作为真实供应商端到端证明。

## 后续阶段

定时交办、IM、SSH 项目执行、多 Bot、独立历史全文搜索和结果未读计数尚未接入。持久投递提供逻辑去重与恢复，不承诺任意外部副作用 exactly-once；继续执行前仍需核对现场效果。
