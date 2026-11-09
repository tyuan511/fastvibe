# Vivi DSH：原生 GitHub REST 适配

状态：M11 的原生 reader、operation planner、写入/对账 adapter 和隔离部署已实现，使用本地服务返回原生 REST 响应完成契约与恢复验收。**真实专用 GitHub 仓库的完整受控链路尚未验收，不代表 M11 或 M12 完成。**后续 [vivi-test 实测](vivi-dsh-live-vivi-test.md)已确认真实 PR 创建、push、CI 和 Source 对外部 merged 的观察；宿主 CLI 合并/关闭与不匹配模型产物的 bot 审批另记为行政操作，独立原生 Review、受控 Merge 与 Issue continuation 仍待验收。进度入口见 [开发记录](vivi-dsh-development.md)，完整授权、生命周期和生产隔离合同见 [目标架构](vivi-dsh-architecture.md)。

## 实现入口

| 模块 | 职责 |
| --- | --- |
| `src/main/bot/shadow/github-transport.ts` | `GithubRestTransport`：认证回调、原生 HTTP、reader、完整分页、超时/取消、路径与响应边界 |
| `src/main/bot/shadow/github-native-plan.ts` | `GithubNativePlanner.buildIntent()` 纯构建；`plan()` 只保存不可变原生意图 |
| `src/main/bot/shadow/github-native-operation.ts` | `OperationAdapter.execute/inspect`：远端前置读取、独立身份校验、写入检查点、原生 receipt 和保守对账 |
| `src/main/bot/shadow/github-native-deployment.ts` | 显式组装 registry、Policy、Authority、ShadowDriver、native planner、reader 和 continuation；没有生产注册 |
| `src/main/bot/shadow/github-pi-deployment.ts` | 进一步组装真实 SDK Executor、独立只读 Reviewer、固定版本产物与原生 Review Effect；[隔离验收合同](vivi-dsh-sdk-executor.md) |

`GithubNativeDeployment` 需要调用方提供 reader/writer/reviewer transport、固定仓库和执行/审核账号 ID、Policy、required checks 以及受管 Executor 端口。缺少 Executor 时沿用既有 `Later`，不会伪造 Worker 或模型成功。`poll()` 是显式 Source 轮询入口；接受、执行、投递及停止仍通过原有 Engine、Effects 和角色端口。

transport 默认 origin 为 `https://api.github.com`、API version 为 `2022-11-28`；版本可由宿主明确配置。只允许配置仓库的 `/repos/{owner}/{repo}`、`/repositories/{id}`，以及只读 `/user`、`/notifications`；跨仓库、跨 origin、编码路径逃逸和重定向拒绝。只有显式 `loopbackTest: true` 才可配置 IPv4 loopback HTTP。当前认证身份验收使用 `/user`，适用于用户凭据；GitHub App installation 身份协议与 Enterprise 自定义 origin 尚未接入。

每次请求经 `ShadowCredentialHost` 解析显式绑定的凭据，不发现本机 `gh`、环境变量或 FastVibe 登录凭据。写入还会用**同一次解析得到的 secret**再次读取 `/user`，核对固定账号 ID/login；其后重新检查 credential binding/resolver 和本地 operation owner、Ticket、binding、Policy、Source。避免把独立的一次 `/user` 查询当成下一次解析所得凭据的身份保证。凭据、授权、网络与解析异常统一脱敏，receipt 只保存白名单事实。

## 原生意图和发送字段

`payload.mode=github-rest`、`schemaVersion=1` 与旧 `dry-run` 意图分开；native adapter 拒绝消费 loopback 计划。仓库稳定 ID 与 owner/name 从可信 registry 配置快照取得，执行前回读仓库核对，HTTP 请求体不携带宿主权限字段。

| 动作 | 原生请求 | 对账正证据 |
| --- | --- | --- |
| branch | `POST /repos/{owner}/{repo}/git/refs`，`ref`、`sha` | 持久发送检查点，预读不存在后的相同完整 ref/目标 SHA；仅证明匹配外部事实，不证明排他创建者 |
| PR | `POST .../pulls`，`title`、`body`、`head`、`base` | 完整分页后唯一的作者、仓库、分支、标题和精确 marker/body 匹配 |
| Review | `POST .../pulls/{n}/reviews`，`commit_id`、`event`、`body` | 唯一的 reviewer、commit、state、精确 marker/body；目标版本漂移另记 `stale` |
| Merge | `PUT .../pulls/{n}/merge`，`sha`、`merge_method` | 指定 PR、作者、目标 head、实际 merged 与 merge commit；回执保存期望 base 的读取证据 |
| Issue close | `PATCH .../issues/{n}`，`state=closed`、`state_reason=completed` | 合并 PR/commit、基线之后新增的 closed event、执行 actor、时间与当前关闭事实 |

不会把 loopback 的 `base`、`mergeCommit`、`version` 或自定义幂等 header 发给 GitHub。PR/Review 正文含宿主生成的 HTML marker，用来对账；server fixture 没有按 marker 或 operation ID 提供幂等缓存。

