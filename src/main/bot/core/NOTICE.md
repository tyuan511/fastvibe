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

这是源码移植，不是安装另一个 Agent Runtime。Pi、Store、Source 和 Effects 适配均在这些同步端口之外实现。当前只有隔离测试调用实验组装；生产 Bot API、BotRuntime、会话、数据库、通知及轮询入口无法到达它。

## 上游更新

更新基准必须使用新的固定提交，逐文件复核差异并保留上述适配记录；先跑领域、策略和隔离回归，再单独决定是否接入生产。不能把上游 Session/inbox/flush 能力当成 Pi 已提供的能力。
