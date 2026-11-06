# Vivi DSH：隔离 SDK Executor 与受管 Reviewer

状态：M11 的显式部署现在能将真实 Pi SDK Worker、独立只读 Reviewer、领域 read/report 和原生 Review Effect 组装起来。验收使用离线脚本 provider、临时 ShadowStore、专用临时文件和 loopback 原生 HTTP 契约服务；**没有使用外部模型、真实 GitHub、真实用户凭据或生产 Runtime，不代表 M11 通过。**

关联：[目标架构](vivi-dsh-architecture.md)、[开发记录](vivi-dsh-development.md)、[原生 REST 合同](vivi-dsh-github-rest.md)。

## 入口与部署输入

- `PiExecutor`：显式传入 ShadowStore、专用 root、Worker ModelRuntime/model、当前 ShadowEngine、enabled、maxWorkers 和可选目录准备 recipe；实现 Driver 的 launch/delivery/stop adapter。
- `ManagedPiReviewer`：使用独立的 ModelRuntime/model、固定 head/base、完整 diff、要求、版本化文件列表和宿主只读端口；不继承 Worker 工具或历史。
- `GithubPiDeployment`：组合 `GithubNativeDeployment` 与 `PiExecutor`。`poll: false` 禁止自动读取；显式 poll 配置在 beforePass 读取 Source，再扫描输入。周期由 `native.driver.intervalMs` 明确选择；`false` 仅由调用方的 idle/pass 驱动，不声称已启动后台轮询。
- `reviewDelivery` 是显式宿主配置：PR 编号与 head/base 来自宿主 target，Source/instance/仓库固定。可选择不可变 profile 的 allowed operations 与独立 Issue continuation 权限；它们必须与该 binding 其余宿主授权一致。Worker 参数只有 artifactId，不能选择另一仓库、伪造授权或提供凭据。组合部署要求 Source selfLogins 明确包含执行账号、botLogins 包含自动审核账号，且审核账号不被当作 self；自动审核反馈保留为 bot context，不伪装成人类交办或恢复权限。

部署方必须提供明确的专用仓库、已注册 Source、reader/writer/reviewer transport、两个独立可撤销用户身份和选定模型。模块不发现本机 `gh`/SSH 登录，不搜索现有 token，不加载普通 settings，不替用户选择模型，也不从 FastVibe 账号登录推导模型可用。

当前 assessment、消息端口、PR/分支/merge 计划、版本快照及后续 Git 提交/push 仍由显式宿主提供或待实现。这个入口没有自动用模型文字创建 Decision，也没有赋予 shell 或直接 git push。生产 Bot API、IPC、旧数据、普通会话、通知与记忆继续由旧 Runtime 管理。

## 持久输入与真实模型读取

```text
launch claim → 准备目录/保留 slot → 打开稳定 Worker Session
→ completeLaunch 提交 running binding
→ delivery adapter 只 prepare Pi inbox
→ completeDelivery 提交 deliveredTo / undelivered
→ sweep 重读当前 binding、暂停、slot 和已提交输入
→ activate → SDK user JSONL → provider-read → 结构化 report
```

`ScratchPiSession.prepare()` 只保存 accepted receipt，不调用 provider、不追加 SDK user。`activate()` 只接受同 binding，已有 entry/terminal 不重复派发，并发激活共享 completion；旧代输入不能以相同 requestId 在新 binding 下复用。原 `submit()` 的既有显式行为保留。

Pi read 与领域 inputsRead 在同一 SQLite 事务接受；宿主校验拒绝、异步回调或 SQL 回滚时都不成立。READ 与 REPORT 的 JSONL 是提交后的审计镜像，不能从未获数据库接受的镜像恢复授权事实。稳定历史仍作为模型上下文，旧 Assignment 的 entry 不会再次成为新 Assignment 的 delivered/read/report 证据；显式 recover 的实际 entry binding 单独保留。

sweep 是恢复依据，进程内唤醒不能代替持久输入。SDK idle 只归还资源并记录 turnEnded；不结束 Assignment/Ticket。缺少终态结构化报告时，Executor 给出固定文案的 waiting；SDK provider 失败给出固定文案的 failed，不保存原始异常或把普通 assistant 文本伪造成 Worker 报告。PiReport/REPORT 镜像仍只来自真实 dsh_report，已有终态报告不会被兜底覆盖。ready 仍按真实 Follow 决定是否结束，绝不推断已经 merge 或完成 Issue 收束。

## Worker、Reviewer 与文件边界

Worker 的固定工具是 `read_file/write_file/edit_file/list_files/dsh_report`；配置独立 Reviewer 后增加 `request_review`。没有 shell、任意网络、git、通用工具调用、子代理或全局扩展/技能/工程上下文加载。

