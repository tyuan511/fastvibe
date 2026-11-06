# Vivi DSH 开发进度与验收记录

本文记录 [目标架构与阶段计划](vivi-dsh-architecture.md#14-实施顺序与数据切换) 的实际实施状态。当前已完成 M0–M7 的隔离领域、Shadow Store、真实 Pi SDK Session、Shadow 调度、执行资源层和 Source/Policy 控制面实验，生产 Vivi 继续使用现有 Router/Worker Runtime。开发分支为 `feat/vivi-dsh`，工作目录为独立 worktree。下列结果只证明本文列出的隔离能力，不代表生产调度、真实执行资源或 GitHub 集成已实现。

## M0：已建立的实施基线

| 决定 | 本次落实 |
| --- | --- |
| 上游与许可 | 固定 `deepseek-ai/dsh-superagent-prototype@8c32a9dc5d72c033816c6a8110b37f40cf94fba4`；源码移植，保留 [MIT License](../src/main/bot/core/LICENSE) 和 [变更说明](../src/main/bot/core/NOTICE.md) |
| 依赖边界 | 移植完整纯领域闭包；不安装 DSH SDK、Cordis 或另一套模型 Runtime。M4 使用现有 Pi SDK 和显式传入的 ModelRuntime 实现隔离 adapter |
| 首个部署宿主 | 首先适配桌面 Main 生命周期；进程退出期间停止轮询，重新启动按持久游标补收并报告覆盖缺口。无头宿主复用同一组端口，云端服务不是首批前置依赖 |
| GitHub 身份接口 | 按 DSH 的专用 GitHub CLI/账号接口设计 Source；执行和 Review/Merge 使用可区分的账号引用，不复用 FastVibe 登录凭据、不写死旧审核账号。本轮不创建账号、读取凭据或配置真实仓库 |
| 凭据落实阶段 | M7 实现隔离 credential reference、宿主 resolver 和权限边界；M10/M11 验证外部写入路径。专用目录和工具列表不声明为 OS 沙箱 |
| 默认关闭方式 | 当前实现没有生产调用者，而不是在旧 BotRuntime 中插入条件分支。导入隔离测试检查整个 `src/` 和内置扩展的静态模块依赖 |
| 状态所有权 | 新代码只使用内存 repository 或临时 Shadow 库；旧 BotRuntime、BotStore、Bot API、生产数据库 schema、Session、通知、记忆和工作目录均不切换 |
| Fixture | 完整上游领域测试保留 fake Assessor/Executor/Outbox 和可控时钟；另有 [来源事件 fixture](../test/fixtures/vivi-dsh-source-events.ts) 提供重复、编辑、分页、短暂失败和状态响应样例 |
| 外部验收边界 | 当前仅回放已标准化 Trigger，不声明已验证 GitHub HTTP 解析、分页或 API 调用；这些 fixture 将用于 M9/M10 |

当前没有生产 feature flag、Source poller 或注册入口；M7 只添加 Shadow 测试路径的 registry/control 组装，M12 才执行生产切换。M0 的默认值是后续实现合同，不能解释成 GitHub 已配置或 Pi 投递已完成。

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

## M5：Shadow Effects、Outbox、Passes 与恢复已组装

位置：[effects.ts](../src/main/bot/shadow/effects.ts)、[operations.ts](../src/main/bot/shadow/operations.ts)、[outbox.ts](../src/main/bot/shadow/outbox.ts)、[passes.ts](../src/main/bot/shadow/passes.ts)、[driver.ts](../src/main/bot/shadow/driver.ts)。

### 调度、事务与健康

- `ShadowDriver` 只组装显式传入的 fake/sandbox adapters；缺少 adapter 时使用 `Later` 保留队列，不伪造成功。六类 DSH Effect 保持各自语义：assessment 并发 4、launch 默认实验并发 1、delivery 并发 4 且 quiet；relay/notice 按各自队列串行，reply 默认串行。M6 才将实验 launch 限额接到真实 WorkerSlots。
- 默认退避为 2 秒至 60 秒，launch/reply 为 5 秒至 300 秒。`Later` 只延期，不增加或重置连续失败数；普通失败指数退避，第三次使健康进入 error，继续重试而非丢弃。M2 的 `attempts` 是 claim 次数，M5 的独立失败记录才用于退避和 Outbox 顺序阈值。quiet 只抑制重复普通失败；调度错误和 uncertain 始终明确报错并显示最早等待时间。
- 所有 claim 在同步事务中保存 owner、token、generation、租约和不可变 attempt 快照。payload 更新不能抹掉原尝试，稳定 requestId 在同 generation 的重试间保持不变。跨连接在同事务内计算全局在途上限；ordered 队头未到 due、正在运行或 uncertain 时，后项不能越过。
- handler 在事务外执行 IO，仅返回同步事实 commit。commit 前后均核对 seq、generation、owner、token 与最终时钟；失败回滚领域 SQL、Effect 及 afterCommit。返回 false 的 commit 撤回其部分事实，再取消原尝试；异步 commit 拒绝。已发生 IO 后的提交失败进入 uncertain，不按普通错误重新外发。
- expired running 进入 uncertain，只有显式、精确 CAS 的 reconcile 才能解除。旧 generation 的完成不调用新 payload 的 commit，也不吞掉新代；旧 owner 的迟到结果不能落入新尝试。这里的 cancelled/uncertain 是队列事实，不表示外部动作已被撤销；不声明跨存储或外部 API 的 exactly-once。

### Outbox、控制意图与操作对账

- Outbox 复用原先的同步 receipt/enqueue 端口，发送确认与 Effect 结算同事务。相同消息 ID 保留首次消息；sent/dropped 不再发送。Source 暂缺、暂停或 `waiting` 使用 Later；ignored/gone 成为带原因的 dropped。相同 Ticket、Source、conversation 的后续消息等待前项，前项达到三次普通失败后可放行；running/uncertain 不能被当作普通失败绕过。
- 尚未领取的消息可原子 withdraw；running/uncertain 保留 receipt 并记录撤回请求。未知发送只接受显式的 sent/gone/not-sent 对账事实，不能自动重发；not-sent 且已请求撤回时才收束为 withdrawn。迟到发送成功仍如实记录 sent，不用撤回来掩盖已发生的发送。
- Stop/Release 原控制记录与内部 `control` Effect 同事务保存。消费时使用原 Assignment、Eval 与捕获的 binding，不查询最新 Worker 来替代旧目标；完成后写控制回执。控制在 processing pause 时仍可消费。此处只证明 fake control 已确认，真实 SDK、子代理、后台 job 与执行资源的停止属于 M6。
- 通用 source-operation 先保存 immutable intent，再入队。执行前持久化 `planned → uncertain`，之后才调用 adapter；confirmed/failed receipt、operation revision 与 Effect 同事务结算。未知异常、提交失败及重启只安排 source-reconcile 读取，不重发 write。只有 not-applied 证据才可重新 planned；unknown 保留待对账。
- claim 已提交但 handler 尚未启动的退出窗口也可恢复：对 `planned + Effect uncertain` 核对不可变 attempt 的身份、generation、token、意图及 revision，先补 uncertain 检查点再只读 inspect。取消未知操作只记录请求，不能抹去未知写入；confirmed 仍记录实际结果，not-applied 后才取消。Source/instance/key 分隔身份，revision CAS 拒绝 ABA 和迟到检查结果。

### 生命周期与验收范围

- Pass 以 2 秒周期及按需 request 驱动，单个 pass 串行，并发请求合并成一个 follow-up pass。未配置时保留队列，失败更新健康，后续成功恢复。idle 只说明当前没有可启动的 pass/Effect，不结束 Ticket 或 Assignment。
- processing pause 单独持久化，重建 Driver 不解除暂停。shutdown 先 closing、拒绝新 Trigger 和新 dispatch，再等待 pass 与在途 handler；主动 abort 将未确认尝试标为 uncertain，但仍等待底层 Promise 真正结束，避免关库后留下活跃 handler。停止的 Driver 需要新实例接管，不能悄悄恢复。
- 真实子进程覆盖 claim 提交前后、handler 启动前、外调成功但事实提交前等窗口；另有跨连接限额、SQL ABORT、旧 generation、租约在 commit 内到期、ordinary failure/Later、withdraw、pause、shutdown 和显式 reconcile 回归。

M5 没有增加 schema 步骤，也没有生产注册、真实 Pi 执行、Source 轮询或外部消息/API 写入。M4 的真实 SDK 实验与 M5 的 fake 端口调度分别验收；M6 才组合真实 Executor、回执回调、WorkerSlots、prepare、稳定执行目录及后台资源恢复。生产仍只有旧 `BotRuntime`。

## M6：Executor 资源层与稳定执行目录已组装

位置：[execution-directory.ts](../src/main/bot/shadow/execution-directory.ts)、[worker-slots.ts](../src/main/bot/shadow/worker-slots.ts)、[worker-resources.ts](../src/main/bot/shadow/worker-resources.ts)。

- `executionPaths()` 与 M4 的 scratch Session 使用同一稳定 `worker-<ticketId>` 哈希布局，固定 `base/workspace/sessions/agent/sessionFile`；Ticket 重试不改变目录和 SessionFile。目录根及内部路径拒绝符号链接，只允许系统临时目录边界。
- `ExecutionDirectories` 把 prepare 先记录为持久 `preparing`，再执行显式 recipe。成功后保存 metadata 并变为 ready；首次没有 recipe 的空目录可以直接 ready。recipe ID、root、cwd 和 Ticket 身份不可漂移。
- prepare 超时、abort、异常和 lease 过期不会伪造 ready。失败的非空目录不能自动重试；`retry` 只接受精确 revision 且目录为空，uncertain 必须先用显式 `reconcile` 处理。prepare Promise 即使被 abort，资源状态也不会在底层回调结束前宣称成功。
- `WorkerSlots` 使用既有 Shadow lease 和 KV，无新 schema。starting、running、settling、stopping 与 uncertain 都占用容量；running/settling/stopping/uncertain 的跨连接 claim 使用 owner、generation、revision 和 lease fencing。launch 计算不重复扣除 launch reservation；人的 follow-up 最多额外占一个 slot。过期 lease 进入 uncertain，只有 quiet 对账才能释放。
- `WorkerResources` 将 shell job 与 subagent 的生命周期和 Session idle 分开。资源可进入 handed-off 而不唤醒 Worker；stop 等待所有 stop adapter 返回后再释放 slot；停止失败和重启恢复保留 uncertain。不同 Assignment 的 binding 不能停止或接管旧资源。
- 这些模块只接受显式 fake/sandbox adapter，不启动真实 shell、Git、GitHub、Pi host 或子代理。M4 的真实 Pi SDK 证据仍由 Scratch Session 提供；M6 证明的是稳定目录、资源状态、slot fencing、handoff 和恢复屏障。真实 Executor Host 接入仍需在后续生产组装中完成。

本阶段新增 18 个目录、slot 和资源回归，覆盖目录复用、recipe/失败残留、超时/取消、symlink、slot 容量与人类额外 slot、跨连接 owner、settling、handoff、stop barrier、uncertain 恢复和旧 binding 拒绝。

## M7：隔离 Source registry、Policy、凭据宿主和测试控制面已组装

位置：[source-registry.ts](../src/main/bot/shadow/source-registry.ts)、[policy-host.ts](../src/main/bot/shadow/policy-host.ts)、[credential-host.ts](../src/main/bot/shadow/credential-host.ts)、[control.ts](../src/main/bot/shadow/control.ts)。

- `ShadowSourceRegistry` 复用既有 `dsh_kv`、`dsh_source_cursors` 和 `dsh_leases`，管理已安装 Source kind、持久实例配置、`enabled/disabled/revoked/unavailable` 状态、健康、按 Source/instance 隔离的 poll cursor，以及跨连接 poll lease。未知 Source 不会监听或启动；重复注册、配置 revision 冲突、游标 CAS 冲突和旧 lease 释放都会拒绝。
- Source kind 只能通过显式 `register()` 进入 Shadow registry；实例默认 disabled。Source 的 `scope()` 是 Core 唯一看到的窄接口，具体平台字段保留在 adapter config。Source 配置递归拒绝 token、secret、password、credential、API key 等凭据材料，只允许 `credentialRef` 这类引用。
- `ShadowPolicyHost` 持久化隔离的 Policy/Eval 快照与 revision，使用已有 `policyVersion()`、`settingsPolicy()` 和 `policyEffects()`，不复制第二套 admission gate。保存使用 CAS；规则、Source policy、`off/observe/auto`、timeout 和撤权变化可被重新验证。Policy 扩展字段同样拒绝凭据材料。
- `ShadowCredentialHost` 只保存 Source 到 credential reference 的绑定。resolver 返回的 secret 只能在 `withSourceCredential()` 回调内交给专用 adapter，Shadow 状态、控制快照、数据库、Renderer 和普通 Worker 都拿不到 secret。M7 使用 fake resolver，未接真实 keychain、GitHub PAT 或 FastVibe account token。
- `ShadowControl` 只提供 Shadow 状态摘要：Source 安装/启用状态、health、config key、Policy version/rule/source 摘要和 credential reference 摘要。写入 API 只有显式 test mode 的 Source/Policy 配置修改；普通模式拒绝写入，也没有 launch、Source operation、credential read 或生产注册入口。
- 这些模块没有接入 Electron IPC、普通 settings、远程 API、旧 BotRuntime 或 Source poller。M7 证明的是 registry、scope、健康/游标/租约、Policy CAS/revalidation、凭据引用隔离和控制面边界；真实 Source HTTP、轮询、消息发送和 GitHub 仍属于 M9/M10。

本阶段新增 **9 项** registry/control 回归，覆盖未知/disabled/revoked/unavailable Source、配置和 Policy secret 拒绝、health/cursor 重启恢复、cursor CAS、poll lease fencing、credential callback 隔离、Policy revision 和 test-only control mutation。



领域、隔离、存储、同步组装与真实 SDK 实验测试：

```bash
node --test test/vivi-dsh-*.test.ts
```

本轮结果：**593/593 通过**，39 个 suite，无跳过或取消。M0–M6 的 584 项保持通过；M7 新增 **9 项** registry/control 用例，覆盖 Source 生命周期、health/cursor/lease、配置与 Policy secret 拒绝、credential callback 隔离、Policy revision 和 test-only control mutation。

让相同上游领域用例改用真实 SQLite repository（fake 外部端口不变）：

```bash
FASTVIBE_DSH_TEST_REPOSITORY=sqlite node --test test/vivi-dsh-core.test.ts
```

本轮结果：**113/113 通过**。Store 验收另外使用真实子进程在提交前、afterCommit 内直接退出，重开检查回滚/持久意图、uncertain 与迟到回调；不依赖 finally 正常关闭来模拟崩溃。

当前功能与公共数据库 adapter 回归：

```bash
node --test test/db.test.ts test/bot-runtime.test.ts test/bot-store.test.ts test/bot-restart.test.ts test/bot-engine.test.ts
```

本轮结果：**83/83 通过**；与上述新测试合并运行 **676/676 通过**。测试使用临时数据，不连接正在运行的真实 userData。复制库演练使用测试构造的旧库，确认源库字节、旧行和 schema 14 不变，只有副本升为 15。

类型与格式：

```bash
pnpm typecheck
git diff --check
```

本轮类型检查及新增测试的独立严格类型检查通过，保持原 ES2022 配置和依赖版本。新增模块仍只有测试引用，生产迁移注册保持原样。

## 下一阶段与限制

本文已完成 M0–M7 隔离能力的记录。下一阶段是 M8：Local Source 回放、旧 Bot API 兼容投影和正式旧数据转换 dry-run。M7 的 Source registry、Policy、凭据宿主和控制 API 仍只在 Shadow 测试路径使用。

M8–M11 的 GitHub 闭环和 M12 的最终切换均未验收。当前用户功能继续走旧 Runtime；没有接入旧 API、Session、通知、记忆或真实 GitHub。
