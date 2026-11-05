# Vivi DSH 开发进度与验收记录

本文记录 [目标架构与阶段计划](vivi-dsh-architecture.md#14-实施顺序与数据切换) 的实际实施状态。当前已完成 M0–M3 的隔离领域、Shadow Store 和同步端口组装，生产 Vivi 继续使用现有 Router/Worker Runtime。开发分支为 `feat/vivi-dsh`，工作目录为独立 worktree。下列结果只证明本文列出的隔离能力，不代表 Pi 投递、自动 Effect 调度或 GitHub 集成已实现。

## M0：已建立的实施基线

| 决定 | 本次落实 |
| --- | --- |
| 上游与许可 | 固定 `deepseek-ai/dsh-superagent-prototype@8c32a9dc5d72c033816c6a8110b37f40cf94fba4`；源码移植，保留 [MIT License](../src/main/bot/core/LICENSE) 和 [变更说明](../src/main/bot/core/NOTICE.md) |
| 依赖边界 | 移植完整纯领域闭包；不安装 DSH SDK、Cordis 或另一套模型 Runtime。模型执行继续由未来 Pi adapter 实现 |
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

## 可重跑的验收入口

领域、隔离、存储与同步组装测试：

```bash
node --test test/vivi-dsh-core.test.ts test/vivi-dsh-stage.test.ts test/vivi-dsh-policy.test.ts test/vivi-dsh-isolation.test.ts test/vivi-dsh-replay.test.ts test/vivi-dsh-migration.test.ts test/vivi-dsh-store.test.ts test/vivi-dsh-engine.test.ts
```

本轮结果：**320/320 通过**，39 个 suite，无跳过或取消。其中 113 个领域行为、31 个 stage/canRetry 用例移植自固定上游，另有 43 个策略、4 个隔离、2 个回放、52 个旧数据分类、40 个 Store 验收及 **35 个 M3 组装用例**。

让相同上游领域用例改用真实 SQLite repository（fake 外部端口不变）：

```bash
FASTVIBE_DSH_TEST_REPOSITORY=sqlite node --test test/vivi-dsh-core.test.ts
```

本轮结果：**113/113 通过**。Store 验收另外使用真实子进程在提交前、afterCommit 内直接退出，重开检查回滚/持久意图、uncertain 与迟到回调；不依赖 finally 正常关闭来模拟崩溃。

当前功能与公共数据库 adapter 回归：

```bash
node --test test/db.test.ts test/bot-runtime.test.ts test/bot-store.test.ts test/bot-restart.test.ts
```

本轮结果：**67/67 通过**；与上述新测试合并运行 **387/387 通过**。测试使用临时数据，不连接正在运行的真实 userData。复制库演练使用测试构造的旧库，确认源库字节、旧行和 schema 14 不变，只有副本升为 15。

类型与格式：

```bash
pnpm typecheck
git diff --check
```

本轮类型检查及新增测试的独立严格类型检查通过，保持原 ES2022 配置和依赖版本。新增模块仍只有测试引用，生产迁移注册保持原样。

## 下一阶段与限制

下一阶段是 M4：在独立 scratch data-dir 中接入真实 Pi SDK，验证稳定 Session key、输入 requestId 与 JSONL entry 的关联，以及 accepted → persisted → read → turn boundary → report。M3 的 fake binding 和手动回执不替代真实 SDK 验收。

M4 的 Pi persisted/read 回执、M5 的 Effect handlers/Passes、M6 的后台执行、M7 的 Source 控制面、M8 的正式旧数据转换、M9–M11 的 GitHub 闭环和 M12 的最终切换均未验收。当前用户功能继续走旧 Runtime；没有接入旧 API、Session、通知、记忆或真实 GitHub。
