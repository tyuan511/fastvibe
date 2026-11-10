# DSH 领域源码来源

本目录的领域实现移植自：

- 仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>
- 固定提交：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`
- 版权：Copyright (c) 2026 DeepSeek Harness Team
- 许可证：[MIT License](LICENSE)，随源码保留完整许可正文。

## 移植边界

`src/core/*.ts` 的完整领域闭包保留在本目录，包括 model、ports、intake、evals、tickets、assignments、replies、stage、engine 和内存 repository。没有引入 DeepSeek Harness Session SDK、Cordis、SQLite Store 或上游插件的注册入口。

FastVibe 适配包括：

1. 各文件增加 SPDX 与此来源记录；
2. 将 TypeScript 构造器参数属性改为显式字段和赋值，使 Node 的原生类型擦除可运行；
3. 将 `model.ts` 的 `Array.findLast` 改成 `slice().reverse().find`，保持“从最后一项查找”且不修改原数组，兼容 FastVibe 的 ES2022 类型目标；
4. 从上游 `src/policy.ts`、`src/admission.ts` 提取纯策略、接收表和 assessment 校验，配置以明确的 TypeScript 输入传入；不带入 Zod 配置表单、CLI、文件系统或部署注册；
5. 上游领域测试改为 Node test runner，保留原场景和断言含义；
6. M3 修复同毫秒重评对已完成 Eval ID 的复用：普通 ID 不变，若该 Thread 的持久 Decision 已使用该 ID，则派生一个未使用的 replay ID。冻结时钟和重启回归证明旧 outcome 不会决定新批次。

M2 的 `../shadow/store.ts` 另外参考上游 `src/app/store.ts` 的 repository、嵌套 savepoint、afterCommit 和 receipt 语义，改为通过 FastVibe 的 Db adapter 操作。它新增实验库路径限制、聚合索引约束、Effect lease/claim fencing、Operation revision CAS 与只读迁移报告，不带入上游配置 parser、模型执行或调度注册。MIT 文件头与本许可证继续随源码保留。

M3 的 `../shadow/ports.ts` 和 `../shadow/engine.ts` 参考上游 `src/app/runtime.ts`、`assessment.ts`、`outbox.ts`、`notices.ts` 及 `src/executor/dsh.ts` 的同步入队、quiet notice、follow-up/report relay 与回执语义。实现只面向手动 fake completion，增加持久 Worker binding、generation/claim fencing 和 Stop/Release control；没有注册 SDK handler、Passes 或生产 Source。

M4 的 `../shadow/pi-ledger.ts` 和 `../shadow/pi-session.ts` 参考上游 `src/app/sessions.ts` 与 `src/executor/dsh.ts` 的稳定 Ticket Session、输入读取与报告语义，使用已有 Pi SDK 重写；不带入 DSH Session/inbox/flush。精确 UserMessage 身份、provider stream 边界、嵌套输入 hook 隔离、epoch/owner、JSONL 对账与 SQL 报告接受记录属于 FastVibe 适配。实例内部方法与附加字段明确锁定 Pi 1.3.0，以真实 SDK、离线 provider、临时数据库及真实进程崩溃测试验收；没有接入生产 host 或 Effect driver。

M5 的 `../shadow/effects.ts`、`passes.ts`、`outbox.ts`、`driver.ts` 移植上游 `src/app/effects.ts`、`passes.ts`、`outbox.ts`、`runtime.ts` 的六类调度、Later、退避、quiet、消息顺序与生命周期语义。FastVibe 新增不可变 attempt、owner/token/lease 尾部 fencing、uncertain 对账、IO 后提交失败保护、持久 control 和通用 source-operation/source-reconcile；这些不是上游已经提供的保证。`claims.ts` 是执行校验助手，`operations.ts` 是新操作适配；均只在临时库与 fake/sandbox 端口上组装，不接生产 Runtime、SDK 执行或 Source。

M8 的 `../shadow/local-source.ts`、`legacy-compat.ts`、`migration.ts` 是新增的 Shadow-only 适配：Local Source 只接受显式标准化 Trigger/分页回放并复用 cursor/lease fencing；兼容层输出 detached 的旧形状 WorkSnapshot 和受控命令，不依赖 `src/shared/bot.ts`、IPC 或旧 BotRuntime；迁移器只在 Shadow 表保存固定 snapshot、checkpoint、稳定映射和未授权 evidence。它们没有接入真实本地输入、旧表写入、生产数据库、Source poller 或生产 Runtime。

M9 的 `../shadow/github-source.ts` 是新增的 Shadow-only GitHub 只读适配：它只接受显式注入的 reader 和 response，不创建网络客户端或凭据解析；Link 分页、按路径 ETag/304、cursor CAS、poll lease、Issue/PR/comment/review/CI Trigger 规范化、多 Source/repository identity、CI baseline、actor 过滤、PR `threadClosed` 和 HTTP health/status 映射均保持在 adapter 内。它复用 Shadow cursor/lease，在同一事务提交接收事实、生命周期、CI baseline、ETag 和游标；不接生产 Source registry/poller、旧 BotRuntime、IPC、真实 GitHub 或写入 Effect。

M10 的 `../shadow/github-operation.ts` 是新增的 Shadow-only dry-run planner：它校验 Source/instance/repository identity、Mandate allowed operations、ticket/generation、Stop、PR head/base、required checks、branch/PR/review/merge/Issue close 参数，保存稳定 operation intent、参数哈希和幂等 key。它只输出预期 method/path/body 与模拟 receipt；`uncertain`、`unknown`、`confirmed`、`not-applied` 和取消必须显式推进，不调用网络、真实凭据或 source-operation Effect。

M11 原生适配的 `../shadow/github-transport.ts`、`github-native-plan.ts`、`github-native-operation.ts` 和 `github-native-deployment.ts` 是 FastVibe 新增实现，不是移植的上游保证。它们复用原有 Source/Engine/Effect/Operation，新增原生 REST 路径与字段、纯意图构造、Ticket/版本/artifact key、发送检查点、完整分页、同 secret 身份反查、独立审核账号和只读对账。settlement 支持注入原生纯 builder；GitHub 的 Review/Issue 没有继承 loopback 的 CAS，默认 Issue strict profile 不发 PATCH。以本地原生 HTTP 契约和真实子进程恢复验收，真实仓库与模型链路尚未验收；详见[原生适配说明](../../../../docs/vivi-github-rest.md)。

M11 SDK 组装新增 `../shadow/pi-executor.ts`、`pi-reviewer.ts`、`pi-workspace.ts`、`github-pi-deployment.ts`，属于 FastVibe 的显式隔离部署实现。稳定 Worker 与独立 role Session、prepare/activate inbox、领域/Pi read 同事务接受、受管只读审核产物、slot/Stop/崩溃恢复和原生 Review Effect 连接都不是上游已经提供的保证。真实 SDK 使用离线脚本 provider、临时文件与 loopback 原生 HTTP 验收；没有接入生产 Runtime、发现真实凭据、运行外部模型或 Git push。工具集合不声称 OS 沙箱，当前验收边界见[SDK Executor 合同](../../../../docs/vivi-sdk-executor.md)。

## 上游更新

M11 前置的 `../shadow/github-deployment.ts`、`github-authority.ts` 和 `github-settlement.ts` 是 FastVibe 新增实验：复用 M5 的 operation/Effect 状态机，对 loopback HTTP、持久宿主权限、merge 后独立 Issue continuation、原子登记和重启对账做验证。fake HTTP server 只在测试 fixture，不是 GitHub 原生协议；host profile、Issue 版本比较和条件关闭也不冒称上游或 GitHub 已提供的能力。M7 credential callback 增加解析后的 binding/resolver fencing，M10 授权可携带精确 Assignment/binding 身份；这些模块仍不可从生产路径到达。真实 GitHub、独立 reviewer、真实 Worker 和 M11 端到端退出条件未验收，范围见 [开发记录](../../../../docs/vivi-development.md)。

更新基准必须使用新的固定提交，逐文件复核差异并保留上述适配记录；先跑领域、策略和隔离回归，再单独决定是否接入生产。不能把上游 Session/inbox/flush 能力当成 Pi 已提供的能力。
