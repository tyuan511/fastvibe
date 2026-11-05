# Vivi DSH 开发进度与验收记录

本文记录 [目标架构与阶段计划](vivi-dsh-architecture.md#14-实施顺序与数据切换) 的实际实施状态。当前已完成 M0–M4 的隔离领域、Shadow Store、同步端口组装与真实 Pi SDK Session 实验，生产 Vivi 继续使用现有 Router/Worker Runtime。开发分支为 `feat/vivi-dsh`，工作目录为独立 worktree。下列结果只证明本文列出的隔离能力，不代表自动 Effect 调度或 GitHub 集成已实现。

## M0：已建立的实施基线

| 决定 | 本次落实 |
| --- | --- |
| 上游与许可 | 固定 `deepseek-ai/dsh-superagent-prototype@8c32a9dc5d72c033816c6a8110b37f40cf94fba4`；源码移植，保留 [MIT License](../src/main/bot/core/LICENSE) 和 [变更说明](../src/main/bot/core/NOTICE.md) |
| 依赖边界 | 移植完整纯领域闭包；不安装 DSH SDK、Cordis 或另一套模型 Runtime。M4 使用现有 Pi SDK 和显式传入的 ModelRuntime 实现隔离 adapter |
| 首个部署宿主 | 首先适配桌面 Main 生命周期；进程退出期间停止轮询，重新启动按持久游标补收并报告覆盖缺口。无头宿主复用同一组端口，云端服务不是首批前置依赖 |
| GitHub 身份接口 | 按 DSH 的专用 GitHub CLI/账号接口设计 Source；执行和 Review/Merge 使用可区分的账号引用，不复用 FastVibe 登录凭据、不写死旧审核账号。本轮不创建账号、读取凭据或配置真实仓库 |
| 凭据落实阶段 | M7 实现凭据引用、CLI 调用边界和权限验证；M10/M11 验证外部写入路径。专用目录和工具列表不声明为 OS 沙箱 |
| 默认关闭方式 | 当前实现没有生产调用者，而不是在旧 BotRuntime 中插入条件分支。导入隔离测试检查整个 `src/` 和内置扩展的静态模块依赖 |
| 状态所有权 | 新代码只使用内存 repository 或临时 Shadow 库；旧 BotRuntime、BotStore、Bot API、生产数据库 schema、Session、通知、记忆和工作目录均不切换 |
| Fixture | 完整上游领域测试保留 fake Assessor/Executor/Outbox 和可控时钟；另有 [来源事件 fixture](../test/fixtures/vivi-dsh-source-events.ts) 提供重复、编辑、分页、短暂失败和状态响应样例 |
| 外部验收边界 | 当前仅回放已标准化 Trigger，不声明已验证 GitHub HTTP 解析、分页或 API 调用；这些 fixture 将用于 M9/M10 |

当前没有生产 feature flag、Source poller 或注册入口；M7/M12 才添加受隔离模式约束的组装入口。M0 的默认值是后续实现合同，不能解释成 GitHub 已配置或 Pi 投递已完成。

## M1：纯领域内核已落地

位置：[src/main/bot/core](../src/main/bot/core/index.ts)。

- 完整保留上游 `src/core` 的 15 个模块，含模型、同步端口、Intake、Evals、Tickets、Assignments、Replies、stage、Engine 和内存 repository。
- M1 保留领域 Engine，让所有状态转移可直接测试；持久端口组装在 M3 单独验收，生产调度器仍未切换。
- 从上游提取纯 Policy/Admission/Assessment，覆盖 actor 接收表、explicit/inferred、主动模式、机器人/CI、Mandate revalidation、policyEffects、规则覆盖和实现意图检查。配置 parser 与表单留在 M7。
- M1 的 Node 原生执行适配限于构造器参数属性与 ES2022 数组查找；M3 对同毫秒 Eval 身份冲突补充了持久化去重，具体差异见源码 [NOTICE](../src/main/bot/core/NOTICE.md)。
- Ticket 执行目录、prepare 和可选 worktree 的实际运行属于 M6；M1 没有创建任何目录或 worktree。

## M2：隔离 Shadow Store 已落地

位置：[schema.ts](../src/main/bot/shadow/schema.ts)、[store.ts](../src/main/bot/shadow/store.ts)、[legacy.ts](../src/main/bot/shadow/legacy.ts)。

### 数据库与事务

- 复用唯一的 [Db adapter](../src/main/engine/db.ts)。`openDatabaseConnection` 可显式选择独立迁移序列；省略参数仍使用生产迁移，不改变缓存连接、现有调用者或生产 schema 注册。
- 实时源码基线为 schema **14**，不是早期文档中的 13。Shadow 序列先运行这 14 步，再运行只属于测试分支的第 **15** 步；没有向生产 `db-schema.ts` 追加迁移。未来生产基线变化必须显式重建此分支，不能静默复用编号。
- `openShadowStore` 只允许 `:memory:` 或系统临时目录内的文件；真实路径检查拒绝非临时目的地及符号链接逃逸，包括悬空链接。此约束是实验入口限制，不声明 OS 沙箱。
- 实现 Repositories 的 Trigger/Disposition、Thread/Eval、Decision、Ticket/Mandate/Input/Assignment 持久化。保留 JSON 聚合，用 SQL 派生列、关系索引和约束查询 active/open、Trigger timeline、Eval identity、整批 accepted Trigger 和唯一活动 Assignment。
- 每个聚合及其关联索引在同一事务落盘；外层使用 `BEGIN IMMEDIATE`，内层使用 savepoint，失败回滚该层写入及 afterCommit 回调。拒绝异步事务回调；回调错误不能伪装成提交失败。没有跨连接的可变领域缓存。

### 为后续执行层准备的持久原语

- 保存六类 DSH Effect 以及 source-operation/source-reconcile 的 payload、seq、generation、attempts、due、status 和 lease。它们目前只有持久化方法，没有 handler、定时器、调度循环或模型调用。
- 同 key 更新保留正在执行的 owner、claim token 和 claimed generation，不能立刻被第二连接领取。旧代完成只释放自己的有效租约，不能完成或取消更新代的 payload。
- 超期尝试进入 uncertain；普通 enqueue 不能清除它，必须经显式、受 generation/token CAS 保护的 reconcile。对账旧代的 done/cancelled 也不能吞掉新代工作。这里验证的是记录与 fencing，不是真实外部 API 对账。
- 提供资源 lease 的 owner/generation fencing，Source/instance/cursor key 的 revision CAS，Outbox first-message/terminal receipt，以及 Session receipt 的单调阶段记录。Session 表暂不证明真实 SDK persisted/read，M4 才接入。
- 外部 Operation 先存不可变意图；source/instance/key 唯一。状态更新要求旧记录的 revision，拒绝 ABA 和迟到结果；uncertain 不能直接重回 planned。与真实 Effect handler 的执行/receipt 事务集成留在 M5/M10。

### 旧数据 dry-run 与断点恢复

- 在单个同步事务中只读 `bot_meta` 和六张当前 Bot 表，以及 v11 的七张兼容表；不调用 `BotStore.recover`，不读 Session JSONL、不改旧行。
- 计划保留全部源行、原始 JSON、内容哈希、缺表、稳定映射、分类与原因。分类为 archived / needs-reconciliation / blocked / invalid；所有记录统一 `authorized: false`，只建议目标类型，不生成可运行的 Ticket、Mandate 或 Effect。
- 检查 paused/stopped、旧 epoch、running/accepted/uncertain、ready、injected、未知角色/来源、重复冲突、损坏 JSON、列/JSON 分歧、孤儿及恢复链问题。ready 不变 completed，内部 delivery 不变 read receipt；隐藏聊天代次照原样保留。
- `snapshotId` 必须由调用方为同一数据集固定指定，不能使用每次运行的临时路径或随机时间；映射身份是 **snapshotId + newId**，其中 newId 由 `[旧表名, 旧主键]` 的 SHA-256 稳定生成。不同数据集的命名空间不能混用，内容哈希另用于发现变化。
- `migrations.begin(plan)` 持久保存完整报告；`advance(snapshotId, batchSize)` 将一批去重映射、该身份下全部原始冲突行和 checkpoint 同事务提交。相同快照重复执行幂等，内容或分类漂移拒绝覆盖；中途失败可以从已提交的位置继续。
- 报告完成表示历史证据已归档，不表示领域转换完成。正式数据转换及新旧 Runtime 所有权切换仍属于 M8/M12。

## M3：同步 Engine 与持久 fake 端口已组装

位置：[engine.ts](../src/main/bot/shadow/engine.ts)、[ports.ts](../src/main/bot/shadow/ports.ts)。

- `ShadowEngine` 私有持有 pure Core，只向 Source、主协调者、人工控制和 Worker 暴露各自命令。receive/evaluate/decide（含 accept）/attach、delivery/read/report/reply、threadClosed、stop/retry/requeue/unsubscribe 均通过既有领域事务执行；没有第二套领域状态机。
- Assessor、Executor、Outbox 同步写入 assessment/launch/delivery/reply；事件产生 notice/follow-up relay，报告产生 report/attention relay。Decision、Ticket、Mandate、首 Assignment、订阅、ack receipt 和 launch 在 accept 的同一事务中提交。
- receipt 保留首次消息。撤回待发送 Attention 时同事务撤回 pending receipt 和 pending reply Effect；running/uncertain 不被误称为已停止。launch/delivery 的同 payload 在途请求幂等，终态后的新合法请求创建新 generation，覆盖 launch 失败后人类跟进唤醒同一 pending Assignment 的场景。
- Stop/Release 保存带稳定身份的持久 control，afterCommit 只通知观察者或唤醒。control 目前是待消费意图，不证明真实 Session 已中止、缓存已释放或外部操作已取消。
- 手动 completion 在事务内重读 Effect，核对 kind/key、有效 lease、owner、claim token 和 generation。事实变更与 Effect 结算共用事务，结算前再次读取时钟，事务执行期间租约到期也会整体回滚；旧代 completion 只可释放自己仍持有的租约，不改变新代领域事实。
- fake Worker binding 持久记录 Ticket、Assignment、launch generation 和 claim token。Worker report/read/turn-end/handback/reply 等回调在事务内核对完整 binding、当前 running Assignment 和 Ticket 开放状态；Stop/Retry 后旧 token 不能写入新 Assignment。Delivery failure 同时要求匹配的 delivery claim。
- delivered、read 和 report 分别记录。未投递、其他 Assignment 的输入不能被补成 read。普通 progress 不生成主协调 relay；问题、结果、等待、阻塞、失败和 answer 保留上游 relay 语义。Main 自身命令不产生自通知，提交后观察者仍可收到已提交领域事件。
- 修复同一毫秒、同一批 Trigger 重评复用已结束 Eval ID 的问题。普通 ID 规则不变，碰撞时依据该 Thread 的持久 Decision 派生新的 replay ID；关闭重开仍能拒绝旧 outcome，并领取新的 assessment。无需新 schema。
- [M3 集成测试](../test/vivi-dsh-engine.test.ts) 覆盖角色命令、所有六类意图、SQL ABORT 回滚、第二连接可见性和迟到回调。另用真实子进程分别在工作创建与报告的提交前/后退出，验证事实和意图一起回滚或持久，重复 completion 不重放。

本阶段只提供显式调用的 fake completion，没有自动 claim loop、退避、WorkerSlots、Pi prompt、Source poller 或 GitHub 请求。真实 SDK 的 turn/entry 身份、输入落盘及读取证据属于 M4，driver/Passes 与 Stop control 的实际消费属于 M5。

## M4：真实 Pi SDK Session 与回执实验已落地

位置：[pi-session.ts](../src/main/bot/shadow/pi-session.ts)、[pi-ledger.ts](../src/main/bot/shadow/pi-ledger.ts)。

### 身份、投递与读取

- 使用真实 Pi `AgentSession`、`SessionManager` 和 agent loop。测试显式创建离线 `ModelRuntime`，使用 `createFauxCore` 提供可控的模型响应；没有模拟 SDK、访问网络或读取真实凭据。
- 稳定身份为 `worker-<ticketId>`，SessionFile 和 workspace 按该身份的哈希固定。Assignment 更换复用 Session 与目录；同一实例只接受同 Ticket 的新 binding。同 token 重绑幂等；进程 owner 使用持久 PID/nonce，epoch 和完整 WorkerToken 隔离迟到结果。
- `PiLedger` 复用已有 Session receipt 和 KV，不加 schema。首次接受保存原始 text、inputIds、mode、binding、epoch 和 fingerprint；同 requestId 同内容复用，异内容拒绝。进度单调，entryId 不可替换；persisted 必须有 entry，read/reported 必须有真实 read 记录。
- SDK 1.3.0 没有公开 UserMessage requestId。实验 adapter 在精确的低层 user 对象附 `__fastvibeDsh`，随真实 JSONL 保存投递时的 requestId、epoch 和 binding，并在最终 LLM 转换后去掉；`entryEpoch`/`entryBinding` 与首次接受身份分别保留。不按文本、时间或队列顺序猜 entry，重开也不把旧 entry 的 persisted 回调归给新 Assignment。输入 hook 的 handled/transform/reject、steer/followUp 各自保留身份。嵌套 SDK prompt 不继承原请求 tag，显式 adapter.submit 则建立自己的作用域。
- accepted、persisted、read、turn boundary、report 分开记录。persisted 通过读取实际 JSONL 验证；read 在最终 context hook/LLM 转换之后、provider 成功返回 stream 的边界记录。被 context hook 排除、只入队、同步 dispatch 失败的输入不补成 read。此证据表示输入获得 provider 处理机会，不表示模型理解或外部操作成功。
- 每次 provider 请求重新读取 context callback，附当前 Ticket/Mandate/Assignment 等调用方快照及 binding；Continue、reload 后的请求和压缩摘要请求也更新。摘要请求不产生原输入的新 read。压缩后的报告可关联同 binding 下已有的真实 read，`readTurnId` 指回该机会，不能沿用其他 Assignment 的 read。

### 报告、停止与恢复

- `dsh_report` 是真实 SDK 结构化工具。普通 assistant 文本不产生报告；同 turn 同报告幂等，异报告拒绝；progress/waiting 后新 turn 可继续报告 ready。同步领域 callback 与接受回执在同一 ShadowStore 的 SQLite 事务中提交；callback 拒绝或返回 Promise 时回滚其 SQL，外部副作用不属于此事务。JSONL REPORT 仅在 afterCommit 追加审计镜像，不能恢复或篡改不存在的接受事实；DB 已提交但镜像尚未写入的崩溃不重播 callback。
- Stop 先持久 paused/epoch，再清 SDK 队列、使未落盘请求 stopped 并等待 abort。resume 只解除暂停；不会重投。dispose 和 rebind 将丢失的未落盘工作保留为 uncertain，不改写已有 stopped，不解除人工暂停。旧 preflight、旧 turn 或旧 Assignment 不能报告到新 binding。
- Continue 复用真实 SDK run 生命周期，不追加 user 消息；末尾 error/aborted/length 通过 SDK context edit 排除后继续。reload 等待 idle 并保留实例适配；compact 运行真实 SDK 摘要并保存 compaction entry。这里使用的 `_startRun`/`_prepareRun` 和 UserMessage 附加字段属于锁定 **pi-coding-agent/pi-agent-core 1.3.0** 的实例适配，升级须重跑真实 SDK 回归，版本不符失败关闭。
- 重开验证 header、entry chain、唯一请求映射和数据库归属，恢复已有事实但不自动请求模型或重播 report callback。只有显式 recover 才重投未落盘且未被 handled/rejected/stopped 的请求；已落盘请求不因 SDK 内存队列消失重复追加。缺失、损坏、重复 entry 或冲突 report mirror 保留原历史并失败关闭，不自动修复或创建替代会话。
- scratch 路径只允许系统临时目录；内部目录与 JSONL 拒绝符号链接，即使目标仍在临时目录。settings/resources/history 独立，禁用自动 skills/context/extensions/templates 发现、自动重试与自动压缩；仅开放报告工具及测试显式注入的扩展。这是隔离实验入口，不是 OS 沙箱或生产凭据隔离实现。

真实子进程分别在 accepted、SDK JSONL 已写但 receipt 未提交、receipt 已提交，以及 SQL report 已提交但 JSONL 镜像未追加时直接退出。测试还验证 SQL 外层回滚、同实例 rebind 后未落盘输入 recover、Stop/preflight 竞态和第二连接可见性。SDK 同步 append 没有 fsync 保证；本阶段证明进程崩溃恢复，不声明断电持久性或跨存储 exactly-once。

本阶段没有消费 M3 的 launch/delivery/Stop control，也没有自动 claim loop、WorkerSlots、Passes、生产 Bot host、Source poller 或 GitHub 调用。实际 driver 组装属于 M5，执行资源与目录准备属于 M6。

## 可重跑的验收入口

领域、隔离、存储、同步组装与真实 SDK 实验测试：

```bash
node --test test/vivi-dsh-core.test.ts test/vivi-dsh-stage.test.ts test/vivi-dsh-policy.test.ts test/vivi-dsh-isolation.test.ts test/vivi-dsh-replay.test.ts test/vivi-dsh-migration.test.ts test/vivi-dsh-store.test.ts test/vivi-dsh-engine.test.ts test/vivi-dsh-pi-ledger.test.ts test/vivi-dsh-pi-session.test.ts
```

本轮结果：**415/415 通过**，39 个 suite，无跳过或取消。其中 113 个领域行为、31 个 stage/canRetry 用例移植自固定上游，另有 43 个策略、4 个隔离、2 个回放、52 个旧数据分类、40 个 Store 验收、35 个 M3 组装用例，以及 **37 个 M4 Ledger 和 58 个真实 SDK Session 用例**。

让相同上游领域用例改用真实 SQLite repository（fake 外部端口不变）：

```bash
FASTVIBE_DSH_TEST_REPOSITORY=sqlite node --test test/vivi-dsh-core.test.ts
```

本轮结果：**113/113 通过**。Store 验收另外使用真实子进程在提交前、afterCommit 内直接退出，重开检查回滚/持久意图、uncertain 与迟到回调；不依赖 finally 正常关闭来模拟崩溃。

当前功能与公共数据库 adapter 回归：

```bash
node --test test/db.test.ts test/bot-runtime.test.ts test/bot-store.test.ts test/bot-restart.test.ts test/bot-engine.test.ts
```

本轮结果：**83/83 通过**；与上述新测试合并运行 **498/498 通过**。测试使用临时数据，不连接正在运行的真实 userData。复制库演练使用测试构造的旧库，确认源库字节、旧行和 schema 14 不变，只有副本升为 15。

类型与格式：

```bash
pnpm typecheck
git diff --check
```

本轮类型检查及新增测试的独立严格类型检查通过，保持原 ES2022 配置和依赖版本。新增模块仍只有测试引用，生产迁移注册保持原样。

## 下一阶段与限制

下一阶段是 M5：消费持久 Effect/Stop/Release 意图，组装 Shadow handlers、Outbox、Passes、退避与 uncertain 对账。M4 的单 Session 实验不替代调度器的 claim、资源和恢复合同。

M5 的 Effect handlers/Passes、M6 的后台执行、M7 的 Source 控制面、M8 的正式旧数据转换、M9–M11 的 GitHub 闭环和 M12 的最终切换均未验收。当前用户功能继续走旧 Runtime；没有接入旧 API、Session、通知、记忆或真实 GitHub。
