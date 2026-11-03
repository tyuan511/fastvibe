# Vivi 会话合同草案

状态：实现前合同，供 Main Host、Bot Runtime、IPC 与 UI 对齐。

## 核心身份

- `conversationId` 是 Worker 的唯一稳定身份。
- `requestId` 是一次输入的幂等身份；重试、回答、补充和恢复不会创建新的 Worker 会话。
- `epoch` 是停止/恢复边界。停止只使旧 epoch 失效，不能让迟到结果重新激活会话。
- `role` 只有 `router | worker`。Router 也是真实会话；Worker 不是 Task 的容器。
- `creationKey` 用于崩溃恢复时幂等创建会话；Host 必须返回同一个 durable conversationId。

## Host 最小接口

```ts
interface ViviConversationHost {
  createConversation(input: {
    kind: "router" | "worker";
    key: string;
    project?: string;
    workspace?: "vivi";
  }): Promise<{ conversationId: string }>;

  execute(input: {
    conversationId: string;
    requestId: string;
    text: string;
    images?: PromptImage[];
    epoch: number;
    signal: AbortSignal;
  }): Promise<{ status: "completed" | "failed" | "interrupted"; text: string; error?: string }>;

  abort(conversationId: string): Promise<void>;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
  messages(conversationId: string): Promise<ChatMessage[]>;
  resolveProject(project?: string, workerKey?: string): string;
  changed(event: ConversationChanged): void;
}
```

`execute` 的返回只表示这一轮 SDK 执行收尾，不表示工作已经 ready；结构化结果必须由 `report` 写入 Runtime 存储。
Host 不得绕过 Runtime 自己排队、创建 Worker 或发送 Vivi 输入。

## Runtime 写入口

```ts
submit({ requestId, text, conversationId?, images?, behavior? })
createWork({ requestId, title, text, project?, workspace?, memoryRefs? })
report({ conversationId, requestId?, outcome, summary, evidence, artifacts })
ask({ conversationId, requestId?, question })
answer({ attentionId, answer })
stopConversation({ conversationId, callerConversationId? })
continueConversation({ conversationId })
stopAll()
getSnapshot()
```

所有入口先在一个 SQLite 事务中登记 request/epoch/状态，再调用 Host。重复 `requestId` 必须返回原记录；文字、图片、目标会话或项目选择不同必须拒绝。

纯图片输入有效，图片随输入持久化，并经 Host 交给 SDK prompt。Router 实时上下文使用当前正在执行的输入和最新本地项目列表，按当前对话语义在 `createWork.project` 指定精确项目主目录；项目身份与实际 cwd 同时绑定到真实 Worker 会话。未指定项目时每个 Worker 默认拥有稳定独立目录；只有显式 `workspace: "vivi"` 才共用 Vivi 总工作区，且与 project 互斥。项目不存在、远程或目录不可访问时明确拒绝，不回退。Router 用 `bot_send_message({ conversationId, requestId, text })` 将补充要求送到已有 Worker，沿用其工作区。

停止全部仍暂停 Worker 并使旧 epoch 失效；新 requestId 的用户输入可重新开放 Router，旧请求重试不恢复 Router，不重放被停止的输入。

## 持久事实

| 表 | 事实 |
| --- | --- |
| `bot_conversations` | conversationId、role、owner、creationKey、epoch、paused |
| `bot_v2_inputs` | requestId、来源、目标会话、epoch、payload、投递状态 |
| `bot_attention` | attentionId、问题、所属输入/epoch、回答状态 |
| `bot_results` | resultId、会话、输入范围、idle/ready/blocked/failed/uncertain、证据 |
| `bot_outbox` | resultId/目标 Router、注入与可见投递回执 |

旧 `bot_runs/bot_tasks/bot_attempts` 仅用于读取既有数据和一次性迁移，不进入新 API、调度器或 UI。

## 执行与恢复

- 同一 `conversationId` 串行；不同 Worker 可并行，重叠项目目录仍由 Runtime 统一门禁。
- `stopConversation` 先事务内递增 epoch/paused，再 abort；自会话调用不能等待自身 abort。
- Worker 正常收尾但没有 `report`：写入 `idle`/`uncertain` 结果，不判失败、不自动重试。
- `ask` 持久化后结束当前执行；回答以同一 conversationId 的新 input 进入下一 epoch/回合。
- 重启将 running/accepted 输入标为 uncertain 并持久记录 restartRecovery，自动排队 Router 检查中断 Worker。检查后沿原会话追加恢复输入，先核对已有文件与外部效果，再继续剩余工作；保留附件和后续队列。ready 只恢复交付，blocked/failed 和待答问题不自动执行，用户主动停止不被恢复。检查自身中断可再次检查，稳定输入身份防止重复排队。
- 结果先落库，再写 outbox；交付成功才产生 `ConversationChanged.delivery`。失败只出现在 snapshot/sidebar 状态。

## Snapshot / Event

```ts
type ConversationSnapshot = {
  revision: number;
  routerConversationId?: string;
  conversations: Array<{
    conversationId: string;
    role: "router" | "worker";
    title?: string;
    project?: string;
    running: boolean;
    paused: boolean;
    attentionCount: number;
    result?: { id: string; status: string; summary?: string };
  }>;
  questions: BotAttention[];
  results: BotResult[];
  error?: string;
};

type ConversationChanged = {
  revision: number;
  conversationId?: string;
  activity?: { running: boolean; waiting: boolean; conversationId?: string };
  delivery?: { id: string; conversationId: string; text: string };
};
```

Snapshot 不读完整转写；会话正文通过已有 `snapshot/messages` 按 conversationId 读取。所有事件带 revision，客户端丢弃不新于 snapshot 的事件。

## 当前进度

- 已完成：架构决策文档、旧实现审计、v12 迁移草案（会话/输入/attention/result/outbox 表）。
- 正在修正：共享合同文件，撤销把旧 `Task` 方法加入新 API 的做法。
- 尚未开始：Runtime 调度器、Host 新签名、IPC/UI 适配、真实 SDK 合同测试。
- 当前工作树存在大量其他代理的未提交改动；本合同会单独提交，避免把 UI/Main 并行改动混入。