`WorkspaceFiles` 只接受专用 ExecutionDirectories.cwd；拒绝绝对路径、父级跳转、控制字符、`.git`、符号链接、硬链接和特殊文件，并在操作边界校验 binding/slot。文件打开使用 O_NOFOLLOW 与 inode 检查，截断前再校验。读取最多 512 KiB，写入最多 1 MiB；edit 是唯一、非空的字面匹配。它不是 OS 沙箱，不承诺抵御相同 OS 用户恶意并发替换祖先目录。

Reviewer 的工具精确为 `read_file/dsh_review`，role Session key 绑定 Ticket/head/base/artifact，不与 Worker transcript 或 owner 共用。宿主提供完整固定 diff，read_file 只可读取列表中的版本。Executor 的文件 version 为 `sha256(JSON.stringify(content))`，快照构造方必须使用相同编码。审核没有执行测试的能力；只有明确传入的宿主 verifiedChecks 能保留 passed/failed，其余检查记为 not-run。

只有真实 provider-read 与结构化工具调用才能生成 completed artifact；普通 assistant 文本不构成审核。相同 artifact 内容漂移拒绝，新 head/产物使用新身份。版本、父 binding 或 Stop 变化使迟到结果无效；中断的旧审核只读呈现 uncertain，显式 retry 才能建立新 attempt。

## 审核产物与原生写入

显式 reviewDelivery 在 Reviewer 完成后调用 `planReview()`：重读持久产物、对应 Pi input/read receipt、完整 binding 与宿主 PR 版本，经过既有 GithubOperationAuthority 生成原生 source-operation。高严重度发现或 failed checks 强制 REQUEST_CHANGES；artifactId/head/base 保留到计划和正文。

返回的 queued/planned operation 不是 GitHub 写入回执。独立 reviewer transport 仍通过真实用户身份反查、Source/Policy/Stop/Effect lease/版本检查后发送原生 POST；确认和未知对账复用原生 adapter，不新增调度器。未知写入保持 uncertain，只读对账，不自动重发。Review commit_id、Merge sha 和 Issue PATCH 的并发限制仍按原生 REST 合同。

## 资源、停止与恢复

从目录 prepare 起保留并续租 Worker slot，provider、文件工具、read/report 和 Reviewer 边界均检查所有权；idle 只在实际 SDK/受管子审核结束后释放。当前 profile 没有后台 shell/job，Reviewer 作为父 turn 等待的受管资源，不因等待而提前释放名额。

Stop 先撤销当前宿主执行资格，覆盖从目录 prepare 到 Session 打开的完整 launch，取消并等待仍在执行的 recipe；每个异步边界重新检查精确的 live/pending Assignment。随后实际 abort/dispose Worker 与所有受管 Reviewer；处理迟到 control 时核对其 Assignment/binding，不能停止新代。关闭部署同时取消 Source poll、停止原生 Driver 并等待 SDK 资源；外部已发请求的未知状态仍由 Operation 保留。

启动扫描遇到旧 slot 或已 persisted 但未 settled 的旧输入，只标记 uncertain。`reconcile(ticketId, { quiet: true })` 要求旧进程已死，或有本进程确认 dispose 的 quiet 证据，并且没有活 Session/owner；旧 slot 还须到期并完成精确 quiet reconcile。quiet 恢复先运行纯磁盘/receipt 对账，不构造 SDK 或启动模型，再按当前 entryBinding 分类，覆盖 JSONL user 已写但 SQLite entryId 未补齐的崩溃；历史 Assignment 不参与当前中断分类。仅 accepted、未写 user 的输入可在原 binding 激活；已发模型请求不得自动重放，显式恢复走领域 interrupted/new Assignment 的恢复说明。Stop 取消的输入不会因扫描或重开复活。

## 复验与退出条件

```bash
node --test test/dsh-*.test.ts
node --test test/vivi-dsh-*.test.ts test/dsh-*.test.ts test/db.test.ts test/bot-runtime.test.ts test/bot-store.test.ts test/bot-restart.test.ts test/bot-engine.test.ts
FASTVIBE_DSH_TEST_REPOSITORY=sqlite node --test test/vivi-dsh-core.test.ts
pnpm typecheck
```

SDK/原生 HTTP 联合测试能证明工具真实调用、临时文件真实修改、领域回执与审核产物分离、原生 Review POST/receipt、修复后新 SHA 重新审核，以及停止/事务/恢复边界。离线 provider 不证明模型能自主解决真实问题；原生契约服务不等于 GitHub。

M11 尚需专用真实仓库与身份部署、真实模型编码与修复、宿主管理的分支提交/push、真实 CI、Merge、独立 Issue 收束、完整 Source 驱动和真实平台故障演练。M11 全部验收前不得进入 M12。
