# Vivi DSH：vivi-test 真实仓库验收记录

核对日期：2026-11-09。仓库 [tyuan511/vivi-test](https://github.com/tyuan511/vivi-test) 是用户明确授权任意操作的专用私有测试仓库，稳定 ID 为 `1450887533`。用户另明确允许本次验收复用本机现有 GitHub 登录和模型配置。没有改动生产 BotRuntime、普通会话、settings 或生产数据库。

**结论：真实 Worker 修复、受控 commit/push、原生 PR 创建、真实 CI 与原交付 head 的独立只读模型审核已通过；后续宿主行政操作使 PR #2 merged、Issue #1 closed，Source 已合法观察 PR closure，但原生独立 Review、受控 Merge／Issue continuation 和自动接单仍未通过验收。M11 尚不能签字，不能进入 M12。**

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
| 真实 PR | [PR #2](https://github.com/tyuan511/vivi-test/pull/2)，后续由宿主 CLI squash merge |
| 原交付 head CI | [test job 128975053271](https://github.com/tyuan511/vivi-test/actions/runs/42560309156/job/128975053271)，相同 head，completed/success |
| 独立模型审核 | 独立 ModelRuntime/Session，只读工具，固定原交付 head/base；completed、approve、0 findings |
| GitHub bot Review | `github-actions[bot]` 的 Review `5822033424` 为 APPROVED，但绑定 workflow 改变后的 head，缺少对应模型产物，不计有效验收 |
| 外部合并事实 | head `5d943df457c578a83f0b780784e58a6364dcf63d`，merge commit `4963ef156dcfb680d14f10b1ab743059073d122f`，actor `tyuan511` |
| 外部 Issue 事实 | Issue #1 在 `2026-11-09T05:41:56Z` 被 `tyuan511` 关闭，`state_reason=completed`；不是 DSH continuation 回执 |
| 后续 Source 核对 | 实际 GET 轮询后，原 PR Follow closed/merged、Ticket ended/merged；重复轮询新增事件为 0 |

持久 Operation 中 commit、push、pull 各一条，均 confirmed。push 使用真实 GitHub HTTPS 与精确 ref lease，pull 由原生 REST adapter 发出并确认。没有使用普通 shell push 代替 Worker 的受控交付；初始基线的初始化/push 属于宿主准备测试仓库。

独立模型审核产物绑定 base `60b96871400d323e990bbddf5c7691647df12f1b` 和原受控交付 head `3cc575f3ec9c58987129954358d401cb07068e76`，另核对了真实 SDK input/read receipt 与工具调用证据。它是模型审核产物，不是 GitHub 已发布的 Review，也不构成 Merge 回执。

## 后续行政操作与证据纠正

宿主为尝试使用 Actions bot，开启了仓库默认写权限与 Actions 审批，在 PR 分支加入通过测试即 APPROVE 的 workflow。该改动创建了新 head `5d943df457c578a83f0b780784e58a6364dcf63d`；原模型产物只覆盖 `3cc575f3ec9c58987129954358d401cb07068e76`。新 head 的 [CI run 42568562619](https://github.com/tyuan511/vivi-test/actions/runs/42568562619) 两个 job 均成功，但 workflow 没有验证新 head 对应的持久审核产物。它发布的 bot Review 不能视为有效的独立模型审核，也没有经过 `planReview()` 或原生 Operation 身份校验。

随后宿主直接调用 CLI 合并 PR，并直接 PATCH 关闭 Issue。这些调用改变了真实 GitHub 对象，但绕过了 DSH Merge Effect 和已登记的 Issue continuation。账本仍只有原 commit/push/pull 三条 confirmed Operation；不得补造 Review/Merge/issue-close confirmed receipt，也不得将其描述成审核侧 Merge 或 DSH Issue 收束已验收。

已将仓库默认 workflow 权限恢复为 `read`、`can_approve_pull_request_reviews=false`，并在 `main` 的清理提交 `57afaa37991dcf2fc33cb36d301072b85f8c055a` 移除无条件审批步骤；[清理 CI](https://github.com/tyuan511/vivi-test/actions/runs/42569280926) 成功。尝试撤回 Review 后 GitHub 回读仍为 APPROVED，因此记录为无效验收证据，不声称已撤回。

后续只启动现有 Source reader 与暂停策略下的 ShadowEngine，没有启动 Driver、Executor 或模型。实际轮询成功读取 8 个页面，接收 2 个事件，并通过 `threadClosed` 关闭原 PR Follow、使 Ticket 以 merged 结束；重复轮询新增事件为 0。两轮均验证 Operation 和 SDK receipt 内容没有变化，continuation 不存在。Ticket 的 `ended.by=executor` 是领域 Follow 收束语义，不是远端合并 actor 或 Merge Operation 的证明；远端 actor 为 `tyuan511`。Source 可保存外部合并事实，现有 settlement 仍要求真实 confirmed Merge Operation 才能登记 Issue continuation。

新增脱敏证据与原 `evidence.json` 并存，不覆盖原 head 的模型产物：`external-settlement-audit.json`、`source-observation.json`、`source-observation-repeat.json`。原证据的 pending 状态表示当时的验收状态，后续 GitHub 当前状态以新增审计为准。本次另运行 Source 与 settlement 专项 **40/40** 通过，包含未确认 Merge、错误身份与 SHA 的拒绝回归；后续仓库变更仅为本验收记录及关联进度文档。

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

当前原生 adapter 用 `/user` 核验独立发布身份，本机仍只有执行账号的用户凭据；Actions bot 在 workflow 中能发布 Review，并不等于已接入该受控凭据协议。后续需提供支持当前协议的独立 reviewer 用户凭据引用，或先实现并验收 GitHub App installation 身份协议，再在新的专用验收轮次中完成严格绑定当前 head/base 的模型审核、原生 Review → 修复 → 新 head 审核、受控 Merge 和独立 Issue continuation。不得重新运行已完成的原 runner、重放原 provider 请求或为已合并 PR 补造 Operation。

单账号的显式回放不证明自动外部事件接单；本次宿主测试失败修复也不能代替原生 Review 反馈修复。完整 Source 驱动和真实平台故障演练仍需验收。生产继续使用旧 Runtime。