业务 key 包含 Source、instance、仓库、Ticket 和版本目标：PR 按 Ticket/分支，Review 按 PR/head/base/artifact，Merge 按 PR/head/base，Issue 按 origin/merge commit。同 key 参数漂移拒绝；同一 Ticket 的修复产生新 SHA/审核产物时可以生成新 Review，不再受 M10 的 object-only key 限制。重建意图不读时钟、不写库；意图与 Effect 入队由部署的外层事务统一提交。

## 前置检查、未知结果与恢复

普通写入必须有持久 host profile，issue-close 必须来自已登记的 merge continuation。adapter 在 `beforeSend` 的同步事务中复核真实 operation revision、Effect owner/generation/claim/lease、取消信号及领域授权，再保存本次发送 attempt；之后才发出写请求。凭据身份读取返回后仍会重做这些检查。

Merge 重新读取当前 head/base、全部 check-runs/statuses 与 Review，按上下文取最新结果；宿主配置的 required checks 必须成功，独立 reviewer 必须批准当前 head，最新的 changes-requested 阻止合并。`requiredChecks` 来自部署宿主，不信任模型在请求中声称已通过。

明确的原生前置拒绝或非限流的 GitHub 4xx 可保存 failed；限流、5xx、网络错误、请求可能已发出后的提交失败保持 uncertain。inspect 只读取并返回 `confirmed` 或 `unknown`；**没有仅凭 404、列表不存在、对象 open、参数不同就返回 not-applied 的路径**，因此不会自动重发未知 PR、Review、Merge 或 close。恢复无对应发送 attempt 证据时也保持未知。

测试包含真实子进程在原生 branch POST 成功后、SQLite receipt 提交前退出；新进程通过读取匹配 ref 收回事实，POST 总数保持一次。它证明进程崩溃恢复，不声明断电持久性或 exactly-once。

## GitHub 的实际并发边界

以下差异按官方文档实现，不能沿用旧 loopback 的版本 CAS：

- Review `commit_id` 指定审核的 commit，**不是当前 head 的原子条件**。写前核对 head/base，发布后再次读取；变化时保存 stale receipt。旧 commit 的批准不能通过新 head 的 Merge 检查，但无法承诺 GitHub 从未创建过已变旧的 Review。
- Merge 的 `sha` 是 head 条件；API 没有对应的 base SHA 条件。宿主写前读取 base 与 CI/Review，但读取和 PUT 之间仍有变化窗口。真实部署还须使用 GitHub 仓库的保护规则约束最终合并，不能把这些本地读取说成平台事务。
- Issue PATCH 没有已文档化的 `If-Match` CAS。**默认 strict profile 不发送 PATCH**，PR merged 与待人工/GitHub 收束分开表达；如果 GitHub 已自动关闭关联 Issue，只有最后一个生命周期事件带相符 merge commit、可信执行/合并 actor 且晚于观测基线，才按外部事实确认完成，不伪造本次 PATCH 回执。宿主只有显式选择 `issueClose: best-effort` 才允许自动关闭：先比对 `updated_at` 与完整 Issue events 的最大 ID，发现 reopen/新事件即拒绝；请求已经发出后，reopen 使未知对账保持 unknown，不会再次 PATCH。写前读取到 PATCH 之间仍有窗口，不能承诺严格不覆盖并发 reopen。

这些限制不改变 Ticket 的 merged 事实，也不授予 ended Ticket 普通执行权限。原生 continuation 注入纯 `buildIntent()`，复核同次 ended、Decision、origin Issue、Follow、原生仓库/PR、merge receipt、Source revision 和 Policy；关闭失败不重启 Worker。

## 验证与仍未完成的范围

```bash
node --test test/vivi-dsh-github-native-*.test.ts test/vivi-dsh-github-transport.test.ts
pnpm typecheck
```

测试使用原生路径、字段、状态码和 Link/ETag，网络只连本地 fixture。包括实际 M9 Source reader、真实 ShadowStore/Effects/Operations、真实领域接单/binding/ready/Follow/merged、独立凭据反查、同 Ticket 新 SHA Review、默认 strict 与显式 best-effort continuation、响应丢失、分页、限流、未知证据和真实子进程退出。该原生 adapter 专项中的 Worker 与审核产物仍由明确 fixture 提供。后续 [SDK 联合验收](vivi-dsh-sdk-executor.md)使用真实 SDK 与离线脚本 provider 修改临时文件、调用只读审核工具，再经相同原生 adapter 发送 Review；它仍不代表外部模型或真实 GitHub 已验收。

仍需专用真实仓库与可撤销的两个身份，完成真实模型编码、受管只读 reviewer、分支提交/push、CI、Source 自动驱动与恢复的整条链路；本地 HTTP 契约不能代替真实 GitHub 服务验收。M12 继续不允许接管生产 Runtime、用户数据、普通 settings 或现有 Session。

官方契约核对入口：

- [Git references](https://docs.github.com/en/rest/git/refs)
- [Pull requests / Merge](https://docs.github.com/en/rest/pulls/pulls)
- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [Issues](https://docs.github.com/en/rest/issues/issues)
- [Conditional requests 的支持边界](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
