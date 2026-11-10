# Vivi DSH：宿主管理的 Git 提交与推送

状态：M11 隔离部署增加固定快照的 Git commit/push 端口，接入已有 `ShadowOperations`，不注册生产 Runtime。回归使用临时真实 Git 仓库与本地 bare 远端；另已在用户授权下完成 [vivi-test 的真实模型修复、受控 GitHub push、PR 与 CI](vivi-live-vivi-test.md)。原生独立 Review、Merge、Issue 收束与自动接单仍是 M11 退出条件。

关联：[SDK Executor](vivi-sdk-executor.md)、[原生 REST](vivi-github-rest.md)、[开发记录](vivi-development.md)。

## 端口与授权

- `ManagedGitRepository`：宿主固定专用仓库路径、`refs/heads/dsh/...` 分支和 HTTPS GitHub 远端。只运行固定参数的 Git 子进程，不接受 Worker 提供的命令、remote、凭据或 Git 配置。
- `GithubGitOperations`：独立 `managed-git` 协议，保存固定 commit/tree/parent、作者与时间、目录 revision、授权 profile 和宿主目标指纹；复用 source-operation/source-reconcile。
- `GithubNativeDeployment`：可选 `git: { repository, directoryRevision }`，通过同一个 Driver 分派 REST 与 Git。`grant(token, ["commit", "push", ...])` 明确授权两种能力；既有 branch 权限不会自动获得修改代码或推送权限。`planGitAndQueue()` 在事务内授权并保存意图，不能使用 REST/dry-run planner 绕过端口。

授权继续绑定真实 Decision/Mandate、当前 Worker binding、Policy exact version 和 Source revision。每次子进程启动前重查，凭据解析后也重查。目录 revision 必须由宿主从当前 ready execution-directory 解析；准备目录的 lease 不等于 Git 执行授权。

凭据只由部署方显式 resolver 提供。HTTPS 固定为 `https://github.com/{owner}/{repo}.git`；测试须显式 `localTest: true` 才接受绝对本地 bare 远端。模块不发现 `gh`、SSH agent 或现有登录，不读取普通 settings、用户 Git 配置或全局模型配置。GitHub API 账号校验仍属于 REST adapter；Git HTTPS resolver 与仓库/执行身份的对应关系由宿主部署配置保证，不能把成功 push 当作 `/user` 身份证明。

## 固定快照、提交与 push

宿主通过 `deployment.git.prepareCommit(input, authorization, directoryRevision, signal)` 准备提交快照。`input` 包含固定 parent SHA、经过宿主文件端口核对的文本变更列表、提交说明、作者姓名/邮箱和 UTC 秒级时间；不是整个工作树的自动暂存。

准备使用临时私有 index，按指定 parent 生成树与确定的 commit 对象，不更新工作区 HEAD、普通 index 或分支。它只写不可达对象；Stop 或准备失败留下的 Git 对象不表示代码已交付。快照保存完整 SHA/tree/parent/ref/message/author/timestamp，授权与目录版本在准备过程中持续验证。

宿主随后按顺序提交两种独立意图：

```text
prepareCommit → 固定 Git 对象快照
→ planGitAndQueue(kind=commit) → Effect → update-ref 的 parent CAS → confirmed
→ planGitAndQueue(kind=push, expectedRemoteSha=明确旧 SHA 或 null)
→ Effect → 本地提交证据与远端 ref lease → confirmed
→ 原生 pull/review/merge 等后续意图
```

commit 校验 Git 对象的完整元数据和内容，再对固定分支执行 `update-ref new old`。push 要求同一快照、binding 和目录 revision 的 commit operation 已确认，固定本地 ref 必须指向目标 SHA。预期旧远端 SHA 必须是目标提交的祖先；新分支必须显式传入 `null`。精确 ref lease 只用于防并发漂移，不能用于任意非快进覆盖，不提供删除、覆盖主分支或任意 refspec。

私有 index、不可变对象和分支 CAS 避免共享普通暂存区；现有 source-operation 的串行执行限制不替代跨进程 CAS。宿主必须提供专用 Git 仓库，不能传入当前应用源码或用户正在编辑的共享仓库。

## 子进程与文件边界

子进程使用固定 Git executable/argv、空临时 HOME、固定 PATH，不继承宿主完整环境；关闭 hooks、交互、签名、凭据 helper、全局/系统 Git 配置、replace objects 与 HTTP 重定向。显式凭据只在网络子进程的临时配置环境中存在，不放进 argv、持久意图、回执或模型上下文。错误统一清理，不保存原始 stderr。

仓库拒绝符号链接路径、共享 worktree 的 `.git` 文件、外置对象目录、replace、shallow/grafts 和未允许的本地 Git 配置。变更路径拒绝绝对路径、父级跳转、控制字符、`.git`、`.gitmodules` 和 `.gitattributes`；文件 mode 只能是普通文件的 100644/100755。调用方传入已验证的文本内容，不从任意工作树路径读取秘密。

中断杀掉实际 Git 子进程组并等待退出后返回，避免 Stop 返回后留下晚到 ref 更新。当前端口依赖 POSIX 的 `/usr/bin/git`、进程组和 `/dev/null`，Windows 尚未适配或验收。该实现不是 OS 沙箱，不承诺抵御同一个 OS 用户恶意并发替换仓库内容；本地测试 bare 远端属于可信测试宿主。

## 崩溃、未知结果与对账

`ShadowOperations` 先持久化 uncertain，再调用端口；端口在可能写入前另存 `(operation.id, revision)` attempt。这个检查点表示可能执行，不证明已经发送。operation 回执和 Effect settle 仍同事务提交。

commit 或 push 已生效但回执落库失败时，恢复仅检查固定本地 ref/完整 commit 或固定远端 ref 的正面证据。检查点缺失、目标配置变化、远端移动或查询失败都保持 unknown；本端口不返回 not-applied，因此不会由恢复自动重新推送。Stop 后仍允许读取外部事实；`cancelRequested` 不会抹去已发生的 push。

远端 ref 恰好匹配只能证明观察时的目标状态，不能证明唯一创建者，也不能证明 ref 从未在两次读取之间变化。Git ref lease 保护实际 receive 的旧值，不是仓库 ID 或账号身份协议。任何 CI、PR、Merge 或 Issue 完成事实仍须由相应 Source/原生回执核实。

## 验证与真实部署要求

```bash
node --test test/dsh-git-repository.test.ts test/dsh-git-delivery.test.ts
pnpm typecheck
```

真实验收必须单独提供专用测试仓库、可撤销的执行身份与独立审核身份、Git HTTPS resolver、独立模型配置、ready 执行目录映射，以及允许的 Source/Policy 范围。不得从本机既有凭据推断这些配置，也不能将本地 bare push 当作真实 GitHub/CI 验收。M12 继续禁止生产数据迁移或 Runtime 切换。
