# Vivi DSH：vivi-test 真实仓库验收记录

核对日期：2026-11-09。仓库 [tyuan511/vivi-test](https://github.com/tyuan511/vivi-test) 是用户明确授权任意操作的专用私有测试仓库，稳定 ID 为 `1450887533`。用户另明确允许本次验收复用本机现有 GitHub 登录和模型配置。没有改动生产 BotRuntime、普通会话、settings 或生产数据库。

**结论：真实 Worker 修复、受控 commit/push、原生 PR 创建、真实 CI 与独立只读模型审核已通过；原生独立 GitHub Review、Merge、Issue 收束和自动接单仍未验收。M11 尚不能签字，不能进入 M12。**

关联：[SDK Executor](vivi-dsh-sdk-executor.md)、[Git 交付](vivi-dsh-git-delivery.md)、[REST 合同](vivi-dsh-github-rest.md)、[开发记录](vivi-dsh-development.md)。

## 固定任务与外部证据

验收用例是人为构造的零依赖 Node 22 项目，修复免打扰窗口的跨午夜、重叠、相邻及全天覆盖行为。README 与 Issue 均明确这是测试 case，不是生产故障。

| 事实 | 本次证据 |
| --- | --- |
| 原始任务 | [Issue #1](https://github.com/tyuan511/vivi-test/issues/1) |
| 基线 | `60b96871400d323e990bbddf5c7691647df12f1b`，固定测试 5 pass / 5 fail |
| 真实基线 CI | [run 42557085808](https://github.com/tyuan511/vivi-test/actions/runs/42557085808)，failure |
| 执行模型 | `magpie / codex/gpt-6.1-sol`，真实 Pi SDK/provider；不是 faux provider |
| 第一次宿主验证 | 8 pass / 2 fail；跨午夜的 nextAllowedMinute 错误返回 0 |
| 修复反馈 | 将真实测试失败记录为宿主事实，在同一 Ticket 的新 Assignment 下交付；保留模型先前 ready 报告 |
| 最终宿主验证 | 不可变验收副本 10/10、工作区测试 10/10，通过 |
| 受控交付 head | `3cc575f3ec9c58987129954358d401cb07068e76` |
| 真实 PR | [PR #2](https://github.com/tyuan511/vivi-test/pull/2)，本次核对时 OPEN |
| 真实 head CI | [test job 128975053271](https://github.com/tyuan511/vivi-test/actions/runs/42560309156/job/128975053271)，相同 head，completed/success |
| 独立模型审核 | 独立 ModelRuntime/Session，只读工具，固定相同 head/base；completed、approve、0 findings |
| 原生 GitHub Review | 尚无可用的独立发布身份；本次核对时 reviews 为空 |

持久 Operation 中 commit、push、pull 各一条，均 confirmed。push 使用真实 GitHub HTTPS 与精确 ref lease，pull 由原生 REST adapter 发出并确认。没有使用普通 shell push 代替 Worker 的受控交付；初始基线的初始化/push 属于宿主准备测试仓库。

独立模型审核产物绑定 base `60b96871400d323e990bbddf5c7691647df12f1b` 和上述 head，另核对了真实 SDK input/read receipt 与工具调用证据。它是模型审核产物，不是 GitHub 已发布的 Review，也不构成 Merge 回执。

## 实际边界与本次发现

- 当前只有 `tyuan511` 一个 GitHub 登录，同时承担验收 Issue 作者和代码执行身份。Source 正确忽略 writer 的自身事件，因此本次采用明确的宿主 self-issue 回放，保留 `self=true / human=false`，不把它伪装成独立人类事件。Decision 为用户授权下的人工宿主 Decision，不是模型自动评估。
- 原 Executor 仅打开首次 Session，没有激活 origin。新增显式 `initialAssignment: true` profile：launch 提交后才准备稳定 assignment 请求，通过同一 sweep 激活；它不伪造 TicketInput delivery。
- 初次实际执行在父线程接管期间被中断。旧 provider-read 已发生，旧请求没有普通重试；确认进程死亡、租约到期后走显式 quiet reconcile，新 Assignment 使用同一 Ticket/Session/目录继续，保留了旧回执。不能据此声明所有真实平台故障演练都已完成。
- 多个 SDK 输入同时完成时，第二个 completion 对已释放 slot 的检查会误标 uncertain。修复为：已 quiet 且 slot 已由本进程释放时允许完成幂等 idle 记录；仍存在但失效的 slot 继续拒绝。工具/read/report 的资源校验保持不变。
- 宿主失败反馈必须在 retry 已排入新 Assignment 后添加；失败或 ready 等待阶段会按领域合同持有自动 note。ready 不等于通过测试，旧 Assignment 的 PiReport 也不能成为当前 Assignment 的 ready 证据。

## runner 与数据

手动入口：[scripts/dsh-live-vivi-test.ts](../scripts/dsh-live-vivi-test.ts)。它固定只接受本仓库身份，模型和 GitHub 凭据仅在宿主使用，Worker 不获得 shell、Git 或网络凭据。

这是特定用例的显式实验入口，不是生产部署器。状态、SDK JSONL、源码工作区和 ShadowStore 均在独立系统临时目录；最终脱敏证据另外保留在 `~/Downloads/vivi-test-m11-acceptance/`。runner 完成后拒绝重复执行；已有外部意图时必须使用 Operation inspect/reconcile，不重建一个带新时间的 commit 再推送。

本次系统临时根目录为 `fastvibe-vivi-test-m11-utwk4_kn`。其中有 5 个 Assignment，包含准备失败后的恢复、真实进程中断恢复与宿主测试反馈修复；没有把这些历史删除后宣称首轮成功。凭据没有复制到该目录或证据报告。

代码回归：完整 DSH/旧 Bot/数据库组合 **1020/1020**，Executor 专项 **20/20**，项目 typecheck 与包含 runner 的严格 ES2022 检查通过。依赖仍复用相同锁文件的主仓库安装，typecheck 使用 `pnpm --config.verify-deps-before-run=false typecheck`，不触发 pnpm 重装共享依赖。

## 剩余验收

原生独立 Review、审核侧 Merge 和独立 Issue continuation 仍等待独立 GitHub 身份。单账号的显式回放不证明自动外部事件接单；本次宿主测试失败修复也不能代替原生 Review → 修复 → 新 head 审核这一段。后续须在完整身份和配置下完成这些步骤及平台故障演练，再评估 M11 退出条件。生产继续使用旧 Runtime。
